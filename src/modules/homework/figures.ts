// Herramienta «grafica»: dibuja figuras 2D exactas como SVG (puntos, segmentos, polígonos, circunferencias, funciones y texto).
// El modelo NO dibuja píxeles: describe la figura y el servidor la renderiza, así coincide con los cálculos.
import { all, create } from 'mathjs';

const math = create(all as never);
const evaluate: (expression: string, scope: Record<string, unknown>) => unknown = math.evaluate.bind(math) as never;
math.import({ import: () => { throw new Error('no'); }, createUnit: () => { throw new Error('no'); }, reviver: () => { throw new Error('no'); }, evaluate: () => { throw new Error('no'); }, parse: () => { throw new Error('no'); }, simplify: () => { throw new Error('no'); }, derivative: () => { throw new Error('no'); }, resolve: () => { throw new Error('no'); } }, { override: true });

type Num = number;
export type FigureElement =
  | { tipo: 'punto'; x: Num; y: Num; etiqueta?: string; color?: string }
  | { tipo: 'segmento'; x1: Num; y1: Num; x2: Num; y2: Num; etiqueta?: string; color?: string; discontinuo?: boolean }
  | { tipo: 'circulo'; cx: Num; cy: Num; r: Num; color?: string; relleno?: boolean }
  | { tipo: 'poligono'; puntos: Array<[Num, Num]>; color?: string; relleno?: boolean }
  | { tipo: 'funcion'; expresion: string; x_min?: Num; x_max?: Num; color?: string; etiqueta?: string }
  | { tipo: 'texto'; x: Num; y: Num; texto: string; color?: string };

