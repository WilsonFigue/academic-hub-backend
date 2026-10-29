// PDF de una guía de estudio: se arma desde el texto guardado en la base de datos (la fuente de verdad) y se imprime con Chromium.
// Todo el texto se escapa antes de entrar a la plantilla: nada de lo que genera la IA se interpreta como HTML.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveChromiumExecutable } from '../blackboard/session-login.js';
import type { GuideContent } from './guides.js';

export interface GuidePdfInput {
  title: string;
  course: string;
  dueAt: string | null;
  points: number | null;
  content: GuideContent;
  /** Dirección de la guía en la web (para los enlaces del PDF). */
  webUrl: string;
  /** La actividad pide GeoGebra: el PDF no puede llevarlo funcionando, así que dirige a la guía en la web. */
  wantsGeoGebra: boolean;
  generatedAt: string | null;
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const paragraphs = (value: string) => value.split(/\n{1,}/).map((line) => line.trim()).filter(Boolean).map((line) => `<p>${esc(line)}</p>`).join('');
const stepNumber = /^\s*\d+[.)]\s*/;
const isChecklist = (heading: string) => /antes de entregar|lista de verificaci/i.test(heading);
const isMissing = (heading: string) => /no cubre|no cubren/i.test(heading);
const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-SV', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/El_Salvador' }) : null);

const CSS = `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #141a24; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hero { padding: 20px 24px; border-radius: 16px; background: #fff1ec; border-left: 6px solid #ff5a36; }
  .kicker { margin: 0 0 6px; font-size: 8.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #c2410c; }
  h1 { margin: 0; font-size: 22pt; line-height: 1.12; letter-spacing: -.02em; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .meta span { padding: 3px 10px; border-radius: 999px; background: #fff; font-size: 8.5pt; font-weight: 600; color: #5b6472; }
  .summary { margin: 16px 0 6px; padding: 14px 18px; border-radius: 14px; background: #ff5a36; color: #fff; font-size: 11.5pt; font-weight: 600; line-height: 1.5; }
  section { margin-top: 16px; break-inside: avoid-page; }
  h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; font-size: 14pt; letter-spacing: -.01em; }
  h2 .n { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 8px; background: #ffe3da; color: #c2410c; font-size: 10pt; font-weight: 800; }
  section.missing { padding: 12px 16px; border-radius: 12px; background: #fff7e6; border: 1px solid #f5d9a4; }
  section.missing h2 .n { background: #fde7b0; color: #92400e; }
  p { margin: 0 0 6px; }
  ul.bullets, ul.checks, ul.sources, ol.steps { margin: 6px 0 0; padding: 0; list-style: none; }
  ul.bullets li { position: relative; margin-bottom: 4px; padding: 6px 10px 6px 26px; border-radius: 10px; background: #f4f2ec; break-inside: avoid; }
  ul.bullets li::before { content: ''; position: absolute; top: 12px; left: 11px; width: 6px; height: 6px; border-radius: 50%; background: #ff5a36; }
  ol.steps { counter-reset: step; }
  ol.steps li { position: relative; margin-bottom: 5px; padding: 8px 12px 8px 42px; border-radius: 10px; background: #f4f2ec; counter-increment: step; break-inside: avoid; }
  ol.steps li::before { content: counter(step); position: absolute; top: 7px; left: 10px; width: 22px; height: 22px; border-radius: 7px; background: #ff5a36; color: #fff; text-align: center; font-size: 9.5pt; font-weight: 800; line-height: 22px; }
  ul.checks li { display: flex; gap: 10px; margin-bottom: 4px; padding: 6px 10px; border-radius: 10px; background: #f4f2ec; break-inside: avoid; }
  ul.checks li::before { content: ''; flex: none; width: 13px; height: 13px; margin-top: 3px; border-radius: 4px; border: 1.6px solid #8b94a3; background: #fff; }
  ul.sources li { margin-bottom: 4px; padding: 6px 10px; border-radius: 10px; background: #f4f2ec; break-inside: avoid; }
  ul.sources small { display: block; color: #5b6472; }
  .geo { margin-top: 16px; padding: 12px 16px; border-radius: 12px; background: #eef6ff; border: 1px solid #cfe3fb; break-inside: avoid; }
  .geo b { color: #1d4ed8; }
  .geo a { color: #1d4ed8; word-break: break-all; }
  .foot { margin-top: 20px; font-size: 8.5pt; color: #5b6472; }
`;

