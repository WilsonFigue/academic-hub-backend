// Contra la DEMO (5174): calificaciones — materias, gráficas, chips, detalle y desbordes.
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
  await page.goto(`${BASE}/grades`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('calificaciones');
  await page.screenshot({ path: join(out, `${label}-grades.png`), fullPage: true });

  // Cambiar de materia con las pestañas y volver.
  const tabs = page.getByRole('tab');
  const n = await tabs.count();
  if (n > 1) {
    await tabs.nth(1).click(); await page.waitForTimeout(1500);
    if ((await tabs.nth(1).getAttribute('aria-selected')) !== 'true') problems.push(`${label}: la pestaña no quedó seleccionada`);
    await overflow('otra materia');
    await page.screenshot({ path: join(out, `${label}-grades-2.png`), fullPage: true });
    await tabs.nth(0).click(); await page.waitForTimeout(1200);
  } else problems.push(`${label}: solo hay ${n} materia(s) en las pestañas`);

  // Abrir el detalle de una nota desde la lista.
  const row = page.locator('section[aria-label="Todas tus notas"] ul li button').first();
  if (await row.count()) {
    await row.click();
    await page.waitForSelector('[role=dialog]', { timeout: 5000 }).catch(() => problems.push(`${label}: el detalle no abre`));
    await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 4000 }).catch(() => problems.push(`${label}: el detalle no se cierra`));
  } else problems.push(label + ': no hay tarjetas en Todas tus notas');
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Calificaciones: materias, gráficas, detalle y sin desbordes.');
