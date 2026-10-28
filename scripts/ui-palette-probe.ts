// Contra la DEMO (5174): abrir la paleta, escribir, cambiar de pestaña con Tab, navegar con teclado, scroll y responsive.
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
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label}: consola: ${m.text().slice(0, 160)}`); });
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 4000 }).catch(() => problems.push(`${label}: Ctrl K no abrió la paleta`));
  await page.waitForTimeout(700);
  const initial = await dialog.getByRole('option').count();
  if (initial < 3) problems.push(`${label}: la paleta vacía muestra pocas sugerencias (${initial})`);
  await page.screenshot({ path: join(out, `${label}-empty.png`) });

  await page.keyboard.type('mat', { delay: 40 });
  await page.waitForTimeout(500);
  const typed = await dialog.getByRole('option').count();
  const marks = await dialog.locator('mark').count();
  if (typed === 0) problems.push(`${label}: escribir "mat" no dio resultados`);
  if (marks === 0) problems.push(`${label}: no se resalta el texto escrito`);
  await page.screenshot({ path: join(out, `${label}-typed.png`) });

  // Tab cambia de pestaña (Todo → Secciones) y solo quedan secciones.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const selected = await dialog.getByRole('tab', { selected: true }).innerText();
  if (selected !== 'Secciones') problems.push(`${label}: Tab no cambió de pestaña (${selected})`);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  if ((await dialog.getByRole('tab', { selected: true }).innerText()) !== 'Actividades') problems.push(`${label}: la pestaña Actividades no se alcanzó con Tab`);

  // Borrar y comprobar scroll con desvanecidos.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.getByRole('tab', { name: 'Todo' }).click();
  await page.keyboard.type('a', { delay: 40 });
  await page.waitForTimeout(600);
  const wrap = dialog.locator('[data-bottom]').first();
  const hasBottom = await wrap.getAttribute('data-bottom');
  await dialog.locator('[cmdk-list]').evaluate((el) => { el.scrollTop = 200; });
  await page.waitForTimeout(500);
  const hasTop = await wrap.getAttribute('data-top');
  if (hasBottom !== 'true') problems.push(`${label}: sin desvanecido inferior con lista larga`);
  if (hasTop !== 'true') problems.push(`${label}: sin desvanecido superior tras hacer scroll`);
  await page.screenshot({ path: join(out, `${label}-scrolled.png`) });

  // Teclado: flecha abajo y Enter navegan.
  await page.keyboard.press('Control+a');
  await page.keyboard.type('calend', { delay: 40 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  if (!page.url().includes('/calendar')) problems.push(`${label}: Enter no abrió la sección (${page.url()})`);
  if (await page.getByRole('dialog').isVisible().catch(() => false)) problems.push(`${label}: la paleta no se cerró tras elegir`);
  await page.close();
}
await browser.close();
console.log(problems.length ? 'PROBLEMAS:\n' + problems.join('\n') : 'Paleta: abre, filtra, resalta, Tab cambia de pestaña, scroll con desvanecidos y Enter navega.');
