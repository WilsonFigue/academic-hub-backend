// Resumen consolidado por correo: gasto de IA del mes (tokens y costo), lo que viene en 7 días y avisos sin leer.
// No es una notificación por evento: es un solo correo por persona y por día, que dispara quien programe la rutina.
import type { Database } from '../../database/connection.js';
import { createAcademicRepository } from '../academic/academic.repository.js';
import { monthStart, nextMonthStart } from '../logs/logs.js';
import { MailError, type Mailer } from './mailer.js';
import { accent, emailShell, esc, firstName, ink, label, line, muted, td, th } from './email-layout.js';
import { unreadCount } from './notifications.js';

const TIME_ZONE = 'America/El_Salvador';
const DAY_MS = 86_400_000;
const FEATURE_LABEL: Record<string, string> = { study_guide: 'Guías de estudio', homework: 'Tareas y foros' };

interface Usage { calls: number; inTokens: number; outTokens: number; cost: number }
export interface SummaryData {
  name: string; dateLabel: string;
  ai: { monthLabel: string; mine: Usage; byFeature: Array<Usage & { feature: string }>; total: Usage; capUsd: number; previous: { monthLabel: string; mine: number; total: number } };
  upcoming: Array<{ name: string; course: string; due: string }>;
  unread: number;
}
export interface RenderedMail { subject: string; html: string; text: string }

const empty = (): Usage => ({ calls: 0, inTokens: 0, outTokens: 0, cost: 0 });
const add = (a: Usage, b: Usage): Usage => ({ calls: a.calls + b.calls, inTokens: a.inTokens + b.inTokens, outTokens: a.outTokens + b.outTokens, cost: a.cost + b.cost });
const money = (n: number) => `$${n.toFixed(n > 0 && n < 0.1 ? 4 : 2)}`;
const tokens = (n: number) => n.toLocaleString('es-SV');
const localDay = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
const monthLabelOf = (start: Date) => new Date(start.getTime() + DAY_MS).toLocaleDateString('es-SV', { timeZone: TIME_ZONE, month: 'long', year: 'numeric' });

/** Uso de IA de un mes: el del usuario por función y el total de la app. */
async function usageOf(db: Database, userId: string, start: Date) {
  const { rows } = await db.query<{ feature: string; mine: boolean; calls: number; in_t: string; out_t: string; cost: string }>(
    `SELECT l.feature, (l.user_id = $1 OR l.enrollment_id IN (SELECT ce.id FROM course_enrollments ce JOIN external_accounts ea ON ea.id = ce.external_account_id WHERE ea.user_id = $1)) AS mine,
            count(*)::int AS calls, COALESCE(sum(l.input_tokens), 0)::bigint AS in_t, COALESCE(sum(l.output_tokens), 0)::bigint AS out_t, COALESCE(sum(l.cost_usd), 0) AS cost
       FROM ai_usage_log l
      WHERE l.event = 'call' AND l.feature IN ('homework', 'study_guide') AND l.created_at >= $2::timestamptz AND l.created_at < $3::timestamptz
      GROUP BY l.feature, 2`,
    [userId, start.toISOString(), nextMonthStart(start).toISOString()]);
  let mine = empty(); let total = empty();
  const byFeature = new Map<string, Usage>();
  for (const row of rows) {
    const usage: Usage = { calls: row.calls, inTokens: Number(row.in_t), outTokens: Number(row.out_t), cost: Number(row.cost) };
    total = add(total, usage);
    if (row.mine) { mine = add(mine, usage); byFeature.set(row.feature, add(byFeature.get(row.feature) ?? empty(), usage)); }
  }
  return { mine, total, byFeature: [...byFeature].map(([feature, usage]) => ({ feature, ...usage })) };
}

