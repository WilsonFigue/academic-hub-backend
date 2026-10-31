// Cierre mensual por correo: lo que gastó cada persona en IA durante el mes que terminó (tokens y costo, por materia y actividad),
// cuánto del tope mensual se usó entre todos y el aviso de que el tope vuelve a empezar. Sale el día 1 de cada mes.
import type { Database } from '../../database/connection.js';
import { monthStart } from '../logs/logs.js';
import { buildMonthlyReport } from '../logs/report.js';
import { accent, emailShell, esc, firstName, ink, itemCard, label, line, muted, pill, row, section, td, th } from './email-layout.js';
import type { Mailer } from './mailer.js';
import { sendDigest, type DigestOptions, type RenderedMail, type SendResult } from './summary.js';

const DAY_MS = 86_400_000;
const money = (n: number) => `$${n.toFixed(n > 0 && n < 0.1 ? 4 : 2)}`;
const tokens = (n: number) => n.toLocaleString('es-SV');
const FEATURE = { study_guide: 'Guías de estudio', homework: 'Tareas y foros' } as const;

/** Inicio del mes anterior al de `now` (el mes que se cierra). */
export const closedMonthStart = (now: Date): Date => monthStart(new Date(monthStart(now).getTime() - DAY_MS));

export interface MonthlyData {
  name: string; monthLabel: string; nextMonthLabel: string;
  mine: { cost: number; inTokens: number; outTokens: number; calls: number };
  byFeature: Array<{ feature: 'study_guide' | 'homework'; calls: number; tokens: number; cost: number }>;
  courses: Array<{ name: string; cost: number; items: string[] }>;
  app: { homeworkUsd: number; studyGuideUsd: number; capUsd: number; remainingUsd: number; capReached: boolean };
  before: { label: string; mine: number; total: number };
}

export async function buildMonthly(db: Database, userId: string, name: string, capUsd: number, now = new Date()): Promise<MonthlyData> {
  const start = closedMonthStart(now);
  const [report, earlier] = await Promise.all([buildMonthlyReport(db, start, { capUsd, now }), buildMonthlyReport(db, closedMonthStart(start), { capUsd, now })]);
  const me = report.users.find((u) => u.userId === userId);
  const features = new Map<'study_guide' | 'homework', { calls: number; tokens: number; cost: number }>();
  for (const course of me?.courses ?? []) for (const a of course.activities) {
    const f = features.get(a.feature) ?? { calls: 0, tokens: 0, cost: 0 };
    f.calls += a.calls; f.tokens += a.inputTokens + a.outputTokens; f.cost += a.costUsd; features.set(a.feature, f);
  }
  const nextLabel = new Date(start.getTime() + 40 * DAY_MS).toLocaleDateString('es-SV', { timeZone: 'America/El_Salvador', month: 'long' });
  return {
    name, monthLabel: report.label, nextMonthLabel: nextLabel,
    mine: { cost: me?.costUsd ?? 0, inTokens: me?.inputTokens ?? 0, outTokens: me?.outputTokens ?? 0, calls: me?.calls ?? 0 },
    byFeature: [...features].map(([feature, f]) => ({ feature, ...f })),
    courses: (me?.courses ?? []).sort((a, b) => b.costUsd - a.costUsd).map((c) => ({
      name: c.name, cost: c.costUsd, items: c.activities.sort((a, b) => b.costUsd - a.costUsd).slice(0, 3).map((a) => `${a.name} (${a.feature === 'homework' ? 'tarea' : 'guía'})`),
    })),
    app: { homeworkUsd: report.homeworkUsd, studyGuideUsd: report.studyGuideUsd, capUsd, remainingUsd: report.remainingUsd, capReached: report.capReached },
    before: { label: earlier.label, mine: earlier.users.find((u) => u.userId === userId)?.costUsd ?? 0, total: earlier.homeworkUsd + earlier.studyGuideUsd },
  };
}

