// Contra la DEMO (5174): "Mis materias" con el avance del ciclo y la pestaña Ciclos de una materia.
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

for (const [label, width, height] of [['1440', 1440, 900], ['768', 768, 900], ['390', 390, 800]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${BASE}/courses`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Evaluación \d en curso/ }).waitFor({ timeout: 8000 }).catch(() => problems.push(`${label}: no aparece el avance del ciclo`));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(out, `${label}-courses.png`), fullPage: true });
  let over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
  if (over > 1) problems.push(`${label} materias: desborde horizontal de ${over}px`);

  await page.locator('a[href*="tab=cycles"]').first().click();
  await page.getByRole('tab', { name: /Eval\. 4/ }).waitFor({ timeout: 8000 }).catch(() => problems.push(`${label}: no aparecen las pestañas de evaluación`));
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(out, `${label}-cycles.png`), fullPage: true });
  await page.getByRole('tab', { name: /Eval\. 2/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${label}-cycles-e2.png`), fullPage: true });
  over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
  if (over > 1) problems.push(`${label} ciclos: desborde horizontal de ${over}px`);
  await page.close();
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'Ciclos: avance del ciclo y pestaña Ciclos sin problemas.');
