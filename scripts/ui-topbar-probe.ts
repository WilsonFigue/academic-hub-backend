// Contra la DEMO (5174): entrada, scroll, hover y responsive del header.
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

async function login(page: import('playwright').Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
}

for (const [label, width, height] of [['1440', 1440, 900], ['1920', 1920, 1080], ['1100', 1100, 800], ['768', 768, 1000], ['390', 390, 844]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => problems.push(`${label}: error JS ${error.message}`));
  await login(page);
  await page.waitForFunction(() => !document.querySelector('[aria-busy=true]'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const bar = page.locator('header').first();
  await bar.screenshot({ path: join(out, `${label}-header.png`) });
  const box = await bar.boundingBox();
  if (!box || box.width > width + 1) problems.push(`${label}: el header desborda (${box?.width})`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  if (overflow > width) problems.push(`${label}: desplazamiento horizontal ${overflow}px`);

  if (label === '1440') {
    // Hover del buscador: se expande.
    const search = page.getByRole('button', { name: 'Buscar en Academic Hub' });
    const w0 = (await search.boundingBox())!.width;
    await search.hover();
    await page.waitForTimeout(700);
    const w1 = (await search.boundingBox())!.width;
    if (!(w1 > w0 + 20)) problems.push(`el buscador no se expande al pasar el mouse (${Math.round(w0)} → ${Math.round(w1)})`);
    await bar.screenshot({ path: join(out, `${label}-header-hover-search.png`) });
    await page.mouse.move(5, 500);

    // Scroll: se compacta.
    const h0 = (await bar.boundingBox())!.height;
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(700);
    const h1 = (await bar.boundingBox())!.height;
    if (!(h1 < h0 - 6)) problems.push(`el header no se compacta al hacer scroll (${Math.round(h0)} → ${Math.round(h1)})`);
    await page.screenshot({ path: join(out, `${label}-scrolled.png`), clip: { x: 0, y: 0, width, height: 200 } });

    // El buscador abre la paleta.
    await search.click();
    await page.waitForTimeout(400);
    if (!(await page.getByRole('dialog').isVisible().catch(() => false))) problems.push('el buscador no abrió la paleta');
  }
  await page.close();
}

// Entrada: muestrea el header cuadro por cuadro en una recarga limpia.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await login(page);
await page.waitForTimeout(2000);
await page.addInitScript(`(function(){var log=[];var s=performance.now();window.__hdr=log;function t(){var el=document.querySelector('header');if(el){var cs=getComputedStyle(el);var y=cs.transform==='none'?0:new DOMMatrixReadOnly(cs.transform).m42;log.push({t:Math.round(performance.now()-s),o:Math.round(Number(cs.opacity)*100)/100,y:Math.round(y)});}if(performance.now()-s<4000)requestAnimationFrame(t);}requestAnimationFrame(t);})();`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4300);
const frames = (await page.evaluate('window.__hdr')) as Array<{ t: number; o: number; y: number }>;
const first = frames[0]; const mid = frames.find((f) => f.o > 0.05 && f.o < 0.95);
console.log(`entrada del header: empieza opacidad ${first?.o} y ${first?.y}px · cuadro intermedio ${mid ? `opacidad ${mid.o}, y ${mid.y}px` : 'ninguno'} · final ${frames[frames.length - 1]?.o}`);
if (!mid) problems.push('el header no anima al entrar');
await browser.close();
console.log(problems.length ? 'PROBLEMAS:\n' + problems.join('\n') : 'Header: entrada, scroll, hover y responsive correctos.');