export function renderMonthly(data: MonthlyData): RenderedMail {
  const used = data.app.capUsd > 0 ? Math.min(100, Math.round((data.app.homeworkUsd / data.app.capUsd) * 100)) : 0;
  const month = data.monthLabel.split(' ')[0] ?? data.monthLabel;
  const subject = `Cierre de ${month}: tu gasto de IA fue ${money(data.mine.cost)}`;
  const featureRows = data.byFeature.length
    ? data.byFeature.map((f) => `<tr><td style="${td}font-weight:700">${FEATURE[f.feature]}</td><td align="right" style="${td}">${f.calls}</td><td align="right" style="${td}">${tokens(f.tokens)}</td><td align="right" style="${td}font-weight:800">${money(f.cost)}</td></tr>`).join('')
    : `<tr><td colspan="4" style="${td}color:#7a8190">No usaste la IA este mes.</td></tr>`;
  const courses = data.courses.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${data.courses.map((c) => itemCard(c.name, c.items.join(' · '), pill(money(c.cost), 'amber'))).join('')}</table>`
    : '';

  const rows = [
    row(`<p class="body-text" style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:${ink}">Hola, <b>${esc(firstName(data.name))}</b>. Este es el cierre de tu gasto de IA de <b>${esc(data.monthLabel)}</b>.</p>
<div style="${label}">Tu gasto en ${esc(month)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;background:#fff4f0;border:1px solid #ffd9cd;border-radius:14px"><tr><td style="padding:16px 18px">
  <div class="big" style="font-size:36px;font-weight:800;letter-spacing:-.02em;color:${ink};line-height:1.1">${money(data.mine.cost)}</div>
  <div style="font-size:12.5px;color:${muted};margin-top:4px;line-height:1.5">${tokens(data.mine.inTokens + data.mine.outTokens)} tokens (${tokens(data.mine.inTokens)} de entrada · ${tokens(data.mine.outTokens)} de salida) en ${data.mine.calls} ${data.mine.calls === 1 ? 'llamada' : 'llamadas'}</div>
</td></tr></table>`, '20px 20px 0'),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${line};border-radius:12px;border-collapse:separate;overflow:hidden">
<tr><th style="${th}">Función</th><th align="right" style="${th}">Llamadas</th><th align="right" style="${th}">Tokens</th><th align="right" style="${th}">Costo</th></tr>${featureRows}</table>`, '12px 20px 0'),
    ...(courses ? [section('Por materia'), row(courses, '6px 20px 0')] : []),
    section('Tope del mes entre todos'),
    row(`<div style="font-size:12.5px;color:${muted};margin-bottom:6px;line-height:1.5">Tareas con IA: <b style="color:${ink}">${money(data.app.homeworkUsd)}</b> de ${money(data.app.capUsd)} (${used}%) · Guías de estudio: <b style="color:${ink}">${money(data.app.studyGuideUsd)}</b></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${line};border-radius:99px"><tr><td width="${Math.max(used, 3)}%" style="background:${used >= 80 ? '#e5392f' : accent};height:8px;border-radius:99px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font-size:12px;color:#7a8190;margin-top:8px">${data.app.capReached ? 'Se alcanzó el tope del mes.' : `Sobraron ${money(data.app.remainingUsd)}.`} ${esc(data.before.label)}: tuyo ${money(data.before.mine)} · total de la app ${money(data.before.total)}</div>`, '8px 20px 0'),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eefaf2;border:1px solid #c9ecd5;border-radius:12px"><tr><td class="body-text" style="padding:12px 14px;font-size:13px;line-height:1.55;color:#1f5c36">✅ El tope de ${money(data.app.capUsd)} <b>se reinicia hoy</b>: empiezas ${esc(data.nextMonthLabel)} con el cupo completo.</td></tr></table>`, '18px 20px 22px'),
  ].join('\n');

  const html = emailShell({ banner: `Cierre de ${month}`, dateLabel: 'Gasto de IA del mes', rows, footer: 'Cierre mensual automático de Academic Hub.' });
  const text = [
    `Hola, ${data.name}`, `Cierre de ${data.monthLabel} · gasto de IA`, '',
    `Tu gasto: ${money(data.mine.cost)} · ${tokens(data.mine.inTokens + data.mine.outTokens)} tokens · ${data.mine.calls} llamadas`,
    ...data.byFeature.map((f) => `- ${FEATURE[f.feature]}: ${f.calls} llamadas, ${tokens(f.tokens)} tokens, ${money(f.cost)}`),
    ...data.courses.map((c) => `- ${c.name}: ${money(c.cost)}`), '',
    `Tope del mes (todos): tareas ${money(data.app.homeworkUsd)} de ${money(data.app.capUsd)} (${used}%) · guías ${money(data.app.studyGuideUsd)}`,
    `${data.app.capReached ? 'Se alcanzó el tope.' : `Sobraron ${money(data.app.remainingUsd)}.`} El tope se reinicia hoy.`, '',
    'Darte de baja: *|UNSUB|*', '*|LIST:ADDRESS|*',
  ].join('\n');
  return { subject, html, text };
}

/** Manda el cierre del mes anterior a cada usuario activo. Una vez por persona y por mes salvo force. */
export const sendMonthly = (db: Database, mailer: Mailer, options: DigestOptions): Promise<SendResult[]> =>
  sendDigest(db, mailer, 'monthly', async ({ userId, name, now }) => renderMonthly(await buildMonthly(db, userId, name, options.capUsd, now)), options);
