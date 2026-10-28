// Contra la DEMO (5174): pasar el mouse por un chip (vista previa), hacer clic y sacar el mouse debe dejar el filtro elegido.
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5174';
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.getByLabel('Correo o usuario').fill('camila.rivas');
await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
await page.getByRole('button', { name: 'Iniciar sesión' }).click();
await page.waitForURL('**/dashboard');
await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

const chip = page.getByRole('group', { name: 'Filtrar por estado' }).getByRole('button').nth(1);
const pressed = async () => (await chip.getAttribute('aria-pressed')) === 'true';
const preview = async () => (await chip.getAttribute('data-preview')) === 'true';
const mostrando = async () => (await page.getByText(/^Mostrando/).first().isVisible().catch(() => false));

// 1. Solo hover: se ve la vista previa, pero NO queda elegido.
await chip.hover();
await page.waitForTimeout(700);
if (await pressed()) problems.push('el hover marca el chip como elegido');
if (!(await preview())) problems.push('el hover no muestra la vista previa');
if (!(await mostrando())) problems.push('el hover no filtra la línea del ciclo');

// 2. Clic con la vista previa activa: debe quedar elegido (antes se quitaba).
await chip.click();
await page.waitForTimeout(500);
if (!(await pressed())) problems.push('el clic con la vista previa activa NO dejó el filtro elegido');

// 3. Sacar el mouse: el filtro se mantiene.
await page.mouse.move(5, 5);
await page.waitForTimeout(900);
if (!(await pressed())) problems.push('al sacar el mouse se perdió el filtro');
if (!(await mostrando())) problems.push('al sacar el mouse la línea del ciclo dejó de estar filtrada');

// 4. Segundo clic (con el mouse encima) lo quita.
await chip.hover();
await page.waitForTimeout(400);
await chip.click();
await page.mouse.move(5, 5);
await page.waitForTimeout(900);
if (await pressed()) problems.push('el segundo clic no quitó el filtro');
if (await mostrando()) problems.push('tras quitar el filtro la línea sigue filtrada');

await browser.close();
console.log(problems.length ? 'PROBLEMAS:\n' + problems.join('\n') : 'Hover = vista previa, clic = elige, sacar el mouse = se mantiene, segundo clic = quita.');
