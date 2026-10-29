// Guías de estudio con IA por actividad: reglas, cola y rutina. El generador (OpenAI) se conecta aparte; sin él, las solicitudes
// quedan en cola ('requested') y nada sale hacia ningún servicio externo.
//
// Reglas:
//  1. Apagado por defecto: la rutina solo mira materias que el estudiante activó.
//  2. Botón manual: una actividad concreta se puede pedir aunque la materia esté apagada.
//  3. Una sola guía por actividad: si ya existe (en cola, generándose o lista) no se puede pedir otra; solo se reintenta si falló.
//  4. Salvaguardas: tope de guías por corrida y tope de gasto mensual.
import type { Database, Queryable } from '../../database/connection.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { detectTools } from './tools.js';

export interface GuideContent {
  summary: string;
  sections: Array<{ heading: string; body: string; bullets?: string[] }>;
  sources: Array<{ file: string; note?: string }>;
}
export interface GuideRequest { guideId: string; enrollmentId: string; courseId: string; gradebookColumnId: string }
export interface GuideResult { content: GuideContent; model: string; inputTokens: number; outputTokens: number; costUsd: number }
export interface GuideGenerator {
  /** false = sin IA conectada: las solicitudes se quedan en cola. */
  readonly configured: boolean;
  generate(request: GuideRequest): Promise<GuideResult>;
}
export class GuideError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
export const notConfiguredGenerator: GuideGenerator = {
  configured: false,
  async generate() { throw new GuideError('ai_not_configured', 'La IA no está conectada.'); },
};

export interface GuidePolicy {
  /** Gasto máximo del mes (USD) sumando guías terminadas y una estimación de las que están en cola. */
  monthlyCapUsd: number;
  /** Guías nuevas que la rutina puede encolar por estudiante en cada corrida. */
  maxPerRun: number;
  /** Costo estimado de una guía en cola, para no pasarse del tope antes de generarla. */
  estimatedCostUsd: number;
  /** Una guía 'generating' más vieja que esto se considera abandonada y vuelve a la cola. */
  staleGeneratingMs: number;
}
export const DEFAULT_POLICY: GuidePolicy = { monthlyCapUsd: 5, maxPerRun: 5, estimatedCostUsd: 0.05, staleGeneratingMs: 10 * 60_000 };

// La misma definición de "actividad" que usa el resto de la API.
const IS_ACTIVITY = 'NOT gc.is_calculated AND NOT gc.is_deleted_at_source AND gc.removed_at_source IS NULL AND sg.is_visible_to_student';
const OWN = `ea.user_id = $1 AND ea.link_status <> 'revoked' AND ce.status = 'active'`;

export interface GuideView {
  id: string; status: 'requested' | 'generating' | 'ready' | 'failed'; trigger: 'manual' | 'routine';
  content: GuideContent | null; model: string | null; errorCode: string | null; requestedAt: string; finishedAt: string | null;
  /** Herramientas que la actividad pide usar (p. ej. 'geogebra'), detectadas en el texto de la guía. */
  tools: string[];
}

const toView = (row: Record<string, unknown>): GuideView => ({
  tools: row.content ? detectTools(JSON.stringify(row.content)) : [],
  id: row.id as string, status: row.status as GuideView['status'], trigger: row.trigger as GuideView['trigger'],
  content: (row.content as GuideContent | null) ?? null, model: (row.model as string | null) ?? null, errorCode: (row.error_code as string | null) ?? null,
  requestedAt: new Date(row.requested_at as string).toISOString(), finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
});

/** Ajuste por materia del estudiante: una fila por inscripción activa; sin fila = apagado. */
export async function listSettings(db: Queryable, userId: string) {
  const { rows } = await db.query(
    `SELECT c.id AS "courseId", c.name, t.name AS "termName", COALESCE(s.enabled, false) AS enabled,
            (SELECT count(*)::int FROM study_guides g WHERE g.enrollment_id = ce.id AND g.status = 'ready') AS "ready",
            (SELECT count(*)::int FROM study_guides g WHERE g.enrollment_id = ce.id AND g.status IN ('requested', 'generating')) AS "queued"
       FROM course_enrollments ce
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN courses c ON c.id = ce.course_id
       LEFT JOIN academic_terms t ON t.id = c.term_id
       LEFT JOIN study_guide_settings s ON s.enrollment_id = ce.id
      WHERE ${OWN}
      ORDER BY t.start_at DESC NULLS LAST, c.name`, [userId]);
  return rows;
}

