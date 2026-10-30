// Notificaciones del estudiante: bandeja de la campana.
// Origen de los avisos: (1) eventos de la app (guía o tarea lista), (2) novedades detectadas por una importación,
// (3) recordatorios de entrega calculados con las fechas (mañana, hoy, en pocas horas).
// Cada aviso lleva una dedupe_key: repetir una importación o un cálculo nunca duplica nada.
import type { Database, Queryable } from '../../database/connection.js';
import { createAcademicRepository } from '../academic/academic.repository.js';
import { classifyActivity } from '../homework/eligibility.js';

export const KINDS = [
  'guide_ready', 'homework_ready', 'activity_new', 'due_changed', 'due_tomorrow', 'due_today', 'due_soon',
  'grade_new', 'grade_changed', 'announcement_new',
] as const;
export type NotificationKind = (typeof KINDS)[number];
export type Severity = 'info' | 'success' | 'warning' | 'urgent';

const DUE_KINDS: NotificationKind[] = ['due_tomorrow', 'due_today', 'due_soon'];
const TIME_ZONE = 'America/El_Salvador';
const HOUR = 3_600_000;
const SOON_MS = 3 * HOUR;
const SCAN_WINDOW_MS = 48 * HOUR;
const RETENTION_DAYS = 60;
const PREFERENCE_KEY = 'notifications';

export interface NotificationInput {
  userId: string; kind: NotificationKind; severity?: Severity; title: string; body?: string | null;
  courseId?: string | null; activityId?: string | null; link?: string | null; dedupeKey: string; expiresAt?: Date | null;
}

export interface NotificationView {
  id: string; kind: NotificationKind; severity: Severity; title: string; body: string | null; courseId: string | null; activityId: string | null;
  link: string | null; createdAt: string; readAt: string | null;
}

const isKind = (value: unknown): value is NotificationKind => typeof value === 'string' && (KINDS as readonly string[]).includes(value);

// ── Preferencias: tipos de aviso silenciados por el usuario ──────────────────────────────────────────────

export async function mutedKinds(db: Queryable, userId: string): Promise<NotificationKind[]> {
  const { rows } = await db.query<{ value: { muted?: unknown } }>('SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2', [userId, PREFERENCE_KEY]);
  const muted = rows[0]?.value?.muted;
  return Array.isArray(muted) ? [...new Set(muted.filter(isKind))] : [];
}

export async function setMutedKinds(db: Queryable, userId: string, muted: unknown): Promise<NotificationKind[]> {
  const clean = Array.isArray(muted) ? [...new Set(muted.filter(isKind))] : [];
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [userId, PREFERENCE_KEY, JSON.stringify({ muted: clean })]);
  return clean;
}

// ── Crear ────────────────────────────────────────────────────────────────────────────────────────────────

/** Crea el aviso si el usuario no silenció ese tipo y no existe ya. Devuelve true si se creó. */
export async function notify(db: Queryable, input: NotificationInput): Promise<boolean> {
  if ((await mutedKinds(db, input.userId)).includes(input.kind)) return false;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications (user_id, kind, severity, title, body, course_id, activity_id, link, dedupe_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [input.userId, input.kind, input.severity ?? 'info', input.title.slice(0, 200), input.body?.slice(0, 500) ?? null, input.courseId ?? null,
     input.activityId ?? null, input.link ?? null, input.dedupeKey.slice(0, 300), input.expiresAt ?? null]);
  return rows.length > 0;
}

// ── Leer y gestionar ─────────────────────────────────────────────────────────────────────────────────────

const VISIBLE = 'n.dismissed_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > now())';

export async function listNotifications(db: Queryable, userId: string, options: { limit: number; before?: { at: Date; id: string }; unreadOnly?: boolean }) {
  const { rows } = await db.query<{ id: string; kind: NotificationKind; severity: Severity; title: string; body: string | null; course_id: string | null; activity_id: string | null;
    link: string | null; created_at: Date; read_at: Date | null }>(
    `SELECT n.id, n.kind, n.severity, n.title, n.body, n.course_id, n.activity_id, n.link, n.created_at, n.read_at
       FROM notifications n
      WHERE n.user_id = $1 AND ${VISIBLE}
        AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
        AND ($3::timestamptz IS NULL OR (n.created_at, n.id) < ($3, $4::uuid))
      ORDER BY n.created_at DESC, n.id DESC LIMIT $5`,
    [userId, options.unreadOnly ?? false, options.before?.at ?? null, options.before?.id ?? null, options.limit]);
  return rows.map((row): NotificationView => ({
    id: row.id, kind: row.kind, severity: row.severity, title: row.title, body: row.body, courseId: row.course_id, activityId: row.activity_id, link: row.link,
    createdAt: new Date(row.created_at).toISOString(), readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
  }));
}