export interface FigureSpec {
  id: string; titulo?: string; x_min?: Num; x_max?: Num; y_min?: Num; y_max?: Num; ejes?: boolean; cuadricula?: boolean;
  elementos: FigureElement[];
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const color = (value: unknown, fallback: string) => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

function step(span: number): number {
  const raw = span / 10; const mag = 10 ** Math.floor(Math.log10(raw)); const unit = raw / mag;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag;
}

export function renderFigure(spec: FigureSpec): string {
  const elements = (Array.isArray(spec.elementos) ? spec.elementos : []).slice(0, 80);
  if (elements.length === 0) throw new Error('La figura no tiene elementos.');
  // Límites: los pedidos o, si faltan, los que contienen todo con un margen.
  const xs: number[] = [0], ys: number[] = [0];
  for (const el of elements) {
    if (el.tipo === 'punto' || el.tipo === 'texto') { if (finite(el.x) && finite(el.y)) { xs.push(el.x); ys.push(el.y); } }
    else if (el.tipo === 'segmento') { for (const v of [el.x1, el.x2]) if (finite(v)) xs.push(v); for (const v of [el.y1, el.y2]) if (finite(v)) ys.push(v); }
    else if (el.tipo === 'circulo') { if (finite(el.cx) && finite(el.cy) && finite(el.r)) { xs.push(el.cx - el.r, el.cx + el.r); ys.push(el.cy - el.r, el.cy + el.r); } }
    else if (el.tipo === 'poligono') { for (const p of el.puntos ?? []) if (finite(p[0]) && finite(p[1])) { xs.push(p[0]); ys.push(p[1]); } }
    else if (el.tipo === 'funcion') { if (finite(el.x_min)) xs.push(el.x_min); if (finite(el.x_max)) xs.push(el.x_max); }
  }
  const pad = (lo: number, hi: number) => { const m = Math.max((hi - lo) * 0.08, 0.5); return [lo - m, hi + m] as const; };
  let [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  let [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  if (finite(spec.x_min)) x0 = spec.x_min; if (finite(spec.x_max)) x1 = spec.x_max;
  if (finite(spec.y_min)) y0 = spec.y_min; if (finite(spec.y_max)) y1 = spec.y_max;
  if (!(x1 > x0) || !(y1 > y0)) throw new Error('Los límites de la figura no son válidos.');
  // Misma escala en ambos ejes para que los círculos se vean redondos.
  const maxW = 620, maxH = 520;
  const S = Math.min(maxW / (x1 - x0), maxH / (y1 - y0));
  const W = (x1 - x0) * S, H = (y1 - y0) * S, margin = 38;
  const X = (x: number) => margin + (x - x0) * S, Y = (y: number) => margin + (y1 - y) * S;
  const sx = step(x1 - x0), sy = step(y1 - y0);
  let g = '';
  if (spec.cuadricula !== false) {
    for (let x = Math.ceil(x0 / sx) * sx; x <= x1 + 1e-9; x += sx) g += `<line x1="${X(x)}" y1="${Y(y0)}" x2="${X(x)}" y2="${Y(y1)}" class="grid"/>`;
    for (let y = Math.ceil(y0 / sy) * sy; y <= y1 + 1e-9; y += sy) g += `<line x1="${X(x0)}" y1="${Y(y)}" x2="${X(x1)}" y2="${Y(y)}" class="grid"/>`;
  }
  if (spec.ejes !== false) {
    if (x0 <= 0 && x1 >= 0) g += `<line x1="${X(0)}" y1="${Y(y0)}" x2="${X(0)}" y2="${Y(y1)}" class="axis"/>`;
    if (y0 <= 0 && y1 >= 0) g += `<line x1="${X(x0)}" y1="${Y(0)}" x2="${X(x1)}" y2="${Y(0)}" class="axis"/>`;
    const ax = y0 <= 0 && y1 >= 0 ? Y(0) : Y(y0), ay = x0 <= 0 && x1 >= 0 ? X(0) : X(x0);
    for (let x = Math.ceil(x0 / sx) * sx; x <= x1 + 1e-9; x += sx) if (Math.abs(x) > 1e-9) g += `<text x="${X(x)}" y="${ax + 14}" class="tick" text-anchor="middle">${fmt(x)}</text>`;
    for (let y = Math.ceil(y0 / sy) * sy; y <= y1 + 1e-9; y += sy) if (Math.abs(y) > 1e-9) g += `<text x="${ay - 6}" y="${Y(y) + 4}" class="tick" text-anchor="end">${fmt(y)}</text>`;
  }
  let body = '';
  for (const el of elements) {
    if (el.tipo === 'circulo' && finite(el.cx) && finite(el.cy) && finite(el.r)) {
      const c = color(el.color, '#ff5a36');
      body += `<circle cx="${X(el.cx)}" cy="${Y(el.cy)}" r="${el.r * S}" fill="${el.relleno === false ? 'none' : c}" fill-opacity=".10" stroke="${c}" stroke-width="2.6"/>`;
    } else if (el.tipo === 'poligono' && Array.isArray(el.puntos) && el.puntos.length >= 2) {
      const c = color(el.color, '#141a24');
      body += `<polygon points="${el.puntos.filter((p) => finite(p[0]) && finite(p[1])).map((p) => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="${el.relleno ? c : 'none'}" fill-opacity=".12" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/>`;
    } else if (el.tipo === 'segmento' && [el.x1, el.y1, el.x2, el.y2].every(finite)) {
      const c = color(el.color, '#141a24');
      body += `<line x1="${X(el.x1)}" y1="${Y(el.y1)}" x2="${X(el.x2)}" y2="${Y(el.y2)}" stroke="${c}" stroke-width="2.2"${el.discontinuo ? ' stroke-dasharray="6 5"' : ''}/>`;
      if (el.etiqueta) body += `<text x="${(X(el.x1) + X(el.x2)) / 2 + 6}" y="${(Y(el.y1) + Y(el.y2)) / 2 - 6}" class="lbl" fill="${c}">${esc(String(el.etiqueta))}</text>`;
    } else if (el.tipo === 'funcion' && typeof el.expresion === 'string') {
      const c = color(el.color, '#1d4ed8'); const a = finite(el.x_min) ? el.x_min : x0, b = finite(el.x_max) ? el.x_max : x1;
      let d = '', pen = false;
      for (let i = 0; i <= 400; i += 1) {
        const x = a + ((b - a) * i) / 400; let y: unknown;
        try { y = evaluate(el.expresion.slice(0, 200), { x }); } catch { y = NaN; }
        if (typeof y !== 'number' || !Number.isFinite(y) || y < y0 - (y1 - y0) || y > y1 + (y1 - y0)) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)} `; pen = true;
      }
      if (!d) throw new Error(`No se pudo evaluar la función «${el.expresion}».`);
      body += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.4"/>`;
      if (el.etiqueta) body += `<text x="${X(b) - 8}" y="${margin + 16}" class="lbl" fill="${c}" text-anchor="end">${esc(String(el.etiqueta))}</text>`;
    } else if (el.tipo === 'texto' && finite(el.x) && finite(el.y)) {
      body += `<text x="${X(el.x)}" y="${Y(el.y)}" class="lbl" fill="${color(el.color, '#141a24')}">${esc(String(el.texto))}</text>`;
    }
  }
  // Los puntos van al final para quedar por encima de todo.
  for (const el of elements) if (el.tipo === 'punto' && finite(el.x) && finite(el.y)) {
    const c = color(el.color, '#1d4ed8');
    body += `<circle cx="${X(el.x)}" cy="${Y(el.y)}" r="5.5" fill="${c}" stroke="#fff" stroke-width="2"/>${el.etiqueta ? `<text x="${X(el.x) + 9}" y="${Y(el.y) - 9}" class="lbl" fill="${c}">${esc(String(el.etiqueta))}</text>` : ''}`;
  }
  const title = spec.titulo ? `<text x="${margin + W / 2}" y="22" class="ttl" text-anchor="middle">${esc(spec.titulo)}</text>` : '';
  const style = '.grid{stroke:#ece8dc;stroke-width:1}.axis{stroke:#141a24;stroke-width:1.6}.tick{font:10px Segoe UI,Arial,sans-serif;fill:#5b6472}.lbl{font:700 12px Segoe UI,Arial,sans-serif}.ttl{font:700 14px Segoe UI,Arial,sans-serif;fill:#141a24}';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + margin * 2} ${H + margin * 2 + (spec.titulo ? 8 : 0)}" role="img"><style>${style}</style>`
    + `<rect x="0" y="0" width="${W + margin * 2}" height="${H + margin * 2 + (spec.titulo ? 8 : 0)}" fill="#fff"/>${title}<g transform="translate(0 ${spec.titulo ? 8 : 0})"><rect x="${margin}" y="${margin}" width="${W}" height="${H}" fill="#fff" stroke="#d9d4c7"/>${g}${body}</g></svg>`;
}
