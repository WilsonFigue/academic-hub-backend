// Contra la DEMO (5174): elegir una materia en el flotante filtra el Inicio, las tres tarjetas muestran su etiqueta,
// las gráficas no se reinician y los accesos del flotante llevan a contenido y notas.
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

for (const [label, width, height] of [['1440', 1440, 1500], ['390', 390, 1900]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.locator('section[aria-labelledby="not-title"]').scrollIntoViewIfNeeded();
  await page.waitForSelector('section[aria-labelledby="not-title"] .recharts-wrapper', { timeout: 8000 });
  await page.waitForTimeout(1500);

  const tags = async () => (await page.locator('section[aria-labelledby="cal-title"], section[aria-labelledby="est-title"], section[aria-labelledby="not-title"]').evaluateAll(
    (els) => els.map((el) => (el.querySelector('h2')?.parentElement?.textContent ?? '').slice(0, 80))));
  const before = await tags();
  if (!before.every((t) => /Todas las materias/.test(t))) problems.push(`${label}: las etiquetas iniciales no dicen "Todas las materias": ${before.join(' | ')}`);

  const notes = await page.locator('section[aria-labelledby="not-title"] .recharts-wrapper').first().elementHandle();
  const pie = await page.locator('section[aria-labelledby="est-title"] svg[viewBox="0 0 200 200"]').first().elementHandle();

  const fab = page.getByRole('button', { name: /Abrir materias/ });
  if (width > 800) await fab.hover(); else await fab.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, `${label}-dial.png`) });
  const rowButton = page.locator('ul[aria-label="Materias"] li').first().locator('button[aria-pressed]');
  const name = ((await rowButton.locator('strong').innerText()) || '').trim();
  await rowButton.click();
  await page.waitForTimeout(1400);
  const after = await tags();
  if (!after.every((t) => t.includes(name))) problems.push(`${label}: no todas las tarjetas muestran "${name}": ${after.join(' | ')}`);
  if (notes && !(await notes.evaluate((el) => el.isConnected))) problems.push(`${label}: la gráfica de notas se reinició`);
  if (pie && !(await pie.evaluate((el) => el.isConnected))) problems.push(`${label}: el pastel se reinició`);
  if (!(await page.getByRole('button', { name: new RegExp(`Materia filtrada: ${name}`) }).isVisible().catch(() => false))) problems.push(`${label}: el botón flotante no refleja la materia`);
  await page.screenshot({ path: join(out, `${label}-filtered.png`) });

  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  const fab2 = page.getByRole('button', { name: /Materia filtrada/ });
  if (width > 800) await fab2.hover(); else await fab2.click();
  await page.waitForTimeout(700);
  const content = page.locator('ul[aria-label="Materias"] li').first().getByRole('link', { name: /Contenido de/ });
  const grades = page.locator('ul[aria-label="Materias"] li').first().getByRole('link', { name: /Notas de/ });
  if ((await content.count()) !== 1 || (await grades.count()) !== 1) problems.push(`${label}: faltan los accesos de contenido o notas`);
  else if (!(await content.getAttribute('href'))?.includes('tab=content') || !(await grades.getAttribute('href'))?.includes('tab=grades')) problems.push(`${label}: los accesos no apuntan a su pestaña`);
  await page.close();
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'Flotante filtra, etiquetas correctas, gráficas sin reinicio y accesos de contenido y notas presentes.');