export async function setEnabled(db: Queryable, userId: string, courseId: string, enabled: boolean): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT ce.id FROM course_enrollments ce JOIN external_accounts ea ON ea.id = ce.external_account_id WHERE ${OWN} AND ce.course_id = $2`, [userId, courseId]);
  if (!rows[0]) return false;
  await db.query(
    `INSERT INTO study_guide_settings (enrollment_id, enabled) VALUES ($1, $2)
     ON CONFLICT (enrollment_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [rows[0].id, enabled]);
  return true;
}

interface OwnActivity { id: string; enrollmentId: string; courseId: string; gradebookColumnId: string; courseEnabled: boolean }

async function ownActivity(db: Queryable, userId: string, activityId: string): Promise<OwnActivity | null> {
  const { rows } = await db.query<{ id: string; enrollment_id: string; course_id: string; gradebook_column_id: string; enabled: boolean }>(
    `SELECT sg.id, sg.enrollment_id, sg.course_id, sg.gradebook_column_id, COALESCE(s.enabled, false) AS enabled
       FROM student_grades sg
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
       LEFT JOIN study_guide_settings s ON s.enrollment_id = ce.id
      WHERE sg.id = $2 AND ${OWN} AND ${IS_ACTIVITY}`, [userId, activityId]);
  const row = rows[0];
  return row ? { id: row.id, enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.gradebook_column_id, courseEnabled: row.enabled } : null;
}

/** Estado de la guía de una actividad y qué puede hacer el estudiante con ella. */
export async function getGuide(db: Queryable, userId: string, activityId: string) {
  const activity = await ownActivity(db, userId, activityId);
  if (!activity) throw notFound();
  const { rows } = await db.query(
    `SELECT id, status, trigger, content, model, error_code, requested_at, finished_at FROM study_guides WHERE enrollment_id = $1 AND gradebook_column_id = $2`,
    [activity.enrollmentId, activity.gradebookColumnId]);
  const guide = rows[0] ? toView(rows[0]) : null;
  return { activityId, courseEnabled: activity.courseEnabled, guide, canRequest: guide === null || guide.status === 'failed' };
}

/** Botón manual: sirve aunque la materia esté apagada. Una guía existente no se duplica; una fallida se reintenta. */
export async function requestGuide(db: Database, userId: string, activityId: string): Promise<GuideView> {
  const activity = await ownActivity(db, userId, activityId);
  if (!activity) throw notFound();
  const inserted = await db.query(
    `INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, trigger) VALUES ($1, $2, $3, 'manual')
     ON CONFLICT (enrollment_id, gradebook_column_id) DO NOTHING
     RETURNING id, status, trigger, content, model, error_code, requested_at, finished_at`,
    [activity.enrollmentId, activity.courseId, activity.gradebookColumnId]);
  if (inserted.rows[0]) return toView(inserted.rows[0]);
  // Ya existía: solo una guía fallida vuelve a la cola (la condición del UPDATE evita carreras).
  const retried = await db.query(
    `UPDATE study_guides SET status = 'requested', error_code = NULL, requested_at = now(), started_at = NULL, finished_at = NULL
      WHERE enrollment_id = $1 AND gradebook_column_id = $2 AND status = 'failed'
      RETURNING id, status, trigger, content, model, error_code, requested_at, finished_at`,
    [activity.enrollmentId, activity.gradebookColumnId]);
  if (retried.rows[0]) return toView(retried.rows[0]);
  throw new HttpError(409, 'study_guide_exists', 'Esta actividad ya tiene una guía de estudio.');
}

export async function monthlySpend(db: Queryable, now: Date = new Date()): Promise<{ spent: number; queued: number }> {
  const { rows } = await db.query<{ spent: string; queued: number }>(
    `SELECT COALESCE(sum(cost_usd) FILTER (WHERE finished_at >= date_trunc('month', $1::timestamptz)), 0) AS spent,
            count(*) FILTER (WHERE status IN ('requested', 'generating'))::int AS queued
       FROM study_guides`, [now.toISOString()]);
  return { spent: Number(rows[0]!.spent), queued: rows[0]!.queued };
}

export interface RoutineSummary { enqueued: number; skipped: 'monthly_cap' | null; courses: number }

/**
 * Rutina: encola las guías de las actividades pendientes de las materias que el estudiante activó.
 * Pendiente = visible, sin entregar, sin nota y con entrega vigente. Respeta el tope por corrida y el tope mensual.
 */
