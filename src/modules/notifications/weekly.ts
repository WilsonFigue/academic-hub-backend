// Resumen semanal por correo: el desglose de la última semana (entregas, notas, actividades nuevas, cambios de fecha,
// anuncios) y lo que viene. Sale una vez por persona y por semana; lo dispara quien programe la rutina.
import type { Database } from '../../database/connection.js';
import { createAcademicRepository } from '../academic/academic.repository.js';
import { emailShell, esc, firstName, ink, itemCard, line, muted, pill, row, section } from './email-layout.js';
import { sendDigest, type DigestOptions, type RenderedMail, type SendResult } from './summary.js';
import type { Mailer } from './mailer.js';

const TIME_ZONE = 'America/El_Salvador';
const DAY_MS = 86_400_000;

interface Item { name: string; course: string; detail?: string }
export interface WeeklyData {
  name: string; rangeLabel: string;
  stats: { submitted: number; graded: number; fresh: number; pending: number };
  grades: Array<Item & { result: string; changed: boolean }>;
  submitted: Item[];
  fresh: Array<Item & { due: string }>;
  dueChanges: Array<Item & { due: string }>;
  announcements: Array<{ course: string; title: string }>;
  upcoming: Array<Item & { due: string }>;
}

const shortDay = (date: Date) => date.toLocaleDateString('es-SV', { timeZone: TIME_ZONE, day: 'numeric', month: 'long' });
const dueLabel = (iso: string | Date) => new Date(iso).toLocaleString('es-SV', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const num = (value: unknown) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : String(Math.round(Number(value) * 100) / 100));

