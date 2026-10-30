// Tareas con IA por actividad: reglas, cola y rutina. El agente (OpenAI + herramientas) se conecta aparte; sin él, las solicitudes
// quedan en cola ('requested') y nada sale hacia ningún servicio externo. Reglas completas: docs/HOMEWORK_AGENT_RULES.md.
//
//  R1/R2  Solo actividades; nunca exámenes (se decide con la categoría de Blackboard, ver eligibility.ts).
//  R2b    Solo pendientes: visibles, sin entregar, sin nota y con fecha vigente.
//  R3     Bandera propia por materia, apagada por defecto.
//  R4     La rutina se dispara por un endpoint interno; esta API no programa nada.
//  R5     Una sola tarea por actividad.
//  R6     Solo lectura en Blackboard: el agente nunca entrega nada.
import { join } from 'node:path';
import type { Database, Queryable } from '../../database/connection.js';
import { notFound } from '../../shared/errors.js';
import { classifyActivity } from './eligibility.js';
import { aiSpend, logAiUsage, monthStart, nextMonthStart } from '../logs/logs.js';

export interface Deliverable { name: string; kind: 'pdf' | 'docx' | 'xlsx'; bytes: number }
export interface HomeworkReport {
  turns: number; tools: Record<string, number>; assumptions: string[]; pending: string[]; placeholders: string[]; warnings: string[]; materialDocs: string[];
}
export interface HomeworkRequest {
  runId: string; enrollmentId: string; courseId: string; gradebookColumnId: string;
  /** Presupuesto máximo (USD) de esta tarea: lo que queda del mes o el tope por tarea, lo que sea menor. El agente no puede pasarlo. */
  budgetUsd?: number;
}
export interface HomeworkResult { deliverables: Deliverable[]; summary: string; report: HomeworkReport; model: string; inputTokens: number; outputTokens: number; costUsd: number }
export interface HomeworkGenerator {
  /** false = sin IA conectada: las solicitudes se quedan en cola. */
  readonly configured: boolean;
  generate(request: HomeworkRequest): Promise<HomeworkResult>;
}
export class HomeworkError extends Error {
  constructor(readonly code: string, readonly usage?: { inputTokens: number; outputTokens: number; costUsd: number }, message = code) { super(message); }
}
export const notConfiguredHomework: HomeworkGenerator = {
  configured: false,
  async generate() { throw new HomeworkError('ai_not_configured', undefined, 'La IA no está conectada.'); },
};

export interface HomeworkPolicy {
  /** Gasto máximo del mes (USD): tareas terminadas más una estimación de las que están en cola. */
  monthlyCapUsd: number;
  /** Tareas nuevas que la rutina puede encolar por estudiante en cada corrida. */
  maxPerRun: number;
  /** Costo estimado de una tarea en cola, para no pasarse del tope antes de generarla. */
  estimatedCostUsd: number;
  /** Una tarea 'generating' más vieja que esto se considera abandonada y vuelve a la cola. */
  staleGeneratingMs: number;
  /** Intentos máximos por tarea (se cuentan también los que fallan). */
  maxAttempts: number;
  /** Tope por tarea (USD). Cada tarea recibe como presupuesto el menor entre este valor y lo que quede del mes. */
  maxPerTaskUsd: number;
  /** Si lo que queda del mes es menos que esto, no se empieza ninguna tarea. */
  minBudgetUsd: number;
}
export const DEFAULT_HOMEWORK_POLICY: HomeworkPolicy = { monthlyCapUsd: 10, maxPerRun: 5, estimatedCostUsd: 0.8, staleGeneratingMs: 20 * 60_000, maxAttempts: 3, maxPerTaskUsd: 1.5, minBudgetUsd: 0.1 };

export const HOMEWORK_DIR = join(process.cwd(), '.state', 'homework');

// La misma definición de "actividad" que usa el resto de la API.
const IS_ACTIVITY = 'NOT gc.is_calculated AND NOT gc.is_deleted_at_source AND gc.removed_at_source IS NULL AND sg.is_visible_to_student';
const OWN = `ea.user_id = $1 AND ea.link_status <> 'revoked' AND ce.status = 'active'`;

