// Reporte mensual de costos de IA. Mientras no haya correo, el reporte se guarda en ai_usage_log (event = 'monthly_report'):
// `message` trae el texto legible y `detail` el desglose completo (persona → materia → actividad).
import type { Queryable } from '../../database/connection.js';
import { logAiUsage, monthStart, monthStartFromKey, nextMonthStart, periodOf } from './logs.js';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const usd = (n: number) => `USD ${n.toFixed(4).replace('.', ',')}`;
const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const firstName = (displayName: string | null, username: string | null) => {
  const word = (displayName ?? '').trim().split(/\s+/)[0] || username || 'Estudiante';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};
const courseTitle = (name: string) => name.replace(/\s+\d{2}\s+\d{2}-\d{4}\s*$/, '').replace(/\s+SECCI[ÓO]N$/i, '').trim();

export interface ReportActivity { activityId: string | null; name: string; feature: 'homework' | 'study_guide'; costUsd: number; inputTokens: number; outputTokens: number; calls: number; errors: number; models: string[] }
export interface ReportCourse { courseId: string | null; name: string; costUsd: number; activities: ReportActivity[] }
export interface ReportUser { userId: string | null; name: string; costUsd: number; inputTokens: number; outputTokens: number; calls: number; courses: ReportCourse[] }
export interface MonthlyReport {
  period: string; label: string; partial: boolean; capUsd: number; homeworkUsd: number; studyGuideUsd: number; remainingUsd: number; capReached: boolean;
  users: ReportUser[]; message: string;
}

export async function buildMonthlyReport(db: Queryable, start: Date, options: { capUsd: number; now?: Date }): Promise<MonthlyReport> {
  const end = nextMonthStart(start);
  const now = options.now ?? new Date();
  const local = new Date(start.getTime() - 6 * 3_600_000);
  const label = `${MONTHS[local.getUTCMonth()]} de ${local.getUTCFullYear()}`;
  const { rows } = await db.query<{
    feature: 'homework' | 'study_guide'; user_id: string | null; course_id: string | null; gradebook_column_id: string | null; run_id: string | null;
    cost: string; inp: string; outp: string; calls: number; errors: number; models: string[] | null;
    display_name: string | null; username: string | null; course_name: string | null; activity_name: string | null;
  }>(
    `SELECT l.feature, l.user_id, l.course_id, l.gradebook_column_id, l.run_id,
            sum(l.cost_usd) AS cost, COALESCE(sum(l.input_tokens), 0) AS inp, COALESCE(sum(l.output_tokens), 0) AS outp,
            count(*)::int AS calls, count(*) FILTER (WHERE l.status = 'error')::int AS errors,
            array_remove(array_agg(DISTINCT l.model), NULL) AS models,
            max(u.display_name) AS display_name, max(u.username) AS username, max(c.name) AS course_name, max(gc.name) AS activity_name
       FROM ai_usage_log l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN courses c ON c.id = l.course_id
       LEFT JOIN gradebook_columns gc ON gc.id = l.gradebook_column_id
      WHERE l.event = 'call' AND l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz
      GROUP BY l.feature, l.user_id, l.course_id, l.gradebook_column_id, l.run_id
      ORDER BY max(u.username), max(c.name), max(gc.name)`, [start.toISOString(), end.toISOString()]);

  const users = new Map<string, ReportUser>();
  let homeworkUsd = 0, studyGuideUsd = 0;
  for (const row of rows) {
    const cost = Number(row.cost);
    if (row.feature === 'homework') homeworkUsd += cost; else studyGuideUsd += cost;
    const key = row.user_id ?? 'sin-usuario';
    const user = users.get(key) ?? { userId: row.user_id, name: row.user_id ? firstName(row.display_name, row.username) : 'Sin usuario', costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0, courses: [] };
    users.set(key, user);
    user.costUsd += cost; user.inputTokens += Number(row.inp); user.outputTokens += Number(row.outp); user.calls += row.calls;
    let course = user.courses.find((c) => c.courseId === row.course_id);
    if (!course) { course = { courseId: row.course_id, name: row.course_name ? courseTitle(row.course_name) : '(materia eliminada)', costUsd: 0, activities: [] }; user.courses.push(course); }
    course.costUsd += cost;
    course.activities.push({ activityId: row.gradebook_column_id, name: row.activity_name ?? '(actividad eliminada)', feature: row.feature, costUsd: cost, inputTokens: Number(row.inp), outputTokens: Number(row.outp), calls: row.calls, errors: row.errors, models: row.models ?? [] });
  }
  const list = [...users.values()].sort((a, b) => b.costUsd - a.costUsd);
  const partial = now < end;
  const remainingUsd = Math.max(0, options.capUsd - homeworkUsd);
  const capReached = homeworkUsd >= options.capUsd - 0.0001;

  const lines: string[] = [
    `Reporte de uso de IA · ${label}${partial ? ' (parcial: el mes sigue en curso)' : ''}`,
    `Tareas con IA: gastado ${usd(homeworkUsd)} de ${usd(options.capUsd)} (${((homeworkUsd / options.capUsd) * 100).toFixed(1).replace('.', ',')} %). ${capReached ? 'Se alcanzó el tope del mes.' : `Quedan ${usd(remainingUsd)}.`}`,
    `Guías de estudio: gastado ${usd(studyGuideUsd)} (tienen su propio tope).`,
    `Total del mes: ${usd(homeworkUsd + studyGuideUsd)}. El conteo vuelve a cero el primer día del mes siguiente.`,
  ];
  if (list.length === 0) lines.push('', 'No hubo uso de IA este mes.');
  for (const user of list) {
    lines.push('', `${user.name}, gastaste ${usd(user.costUsd)} en tokens este mes (${int(user.inputTokens)} de entrada y ${int(user.outputTokens)} de salida, ${user.calls} ${user.calls === 1 ? 'llamada' : 'llamadas'}).`);
    for (const course of user.courses.sort((a, b) => b.costUsd - a.costUsd)) {
      lines.push(`  • ${course.name}: ${usd(course.costUsd)}`);
      for (const activity of course.activities.sort((a, b) => b.costUsd - a.costUsd)) {
        lines.push(`      – ${activity.name} (${activity.feature === 'homework' ? 'tarea' : 'guía de estudio'}): ${usd(activity.costUsd)} · ${activity.calls} ${activity.calls === 1 ? 'llamada' : 'llamadas'}${activity.errors > 0 ? ` (${activity.errors} con error)` : ''}${activity.models.length ? ` · ${activity.models.join(', ')}` : ''}`);
      }
    }
  }
  return { period: periodOf(start), label, partial, capUsd: options.capUsd, homeworkUsd, studyGuideUsd, remainingUsd, capReached, users: list, message: lines.join('\n') };
}

