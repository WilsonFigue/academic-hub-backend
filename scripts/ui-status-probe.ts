// Contra la DEMO (5174): cada chip de estado de la línea del ciclo debe contar lo mismo que las marcas que quedan,
// y el calendario y las notas deben mostrar la etiqueta del estado elegido.
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5174';
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
page.on('pageerror', (error) => problems.push(`error JS ${error.message}`));
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.getByLabel('Correo o usuario').fill('camila.rivas');
await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
await page.getByRole('button', { name: 'Iniciar sesión' }).click();
await page.waitForURL('**/dashboard');
await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

const group = page.getByRole('group', { name: 'Filtrar por estado' });
const chips = group.getByRole('button');
const n = await chips.count();
const summary: string[] = [];
for (let i = 0; i < n; i++) {
  const chip = group.getByRole('button').nth(i);
  const text = ((await chip.innerText()) || '').replace(/\s+/g, ' ').trim();
  const count = Number(text.match(/(\d+)\s*$/)?.[1] ?? NaN);
  const name = text.replace(/\s*\d+\s*$/, '');
  await chip.click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(1200);
  const pins = await page.locator('section[aria-labelledby="ribbon-title"] button[class*="pin"]').count();
  const showing = await page.getByText(/^Mostrando/).first().innerText().catch(() => '');
  const shown = Number(showing.match(/Mostrando\s+(\d+)/)?.[1] ?? NaN);
  const calTag = await page.locator('section[aria-labelledby="cal-title"] h2').first().evaluate((el) => el.parentElement?.textContent ?? '');
  summary.push(`${name}: chip ${count} · marcas ${pins} · "${showing}"`);
  if (name !== 'Notas bajas' && pins !== count) problems.push(`${name}: el chip dice ${count} pero hay ${pins} marcas`);
  if (name === 'Notas bajas' && pins !== count) problems.push(`${name}: el chip dice ${count} pero hay ${pins} marcas`);
  if (!Number.isNaN(shown) && shown !== pins) problems.push(`${name}: "Mostrando ${shown}" no coincide con ${pins} marcas`);
  if (!calTag.includes(name)) problems.push(`${name}: el calendario no muestra la etiqueta del estado ("${calTag}")`);
  await chip.click();
  await page.waitForTimeout(500);
}
console.log(summary.join('\n'));
await browser.close();
console.log(problems.length ? 'PROBLEMAS:\n' + problems.join('\n') : 'Chips, marcas y etiquetas coinciden.');