export interface HomeworkView {
  id: string; status: 'requested' | 'generating' | 'ready' | 'failed' | 'skipped'; trigger: 'manual' | 'routine';
  deliverables: Deliverable[]; summary: string | null; report: HomeworkReport | null; model: string | null; errorCode: string | null;
  costUsd: number | null; requestedAt: string; finishedAt: string | null;
}
const toView = (row: Record<string, unknown>): HomeworkView => ({
  id: row.id as string, status: row.status as HomeworkView['status'], trigger: row.trigger as HomeworkView['trigger'],
  deliverables: (row.deliverables as Deliverable[]) ?? [], summary: (row.summary as string | null) ?? null, report: (row.report as HomeworkReport | null) ?? null,
  model: (row.model as string | null) ?? null, errorCode: (row.error_code as string | null) ?? null, costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
  requestedAt: new Date(row.requested_at as string).toISOString(), finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
});

/** Ajuste por materia del estudiante: una fila por inscripción activa; sin fila = apagado. */
export async function listSettings(db: Queryable, userId: string) {
  const { rows } = await db.query(
    `SELECT c.id AS "courseId", c.name, t.name AS "termName", COALESCE(s.enabled, false) AS enabled,
            (SELECT count(*)::int FROM homework_runs h WHERE h.enrollment_id = ce.id AND h.status = 'ready') AS "ready",
            (SELECT count(*)::int FROM homework_runs h WHERE h.enrollment_id = ce.id AND h.status IN ('requested', 'generating')) AS "queued"
       FROM course_enrollments ce
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN courses c ON c.id = ce.course_id
       LEFT JOIN academic_terms t ON t.id = c.term_id
       LEFT JOIN homework_settings s ON s.enrollment_id = ce.id
      WHERE ${OWN}
      ORDER BY t.start_at DESC NULLS LAST, c.name`, [userId]);
  return rows;
}

export async function setEnabled(db: Queryable, userId: string, courseId: string, enabled: boolean): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT ce.id FROM course_enrollments ce JOIN external_accounts ea ON ea.id = ce.external_account_id WHERE ${OWN} AND ce.course_id = $2`, [userId, courseId]);
  if (!rows[0]) return false;
  await db.query(
    `INSERT INTO homework_settings (enrollment_id, enabled) VALUES ($1, $2)
     ON CONFLICT (enrollment_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [rows[0].id, enabled]);
  return true;
}

interface OwnActivity { enrollmentId: string; courseId: string; gradebookColumnId: string; courseEnabled: boolean; name: string; category: string | null; submitted: boolean; score: number | null; due: Date | null }

async function ownActivity(db: Queryable, userId: string, activityId: string): Promise<OwnActivity | null> {
  const { rows } = await db.query<{ enrollment_id: string; course_id: string; gradebook_column_id: string; enabled: boolean; name: string; category_title: string | null; submitted: boolean; score: string | null; due: Date | null }>(
    `SELECT sg.enrollment_id, sg.course_id, sg.gradebook_column_id, COALESCE(s.enabled, false) AS enabled, gc.name, gc.category_title,
            COALESCE(sg.is_submitted, false) AS submitted, sg.score, COALESCE(sg.effective_due_at, gc.due_at) AS due
       FROM student_grades sg
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
       LEFT JOIN homework_settings s ON s.enrollment_id = ce.id
      WHERE sg.id = $2 AND ${OWN} AND ${IS_ACTIVITY}`, [userId, activityId]);
  const r = rows[0];
  return r ? { enrollmentId: r.enrollment_id, courseId: r.course_id, gradebookColumnId: r.gradebook_column_id, courseEnabled: r.enabled, name: r.name, category: r.category_title, submitted: r.submitted, score: r.score === null ? null : Number(r.score), due: r.due } : null;
}

