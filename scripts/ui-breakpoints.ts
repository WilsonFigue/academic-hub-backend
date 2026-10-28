// Capturas por punto de quiebre contra el entorno de DEMOSTRACIÓN (datos ficticios, puerto 5174).
// Uso: npm run ui:breakpoints <carpeta> [rutas separadas por coma]
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2]!;
const routes = (process.argv[3] ?? 'dashboard,courses,activities,grades,calendar,updates,profile').split(',').map((r) => `/${r.replace(/^\/+/, '')}`);
mkdirSync(out, { recursive: true });
const BASE = 'http://localhost:5174';
const VIEWPORTS: Array<[string, number, number]> = [
  ['3840', 3840, 2160], ['2560', 2560, 1440], ['1920', 1920, 1080], ['1440', 1440, 900], ['1366-short', 1366, 768],
  ['1100', 1100, 800], ['900', 900, 1100], ['768', 768, 1024], ['581', 581, 900], ['390', 390, 844],
];
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];

// Sin animaciones: las capturas de página completa salen deterministas (las animaciones se prueban en ui-dashboard-interact).
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const login = await context.newPage();
await login.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await login.getByLabel('Correo o usuario').fill('camila.rivas');
await login.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
await login.getByRole('button', { name: 'Iniciar sesión' }).click();
await login.waitForURL('**/dashboard');
await login.close();

for (const [label, width, height] of VIEWPORTS) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  for (const route of routes) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2200);
    // Recorre la página para que se disparen las animaciones de entrada por visibilidad.
    await page.evaluate(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 380) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 130)); } window.scrollTo(0, 0); });
    await page.waitForTimeout(1500);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scroll > width) problems.push(`${label} ${route}: desplazamiento horizontal (${scroll}px > ${width}px)`);
    await page.screenshot({ path: join(out, `${label}${route.replace(/\//g, '_')}.png`), fullPage: true });
  }
  await page.close();
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'Sin problemas automáticos.');
