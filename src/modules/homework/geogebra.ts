// Herramienta «geogebra»: ejecuta GeoGebra de verdad (el mismo applet que usa el panel de la guía) en el Chromium del servidor.
// Evalúa los comandos, devuelve el valor de cada objeto para que el agente compruebe sus cálculos, y exporta la imagen real (PNG)
// y el archivo .ggb que el estudiante puede abrir y modificar. Necesita internet: el applet se carga desde geogebra.org.
// El código que corre dentro del navegador va como texto (no como función) para que el compilador no le inserte ayudantes que el navegador no conoce.
import { withPage } from './render.js';

export interface GeoGebraSpec {
  id: string; comandos: string[]; nombre_archivo?: string; entregar_archivo?: boolean;
  x_min?: number; x_max?: number; y_min?: number; y_max?: number; ejes?: boolean; cuadricula?: boolean;
  /** Misma escala en ambos ejes (por defecto sí): así una circunferencia se ve redonda. Ponlo en false para funciones con rangos muy distintos. */
  escala_igual?: boolean;
}
export interface GeoGebraResult { png: Buffer; ggb: Buffer; width: number; height: number; objects: Record<string, string>; errors: string[] }

const APPLET = 'https://www.geogebra.org/apps/deployggb.js';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const START = (width: number, height: number) => `new Promise((resolve, reject) => {
  if (typeof window.GGBApplet !== 'function') { reject(new Error('No se pudo cargar GeoGebra (¿sin internet?).')); return; }
  const timer = setTimeout(() => reject(new Error('GeoGebra tardó demasiado en iniciar.')), 60000);
  new window.GGBApplet({ appName: 'classic', perspective: 'G', width: ${width}, height: ${height}, showToolBar: false, showAlgebraInput: false, showMenuBar: false, showResetIcon: false,
    enableRightClick: false, enableShiftDragZoom: false, language: 'es', borderColor: null, useBrowserForJS: true,
    appletOnLoad: function (api) { window.__ggb = api; clearTimeout(timer); resolve(true); } }, true).inject('ggb');
})`;

const RUN = (input: { commands: string[]; view: number[] | null; axes: boolean; grid: boolean; equal: boolean }) => `(function () {
  const input = ${JSON.stringify(input)}; const ggb = window.__ggb; const errors = [];
  ggb.setAxesVisible(input.axes, input.axes); ggb.setGridVisible(input.grid);
  for (const command of input.commands) { let ok = false; try { ok = ggb.evalCommand(command); } catch (e) { ok = false; } if (!ok) errors.push(command); }
  const names = ggb.getAllObjectNames();
  // Etiquetas solo en los puntos: las de circunferencias, rectas y demás estorban en la imagen.
  for (const n of names) { try { ggb.setLabelVisible(n, ggb.getObjectType(n) === 'point'); } catch (e) { /* sin etiqueta */ } }
  const W = 900, H = 700;
  const fit = function (v) { if (!input.equal) return v; const cx = (v[0] + v[1]) / 2, cy = (v[2] + v[3]) / 2, k = Math.max((v[1] - v[0]) / W, (v[3] - v[2]) / H); return [cx - k * W / 2, cx + k * W / 2, cy - k * H / 2, cy + k * H / 2]; };
  if (input.view) { const v = fit(input.view); ggb.setCoordSystem(v[0], v[1], v[2], v[3]); }
  else {
    const xs = [], ys = [];
    for (const n of names) if (ggb.getObjectType(n) === 'point') { xs.push(ggb.getXcoord(n)); ys.push(ggb.getYcoord(n)); }
    if (xs.length > 0) { const mx = Math.max(1, (Math.max(...xs) - Math.min(...xs)) * 0.6), my = Math.max(1, (Math.max(...ys) - Math.min(...ys)) * 0.6);
      const v = fit([Math.min(...xs) - mx, Math.max(...xs) + mx, Math.min(...ys) - my, Math.max(...ys) + my]); ggb.setCoordSystem(v[0], v[1], v[2], v[3]); }
  }
  const objects = {};
  for (const n of names.slice(0, 60)) { try { objects[n] = ggb.getValueString(n); } catch (e) { /* sin valor */ } }
  const png = ggb.getPNGBase64(1.5, false, 72);
  return new Promise(function (resolve) { ggb.getBase64(function (b64) { resolve({ errors: errors, objects: objects, png: png, ggb: b64 }); }); });
})()`;

export async function runGeoGebra(spec: GeoGebraSpec): Promise<GeoGebraResult> {
  const commands = (Array.isArray(spec.comandos) ? spec.comandos : []).map((c) => String(c ?? '').trim()).filter(Boolean).slice(0, 80);
  if (commands.length === 0) throw new Error('No hay comandos.');
  const view = [spec.x_min, spec.x_max, spec.y_min, spec.y_max].every(finite) ? [spec.x_min!, spec.x_max!, spec.y_min!, spec.y_max!] : null;
  return withPage(async (page) => {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><script src="${APPLET}"></script></head><body style="margin:0;background:#fff"><div id="ggb"></div></body></html>`, { waitUntil: 'load', timeout: 45_000 });
    await page.evaluate(START(900, 700));
    const out = await page.evaluate(RUN({ commands, view, axes: spec.ejes !== false, grid: spec.cuadricula !== false, equal: spec.escala_igual !== false })) as { errors: string[]; objects: Record<string, string>; png: string; ggb: string };
    const png = Buffer.from(out.png, 'base64');
    if (png.length < 500) throw new Error('GeoGebra no produjo imagen.');
    return { png, ggb: Buffer.from(out.ggb, 'base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20), objects: out.objects, errors: out.errors };
  });
}
