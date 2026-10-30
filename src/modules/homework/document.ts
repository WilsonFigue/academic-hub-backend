// Herramienta «documento»: arma el PDF o el Word final a partir de bloques (secciones, pasos, fórmulas, tablas, figuras…).
// Todo el texto se escapa: nada de lo que escribe el modelo se interpreta como HTML. PDF con el mismo estilo que las guías.
import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, ShadingType } from 'docx';
import { CSS } from '../guides/pdf.js';
import { htmlToPdf, svgToPng } from './render.js';

export type Block =
  | { tipo: 'seccion'; titulo: string }
  | { tipo: 'parrafo'; texto: string }
  | { tipo: 'lista'; items: string[]; numerada?: boolean }
  | { tipo: 'formulas'; lineas: string[] }
  | { tipo: 'tabla'; encabezados: string[]; filas: string[][]; pie?: string }
  | { tipo: 'figura'; id: string; pie?: string }
  | { tipo: 'resultado'; texto: string }
  | { tipo: 'codigo'; texto: string };

export interface DocumentSpec {
  formato: 'pdf' | 'docx';
  nombre_archivo: string;
  titulo: string;
  etiqueta?: string;
  meta?: string[];
  resumen?: string;
  bloques: Block[];
}

const FOOTER = 'Academic Hub · Tarea (borrador con IA)';
const esc = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** **negrita** y los marcadores [COMPLETAR: …] (resaltados) son lo único con formato dentro del texto. */
const inline = (value: unknown) => esc(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[COMPLETAR:([^\]]*)\]/g, '<span class="todo">[COMPLETAR:$1]</span>');

const EXTRA_CSS = `
  .calc { margin:6px 0; padding:9px 14px; border-radius:10px; background:#f4f2ec; font-family:'Cambria Math','Cambria','Times New Roman',serif; font-size:12pt; break-inside:avoid }
  .calc div { margin:3px 0 }
  table.data { border-collapse:collapse; margin:8px 0; font-size:10.5pt; max-width:100% } table.data th, table.data td { border:1px solid #d9d4c7; padding:5px 10px; text-align:center }
  table.data th { background:#ffe3da; color:#7c2d12 }
  .answer { margin:10px 0; padding:11px 16px; border-radius:12px; background:#fff1ec; border:1.6px solid #ff5a36; font-weight:600; break-inside:avoid }
  figure { margin:8px 0; break-inside:avoid } figure svg { width:100%; max-width:540px; display:block; margin:0 auto } figcaption { text-align:center; font-size:9pt; color:#5b6472; margin-top:2px }
  pre.code { margin:6px 0; padding:10px 14px; border-radius:10px; background:#141a24; color:#e8eaf0; font:9.5pt Consolas,monospace; white-space:pre-wrap; break-inside:avoid }
  .todo { background:#fff7e6; border:1px dashed #d99a1b; padding:1px 6px; border-radius:6px; font-weight:700; color:#92400e }
  h2 { page-break-after: avoid } ol.steps li, ul.bullets li { white-space: normal }
`;