export async function enqueueRoutine(db: Database, policy: GuidePolicy = DEFAULT_POLICY, scope: { userId?: string } = {}, now: Date = new Date()): Promise<RoutineSummary> {
  const summary: RoutineSummary = { enqueued: 0, skipped: null, courses: 0 };
  const enrollments = await db.query<{ enrollment_id: string; course_id: string; user_id: string }>(
    `SELECT ce.id AS enrollment_id, ce.course_id, ea.user_id
       FROM study_guide_settings s
       JOIN course_enrollments ce ON ce.id = s.enrollment_id AND ce.status = 'active'
       JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.link_status <> 'revoked'
      WHERE s.enabled AND ($1::uuid IS NULL OR ea.user_id = $1)
      ORDER BY ea.user_id, ce.id`, [scope.userId ?? null]);
  const perUser = new Map<string, number>();
  for (const enrollment of enrollments.rows) {
    summary.courses += 1;
    const { spent, queued } = await monthlySpend(db, now);
    const available = policy.monthlyCapUsd - spent - queued * policy.estimatedCostUsd;
    const budget = Math.floor(available / policy.estimatedCostUsd);
    if (budget <= 0) { summary.skipped = 'monthly_cap'; break; }
    const room = policy.maxPerRun - (perUser.get(enrollment.user_id) ?? 0);
    if (room <= 0) continue;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, trigger)
       SELECT sg.enrollment_id, sg.course_id, sg.gradebook_column_id, 'routine'
         FROM student_grades sg
         JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
        WHERE sg.enrollment_id = $1 AND ${IS_ACTIVITY}
          AND COALESCE(sg.is_submitted, false) = false AND sg.score IS NULL
          AND COALESCE(sg.effective_due_at, gc.due_at) >= $2::timestamptz
          AND NOT EXISTS (SELECT 1 FROM study_guides g WHERE g.enrollment_id = sg.enrollment_id AND g.gradebook_column_id = sg.gradebook_column_id)
        ORDER BY COALESCE(sg.effective_due_at, gc.due_at)
        LIMIT $3
       ON CONFLICT (enrollment_id, gradebook_column_id) DO NOTHING
       RETURNING id`, [enrollment.enrollment_id, now.toISOString(), Math.min(room, budget)]);
    summary.enqueued += rows.length;
    perUser.set(enrollment.user_id, (perUser.get(enrollment.user_id) ?? 0) + rows.length);
  }
  return summary;
}

export interface QueueSummary { processed: number; ready: number; failed: number; skipped: 'ai_not_configured' | 'monthly_cap' | null }

/** Procesa la cola con el generador. Sin IA conectada no hace nada: las guías siguen en cola. */
export async function processQueue(db: Database, generator: GuideGenerator, policy: GuidePolicy = DEFAULT_POLICY, options: { limit?: number; now?: Date } = {}): Promise<QueueSummary> {
  const summary: QueueSummary = { processed: 0, ready: 0, failed: 0, skipped: null };
  if (!generator.configured) { summary.skipped = 'ai_not_configured'; return summary; }
  const now = options.now ?? new Date();
  await db.query(
    `UPDATE study_guides SET status = 'requested', started_at = NULL WHERE status = 'generating' AND started_at < $1::timestamptz`,
    [new Date(now.getTime() - policy.staleGeneratingMs).toISOString()]);
  for (let i = 0; i < (options.limit ?? 10); i += 1) {
    const { spent } = await monthlySpend(db, now);
    if (spent + policy.estimatedCostUsd > policy.monthlyCapUsd) { summary.skipped = 'monthly_cap'; break; }
    const claimed = await db.query<{ id: string; enrollment_id: string; course_id: string; gradebook_column_id: string }>(
      `UPDATE study_guides SET status = 'generating', started_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM study_guides WHERE status = 'requested' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, enrollment_id, course_id, gradebook_column_id`);
    const row = claimed.rows[0];
    if (!row) break;
    summary.processed += 1;
    try {
      const result = await generator.generate({ guideId: row.id, enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.gradebook_column_id });
      await db.query(
        `UPDATE study_guides SET status = 'ready', content = $2, model = $3, input_tokens = $4, output_tokens = $5, cost_usd = $6, error_code = NULL, finished_at = now() WHERE id = $1`,
        [row.id, JSON.stringify(result.content), result.model, result.inputTokens, result.outputTokens, result.costUsd]);
      summary.ready += 1;
    } catch (error) {
      await db.query(`UPDATE study_guides SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1`, [row.id, error instanceof GuideError ? error.code : 'generation_failed']);
      summary.failed += 1;
    }
  }
  return summary;
}
