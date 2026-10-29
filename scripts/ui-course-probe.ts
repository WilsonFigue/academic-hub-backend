// Contra la DEMO (5174): vista de materia — cabecera, actividades, contenido, calificaciones, filtros, detalle y desbordes.
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

for (const [label, width, height] of [['1440', 1440, 900], ['1920', 1920, 1080], ['1100', 1100, 800], ['768', 768, 900], ['390', 390, 800]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${BASE}/courses`, { waitUntil: 'networkidle' });
  await page.locator('a[href^="/courses/"]').first().click();
  await page.waitForURL(/\/courses\/[^/]+$/);
  await page.waitForTimeout(2200);

  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('actividades');
  await page.screenshot({ path: join(out, `${label}-activities.png`), fullPage: true });

  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(name) });
  // Filtros de estado.
  const total = await page.locator('main ul li button[aria-label]').count();
  const chip = page.getByRole('group', { name: 'Estado' }).getByRole('button', { name: /^Calificadas/ });
  if (await chip.count()) {
    const n = Number((await chip.innerText()).match(/(\d+)\s*$/)?.[1] ?? -1);
    await chip.click(); await page.waitForTimeout(700);
    const shown = await page.locator('main ul li button[aria-label]').count();
    if (shown !== n) problems.push(`${label}: chip Calificadas dice ${n} y muestra ${shown}`);
    await chip.click(); await page.waitForTimeout(700);
    const back = await page.locator('main ul li button[aria-label]').count();
    if (back !== total) problems.push(`${label}: al quitar el filtro quedan ${back} de ${total}`);
  } else problems.push(`${label}: no hay chip Calificadas`);

  // Menú de orden abierto.
  await page.getByRole('button', { name: /^Ordenar/ }).click(); await page.waitForTimeout(600);
  if (!(await page.getByRole('radio', { name: /más antigua/i }).first().isVisible().catch(() => false))) problems.push(label + ': el menú Ordenar no abre');
  await page.screenshot({ path: join(out, label + '-menu.png') });
  await page.getByRole('radio', { name: /más antigua/i }).first().click(); await page.waitForTimeout(700);
  await page.getByRole('button', { name: /^Ordenar/ }).click(); await page.getByRole('radio', { name: /Lo próximo/ }).click(); await page.waitForTimeout(500);

  // Detalle de actividad.
  await page.locator('main ul li button[aria-label]').first().click();
  await page.waitForTimeout(900);
  if (!(await page.getByRole('dialog').first().isVisible().catch(() => false))) problems.push(`${label}: la actividad no abre su detalle`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);

  // Contenido.
  await tab('Contenido').click(); await page.waitForTimeout(1400);
  await overflow('contenido');
  const folder = page.locator('[role=tabpanel] button[aria-expanded]').first();
  if (await folder.count()) { await folder.click(); await page.waitForTimeout(700); }
  await page.screenshot({ path: join(out, `${label}-content.png`), fullPage: true });
  const typeChip = page.getByRole('group', { name: 'Tipo de recurso' }).getByRole('button', { name: /^Documentos/ });
  if (await typeChip.count()) { await typeChip.click(); await page.waitForTimeout(800); if ((await page.locator('main ul li').count()) === 0) problems.push(`${label}: filtro Documentos sin resultados`); await page.screenshot({ path: join(out, `${label}-content-docs.png`), fullPage: true }); }

  // Orden del contenido: más antiguos primero muestra lista plana.
  await page.getByRole('button', { name: /^Ordenar/ }).click(); await page.getByRole('radio', { name: /Más antiguos/ }).click(); await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, label + '-content-sorted.png'), fullPage: true });

  // Calificaciones.
  await tab('Calificaciones').click(); await page.waitForTimeout(1800);
  await overflow('calificaciones');
  await page.screenshot({ path: join(out, `${label}-grades.png`), fullPage: true });
await tab('Información').click(); await page.waitForTimeout(1800); await overflow('información');  await page.screenshot({ path: join(out, `${label}-info.png`), fullPage: true });  await page.getByRole('tab', { name: /Actividades/ }).click(); await page.waitForTimeout(600);  await page.locator('[data-tip="Vencidas"]').first().hover(); await page.waitForTimeout(500);  await page.screenshot({ path: join(out, `${label}-hover.png`), clip: { x: 0, y: 250, width: Math.min(width, 1100), height: 330 } });
  await page.close();
}
await browser.close();
console.log(problems.length ? 'PROBLEMAS:\n' + problems.join('\n') : 'Materia: pestañas, filtros, detalle y sin desbordes.');