export async function buildSummary(db: Database, userId: string, name: string, capUsd: number, now = new Date()): Promise<SummaryData> {
  const start = monthStart(now);
  const previousStart = monthStart(new Date(start.getTime() - DAY_MS));
  const [current, previous] = await Promise.all([usageOf(db, userId, start), usageOf(db, userId, previousStart)]);
  const pending = await createAcademicRepository(db).activities(userId, { status: 'pending', from: now, to: new Date(now.getTime() + 7 * DAY_MS) });
  const upcoming = pending.filter((a) => a.countsInGrade !== false && a.dueAt).slice(0, 8).map((a) => ({
    name: String(a.name), course: String(a.courseName),
    due: new Date(a.dueAt as string).toLocaleString('es-SV', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }),
  }));
  return {
    name, dateLabel: now.toLocaleDateString('es-SV', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' }),
    ai: { monthLabel: monthLabelOf(start), mine: current.mine, byFeature: current.byFeature, total: current.total, capUsd,
      previous: { monthLabel: monthLabelOf(previousStart), mine: previous.mine.cost, total: previous.total.cost } },
    upcoming, unread: await unreadCount(db, userId),
  };
}

export function renderSummary(data: SummaryData): RenderedMail {
  const { ai } = data;
  const used = ai.capUsd > 0 ? Math.min(100, Math.round((ai.total.cost / ai.capUsd) * 100)) : 0;
  const subject = `Tu resumen del ${data.dateLabel} · IA de ${ai.monthLabel.split(' ')[0]}: ${money(ai.mine.cost)}`;

  const featureRows = ai.byFeature.length
    ? ai.byFeature.map((f) => `<tr><td style="${td}font-weight:700">${esc(FEATURE_LABEL[f.feature] ?? f.feature)}</td><td align="right" style="${td}">${f.calls}</td><td align="right" style="${td}">${tokens(f.inTokens + f.outTokens)}</td><td align="right" style="${td}font-weight:800">${money(f.cost)}</td></tr>`).join('')
    : `<tr><td colspan="4" style="${td}color:#7a8190">Este mes todavía no usaste la IA.</td></tr>`;
  const upcomingHtml = data.upcoming.length
    ? data.upcoming.map((u) => `<tr><td style="padding:6px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${line};border-radius:12px"><tr>
<td style="padding:11px 14px;font-size:13.5px;line-height:1.35;color:${ink}"><b>${esc(u.name)}</b><br><span style="font-size:12px;color:#7a8190">${esc(u.course)}</span></td>
<td align="right" valign="middle" style="padding:11px 14px 11px 0;white-space:nowrap"><span style="display:inline-block;padding:4px 10px;border-radius:99px;background:#fff1cc;border:1px solid #f4dca5;color:#8a5a00;font-size:11px;font-weight:800">${esc(u.due)}</span></td></tr></table></td></tr>`).join('')
    : `<tr><td style="padding:12px 14px;border:1px solid ${line};border-radius:12px;font-size:13px;color:#7a8190">No tienes entregas pendientes en los próximos 7 días.</td></tr>`;
  const unreadText = data.unread > 0 ? `Tienes <b>${data.unread}</b> ${data.unread === 1 ? 'aviso sin leer' : 'avisos sin leer'} en la campana de Academic Hub.` : 'No tienes avisos sin leer en Academic Hub.';

  const html = emailShell({ banner: 'Tu resumen diario', dateLabel: data.dateLabel, rows: `    <tr><td class="pad" style="padding:20px 20px 4px">
      <p class="body-text" style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:${ink}">Hola, <b>${esc(firstName(data.name))}</b>. Esto es lo que pasó con la IA este mes y lo que viene en tus clases.</p>
      <div style="${label}">Gasto de IA · ${esc(ai.monthLabel)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;background:#fff4f0;border:1px solid #ffd9cd;border-radius:14px"><tr><td style="padding:16px 18px">
        <div class="big" style="font-size:36px;font-weight:800;letter-spacing:-.02em;color:${ink};line-height:1.1">${money(ai.mine.cost)}</div>
        <div style="font-size:12.5px;color:${muted};margin-top:4px;line-height:1.5">${tokens(ai.mine.inTokens + ai.mine.outTokens)} tokens (${tokens(ai.mine.inTokens)} de entrada · ${tokens(ai.mine.outTokens)} de salida) en ${ai.mine.calls} ${ai.mine.calls === 1 ? 'llamada' : 'llamadas'}</div>
      </td></tr></table>
    </td></tr>

    <tr><td class="pad" style="padding:12px 20px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${line};border-radius:12px;border-collapse:separate;overflow:hidden">
        <tr><th style="${th}">Función</th><th align="right" style="${th}">Llamadas</th><th align="right" style="${th}">Tokens</th><th align="right" style="${th}">Costo</th></tr>${featureRows}
      </table>
    </td></tr>

    <tr><td class="pad" style="padding:14px 20px 0">
      <div style="font-size:12.5px;color:${muted};margin-bottom:6px;line-height:1.5">Total de la app este mes: <b style="color:${ink}">${money(ai.total.cost)}</b> de ${money(ai.capUsd)} de tope (${used}%)</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${line};border-radius:99px"><tr><td width="${Math.max(used, 3)}%" style="background:${used >= 80 ? '#e5392f' : accent};height:8px;border-radius:99px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr></table>
      <div style="font-size:12px;color:#7a8190;margin-top:8px">${esc(ai.previous.monthLabel)}: tuyo ${money(ai.previous.mine)} · total de la app ${money(ai.previous.total)}</div>
    </td></tr>

    <tr><td class="pad" style="padding:24px 20px 0"><div style="${label}">Lo que viene · próximos 7 días</div></td></tr>
    <tr><td class="pad" style="padding:6px 20px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${upcomingHtml}</table></td></tr>

    <tr><td class="pad" style="padding:18px 20px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #eeeeee;border-radius:12px"><tr><td class="body-text" style="padding:12px 14px;font-size:13px;line-height:1.55;color:${muted}">${unreadText}</td></tr></table></td></tr>` });
  const text = [
    `Hola, ${data.name}`, data.dateLabel, '',
    `GASTO DE IA · ${ai.monthLabel}`, `${money(ai.mine.cost)} · ${tokens(ai.mine.inTokens + ai.mine.outTokens)} tokens · ${ai.mine.calls} llamadas`,
    ...ai.byFeature.map((f) => `- ${FEATURE_LABEL[f.feature] ?? f.feature}: ${f.calls} llamadas, ${tokens(f.inTokens + f.outTokens)} tokens, ${money(f.cost)}`),
    `Total de la app: ${money(ai.total.cost)} de ${money(ai.capUsd)} (${used}%)`, `${ai.previous.monthLabel}: tuyo ${money(ai.previous.mine)} · total ${money(ai.previous.total)}`, '',
    'LO QUE VIENE · 7 DÍAS', ...(data.upcoming.length ? data.upcoming.map((u) => `- ${u.name} (${u.course}) · ${u.due}`) : ['- Nada pendiente.']), '',
    data.unread > 0 ? `Avisos sin leer: ${data.unread}` : 'Sin avisos sin leer.', '', 'Darte de baja: *|UNSUB|*', '*|LIST:ADDRESS|*',
  ].join('\n');
  return { subject, html, text };
}

