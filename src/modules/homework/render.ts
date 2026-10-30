// Chromium compartido para las tareas: HTML → PDF y SVG → PNG. Se abre al primer uso y se cierra tras un rato sin uso.
import { resolveChromiumExecutable } from '../blackboard/session-login.js';

interface Page {
  setContent(html: string, options?: object): Promise<void>;
  pdf(options: object): Promise<Buffer>;
  screenshot(options: object): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
}
type Browser = { newPage(): Promise<Page>; close(): Promise<void>; on(event: 'disconnected', fn: () => void): void };

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

export async function closeHomeworkBrowser(): Promise<void> {
  if (idle) clearTimeout(idle);
  const current = browser; browser = null;
  await current?.then((b) => b.close()).catch(() => {});
}

export async function htmlToPdf(html: string, footer: string): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4', printBackground: true, margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 16mm;font-size:8px;color:#8b94a3;font-family:Arial,sans-serif;display:flex;justify-content:space-between"><span>${footer}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/** Convierte un SVG autocontenido (con viewBox) a PNG con fondo blanco. */
export async function svgToPng(svg: string, width = 900): Promise<Buffer> {
  const page = await (await getBrowser()).newPage();
  try {
    await page.setViewportSize({ width, height: 10 });
    await page.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg.replace('<svg ', `<svg width="${width}" `)}</body>`, { waitUntil: 'load' });
    return await page.screenshot({ type: 'png', fullPage: true });
  } finally {
    await page.close().catch(() => {});
  }
}
