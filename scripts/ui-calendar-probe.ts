// Contra la DEMO (5174): calendario — vistas, filtros, selección de día, navegación, detalle y desbordes.
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

for (const [label, width, height] of [['1440', 1440, 900], ['1920', 1920, 1080], ['1100', 1100, 800], ['1365', 1365, 900], ['900', 900, 900], ['768', 768, 900], ['581', 581, 800], ['390', 390, 800]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('mes');
  await page.screenshot({ path: join(out, `${label}-month.png`), fullPage: true });

  // Seleccionar un día con elementos: el panel lista sus tarjetas.
  await page.evaluate('window.scrollTo(0, 0)');
  const busy = page.locator('[role=gridcell][aria-label*="elemento"]:not([aria-label*="sin vencimientos"])').first();
  if (await busy.count()) {
    await busy.click({ position: { x: 8, y: 6 } }); await page.waitForTimeout(600);
    const cards = await page.locator('aside ul li').count();
    if (cards === 0) problems.push(`${label}: el panel del día no muestra tarjetas`);
    // Botón flotante: solo cuando el panel del día queda fuera de la pantalla (diseño en una columna).
    const fab = page.locator('button[class*=_fab_]');
    await page.screenshot({ path: join(out, `${label}-fab.png`) });
    const shown = await fab.count();
    if (width <= 1365 && shown !== 1) problems.push(`${label}: no aparece el botón flotante (${shown})`);
    if (width > 1365 && shown !== 0) problems.push(`${label}: el botón flotante aparece con el panel a la vista`);
    if (shown) {
      await fab.click(); await page.waitForTimeout(1500);
      if ((await fab.count()) !== 0) problems.push(`${label}: el botón flotante no desaparece al llegar al panel`);
    }
    await page.screenshot({ path: join(out, `${label}-day.png`), fullPage: true });
    // Abrir el detalle de la primera entrega del panel.
    const first = page.locator('aside ul li button').first();
    if (await first.count()) {
      await first.click();
      await page.waitForSelector('[role=dialog]', { timeout: 5000 }).catch(() => problems.push(`${label}: el detalle no abre`));
      await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 4000 }).catch(() => problems.push(label + ': el detalle no se cierra con Escape'));
    }
  } else problems.push(`${label}: no hay días con elementos en el mes actual`);

  // Estado: filtrar por "Por entregar" reduce los elementos y se puede quitar.
  const pending = page.getByRole('group', { name: 'Estado' }).getByRole('button', { name: /^Por entregar/ });
  if (await pending.count()) {
    await pending.click(); await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `${label}-filtered.png`), fullPage: false });
    await page.getByRole('button', { name: 'Quitar filtros' }).click(); await page.waitForTimeout(400);
  }

  // Materias: ocultar una y volver.
  const course = page.getByRole('group', { name: 'Materias visibles' }).getByRole('button').first();
  if (await course.count()) { await course.click(); await page.waitForTimeout(400); await course.click(); await page.waitForTimeout(300); }

  // Navegación por mes y regreso a hoy.
  const period = await page.locator('h2[aria-live]').innerText();
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click(); await page.waitForTimeout(700);
  const next = await page.locator('h2[aria-live]').innerText();
  if (period === next) problems.push(`${label}: Siguiente no cambió el período`);
  await page.getByRole('button', { name: 'Hoy', exact: true }).click(); await page.waitForTimeout(700);
  if ((await page.locator('h2[aria-live]').innerText()) !== period) problems.push(`${label}: Hoy no regresó al período actual`);

  // Semana y agenda.
  await page.getByRole('group', { name: 'Vista del calendario' }).getByRole('button', { name: /Semana/ }).click(); await page.waitForTimeout(1200);
  await overflow('semana');
  await page.screenshot({ path: join(out, `${label}-week.png`), fullPage: true });
  await page.getByRole('group', { name: 'Vista del calendario' }).getByRole('button', { name: /Agenda/ }).click(); await page.waitForTimeout(1200);
  await overflow('agenda');
  await page.screenshot({ path: join(out, `${label}-agenda.png`), fullPage: true });
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Calendario: vistas, filtros, día, navegación, detalle y sin desbordes.');