export interface SendResult { username: string | null; to: string | null; status: 'sent' | 'dry_run' | 'already_sent' | 'no_email' | 'failed'; code?: string; message?: string; subject?: string; html?: string }

/**
 * Manda el resumen del día a cada usuario activo (o solo a uno). Una vez por persona y por día salvo force.
 * El destino es su correo personal; si no lo tiene, el institucional de su cuenta.
 */
export interface DigestOptions { capUsd: number; userId?: string; dryRun?: boolean; force?: boolean; now?: Date; reviewTo?: string }
export type DigestKind = 'summary' | 'weekly';

/** Semana ISO (lunes a domingo) de un día, como "2026-W44": una llave por semana para no repetir el semanal. */
export function isoWeekKey(date: Date): string {
  const [y, m, d] = localDay(date).split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7)).padStart(2, '0')}`;
}

export const sendSummaries = (db: Database, mailer: Mailer, options: DigestOptions) =>
  sendDigest(db, mailer, 'summary', async ({ userId, name, now }) => renderSummary(await buildSummary(db, userId, name, options.capUsd, now)), options);

/** Envío común de los correos consolidados: destino, una vez por periodo, prueba, revisión y registro. */
export async function sendDigest(db: Database, mailer: Mailer, kind: DigestKind, build: (who: { userId: string; name: string; now: Date }) => Promise<RenderedMail>, options: DigestOptions): Promise<SendResult[]> {
  const now = options.now ?? new Date();
  const periodKey = kind === 'weekly' ? isoWeekKey(now) : localDay(now);
  const { rows: people } = await db.query<{ id: string; username: string | null; display_name: string | null; email: string | null }>(
    `SELECT u.id, u.username, u.display_name,
            COALESCE(u.contact_email, (SELECT ea.institutional_email FROM external_accounts ea WHERE ea.user_id = u.id AND ea.link_status <> 'revoked' AND ea.institutional_email IS NOT NULL ORDER BY ea.created_at LIMIT 1)) AS email
       FROM users u WHERE u.status = 'active' AND ($1::uuid IS NULL OR u.id = $1::uuid) ORDER BY u.created_at`, [options.userId ?? null]);
  const results: SendResult[] = [];
  for (const person of people) {
    const base = { username: person.username, to: person.email };
    if (!person.email) { results.push({ ...base, status: 'no_email' }); continue; }
    if (!options.dryRun && !options.force && !options.reviewTo) {
      const sent = await db.query(`SELECT 1 FROM email_summaries WHERE user_id = $1 AND kind = $3 AND period_key = $2 AND status = 'sent'`, [person.id, periodKey, kind]);
      if (sent.rows.length > 0) { results.push({ ...base, status: 'already_sent' }); continue; }
    }
    const name = person.display_name ?? person.username ?? 'estudiante';
    const mail = await build({ userId: person.id, name, now });
    if (options.dryRun) { results.push({ ...base, status: 'dry_run', subject: mail.subject, html: mail.html }); continue; }
    // Revisión: el correo de cada persona se manda a otra dirección, marcado como prueba y sin quedar registrado como enviado.
    if (options.reviewTo) {
      const subject = `[Prueba · ${name}] ${mail.subject}`;
      try {
        await mailer.send({ to: options.reviewTo, toName: name, subject, html: mail.html, text: mail.text });
        results.push({ username: person.username, to: options.reviewTo, status: 'sent', subject });
      } catch (error) {
        results.push({ username: person.username, to: options.reviewTo, status: 'failed', code: error instanceof MailError ? error.code : 'mail_failed', message: error instanceof MailError ? error.message : undefined, subject });
      }
      continue;
    }
    let outcome: { status: 'sent' | 'failed'; code: string | null; ref: string | null; message?: string };
    try {
      const { ref } = await mailer.send({ to: person.email, toName: name, subject: mail.subject, html: mail.html, text: mail.text });
      outcome = { status: 'sent', code: null, ref };
    } catch (error) {
      const code = error instanceof MailError ? error.code : 'mail_failed';
      outcome = { status: 'failed', code, ref: null, message: error instanceof MailError ? error.message : undefined };
    }
    await db.query(
      `INSERT INTO email_summaries (user_id, kind, period_key, to_email, subject, status, error_code, provider_ref) VALUES ($1, $8, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, kind, period_key) DO UPDATE SET to_email = EXCLUDED.to_email, subject = EXCLUDED.subject, status = EXCLUDED.status, error_code = EXCLUDED.error_code, provider_ref = EXCLUDED.provider_ref, created_at = now()`,
      [person.id, periodKey, person.email, mail.subject, outcome.status, outcome.code, outcome.ref, kind]);
    results.push({ ...base, status: outcome.status, ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.message ? { message: outcome.message } : {}), subject: mail.subject });
  }
  return results;
}
