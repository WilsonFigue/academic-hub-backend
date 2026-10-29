// Contra la DEMO (5174): tablero de actividades — columnas, semana, filtros, plegado, detalle y desbordes.
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
  await page.goto(`${BASE}/activities`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('tablero');
  await page.screenshot({ path: join(out, `${label}-board.png`), fullPage: true });

  const cards = page.locator('main ul li button[aria-label]');
  const total = await cards.count();
  if (total === 0) problems.push(`${label}: no hay tarjetas`);

  // Día de la semana: filtra y se puede quitar.
  const day = page.locator('button[aria-pressed]:not([disabled])').filter({ has: page.locator('small') }).first();
  if (await day.count()) {
    await day.hover(); await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${label}-day-hover.png`), clip: { x: 0, y: 0, width, height: Math.min(height, 700) } });
    await day.click(); await page.waitForTimeout(700);
    const after = await cards.count();
    if (after >= total && total > 1) problems.push(`${label}: el filtro por día no redujo (${total} → ${after})`);
    await page.getByRole('button', { name: 'Quitar filtros' }).first().click(); await page.waitForTimeout(600);
    if ((await cards.count()) !== total) problems.push(`${label}: quitar filtros no restauró`);
  }

  // Menú de materia.
  const menu = page.getByRole('button', { name: /Materia/ }).first();
  if (await menu.count()) {
    await menu.click(); await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `${label}-menu.png`) });
    await page.keyboard.press('Escape');
  }

  // Minimizar a un lado (solo escritorio): la columna queda como pestaña de 70 px y se vuelve a abrir.
  if (width > 1100) {
    await page.getByRole('button', { name: /^Minimizar columna Calificadas/ }).click(); await page.waitForTimeout(800);
    const w = await page.getByRole('button', { name: /^Expandir columna Calificadas/ }).evaluate((el) => el.getBoundingClientRect().width);
    if (w > 100) problems.push(`${label}: la columna minimizada mide ${w}px`);
    await page.screenshot({ path: join(out, `${label}-min.png`), clip: { x: 0, y: 400, width, height: 500 } });
    await page.getByRole('button', { name: /^Expandir columna Calificadas/ }).click(); await page.waitForTimeout(600);
  }

  // Distribución guardada en la cuenta: reordenar, cerrar y restablecer (solo escritorio).
  const NAMES = ['Por entregar', 'Vencidas', 'Entregadas', 'Calificadas', 'Sin fecha'];
  const order = async () => (await page.locator('section[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))).filter((n) => NAMES.includes(n));
  if (width > 1100) {
    await page.getByRole('button', { name: /^Ver las \d+ de Por entregar/ }).focus();
    await page.keyboard.press('Alt+ArrowRight'); await page.waitForTimeout(1300);
    let now = await order();
    if (now[0] !== 'Vencidas' || now[1] !== 'Por entregar') problems.push(`${label}: Alt+→ no reordenó (${now.join(', ')})`);
    await page.getByRole('button', { name: /^Cerrar columna Sin fecha/ }).click(); await page.waitForTimeout(1300);
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1500);
    now = await order();
    if (now.length !== 4 || now[0] !== 'Vencidas' || now.includes('Sin fecha')) problems.push(`${label}: la distribución no se conservó tras recargar (${now.join(', ')})`);
    await page.screenshot({ path: join(out, `${label}-layout.png`), clip: { x: 0, y: 380, width, height: 520 } });
    // Arrastre real con el mouse por la cabecera de la primera columna.
    const box = await page.getByRole('button', { name: /^Ver las \d+ de Vencidas/ }).boundingBox();
    if (box) {
      await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 22, { steps: 8 }); await page.mouse.move(box.x + 420, box.y + 22, { steps: 12 });
      await page.mouse.up(); await page.waitForTimeout(1300);
      now = await order();
      if (now[0] === 'Vencidas') problems.push(`${label}: el arrastre no reordenó (${now.join(', ')})`);
    }
    await page.getByRole('button', { name: /^Columnas/ }).click(); await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Restablecer orden y columnas/ }).click(); await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1500);
    now = await order();
    if (now.join() !== NAMES.join()) problems.push(`${label}: restablecer no volvió al orden original (${now.join(', ')})`);
  }

  // Ver todas: panel lateral con la lista completa de la columna.
  const all = page.getByRole('button', { name: /^Ver las \d+ de Por entregar/ }).first();
  if (await all.count()) {
    const n = Number((await all.getAttribute('aria-label'))?.match(/Ver las (\d+)/)?.[1] ?? 0);
    if (total > 0 && (await cards.count()) > 5 * 5) problems.push(`${label}: columnas sin límite de 5`);
    await all.click(); await page.waitForTimeout(700);
    const inSheet = await page.locator('[role=dialog] ul li').count();
    if (inSheet !== n) problems.push(`${label}: el panel muestra ${inSheet} y la columna tiene ${n}`);
    await page.screenshot({ path: join(out, `${label}-sheet.png`) });
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  } else problems.push(`${label}: no hay botón Ver las…`);

  // Detalle.
  await cards.first().click();
  await page.waitForSelector('[role=dialog]', { timeout: 5000 }).catch(() => problems.push(`${label}: el detalle no abre`));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  await overflow('tablero (después de interactuar)');
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Tablero: semana, filtros, plegado, detalle y sin desbordes.');