/** Estado de la tarea de una actividad: si es elegible, si está pendiente y qué archivos produjo. */
export async function getHomework(db: Queryable, userId: string, activityId: string, now: Date = new Date()) {
  const activity = await ownActivity(db, userId, activityId);
  if (!activity) throw notFound();
  const { rows } = await db.query(
    `SELECT id, status, trigger, deliverables, summary, report, model, error_code, cost_usd, requested_at, finished_at FROM homework_runs WHERE enrollment_id = $1 AND gradebook_column_id = $2`,
    [activity.enrollmentId, activity.gradebookColumnId]);
  const eligibility = classifyActivity(activity.category, activity.name);
  const pending = !activity.submitted && activity.score === null && (activity.due === null || new Date(activity.due) >= now);
  return { activityId, courseEnabled: activity.courseEnabled, eligible: eligibility.kind === 'activity', pending, homework: rows[0] ? toView(rows[0]) : null };
}

/** Ruta del archivo de una tarea lista; 404 si no es del usuario o no está en la lista de entregables. */
export async function getDeliverablePath(db: Queryable, userId: string, activityId: string, name: string): Promise<{ path: string; kind: Deliverable['kind'] }> {
  const activity = await ownActivity(db, userId, activityId);
  if (!activity) throw notFound();
  const { rows } = await db.query<{ id: string; deliverables: Deliverable[] }>(
    `SELECT id, deliverables FROM homework_runs WHERE enrollment_id = $1 AND gradebook_column_id = $2 AND status = 'ready'`, [activity.enrollmentId, activity.gradebookColumnId]);
  const run = rows[0]; const file = run?.deliverables.find((d) => d.name === name);
  if (!run || !file) throw notFound();
  return { path: join(HOMEWORK_DIR, run.id, file.name), kind: file.kind };
}

/**
 * Gasto de tareas en el mes de `now` (hora de El Salvador): el mayor entre lo registrado llamada por llamada en ai_usage_log
 * y lo guardado en las propias tareas. Así un corte a media tarea no hace que el tope se subestime. El conteo vuelve a cero cada mes.
 */
export async function monthlySpend(db: Queryable, now: Date = new Date()): Promise<{ spent: number; queued: number }> {
  const start = monthStart(now);
  const { rows } = await db.query<{ spent: string; queued: number }>(
    `SELECT COALESCE(sum(cost_usd) FILTER (WHERE finished_at >= $1::timestamptz AND finished_at < $2::timestamptz), 0) AS spent,
            count(*) FILTER (WHERE status IN ('requested', 'generating'))::int AS queued
       FROM homework_runs`, [start.toISOString(), nextMonthStart(start).toISOString()]);
  const logged = await aiSpend(db, 'homework', now);
  return { spent: Math.max(Number(rows[0]!.spent), logged), queued: rows[0]!.queued };
}

export interface RoutineSummary { enqueued: number; blockedExams: number; skipped: 'monthly_cap' | null; courses: number }

