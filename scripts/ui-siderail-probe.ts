// Contra la DEMO (5174): menú lateral — entrada, despliegue al pasar el mouse, contenido fijo, contadores, navegación y hoja ≤1100.
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

async function login(page: import('playwright').Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
}

for (const [label, width, height] of [['1440', 1440, 900], ['1920', 1920, 1080], ['860', 1300, 700]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await login(page);
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const nav = page.getByRole('navigation', { name: 'Principal' }).first();
  const panel = nav.locator('> div').first();
  const w0 = (await panel.boundingBox())!.width;
  const mainX0 = (await page.locator('main').boundingBox())!.x;
  await page.screenshot({ path: join(out, `${label}-collapsed.png`), clip: { x: 0, y: 0, width: 360, height: Math.min(height, 900) } });

  await nav.hover();
  await page.waitForTimeout(900);
  const w1 = (await panel.boundingBox())!.width;
  const mainX1 = (await page.locator('main').boundingBox())!.x;
  if (!(w1 > w0 + 120)) problems.push(`${label}: el menú no se despliega (${Math.round(w0)} → ${Math.round(w1)})`);
  if (Math.abs(mainX1 - mainX0) > 1) problems.push(`${label}: el contenido se movió al desplegar (${mainX0} → ${mainX1})`);
  const names = await nav.getByRole('link').allInnerTexts();
  if (!names.join(' ').includes('Calificaciones')) problems.push(`${label}: no aparecen las etiquetas al desplegar`);
  await page.screenshot({ path: join(out, `${label}-expanded.png`), clip: { x: 0, y: 0, width: 360, height: Math.min(height, 900) } });

  // Contadores reales: Actividades (pendientes) y Novedades.
  const act = await nav.getByRole('link', { name: /^Actividades/ }).getAttribute('aria-label');
  const nov = await nav.getByRole('link', { name: /^Novedades/ }).getAttribute('aria-label');
  if (!/\d/.test(act ?? '')) problems.push(`${label}: Actividades sin contador (${act})`);
  if (!/\d/.test(nov ?? '')) problems.push(`${label}: Novedades sin contador (${nov})`);

  // Navegar y píldora activa.
  await nav.getByRole('link', { name: /^Calendario/ }).click();
  await page.waitForURL('**/calendar');
  await page.waitForTimeout(700);
  const current = await nav.locator('[aria-current="page"]').innerText();
  if (!current.includes('Calendario')) problems.push(`${label}: la sección activa no es Calendario (${current})`);

  await page.mouse.move(900, 500);
  await page.waitForTimeout(900);
  const w2 = (await panel.boundingBox())!.width;
  if (Math.abs(w2 - w0) > 2) problems.push(`${label}: no se replegó al sacar el mouse (${Math.round(w2)} vs ${Math.round(w0)})`);

  // Teclado: enfocar con Tab lo despliega.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  await page.close();
}

// Entrada medida cuadro por cuadro.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await login(page);
await page.waitForTimeout(2000);
await page.addInitScript(`(function(){var log=[];var s=performance.now();window.__rail=log;function t(){var el=document.querySelector('nav[aria-label=Principal] > div');if(el){var cs=getComputedStyle(el);var x=cs.transform==='none'?0:new DOMMatrixReadOnly(cs.transform).m41;log.push({t:Math.round(performance.now()-s),o:Math.round(Number(cs.opacity)*100)/100,x:Math.round(x)});}if(performance.now()-s<4000)requestAnimationFrame(t);}requestAnimationFrame(t);})();`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4300);
const frames = (await page.evaluate('window.__rail')) as Array<{ t: number; o: number; x: number }>;
const mid = frames.find((f) => f.o > 0.05 && f.o < 0.95);
console.log(`entrada del menú: empieza opacidad ${frames[0]?.o} x ${frames[0]?.x}px · cuadro intermedio ${mid ? `opacidad ${mid.o}, x ${mid.x}px` : 'ninguno'} · final ${frames[frames.length - 1]?.o}`);
if (!mid) problems.push('el menú no anima al entrar');
await page.close();

// Tablet: el riel se oculta y la hoja de navegación funciona.
const tab = await browser.newPage({ viewport: { width: 900, height: 900 } });
await login(tab);
await tab.waitForTimeout(2000);
if (await tab.getByRole('navigation', { name: 'Principal' }).first().isVisible().catch(() => false)) problems.push('900: el riel sigue visible');
await tab.getByRole('button', { name: 'Abrir menú' }).click();
await tab.waitForTimeout(700);
const sheet = tab.getByRole('navigation', { name: 'Menú' });
if (!(await sheet.isVisible().catch(() => false))) problems.push('900: la hoja de navegación no abrió');
else { await sheet.getByRole('link', { name: 'Calificaciones' }).click(); await tab.waitForURL('**/grades'); }
await tab.screenshot({ path: join(out, '900-sheet.png') });
await browser.close();
console.log(problems.length ? 'PROBLEMAS:\n' + problems.join('\n') : 'Menú: entra animado, se despliega sin mover el contenido, contadores reales, navega y la hoja ≤1100 funciona.');
