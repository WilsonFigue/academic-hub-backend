// Contra la DEMO (5174): perfil — cabecera, tarjetas, copiar, ventana de contraseña (validación y rechazo) y desbordes.
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
  await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const overflow = async (where: string) => {
    const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') as number;
    if (over > 1) problems.push(`${label} ${where}: desborde horizontal de ${over}px`);
  };
  await overflow('perfil');
  await page.screenshot({ path: join(out, `${label}-profile.png`), fullPage: true });

  // El botón abre una ventana (no navega a otra vista).
  await page.locator('main').getByRole('button', { name: 'Cambiar contraseña' }).first().click();
  await page.waitForSelector('[role=dialog]', { timeout: 4000 }).catch(() => problems.push(`${label}: la ventana de contraseña no abre`));
  if (!page.url().endsWith('/profile')) problems.push(`${label}: cambió la URL al abrir la ventana (${page.url()})`);
  await page.waitForTimeout(500);
  const dialog = page.getByRole('dialog');
  await page.screenshot({ path: join(out, `${label}-modal.png`) });
  // Validación local: contraseñas distintas.
  await dialog.getByLabel('Contraseña actual').fill('x');
  await dialog.getByLabel('Nueva contraseña', { exact: true }).fill('una-frase-larga-y-distinta');
  await dialog.getByLabel('Confirma la nueva contraseña').fill('otra-cosa');
  await dialog.getByRole('button', { name: 'Guardar contraseña' }).click(); await page.waitForTimeout(400);
  if (!(await dialog.getByText('Las contraseñas no coinciden.').count())) problems.push(`${label}: no avisa que no coinciden`);
  // El servidor rechaza una contraseña actual incorrecta (no se cambia nada).
  await dialog.getByLabel('Confirma la nueva contraseña').fill('una-frase-larga-y-distinta');
  await dialog.getByRole('button', { name: 'Guardar contraseña' }).click(); await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${label}-modal-error.png`) });
  if (!(await page.getByRole('dialog').count())) problems.push(`${label}: la ventana se cerró con una contraseña actual incorrecta`);
  await overflow('ventana');
  await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 4000 }).catch(() => problems.push(`${label}: Escape no cierra la ventana`));
  await page.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Perfil: tarjetas, ventana de contraseña y sin desbordes.');