/** Rutina: encola las tareas de las actividades pendientes de las materias que el estudiante activó. Los exámenes nunca entran. */
export async function enqueueRoutine(db: Database, policy: HomeworkPolicy = DEFAULT_HOMEWORK_POLICY, scope: { userId?: string } = {}, now: Date = new Date()): Promise<RoutineSummary> {
  const summary: RoutineSummary = { enqueued: 0, blockedExams: 0, skipped: null, courses: 0 };
  const enrollments = await db.query<{ enrollment_id: string; user_id: string }>(
    `SELECT ce.id AS enrollment_id, ea.user_id
       FROM homework_settings s
       JOIN course_enrollments ce ON ce.id = s.enrollment_id AND ce.status = 'active'
       JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.link_status <> 'revoked'
      WHERE s.enabled AND ($1::uuid IS NULL OR ea.user_id = $1)
      ORDER BY ea.user_id, ce.id`, [scope.userId ?? null]);
  const perUser = new Map<string, number>();
  for (const enrollment of enrollments.rows) {
    summary.courses += 1;
    const { spent, queued } = await monthlySpend(db, now);
    const budget = Math.floor((policy.monthlyCapUsd - spent - queued * policy.estimatedCostUsd) / policy.estimatedCostUsd);
    if (budget <= 0) { summary.skipped = 'monthly_cap'; break; }
    let room = Math.min(policy.maxPerRun - (perUser.get(enrollment.user_id) ?? 0), budget);
    if (room <= 0) continue;
    const candidates = await db.query<{ course_id: string; gradebook_column_id: string; name: string; category_title: string | null }>(
      `SELECT sg.course_id, sg.gradebook_column_id, gc.name, gc.category_title
         FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
        WHERE sg.enrollment_id = $1 AND ${IS_ACTIVITY}
          AND COALESCE(sg.is_submitted, false) = false AND sg.score IS NULL
          AND COALESCE(sg.effective_due_at, gc.due_at) >= $2::timestamptz
          AND NOT EXISTS (SELECT 1 FROM homework_runs h WHERE h.enrollment_id = sg.enrollment_id AND h.gradebook_column_id = sg.gradebook_column_id)
        ORDER BY COALESCE(sg.effective_due_at, gc.due_at)`, [enrollment.enrollment_id, now.toISOString()]);
    for (const candidate of candidates.rows) {
      if (room <= 0) break;
      if (classifyActivity(candidate.category_title, candidate.name).kind === 'exam') { summary.blockedExams += 1; continue; }
      const inserted = await db.query(
        `INSERT INTO homework_runs (enrollment_id, course_id, gradebook_column_id, trigger) VALUES ($1, $2, $3, 'routine')
         ON CONFLICT (enrollment_id, gradebook_column_id) DO NOTHING RETURNING id`, [enrollment.enrollment_id, candidate.course_id, candidate.gradebook_column_id]);
      if (inserted.rows[0]) { summary.enqueued += 1; room -= 1; perUser.set(enrollment.user_id, (perUser.get(enrollment.user_id) ?? 0) + 1); }
    }
  }
  return summary;
}

export interface QueueSummary { processed: number; ready: number; failed: number; skipped: number; skippedReason: 'ai_not_configured' | 'monthly_cap' | 'busy' | null }

/** Procesa la cola con el agente. Sin IA conectada no hace nada: las tareas siguen en cola. */
let processing = false;

export async function processQueue(db: Database, generator: HomeworkGenerator, policy: HomeworkPolicy = DEFAULT_HOMEWORK_POLICY, options: { limit?: number; now?: Date } = {}): Promise<QueueSummary> {
  const summary: QueueSummary = { processed: 0, ready: 0, failed: 0, skipped: 0, skippedReason: null };
  if (!generator.configured) { summary.skippedReason = 'ai_not_configured'; return summary; }
  // Una sola corrida a la vez: así dos llamadas seguidas al endpoint no pueden gastar el mismo presupuesto dos veces.
  if (processing) { summary.skippedReason = 'busy'; return summary; }
  processing = true;
  try { return await processLocked(db, generator, policy, options, summary); } finally { processing = false; }
}

