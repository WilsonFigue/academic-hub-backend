// Prueba de interacción del Inicio contra la DEMO (puerto 5174): calendario, insignias-filtro, pastel,
// botón flotante de materias y "Próxima entrega" desplegable.
// Uso: tsx scripts/ui-dashboard-interact.ts <carpeta>
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

for (const [label, width, height] of [['1440', 1440, 900], ['390', 390, 844]] as const) {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 800, reducedMotion: 'reduce' });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(out, `${label}-loading.png`) });
  await page.waitForTimeout(650);
  await page.screenshot({ path: join(out, `${label}-entering.png`) });
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2400);

  // 0. Vista previa: pasar el mouse por una pestaña de materia ya filtra, sin elegirla.
  if (width > 800) {
    const tabs = page.getByRole('group', { name: 'Filtrar por materia' }).getByRole('button');
    await tabs.nth(2).hover();
    await page.waitForTimeout(700);
    if (!(await page.getByText(/Mostrando/).first().isVisible().catch(() => false))) problems.push(`${label}: la vista previa de la pestaña no filtró`);
    await page.screenshot({ path: join(out, `${label}-tab-preview.png`), clip: { x: 0, y: 0, width, height: 560 } });
    await page.mouse.move(5, height - 5);
    await page.waitForTimeout(500);
  }

  // 1. Próxima entrega: círculo → despliega (mouse) o primer toque (táctil).
  const next = page.locator('button[aria-label^="Próxima entrega"]').first();
  if (await next.count()) {
    const closed = await next.getAttribute('data-open');
    if (width > 800) await next.hover(); else await next.tap();
    await page.waitForTimeout(700);
    const opened = await next.getAttribute('data-open');
    if (closed !== 'false' || opened !== 'true') problems.push(`${label}: la próxima entrega no se desplegó (${closed} → ${opened})`);
    await page.screenshot({ path: join(out, `${label}-next-open.png`), clip: { x: 0, y: 0, width, height: Math.min(height, 520) } });
    await page.mouse.move(5, height - 5);
    await page.waitForTimeout(300);
  } else problems.push(`${label}: no hay botón de próxima entrega`);

  // 2. Calendario: flechas.
  const calNext = page.getByRole('button', { name: /días siguientes/ });
  const before = await page.locator('p[aria-live="polite"]').first().innerText();
  await calNext.click();
  await page.waitForTimeout(900);
  const after = await page.locator('p[aria-live="polite"]').first().innerText();
  if (before === after) problems.push(`${label}: la flecha siguiente no cambió el rango (${before})`);
  await calNext.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, `${label}-calendar-next.png`) });
  await page.getByRole('button', { name: 'Hoy', exact: true }).click();
  await page.waitForTimeout(500);

  // 3. Chips de estado dentro de la línea del ciclo: "Calificadas" filtra y queda activo.
  const badge = page.getByRole('group', { name: 'Filtrar por estado' }).getByRole('button', { name: /calificadas/i });
  await badge.click();
  await page.waitForTimeout(600);
  if ((await badge.getAttribute('aria-pressed')) !== 'true') problems.push(`${label}: la insignia no quedó activa`);
  if (!(await page.getByText(/Mostrando/).first().isVisible().catch(() => false))) problems.push(`${label}: la línea del ciclo no indicó el filtro`);
  await page.screenshot({ path: join(out, `${label}-filter-status.png`) });
  await badge.click();
  await page.waitForTimeout(500);

  // 4. Botón flotante de materias: abre, elige una y filtra.
  const fab = page.getByRole('button', { name: /Abrir materias/ });
  if (width > 800) { await fab.hover(); } else { await fab.click(); }   // con mouse se abre solo al pasar
  await page.waitForTimeout(800);
  const items = page.getByRole('menuitemradio');
  if ((await items.count()) < 2) problems.push(`${label}: el abanico no mostró materias`);
  await page.screenshot({ path: join(out, `${label}-dial-open.png`) });
  await items.first().click();
  await page.waitForTimeout(700);
  if (!(await page.getByRole('button', { name: /Materia filtrada/ }).isVisible().catch(() => false))) problems.push(`${label}: el botón flotante no reflejó la materia elegida`);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${label}-filter-course.png`) });

  // 5. Pastel: la leyenda responde al hover (centro) y al clic (filtro de estado).
  const row = page.locator('li > button[aria-pressed]').filter({ hasText: 'Por entregar' }).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const center = await page.locator('div[aria-live="polite"]').first().innerText().catch(() => '');
  if (!/Por entregar/.test(center)) problems.push(`${label}: el centro del pastel no respondió a la leyenda (${center.split('\n').join(' ')})`);
  await page.screenshot({ path: join(out, `${label}-pie.png`) });
  // 6. Panel lateral de actividad.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(300);
  const pin = page.locator('button[aria-label^="Próxima entrega"]').first();
  if (await pin.count()) { await pin.dispatchEvent('click'); await page.waitForTimeout(1500); if (!(await page.getByRole('dialog').isVisible().catch(() => false))) problems.push(`${label}: el panel lateral no abrió`); await page.screenshot({ path: join(out, `${label}-drawer.png`) }); }
  await page.close();
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'Interacciones correctas.');
