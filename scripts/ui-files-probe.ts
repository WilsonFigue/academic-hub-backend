// Contra la DEMO (5174): visor de archivos — Word, PowerPoint, Excel, PDF, imagen, video, documento, marcas de lectura y guías de la actividad.
// Requiere: DB_SCHEMA=academic_hub_demo npx tsx scripts/demo-files.ts
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const BASE = 'http://localhost:5174';
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];

for (const [label, width, height] of [['1440', 1440, 900], ['1894x645', 1894, 645], ['768', 768, 900], ['390', 390, 800]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.route('**/youtube-nocookie.com/**', (route) => route.abort()); // la prueba no sale a internet
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${BASE}/courses`, { waitUntil: 'networkidle' });
  await page.locator('a[href^="/courses/"]', { hasText: /Cálculo/i }).first().click();
  await page.waitForURL(/\/courses\/[^/]+$/);
  await page.getByRole('tab', { name: /Contenido/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /Semana 9/ }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, `${label}-content.png`), fullPage: true });
  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('contenido');

  const dialog = page.getByRole('dialog').last();
  const open = async (title: RegExp) => { await page.getByRole('button', { name: title }).first().click(); await dialog.waitFor({ timeout: 8000 }); await page.waitForTimeout(900); };
  const close = async () => { await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 4000 }).catch(() => problems.push(`${label}: el visor no se cierra con Escape`)); };
  const expectText = async (text: string | RegExp, what: string) => { if (!(await dialog.getByText(text).first().isVisible().catch(() => false))) problems.push(`${label}: ${what} no muestra "${text}"`); };

  // Word
  await open(/Guía de actividad Quiz semana 9/);
  // Tal cual: el documento se muestra como PDF convertido con Office (si este equipo lo tiene).
  await dialog.locator('iframe[src*="/render"]').waitFor({ timeout: 20000 }).catch(() => problems.push(label + ': el Word no ofrece la vista tal cual'));
  const src = await dialog.locator('iframe[src*="/render"]').getAttribute('src').catch(() => null);
  if (src) {
    const res = await page.request.get(BASE + src, { timeout: 120000 });
    if (res.status() !== 200 || !(res.headers()['content-type'] ?? '').includes('application/pdf') || (await res.body()).subarray(0, 5).toString() !== '%PDF-') problems.push(label + ': /render no devolvió un PDF (' + res.status() + ')');
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, label + '-docx-tal-cual.png') });
  await dialog.getByRole('tab', { name: /Texto y búsqueda/ }).click(); await page.waitForTimeout(500);
  await expectText('Procedimiento correcto', 'la guía (Word)');
  await expectText(/Marcar como leído/, 'la barra de lectura');
  await page.screenshot({ path: join(out, `${label}-docx.png`) });
  await overflow('visor Word');
  await close();
  // PowerPoint (marcada y enviada)
  await open(/Presentación: Series de potencias/);
  // El PowerPoint de la demo es un paquete mínimo que PowerPoint no abre: debe caer a la vista de texto con su aviso.
  await dialog.getByText('Radio de convergencia').first().waitFor({ timeout: 45000 }).catch(() => {});
  await expectText('Radio de convergencia', 'las diapositivas');
  await expectText('Enviado a UTEC', 'la marca enviada');
  await page.screenshot({ path: join(out, `${label}-pptx.png`) });
  await close();
  // Excel (marca pendiente → quitar → volver a marcar)
  await open(/Ejercicios y puntajes/);
  await dialog.getByRole('tab', { name: /Texto y búsqueda/ }).click({ timeout: 20000 }).catch(() => {}); await page.waitForTimeout(500);
  await expectText('Series geométricas', 'la hoja de cálculo');
  await dialog.getByRole('tab', { name: 'Resumen' }).click();
  await expectText('12', 'la segunda hoja');
  await expectText(/Marcado · aún no llegó a UTEC/, 'la marca pendiente');
  await dialog.getByRole('button', { name: 'Quitar' }).click(); await page.waitForTimeout(900);
  await expectText('Marcar como leído', 'la marca quitada');
  await dialog.getByRole('button', { name: 'Marcar como leído' }).click(); await page.waitForTimeout(900);
  await expectText(/Marcado · aún no llegó a UTEC/, 'la marca vuelta a poner');
  await page.screenshot({ path: join(out, `${label}-xlsx.png`) });
  await close();
  // PDF (completado en UTEC): documento + texto con búsqueda
  await open(/Resumen de la semana \(PDF\)/);
  await expectText('Completado en UTEC', 'el estado de UTEC');
  if (!(await dialog.locator('iframe').count())) problems.push(`${label}: el PDF no muestra su marco`);
  await dialog.getByRole('tab', { name: /Texto y búsqueda/ }).click(); await page.waitForTimeout(900);
  await expectText(/criterio del cociente/i, 'el texto del PDF');
  await dialog.getByPlaceholder('Buscar en el texto').fill('raiz'); await page.waitForTimeout(500);
  await expectText('1 resultado', 'la búsqueda en el texto');
  await page.screenshot({ path: join(out, `${label}-pdf-text.png`) });
  await close();
  // Imagen
  await open(/Diagrama de convergencia/);
  const natural = await dialog.locator('img').first().evaluate((img) => (img as HTMLImageElement).naturalWidth).catch(() => 0);
  if (!natural) problems.push(`${label}: la imagen no carga`);
  await close();
  // Pantalla completa y segunda vista en una pestaña nueva
  await open(/Resumen de la semana \(PDF\)/);
  const before = await page.getByRole('dialog').last().boundingBox();
  await dialog.getByRole('button', { name: /pantalla completa/i }).click(); await page.waitForTimeout(500);
  const after = await page.getByRole('dialog').last().boundingBox();
  if (!before || !after || after.width < width - 2 || after.height < height - 2 || after.width <= before.width - 1 && width > 1100) problems.push(label + ': la pantalla completa no ocupa toda la ventana (' + Math.round(after?.width ?? 0) + 'x' + Math.round(after?.height ?? 0) + ')');
  await page.screenshot({ path: join(out, label + '-expanded.png') });
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10000 }),
    dialog.getByRole('link', { name: /pestaña nueva/ }).click(),
  ]);
  await popup.waitForLoadState('networkidle').catch(() => {});
  await popup.setViewportSize({ width, height });
  await popup.getByRole('heading', { name: /Resumen de la semana/ }).waitFor({ timeout: 15000 }).catch(() => problems.push(label + ': la página propia no muestra el archivo'));
  if (!/\/courses\/[^/]+\/files\/[^/]+$/.test(popup.url())) problems.push(label + ': la URL de la segunda vista no es la esperada (' + popup.url() + ')');
  const full = await popup.getByRole('main').boundingBox();
  if (!full || full.width < width - 2 || full.height < height - 2) problems.push(label + ': la página propia no ocupa toda la pantalla');
  await popup.screenshot({ path: join(out, label + '-page.png') });
  await popup.close();
  // Se deja el visor como estaba (la preferencia se recuerda en el navegador).
  await dialog.getByRole('button', { name: /Reducir/i }).click().catch(() => {});
  await close();
  // Documento de Blackboard y video enlazado
  await open(/Notas del docente/);
  await expectText('Antes del quiz', 'el documento');
  await close();
  await open(/Video: convergencia explicada/);
  if (!(await dialog.locator('iframe[src*="youtube-nocookie.com/embed/"]').count())) problems.push(`${label}: el video no usa el reproductor sin cookies`);
  await page.screenshot({ path: join(out, `${label}-video.png`) });
  await close();

  // Guías dentro de la actividad
  await page.goto(`${BASE}/activities`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Quiz semana 9/ }).first().click();
  const detail = page.getByRole('dialog').last();
  await detail.waitFor({ timeout: 6000 });
  await page.waitForTimeout(900);
  const guides = detail.getByText(/Guías y material de esta actividad|Guía de esta actividad/).first();
  if (!(await guides.isVisible().catch(() => false))) problems.push(`${label}: la actividad no muestra sus guías`);
  await page.screenshot({ path: join(out, `${label}-activity-guides.png`) });
  await detail.getByRole('button', { name: /Guía de actividad Quiz semana 9/ }).first().click();
  await page.waitForTimeout(1200);
  if ((await page.getByRole('dialog').count()) < 2) problems.push(`${label}: la guía no abre el visor sobre la actividad`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(600);
  if ((await page.getByRole('dialog').count()) !== 1) problems.push(`${label}: Escape debía cerrar solo el visor y dejar la actividad`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await overflow('actividad con guías');
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Visor: Word, PowerPoint, Excel, PDF, imagen, video, documento, marcas de lectura y guías de la actividad.');