export async function unreadCount(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications n WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE}`, [userId]);
  return rows[0]?.n ?? 0;
}

/** Marca como leídos los avisos indicados, o todos. */
export async function markRead(db: Queryable, userId: string, target: { ids?: string[]; all?: boolean }): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE notifications n SET read_at = now() WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE} AND ($2::boolean OR n.id = ANY($3::uuid[]))`,
    [userId, target.all === true, target.ids ?? []]);
  return rowCount ?? 0;
}

/** Quita avisos de la bandeja (siguen contando para no volver a crearse). */
export async function dismiss(db: Queryable, userId: string, target: { ids?: string[]; all?: boolean }): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE notifications n SET dismissed_at = now(), read_at = COALESCE(n.read_at, now()) WHERE n.user_id = $1 AND n.dismissed_at IS NULL AND ($2::boolean OR n.id = ANY($3::uuid[]))`,
    [userId, target.all === true, target.ids ?? []]);
  return rowCount ?? 0;
}

// ── Recordatorios de entrega ─────────────────────────────────────────────────────────────────────────────

const localDay = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
const clock = (date: Date) => date.toLocaleTimeString('es-SV', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });

/** Cuánto falta, en palabras cortas: «45 min», «2 h». */
function remaining(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * Crea los recordatorios de lo que vence mañana, hoy o en pocas horas (solo lo pendiente) y limpia los que ya no sirven:
 * entregado o calificado, o reemplazado por uno más urgente de la misma actividad.
 * Los diferidos que no cuentan para la nota no avisan.
 */
export async function scanDeadlines(db: Database, userId: string, now = new Date()): Promise<number> {
  const repo = createAcademicRepository(db);
  const pending = await repo.activities(userId, { status: 'pending', from: now, to: new Date(now.getTime() + SCAN_WINDOW_MS) });
  const today = localDay(now);
  const tomorrow = localDay(new Date(now.getTime() + 24 * HOUR));
  let created = 0;
  for (const activity of pending) {
    if (!activity.dueAt || activity.countsInGrade === false) continue;
    const due = new Date(activity.dueAt as string);
    const left = due.getTime() - now.getTime();
    if (left <= 0) continue;
    const day = localDay(due);
    const exam = classifyActivity((activity.categoryTitle as string | null) ?? null, String(activity.name)).kind === 'exam';
    const what = exam ? 'Examen' : 'Entrega';
    const kind: NotificationKind | null = left <= SOON_MS ? 'due_soon' : day === today ? 'due_today' : day === tomorrow ? 'due_tomorrow' : null;
    if (!kind) continue;
    const title = kind === 'due_soon' ? `${what} en ${remaining(left)}: ${activity.name}`
      : kind === 'due_today' ? `${what} hoy a las ${clock(due)}: ${activity.name}` : `${what} mañana a las ${clock(due)}: ${activity.name}`;
    const ok = await notify(db, {
      userId, kind, severity: kind === 'due_tomorrow' ? 'warning' : 'urgent', title, body: String(activity.courseName),
      courseId: activity.courseId as string, activityId: activity.id, link: `/activities?abrir=${activity.id}`,
      dedupeKey: `${kind}:${activity.id}:${due.toISOString()}`, expiresAt: due,
    });
    if (ok) created += 1;
  }
  // Ya entregada o calificada: el recordatorio deja de servir.
  await db.query(
    `UPDATE notifications n SET expires_at = now() FROM student_grades sg
      WHERE sg.id = n.activity_id AND n.user_id = $1 AND n.kind = ANY($2::text[]) AND (n.expires_at IS NULL OR n.expires_at > now())
        AND (sg.is_submitted IS TRUE OR sg.status = 'GRADED')`, [userId, DUE_KINDS]);
  // Un aviso más urgente de la misma actividad y fecha reemplaza al anterior.
  await db.query(
    `UPDATE notifications n SET expires_at = now()
      WHERE n.user_id = $1 AND (n.expires_at IS NULL OR n.expires_at > now())
        AND ((n.kind = 'due_tomorrow' AND EXISTS (SELECT 1 FROM notifications h WHERE h.user_id = n.user_id AND h.activity_id = n.activity_id AND h.expires_at = n.expires_at AND h.kind IN ('due_today', 'due_soon')))
          OR (n.kind = 'due_today' AND EXISTS (SELECT 1 FROM notifications h WHERE h.user_id = n.user_id AND h.activity_id = n.activity_id AND h.expires_at = n.expires_at AND h.kind = 'due_soon')))`, [userId]);
  await db.query(`DELETE FROM notifications WHERE user_id = $1 AND created_at < now() - make_interval(days => $2)`, [userId, RETENTION_DAYS]);
  return created;
}

const lastScan = new Map<string, number>();
/** Recalcula los recordatorios como máximo cada 5 minutos por usuario (se llama al abrir la bandeja). */
export async function scanIfStale(db: Database, userId: string, now = new Date(), maxAgeMs = 5 * 60_000): Promise<void> {
  if (now.getTime() - (lastScan.get(userId) ?? 0) < maxAgeMs) return;
  lastScan.set(userId, now.getTime());
  try { await scanDeadlines(db, userId, now); } catch { lastScan.delete(userId); }
}

// ── Eventos de la app ────────────────────────────────────────────────────────────────────────────────────

interface ActivityRef { user_id: string; activity_id: string; name: string; course_id: string; course_name: string }

/** Guía lista → aviso con enlace directo a la guía. */
export async function notifyGuideReady(db: Queryable, guideId: string): Promise<void> {
  const { rows } = await db.query<ActivityRef>(
    `SELECT ea.user_id, sg.id AS activity_id, gc.name, c.id AS course_id, c.name AS course_name
       FROM study_guides g
       JOIN course_enrollments ce ON ce.id = g.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN student_grades sg ON sg.enrollment_id = g.enrollment_id AND sg.gradebook_column_id = g.gradebook_column_id
       JOIN gradebook_columns gc ON gc.id = g.gradebook_column_id
       JOIN courses c ON c.id = g.course_id
      WHERE g.id = $1`, [guideId]);
  const row = rows[0];
  if (!row) return;
  await notify(db, {
    userId: row.user_id, kind: 'guide_ready', severity: 'success', title: `Tu guía de estudio ya está lista`, body: `${row.name} · ${row.course_name}`,
    courseId: row.course_id, activityId: row.activity_id, link: `/activities/${row.activity_id}/guide`, dedupeKey: `guide_ready:${guideId}`,
  });
}

/** Tarea lista → aviso con enlace al resultado. */
export async function notifyHomeworkReady(db: Queryable, runId: string): Promise<void> {
  const { rows } = await db.query<ActivityRef & { files: number }>(
    `SELECT ea.user_id, sg.id AS activity_id, gc.name, c.id AS course_id, c.name AS course_name,
            CASE WHEN jsonb_typeof(h.deliverables) = 'array' THEN jsonb_array_length(h.deliverables) ELSE 0 END AS files
       FROM homework_runs h
       JOIN course_enrollments ce ON ce.id = h.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN student_grades sg ON sg.enrollment_id = h.enrollment_id AND sg.gradebook_column_id = h.gradebook_column_id
       JOIN gradebook_columns gc ON gc.id = h.gradebook_column_id
       JOIN courses c ON c.id = h.course_id
      WHERE h.id = $1`, [runId]);
  const row = rows[0];
  if (!row) return;
  const files = Number(row.files);
  await notify(db, {
    userId: row.user_id, kind: 'homework_ready', severity: 'success', title: 'Tu tarea ya está lista para revisar',
    body: `${row.name} · ${row.course_name}${files > 0 ? ` · ${files} ${files === 1 ? 'archivo' : 'archivos'}` : ''}`,
    courseId: row.course_id, activityId: row.activity_id, link: `/activities/${row.activity_id}/homework`, dedupeKey: `homework_ready:${runId}`,
  });
}

// ── Novedades de una importación ─────────────────────────────────────────────────────────────────────────

const num = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : null;
};
const when = (date: Date | null) => (date ? `${date.toLocaleDateString('es-SV', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' })} · ${clock(date)}` : 'sin fecha');

/** Convierte las novedades registradas por una importación en avisos para los estudiantes a quienes les importan. */
export async function notifyFromRun(db: Database, runId: string): Promise<number> {
  const changes = await db.query<{ id: string; kind: string; entity_type: string; entity_id: string; course_id: string | null; account_id: string | null;
    before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
    `SELECT ec.id, ec.after->>'kind' AS kind, ec.entity_type, ec.entity_id, ec.course_id, ec.external_account_id AS account_id, ec.before, ec.after
       FROM entity_changes ec
      WHERE ec.sync_run_id = $1 AND ec.after->>'kind' IN ('activity_new', 'due_changed', 'grade_new', 'grade_changed', 'announcement_new')
      ORDER BY ec.detected_at LIMIT 500`, [runId]);
  let created = 0;
  for (const change of changes.rows) {
    if (change.kind === 'announcement_new' && change.course_id) {
      const title = typeof change.after?.title === 'string' ? change.after.title : null;
      const people = await db.query<{ user_id: string; course_name: string }>(
        `SELECT DISTINCT ea.user_id, c.name AS course_name FROM course_enrollments ce
           JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.link_status <> 'revoked'
           JOIN courses c ON c.id = ce.course_id WHERE ce.course_id = $1 AND ce.status = 'active'`, [change.course_id]);
      for (const person of people.rows) {
        if (await notify(db, { userId: person.user_id, kind: 'announcement_new', title: `Nuevo anuncio en ${person.course_name}`, body: title, courseId: change.course_id,
          link: `/courses/${change.course_id}`, dedupeKey: `announcement_new:${change.entity_id}` })) created += 1;
      }
      continue;
    }
    // Resto: se resuelve la actividad propia de cada estudiante afectado.
    const refs = await db.query<ActivityRef & { score: string | null; points: string | null; due: Date | null; done: boolean }>(
      `SELECT ea.user_id, sg.id AS activity_id, gc.name, c.id AS course_id, c.name AS course_name, sg.score, gc.points_possible AS points,
              COALESCE(sg.effective_due_at, gc.due_at) AS due, (sg.is_submitted IS TRUE OR sg.status = 'GRADED') AS done
         FROM student_grades sg
         JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
         JOIN course_enrollments ce ON ce.id = sg.enrollment_id AND ce.status = 'active'
         JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.link_status <> 'revoked'
         JOIN courses c ON c.id = sg.course_id
        WHERE sg.is_visible_to_student AND NOT gc.is_calculated AND gc.removed_at_source IS NULL AND NOT gc.is_deleted_at_source
          AND (CASE WHEN $1::text = 'student_grade' THEN sg.id = $2::uuid ELSE gc.id = $2::uuid AND ($3::uuid IS NULL OR ea.id = $3::uuid) END)`,
      [change.entity_type, change.entity_id, change.account_id]);
    for (const ref of refs.rows) {
      const link = `/activities?abrir=${ref.activity_id}`;
      const base = { userId: ref.user_id, courseId: ref.course_id, activityId: ref.activity_id, link };
      if (change.kind === 'activity_new') {
        if (ref.done) continue;
        if (await notify(db, { ...base, kind: 'activity_new', title: `Nueva actividad en ${ref.course_name}`,
          body: `${ref.name} · vence ${when(ref.due ? new Date(ref.due) : null)}`, dedupeKey: `activity_new:${ref.activity_id}` })) created += 1;
      } else if (change.kind === 'due_changed') {
        const to = change.after && typeof change.after.due_at === 'string' ? new Date(change.after.due_at) : ref.due ? new Date(ref.due) : null;
        if (ref.done) continue;
        if (await notify(db, { ...base, kind: 'due_changed', severity: 'warning', title: `Cambió la fecha de entrega en ${ref.course_name}`,
          body: `${ref.name} · ahora ${when(to)}`, dedupeKey: `due_changed:${ref.activity_id}:${change.id}` })) created += 1;
      } else if (change.kind === 'grade_new' || change.kind === 'grade_changed') {
        const score = num(change.after?.score ?? ref.score);
        const points = num(ref.points);
        const result = score !== null ? `${score}${points ? ` / ${points}` : ''}` : null;
        if (await notify(db, { ...base, kind: change.kind, severity: 'info', title: change.kind === 'grade_new' ? `Ya hay nota en ${ref.course_name}` : `Cambió una nota en ${ref.course_name}`,
          body: `${ref.name}${result ? ` · ${result}` : ''}`, dedupeKey: `${change.kind}:${ref.activity_id}:${change.id}` })) created += 1;
      }
    }
  }
  return created;
}