export async function buildWeekly(db: Database, userId: string, name: string, now = new Date()): Promise<WeeklyData> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const repo = createAcademicRepository(db);
  const changes = (await repo.changes(userId, { limit: 200 })) as Array<{ kind: string; courseName: string | null; activityId: string | null; detectedAt: Date; after: Record<string, unknown> | null }>;
  const recent = changes.filter((c) => new Date(c.detectedAt) >= since);

  // Datos actuales de las actividades mencionadas en las novedades.
  const activityIds = [...new Set(recent.map((c) => c.activityId).filter((id): id is string => Boolean(id)))];
  const details = new Map<string, { name: string; course: string; points: string | null; score: string | null; due: Date | null }>();
  if (activityIds.length > 0) {
    const { rows } = await db.query<{ id: string; name: string; course: string; points: string | null; score: string | null; due: Date | null }>(
      `SELECT sg.id, gc.name, c.name AS course, gc.points_possible AS points, sg.score, COALESCE(sg.effective_due_at, gc.due_at) AS due
         FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id JOIN courses c ON c.id = sg.course_id WHERE sg.id = ANY($1::uuid[])`, [activityIds]);
    for (const r of rows) details.set(r.id, r);
  }
  const seen = new Set<string>();
  const once = (kind: string, id: string | null) => { const key = `${kind}:${id}`; if (!id || seen.has(key)) return false; seen.add(key); return true; };

  const grades: WeeklyData['grades'] = []; const fresh: WeeklyData['fresh'] = []; const dueChanges: WeeklyData['dueChanges'] = [];
  for (const change of recent) {
    const info = change.activityId ? details.get(change.activityId) : undefined;
    if (change.kind === 'grade_new' || change.kind === 'grade_changed') {
      if (!info || !once('grade', change.activityId)) continue;
      const score = num(info.score); const points = num(info.points);
      grades.push({ name: info.name, course: info.course, result: score === null ? 'Calificada' : `${score}${points ? ` / ${points}` : ''}`, changed: change.kind === 'grade_changed' });
    } else if (change.kind === 'activity_new') {
      if (!info || !once('new', change.activityId)) continue;
      fresh.push({ name: info.name, course: info.course, due: info.due ? dueLabel(info.due) : 'sin fecha' });
    } else if (change.kind === 'due_changed') {
      if (!info || !once('due', change.activityId)) continue;
      dueChanges.push({ name: info.name, course: info.course, due: info.due ? dueLabel(info.due) : 'sin fecha' });
    }
  }
  // Notas calificadas esta semana según el historial de intentos (cubre lo anterior al registro de novedades).
  const graded = await db.query<{ id: string; name: string; course: string; points: string | null; score: string }>(
    `SELECT sg.id, gc.name, c.name AS course, gc.points_possible AS points, sg.score
       FROM student_grades sg
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id AND ce.status = 'active'
       JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.user_id = $1 AND ea.link_status <> 'revoked'
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id AND NOT gc.is_calculated AND gc.removed_at_source IS NULL
       JOIN courses c ON c.id = sg.course_id
      WHERE sg.score IS NOT NULL AND sg.is_visible_to_student
        AND (SELECT max(a.last_graded_at) FROM grade_attempts a WHERE a.student_grade_id = sg.id) >= $2::timestamptz
      ORDER BY 2 LIMIT 20`, [userId, since.toISOString()]);
  for (const g of graded.rows) {
    if (!once('grade', g.id)) continue;
    grades.push({ name: g.name, course: g.course, result: `${num(g.score)}${num(g.points) ? ` / ${num(g.points)}` : ''}`, changed: false });
  }
  const announcements = recent.filter((c) => c.kind === 'announcement_new').slice(0, 6).map((c) => ({ course: c.courseName ?? 'Materia', title: typeof c.after?.title === 'string' ? c.after.title : 'Anuncio nuevo' }));

  const submittedRows = await db.query<{ name: string; course: string }>(
    `SELECT gc.name, c.name AS course
       FROM grade_attempts a
       JOIN student_grades sg ON sg.id = a.student_grade_id
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id AND ce.status = 'active'
       JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.user_id = $1 AND ea.link_status <> 'revoked'
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
       JOIN courses c ON c.id = sg.course_id
      WHERE a.submitted_at >= $2::timestamptz AND a.status <> 'IN_PROGRESS' AND NOT gc.is_calculated
      GROUP BY gc.name, c.name ORDER BY max(a.submitted_at) DESC LIMIT 10`, [userId, since.toISOString()]);

  const pending = (await repo.activities(userId, { status: 'pending' })).filter((a) => a.countsInGrade !== false);
  const horizon = now.getTime() + 7 * DAY_MS;
  const upcoming = pending.filter((a) => a.dueAt && new Date(a.dueAt as string).getTime() <= horizon).slice(0, 10)
    .map((a) => ({ name: String(a.name), course: String(a.courseName), due: dueLabel(a.dueAt as string) }));

  return {
    name, rangeLabel: `${shortDay(since)} – ${shortDay(now)}`,
    stats: { submitted: submittedRows.rows.length, graded: grades.length, fresh: fresh.length, pending: pending.length },
    grades, submitted: submittedRows.rows, fresh, dueChanges, announcements, upcoming,
  };
}