/** Guarda (o reemplaza, con `force`) el reporte de un mes en ai_usage_log. */
export async function writeMonthlyReport(db: Queryable, start: Date, options: { capUsd: number; force?: boolean; now?: Date }): Promise<MonthlyReport> {
  const report = await buildMonthlyReport(db, start, options);
  const detail = JSON.stringify({ ...report, message: undefined });
  await db.query(
    `INSERT INTO ai_usage_log (event, feature, cost_usd, status, period, message, detail)
     VALUES ('monthly_report', 'report', $2, 'ok', $1::date, $3, $4)
     ON CONFLICT (period) WHERE event = 'monthly_report' DO ${options.force ? 'UPDATE SET message = EXCLUDED.message, detail = EXCLUDED.detail, cost_usd = EXCLUDED.cost_usd, created_at = now()' : 'NOTHING'}`,
    [report.period, report.homeworkUsd + report.studyGuideUsd, report.message, detail]);
  return report;
}

/** Genera el reporte de cada mes ya terminado que tuvo uso de IA y todavía no tiene uno definitivo (un reporte parcial guardado antes se reemplaza). Devuelve los meses generados. */
export async function ensureMonthlyReports(db: Queryable, options: { capUsd: number; now?: Date }): Promise<string[]> {
  const now = options.now ?? new Date();
  const current = periodOf(now);
  const { rows } = await db.query<{ period: string }>(
    `SELECT DISTINCT to_char(l.period, 'YYYY-MM-DD') AS period FROM ai_usage_log l
      WHERE l.event = 'call' AND l.period < $1::date
        AND NOT EXISTS (SELECT 1 FROM ai_usage_log r WHERE r.event = 'monthly_report' AND r.period = l.period AND COALESCE((r.detail->>'partial')::boolean, false) = false)
      ORDER BY 1`, [current]);
  const done: string[] = [];
  for (const row of rows) {
    const start = monthStartFromKey(row.period.slice(0, 7));
    if (start) { await writeMonthlyReport(db, start, { capUsd: options.capUsd, now, force: true }); done.push(row.period.slice(0, 7)); }
  }
  return done;
}

export { monthStart, monthStartFromKey, logAiUsage };