export function renderDocumentHtml(spec: DocumentSpec, figures: Map<string, string>): string {
  let n = 0;
  const parts = spec.bloques.map((block) => {
    switch (block.tipo) {
      case 'seccion': n += 1; return `<section><h2><span class="n">${n}</span>${esc(block.titulo)}</h2>`;
      case 'parrafo': return `<p>${inline(block.texto)}</p>`;
      case 'lista': return block.numerada ? `<ol class="steps">${block.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>` : `<ul class="bullets">${block.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
      case 'formulas': return `<div class="calc">${block.lineas.map((l) => `<div>${inline(l)}</div>`).join('')}</div>`;
      case 'tabla': return `<table class="data"><tr>${block.encabezados.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>${block.filas.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>${block.pie ? `<p class="figcap" style="font-size:9pt;color:#5b6472">${inline(block.pie)}</p>` : ''}`;
      case 'figura': { const svg = figures.get(block.id); return svg ? `<figure>${svg}${block.pie ? `<figcaption>${inline(block.pie)}</figcaption>` : ''}</figure>` : `<p><span class="todo">[COMPLETAR: figura «${esc(block.id)}»]</span></p>`; }
      case 'resultado': return `<div class="answer">${inline(block.texto)}</div>`;
      case 'codigo': return `<pre class="code">${esc(block.texto)}</pre>`;
      default: return '';
    }
  });
  // Cada «seccion» abre un <section>; se cierra antes de la siguiente y al final.
  const html: string[] = []; let open = false;
  spec.bloques.forEach((block, i) => { if (block.tipo === 'seccion') { if (open) html.push('</section>'); open = true; } html.push(parts[i]!); });
  if (open) html.push('</section>');
  const meta = (spec.meta ?? []).slice(0, 6).map((m) => `<span>${inline(m)}</span>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(spec.titulo)}</title><style>${CSS}${EXTRA_CSS}</style></head><body>
    <header class="hero">${spec.etiqueta ? `<p class="kicker">${esc(spec.etiqueta)}</p>` : ''}<h1>${esc(spec.titulo)}</h1>${meta ? `<div class="meta">${meta}</div>` : ''}</header>
    ${spec.resumen ? `<p class="summary">${inline(spec.resumen)}</p>` : ''}${html.join('')}
    <p class="foot">Borrador generado con IA a partir de las instrucciones y del material de tu materia. Revísalo y complétalo antes de entregarlo.</p></body></html>`;
}

// ── Word ────────────────────────────────────────────────────────────────────
const FONT = 'Calibri';
function runs(value: unknown, base: { size?: number; bold?: boolean; font?: string } = {}): TextRun[] {
  const out: TextRun[] = []; const text = String(value ?? '');
  const re = /\*\*(.+?)\*\*|\[COMPLETAR:[^\]]*\]/g; let last = 0; let m: RegExpExecArray | null;
  const push = (t: string, extra: object = {}) => { if (t) out.push(new TextRun({ text: t, font: base.font ?? FONT, size: base.size ?? 22, bold: base.bold, ...extra })); };
  while ((m = re.exec(text))) { push(text.slice(last, m.index)); if (m[1]) push(m[1], { bold: true }); else push(m[0], { bold: true, highlight: 'yellow' }); last = m.index + m[0].length; }
  push(text.slice(last));
  return out;
}
const para = (value: unknown, o: { after?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; mono?: boolean } = {}) =>
  new Paragraph({ children: runs(value, o.mono ? { font: 'Consolas', size: 20 } : {}), spacing: { after: o.after ?? 120, line: 320 }, alignment: o.align ?? AlignmentType.LEFT });

export async function buildDocx(spec: DocumentSpec, figures: Map<string, string>): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ children: [new TextRun({ text: spec.titulo, font: FONT, size: 36, bold: true })], spacing: { after: 80 } }),
  ];
  if (spec.etiqueta || (spec.meta ?? []).length) children.push(para([spec.etiqueta, ...(spec.meta ?? [])].filter(Boolean).join('  ·  '), { after: 200 }));
  if (spec.resumen) children.push(para(spec.resumen, { after: 200 }));
  for (const block of spec.bloques) {
    switch (block.tipo) {
      case 'seccion': children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: block.titulo, font: FONT, size: 28, bold: true })], spacing: { before: 280, after: 120 } })); break;
      case 'parrafo': children.push(para(block.texto, { align: AlignmentType.JUSTIFIED })); break;
      case 'lista': block.items.forEach((item, i) => children.push(new Paragraph({ children: runs(block.numerada ? `${i + 1}. ${item}` : item), bullet: block.numerada ? undefined : { level: 0 }, indent: block.numerada ? { left: 360 } : undefined, spacing: { after: 80, line: 320 } }))); break;
      case 'formulas': block.lineas.forEach((l) => children.push(new Paragraph({ children: runs(l, { font: 'Cambria Math', size: 24 }), spacing: { after: 60 }, indent: { left: 360 } }))); break;
      case 'resultado': children.push(new Paragraph({ children: runs(block.texto, { bold: true }), spacing: { before: 80, after: 160 }, shading: { type: ShadingType.CLEAR, fill: 'FFF1EC' }, border: { top: { style: 'single', size: 6, color: 'FF5A36', space: 4 }, bottom: { style: 'single', size: 6, color: 'FF5A36', space: 4 }, left: { style: 'single', size: 6, color: 'FF5A36', space: 4 }, right: { style: 'single', size: 6, color: 'FF5A36', space: 4 } } })); break;
      case 'codigo': block.texto.split('\n').slice(0, 400).forEach((l) => children.push(para(l || ' ', { after: 0, mono: true }))); children.push(para(' ', { after: 80 })); break;
      case 'tabla': {
        const cols = Math.max(block.encabezados.length, 1);
        const cell = (t: string, head = false) => new TableCell({ width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE }, shading: head ? { type: ShadingType.CLEAR, fill: 'FFE3DA' } : undefined, children: [new Paragraph({ children: runs(t, { size: 20, bold: head }), alignment: AlignmentType.CENTER, spacing: { after: 40 } })] });
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: block.encabezados.map((h) => cell(h, true)) }), ...block.filas.slice(0, 300).map((r) => new TableRow({ children: Array.from({ length: cols }, (_, i) => cell(r[i] ?? '')) }))] }));
        if (block.pie) children.push(para(block.pie, { after: 160, align: AlignmentType.CENTER })); else children.push(para(' ', { after: 80 }));
        break;
      }
      case 'figura': {
        const svg = figures.get(block.id);
        if (!svg) { children.push(para(`[COMPLETAR: figura «${block.id}»]`)); break; }
        const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg); const ratio = vb ? Number(vb[2]) / Number(vb[1]) : 0.8;
        const width = 520;
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: await svgToPng(svg, 1000), transformation: { width, height: Math.round(width * ratio) } })], spacing: { before: 80, after: 40 } }));
        if (block.pie) children.push(para(block.pie, { after: 160, align: AlignmentType.CENTER }));
        break;
      }
      default: break;
    }
  }
  const doc = new Document({ creator: 'Academic Hub (borrador con IA)', title: spec.titulo, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function buildDocumentFile(spec: DocumentSpec, figures: Map<string, string>): Promise<Buffer> {
  return spec.formato === 'docx' ? buildDocx(spec, figures) : htmlToPdf(renderDocumentHtml(spec, figures), FOOTER);
}