export function renderWeekly(data: WeeklyData): RenderedMail {
  const subject = `Tu semana en Academic Hub · ${data.rangeLabel}`;
  const note = (text: string) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${line};border-radius:12px"><tr><td style="padding:12px 14px;font-size:13px;color:#7a8190">${esc(text)}</td></tr></table>`, '6px 20px 0');
  const list = (items: string[], empty: string) => (items.length ? row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.join('')}</table>`, '6px 20px 0') : note(empty));
  const tile = (value: number, labelText: string, color: string) => `<td align="center" width="25%" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f6;border:1px solid ${line};border-radius:14px"><tr><td align="center" style="padding:12px 4px"><div style="font-size:26px;font-weight:800;line-height:1.1;color:${color}">${value}</div><div style="font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#7a8190;margin-top:3px">${esc(labelText)}</div></td></tr></table></td>`;

  const rows = [
    row(`<p class="body-text" style="margin:0;font-size:13.5px;line-height:1.6;color:${ink}">Hola, <b>${esc(firstName(data.name))}</b>. Este es el desglose de tu semana en clases.</p>`, '20px 20px 0'),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px;width:calc(100% + 8px)"><tr>${tile(data.stats.submitted, 'Entregadas', '#24509e')}${tile(data.stats.graded, 'Calificadas', '#1f6b43')}${tile(data.stats.fresh, 'Nuevas', '#c2401f')}${tile(data.stats.pending, 'Pendientes', ink)}</tr></table>`, '16px 20px 0'),
    section('Notas de la semana'),
    list(data.grades.map((g) => itemCard(g.name, g.course, pill(g.changed ? `${g.result} · cambió` : g.result, g.changed ? 'amber' : 'green'))), 'Esta semana no salió ninguna nota nueva.'),
    section('Lo que entregaste'),
    list(data.submitted.map((s) => itemCard(s.name, s.course, pill('Entregada', 'blue'))), 'No registraste entregas esta semana.'),
    ...(data.fresh.length ? [section('Actividades nuevas'), list(data.fresh.map((f) => itemCard(f.name, f.course, pill(`Vence ${f.due}`, 'amber'))), '')] : []),
    ...(data.dueChanges.length ? [section('Cambios de fecha'), list(data.dueChanges.map((d) => itemCard(d.name, d.course, pill(`Ahora ${d.due}`, 'red'))), '')] : []),
    ...(data.announcements.length ? [section('Anuncios de tus docentes'), list(data.announcements.map((a) => itemCard(a.title, a.course, pill('Anuncio', 'gray'))), '')] : []),
    section('Lo que viene · próximos 7 días'),
    list(data.upcoming.map((u) => itemCard(u.name, u.course, pill(u.due, 'amber'))), 'No tienes entregas pendientes en los próximos 7 días.'),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #eeeeee;border-radius:12px"><tr><td class="body-text" style="padding:12px 14px;font-size:13px;line-height:1.55;color:${muted}">${data.stats.pending > 0 ? `En total tienes <b>${data.stats.pending}</b> ${data.stats.pending === 1 ? 'actividad pendiente' : 'actividades pendientes'}.` : 'No tienes actividades pendientes. ¡Buen trabajo!'}</td></tr></table>`, '18px 20px 22px'),
  ].join('\n');

  const html = emailShell({ banner: 'Tu semana en Academic Hub', dateLabel: data.rangeLabel, rows, footer: 'Resumen semanal automático de Academic Hub.' });
  const text = [
    `Hola, ${data.name}`, `Tu semana · ${data.rangeLabel}`, '',
    `Entregadas: ${data.stats.submitted} · Calificadas: ${data.stats.graded} · Nuevas: ${data.stats.fresh} · Pendientes: ${data.stats.pending}`, '',
    'NOTAS', ...(data.grades.length ? data.grades.map((g) => `- ${g.name} (${g.course}): ${g.result}`) : ['- Ninguna esta semana.']), '',
    'ENTREGADAS', ...(data.submitted.length ? data.submitted.map((s) => `- ${s.name} (${s.course})`) : ['- Ninguna.']), '',
    ...(data.fresh.length ? ['NUEVAS', ...data.fresh.map((f) => `- ${f.name} (${f.course}) · vence ${f.due}`), ''] : []),
    ...(data.dueChanges.length ? ['CAMBIOS DE FECHA', ...data.dueChanges.map((d) => `- ${d.name} (${d.course}) · ahora ${d.due}`), ''] : []),
    ...(data.announcements.length ? ['ANUNCIOS', ...data.announcements.map((a) => `- ${a.title} (${a.course})`), ''] : []),
    'LO QUE VIENE · 7 DÍAS', ...(data.upcoming.length ? data.upcoming.map((u) => `- ${u.name} (${u.course}) · ${u.due}`) : ['- Nada pendiente.']), '',
    'Darte de baja: *|UNSUB|*', '*|LIST:ADDRESS|*',
  ].join('\n');
  return { subject, html, text };
}

/** Manda el resumen semanal a cada usuario activo (o solo a uno). Una vez por persona y por semana salvo force. */
export const sendWeekly = (db: Database, mailer: Mailer, options: DigestOptions): Promise<SendResult[]> =>
  sendDigest(db, mailer, 'weekly', async ({ userId, name, now }) => renderWeekly(await buildWeekly(db, userId, name, now)), options);