async function processLocked(db: Database, generator: HomeworkGenerator, policy: HomeworkPolicy, options: { limit?: number; now?: Date }, summary: QueueSummary): Promise<QueueSummary> {
  const now = options.now ?? new Date();
  await db.query(`UPDATE homework_runs SET status = 'requested', started_at = NULL WHERE status = 'generating' AND started_at < $1::timestamptz`,
    [new Date(now.getTime() - policy.staleGeneratingMs).toISOString()]);
  for (let i = 0; i < (options.limit ?? 10); i += 1) {
    const { spent } = await monthlySpend(db, now);
    const remaining = policy.monthlyCapUsd - spent;
    if (remaining < policy.minBudgetUsd) {
      summary.skippedReason = 'monthly_cap';
      await logAiUsage(db, { event: 'cap_reached', feature: 'homework', status: 'error', errorCode: 'monthly_cap', message: `Tope mensual de tareas alcanzado: gastado USD ${spent.toFixed(4)} de USD ${policy.monthlyCapUsd.toFixed(2)}.`, detail: { spentUsd: spent, capUsd: policy.monthlyCapUsd } });
      break;
    }
    const budgetUsd = Math.min(policy.maxPerTaskUsd, remaining);
    const claimed = await db.query<{ id: string; enrollment_id: string; course_id: string; gradebook_column_id: string; attempts: number }>(
      `UPDATE homework_runs SET status = 'generating', started_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM homework_runs WHERE status = 'requested' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, enrollment_id, course_id, gradebook_column_id, attempts`);
    const row = claimed.rows[0];
    if (!row) break;
    // Reglas duras ANTES de llamar al modelo: nada de exámenes y solo lo que sigue pendiente.
    const check = await db.query<{ name: string; category_title: string | null; submitted: boolean; score: string | null; due: Date | null }>(
      `SELECT gc.name, gc.category_title, COALESCE(sg.is_submitted, false) AS submitted, sg.score, COALESCE(sg.effective_due_at, gc.due_at) AS due
         FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
        WHERE sg.enrollment_id = $1 AND sg.gradebook_column_id = $2`, [row.enrollment_id, row.gradebook_column_id]);
    const activity = check.rows[0];
    const skip = !activity ? 'activity_not_found'
      : classifyActivity(activity.category_title, activity.name).kind === 'exam' ? 'exam_blocked'
        : activity.submitted || activity.score !== null || (activity.due !== null && new Date(activity.due) < now) ? 'not_pending'
          : row.attempts > policy.maxAttempts ? 'too_many_attempts' : null;
    if (skip) {
      await db.query(`UPDATE homework_runs SET status = $2, error_code = $3, finished_at = now() WHERE id = $1`, [row.id, skip === 'too_many_attempts' ? 'failed' : 'skipped', skip]);
      await logAiUsage(db, { event: 'run_skipped', feature: 'homework', runId: row.id, enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.gradebook_column_id, errorCode: skip, message: `Tarea omitida sin llamar a la IA: ${skip}.`, detail: activity ? { name: activity.name, category: activity.category_title } : undefined });
      summary.skipped += 1;
      continue;
    }
    summary.processed += 1;
    try {
      const result = await generator.generate({ runId: row.id, enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.gradebook_column_id, budgetUsd });
      await db.query(
        `UPDATE homework_runs SET status = 'ready', deliverables = $2, summary = $3, report = $4, model = $5, input_tokens = $6, output_tokens = $7, cost_usd = $8, error_code = NULL, finished_at = now() WHERE id = $1`,
        [row.id, JSON.stringify(result.deliverables), result.summary, JSON.stringify(result.report), result.model, result.inputTokens, result.outputTokens, result.costUsd]);
      summary.ready += 1;
      await logAiUsage(db, { event: 'run_finished', feature: 'homework', runId: row.id, enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.gradebook_column_id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: 0, status: 'ok',
        message: `Tarea lista: ${result.deliverables.length} archivo(s), ${result.report.turns} turno(s), USD ${result.costUsd.toFixed(4)}.`, detail: { totalCostUsd: result.costUsd, budgetUsd, deliverables: result.deliverables, tools: result.report.tools, warnings: result.report.warnings, placeholders: result.report.placeholders.length } });
    } catch (error) {
      const code = error instanceof HomeworkError ? error.code : 'generation_failed';
      const usage = error instanceof HomeworkError ? error.usage : undefined;
      // El costo se guarda también cuando el intento falla: los tokens ya se gastaron.
      await db.query(`UPDATE homework_runs SET status = 'failed', error_code = $2, input_tokens = $3, output_tokens = $4, cost_usd = $5, finished_at = now() WHERE id = $1`,
        [row.id, code, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.costUsd ?? null]);
      summary.failed += 1;
      await logAiUsage(db, { event: 'run_finished', feature: 'homework', runId: row.id, enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.gradebook_column_id, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, costUsd: 0, status: 'error', errorCode: code,
        message: `La tarea falló (${code}); costo ya gastado: USD ${(usage?.costUsd ?? 0).toFixed(4)}.`, detail: { totalCostUsd: usage?.costUsd ?? 0, budgetUsd } });
    }
  }
  return summary;
}
