// Contra la DEMO (5174): novedades — tipos, materias, período, línea de tiempo, acciones y desbordes.
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

for (const [label, width, height] of [['1440', 1440, 900], ['1920', 1920, 1080], ['1100', 1100, 800], ['768', 768, 900], ['581', 581, 800], ['390', 390, 800]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto(`${BASE}/updates`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('novedades');
  await page.screenshot({ path: join(out, `${label}-updates.png`), fullPage: true });

  const cards = page.locator('main ul li');
  const total = await cards.count();
  if (total === 0) console.log(`${label}: sin novedades en la demo`);
  else {
    // Filtrar por tipo y quitar.
    const tipos = page.getByRole('group', { name: 'Tipo de novedad' }).getByRole('button');
    const n = await tipos.count();
    if (n > 1) {
      for (let i = 1; i < n; i++) {
        const b = tipos.nth(i);
        if (await b.isDisabled()) continue;
        await b.click(); await page.waitForTimeout(600);
        const after = await cards.count();
        if (after > total) problems.push(`${label}: filtrar por tipo aumentó las tarjetas`);
        await page.screenshot({ path: join(out, `${label}-filtered.png`) });
        await page.getByRole('button', { name: 'Quitar filtros' }).click(); await page.waitForTimeout(500);
        break;
      }
    }
    // Período.
    const periodo = page.getByRole('button', { name: /^Período/ });
    if (await periodo.count()) { await periodo.click(); await page.waitForTimeout(400); await page.screenshot({ path: join(out, `${label}-period.png`) }); await page.keyboard.press('Escape'); }
    // Abrir el detalle de una actividad desde una novedad.
    const open = page.locator('main').getByRole('button', { name: 'Abrir', exact: true }).first();
    if (await open.count()) {
      await open.click();
      await page.waitForSelector('[role=dialog]', { timeout: 5000 }).catch(() => problems.push(`${label}: el detalle no abre`));
      await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 4000 }).catch(() => problems.push(`${label}: el detalle no se cierra`));
    }
  }
  await overflow('novedades (tras interactuar)');
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Novedades: tipos, período, línea de tiempo, acciones y sin desbordes.');