export function renderGuideHtml(input: GuidePdfInput): string {
  const { content } = input;
  const due = dateText(input.dueAt);
  const generated = dateText(input.generatedAt);
  const sections = content.sections.map((section, index) => {
    const bullets = section.bullets ?? [];
    const numbered = bullets.length > 0 && bullets.every((bullet) => stepNumber.test(bullet));
    const list = bullets.length === 0 ? ''
      : isChecklist(section.heading) ? `<ul class="checks">${bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul>`
        : numbered ? `<ol class="steps">${bullets.map((bullet) => `<li>${esc(bullet.replace(stepNumber, ''))}</li>`).join('')}</ol>`
          : `<ul class="bullets">${bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul>`;
    return `<section class="${isMissing(section.heading) ? 'missing' : ''}"><h2><span class="n">${index + 1}</span>${esc(section.heading)}</h2>${paragraphs(section.body)}${list}</section>`;
  }).join('');
  const sources = content.sources.length === 0 ? '' : `<section><h2><span class="n">★</span>Fuentes</h2><ul class="sources">${content.sources.map((source) => `<li><b>${esc(source.file)}</b>${source.note ? `<small>${esc(source.note)}</small>` : ''}</li>`).join('')}</ul></section>`;
  const geo = input.wantsGeoGebra
    ? `<div class="geo"><b>GeoGebra.</b> Esta actividad pide usar GeoGebra. En el PDF no funciona de forma interactiva: ábrelo desde la guía en la web, donde puedes graficar y descargar tu archivo .ggb.<br><a href="${esc(input.webUrl)}">${esc(input.webUrl)}</a></div>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Guía de estudio · ${esc(input.title)}</title><style>${CSS}</style></head><body>
    <header class="hero"><p class="kicker">Guía de estudio · ${esc(input.course)}</p><h1>${esc(input.title)}</h1>
      <div class="meta">${due ? `<span>Entrega ${esc(due)}</span>` : ''}${input.points !== null ? `<span>${input.points} puntos</span>` : ''}<span>${content.sources.length} ${content.sources.length === 1 ? 'fuente' : 'fuentes'}</span><span>Generada con IA${generated ? ` · ${esc(generated)}` : ''}</span></div></header>
    <p class="summary">${esc(content.summary)}</p>${sections}${geo}${sources}
    <p class="foot">Esta guía la generó una IA a partir del material de tu materia. Revísala con tus apuntes y las instrucciones de tu docente: ayuda a entender la actividad, no la reemplaza.</p>
  </body></html>`;
}

// ── Chromium compartido: se abre al primer PDF y se cierra tras un rato sin uso ──
type Browser = { newPage(): Promise<{ setContent(html: string, options?: object): Promise<void>; pdf(options: object): Promise<Buffer>; close(): Promise<void> }>; close(): Promise<void> };
let browser: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | null = null;
const IDLE_MS = 60_000;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = (async () => {
      const { chromium } = await import('playwright');
      const executablePath = resolveChromiumExecutable(chromium);
      const launched = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      launched.on('disconnected', () => { browser = null; });
      return launched as unknown as Browser;
    })().catch((error) => { browser = null; throw error; });
  }
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { const current = browser; browser = null; void current?.then((b) => b.close()).catch(() => {}); }, IDLE_MS);
  idle.unref();
  return browser;
}

export async function closePdfBrowser(): Promise<void> {
  if (idle) clearTimeout(idle);
  const current = browser; browser = null;
  await current?.then((b) => b.close()).catch(() => {});
}

export async function renderGuidePdf(input: GuidePdfInput): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(renderGuideHtml(input), { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4', printBackground: true, margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;padding:0 16mm;font-size:8px;color:#8b94a3;font-family:Arial,sans-serif;display:flex;justify-content:space-between"><span>Academic Hub · Guía de estudio</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
  } finally {
    await page.close().catch(() => {});
  }
}

const PDF_DIR = join(process.cwd(), '.state', 'guides');
/** PDF en caché: cambia solo cuando cambia el contenido de la guía. */
export async function guidePdf(guideId: string, input: GuidePdfInput): Promise<string> {
  mkdirSync(PDF_DIR, { recursive: true });
  const hash = createHash('sha1').update(JSON.stringify([input.title, input.course, input.dueAt, input.points, input.content, input.wantsGeoGebra, input.webUrl])).digest('hex').slice(0, 12);
  const target = join(PDF_DIR, `${guideId}-${hash}.pdf`);
  if (existsSync(target)) return target;
  writeFileSync(target, await renderGuidePdf(input), { mode: 0o600 });
  return target;
}
export const readPdf = (path: string) => readFileSync(path);
