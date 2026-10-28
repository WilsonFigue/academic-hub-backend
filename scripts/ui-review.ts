// Capturas de revisión visual contra el entorno de DEMOSTRACIÓN (datos ficticios, puerto 5174).
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2]!;
mkdirSync(out, { recursive: true });
const BASE = 'http://localhost:5174';
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];

async function check(page: Page, name: string, viewport: number) {
  // Espera a que desaparezcan los skeletons (la base remota responde en ~1 s).
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  if (width > viewport) problems.push(`${name}: desplazamiento horizontal (${width}px > ${viewport}px)`);
  const raw = await page.evaluate(() => document.body.innerText.match(/\b[A-Z][a-z]+\.name\b/g));
  if (raw) problems.push(`${name}: clave técnica visible ${raw.join(', ')}`);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
}

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await check(page, `${label}-01-dashboard`, viewport.width);

  await page.goto(`${BASE}/courses`, { waitUntil: 'networkidle' });
  await check(page, `${label}-02-courses`, viewport.width);
  await page.getByRole('link', { name: /Bases de Datos I/ }).first().click();
  await page.waitForURL('**/courses/**');
  await check(page, `${label}-03-course-activities`, viewport.width);
  await page.getByRole('tab', { name: /Contenido/ }).click();
  await page.getByRole('button', { name: 'Expandir todo' }).click();
  await check(page, `${label}-04-course-content`, viewport.width);
  await page.getByLabel('Buscar en el contenido').fill('guía');
  await check(page, `${label}-05-course-content-search`, viewport.width);
  await page.getByRole('tab', { name: /Ciclos/ }).click();
  await page.getByRole('button', { name: /Agregar Modelo entidad-relación/ }).click();
  await check(page, `${label}-06-course-cycles`, viewport.width);
  await page.getByRole('button', { name: 'Guardar ciclos' }).click();
  const saved = await page.getByText('Configuración guardada.').waitFor({ timeout: 10000 }).then(() => true, () => false);
  if (!saved) problems.push(`${label}: los ciclos no confirmaron el guardado`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Ciclos/ }).click();
  await page.waitForTimeout(600);
  const persisted = await page.getByText('Modelo entidad-relación').first().isVisible();
  if (!persisted) problems.push(`${label}: los ciclos no persistieron tras recargar`);

  await page.goto(`${BASE}/activities`, { waitUntil: 'networkidle' });
  await check(page, `${label}-07-activities`, viewport.width);
  await page.getByRole('button', { name: /Examen corto de índices/ }).click();
  await page.getByText('Tus intentos').waitFor({ timeout: 10000 }).catch(() => {});
  await check(page, `${label}-08-activity-detail`, viewport.width);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await page.getByRole('dialog').count()) problems.push(`${label}: Escape no cerró el detalle`);

  await page.goto(`${BASE}/grades`, { waitUntil: 'networkidle' });
  await check(page, `${label}-09-grades`, viewport.width);
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await check(page, `${label}-10-calendar-month`, viewport.width);
  await page.goto(`${BASE}/calendar?vista=week`, { waitUntil: 'networkidle' });
  await check(page, `${label}-11-calendar-week`, viewport.width);
  await page.goto(`${BASE}/updates`, { waitUntil: 'networkidle' });
  await check(page, `${label}-12-updates`, viewport.width);
  await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
  await check(page, `${label}-13-profile`, viewport.width);

  // Limpieza para la siguiente pasada: quitar los ciclos guardados.
  await page.evaluate(async () => {
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('ah_csrf='))?.slice(8) ?? '';
    const courses = await (await fetch('/api/v1/courses')).json();
    for (const course of courses.courses) {
      await fetch(`/api/v1/courses/${course.id}/evaluation-cycles`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) }, body: JSON.stringify({ activeNumber: null, cycles: [] }) });
    }
  });
  await page.close();
}
await browser.close();
console.log(problems.length ? `PROBLEMAS:\n- ${problems.join('\n- ')}` : 'Sin problemas detectados.');
