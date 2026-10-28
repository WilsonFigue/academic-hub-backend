// Mide las animaciones de entrada del Inicio cuadro por cuadro contra la DEMO (puerto 5174).
// Uso: tsx scripts/ui-entrance-probe.ts
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5174';
const root = join(process.env.LOCALAPPDATA!, 'ms-playwright');
const exe = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => join(root, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe });

for (const mode of ['no-preference', 'reduce'] as const) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2400 }, reducedMotion: mode });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Correo o usuario').fill('camila.rivas');
  await page.getByLabel('Contraseña', { exact: true }).fill('Demo-academic-hub-2026');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL('**/dashboard');
  await page.waitForTimeout(2500);

  // Recarga completa de /dashboard con un muestreador que corre desde el primer cuadro.
  await page.addInitScript(`
    (function () {
      var targets = { saludo: "h1", ciclo: "[aria-labelledby=ribbon-title]", calendario: "[aria-labelledby=cal-title]", pastel: "[aria-labelledby=est-title]", notas: "[aria-labelledby=not-title]" };
      var log = {}; var start = performance.now();
      window.__probe = log;
      function tick() {
        var t = performance.now() - start;
        Object.keys(targets).forEach(function (name) {
          var el = document.querySelector(targets[name]);
          for (var n = 0; el && n < 4; n++) {
            var cs0 = getComputedStyle(el);
            if (cs0.opacity !== "1" || cs0.transform !== "none") break;
            el = el.parentElement;
          }
          if (!el) return;
          var cs = getComputedStyle(el);
          var y = cs.transform === "none" ? 0 : new DOMMatrixReadOnly(cs.transform).m42;
          (log[name] = log[name] || []).push({ t: Math.round(t), o: Math.round(Number(cs.opacity) * 100) / 100, y: Math.round(y) });
        });
        if (t < 4000) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    })();
  `);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const log = (await page.evaluate("window.__probe")) as Record<string, Array<{ t: number; o: number; y: number }>>;

  console.log(`\n== prefers-reduced-motion: ${mode} ==`);
  for (const [name, frames] of Object.entries(log)) {
    if (!frames.length) { console.log(`${name}: no apareció`); continue; }
    const first = frames[0]!;
    const mid = frames.find((f) => f.o > 0.05 && f.o < 0.95);
    const end = frames[frames.length - 1]!;
    const animated = frames.some((f) => f.o < 0.9) || frames.some((f) => Math.abs(f.y) > 2);
    console.log(`${name.padEnd(11)} aparece a ${String(first.t).padStart(4)} ms con opacidad ${first.o} y desplazamiento ${first.y}px · cuadro intermedio: ${mid ? `opacidad ${mid.o}, y ${mid.y}px` : 'ninguno'} · final: ${end.o} · ${animated ? 'ANIMA' : 'SIN ANIMACIÓN'}`);
  }
  await context.close();
}
await browser.close();
