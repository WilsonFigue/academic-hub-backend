// Herramienta «documento»: arma el trabajo del estudiante a partir de bloques (secciones, pasos, fórmulas, tablas, figuras…).
// Cada documento sale SIEMPRE en dos formatos con el mismo contenido: PDF y Word. Estilo sobrio de trabajo universitario, sin adornos de app.
// Todo el texto se escapa: nada de lo que escribe el modelo se interpreta como HTML. La portada la arma el servidor con los datos del estudiante.
import { AlignmentType, BorderStyle, Document, Footer, ImageRun, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType } from 'docx';
import { PDFDocument } from 'pdf-lib';
import { htmlToPdfCss, htmlToPdfNumbered, svgToPng } from './render.js';

export type Block =
  | { tipo: 'seccion'; titulo: string }
  | { tipo: 'parrafo'; texto: string }
  | { tipo: 'lista'; items: string[]; numerada?: boolean }
  | { tipo: 'formulas'; lineas: string[] }
  | { tipo: 'tabla'; encabezados: string[]; filas: string[][]; pie?: string }
  | { tipo: 'figura'; id: string; pie?: string }
  | { tipo: 'resultado'; texto: string }
  | { tipo: 'codigo'; texto: string }
  | { tipo: 'referencias'; items: string[] };

/** Figura lista para un documento: SVG dibujado por «grafica» o PNG real exportado por «geogebra». */
export type FigureAsset = { svg: string } | { png: Buffer; width: number; height: number };

/** Lo que decide el agente de la portada; todo lo demás lo pone el servidor. */
export interface CoverSpec { titulo: string; subtitulo?: string; unidad?: string }
/** Datos de la portada que solo conoce el servidor (nunca pasan por el modelo). */
export interface CoverData { institution: string; course: string; term: string | null; section: string | null; student: string; carne: string | null; teacher: string | null; city: string; dateText: string }

export interface DocumentSpec { nombre_archivo: string; titulo: string; portada?: CoverSpec; bloques: Block[] }

const ACCENT = '#7a1f45';
const ACCENT_HEX = '7A1F45';
const esc = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** **negrita** y los marcadores [COMPLETAR: …] (resaltados) son lo único con formato dentro del texto. */
const inline = (value: unknown) => esc(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[COMPLETAR:([^\]]*)\]/g, '<span class="todo">[COMPLETAR:$1]</span>');

const coverRows = (cover: CoverData): Array<[string, string]> => [
  ['Estudiante', cover.student], ...(cover.carne ? [['Carné', cover.carne] as [string, string]] : []), ...(cover.teacher ? [['Docente', cover.teacher] as [string, string]] : []),
  ...(cover.section ? [['Sección', `${cover.section} · Aula Virtual`] as [string, string]] : []), ...(cover.term ? [['Ciclo', cover.term.replace(/^Ciclo\s+/i, '')] as [string, string]] : []),
];
const courseLabel = (cover: CoverData, spec: CoverSpec) => [cover.course.toUpperCase(), spec.unidad?.toUpperCase()].filter(Boolean).join(' · ');

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.45 Arial, 'Liberation Sans', Helvetica, sans-serif; color: #111; }
  h1.doc { margin: 0 0 12pt; font-size: 18pt; line-height: 1.2; }
  h2 { margin: 16pt 0 6pt; font-size: 13pt; line-height: 1.25; break-after: avoid; }
  p { margin: 0 0 7pt; }
  ul, ol { margin: 0 0 8pt; padding-left: 22pt; } li { margin-bottom: 3pt; }
  .calc { margin: 6pt 0 8pt 16pt; font-family: 'Cambria Math', Cambria, 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; }
  .calc div { margin: 1pt 0; }
  table.data { margin: 8pt auto; border-collapse: collapse; font-size: 10.5pt; }
  table.data th, table.data td { padding: 4pt 9pt; border: 1px solid #333; text-align: center; }
  table.data th { background: #ececec; }
  .cap { margin: -2pt 0 8pt; text-align: center; font-size: 9.5pt; font-style: italic; color: #333; }
  .answer { margin: 8pt 0; padding: 7pt 12pt; border: 1.2px solid #111; font-weight: 700; break-inside: avoid; }
  figure { margin: 10pt 0; text-align: center; break-inside: avoid; }
  figure svg, figure img { display: block; width: 100%; max-width: 150mm; height: auto; margin: 0 auto; }
  figcaption { margin-top: 3pt; font-size: 9.5pt; font-style: italic; color: #333; }
  pre.code { margin: 6pt 0; padding: 8pt 10pt; border: 1px solid #ddd; background: #f2f2f2; font: 9pt/1.4 Consolas, 'Courier New', monospace; white-space: pre-wrap; }
  .refs p { margin: 0 0 6pt; padding-left: 28pt; text-indent: -28pt; text-align: left; }
  .todo { padding: 0 3px; background: #fff3b0; }
  /* Portada: ocupa la página completa, repartida de arriba a abajo. */
  .cover { display: flex; flex-direction: column; justify-content: space-between; align-items: center; height: 245mm; text-align: center; }
  .inst { margin-top: 8mm; color: ${ACCENT}; font: italic 700 21pt 'Times New Roman', Georgia, serif; }
  .mid { margin-bottom: 18mm; }
  .label { margin: 0 0 12mm; color: ${ACCENT}; font-size: 10.5pt; letter-spacing: 0.02em; }
  .cover h1 { max-width: 140mm; margin: 0 auto 6mm; font-size: 28pt; line-height: 1.2; }
  .sub { margin: 0; color: #555; font-size: 14pt; }
  .mid hr { width: 28mm; margin: 9mm auto 0; border: 0; border-top: 2px solid ${ACCENT}; }
  table.info { margin: 0 auto 12mm; border-collapse: collapse; font-size: 11pt; }
  table.info td { padding: 3pt 8pt; text-align: left; } table.info td.k { color: #666; text-align: right; }
  .when { margin: 0; color: #666; font-size: 10.5pt; }
`;
const PAGE_CSS = '@page { size: A4; margin: 20mm 22mm 22mm; }';

/** HTML de la portada (si la hay) y del contenido, por separado: así la portada no lleva número de página. */
export function renderParts(spec: DocumentSpec, figures: Map<string, FigureAsset>, cover: CoverData | null): { cover: string | null; body: string } {
  let figureNumber = 0;
  const body = spec.bloques.map((block) => {
    switch (block.tipo) {
      case 'seccion': return `<h2>${esc(block.titulo)}</h2>`;
      case 'parrafo': return `<p>${inline(block.texto)}</p>`;
      case 'lista': return block.numerada ? `<ol>${block.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>` : `<ul>${block.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
      case 'formulas': return `<div class="calc">${block.lineas.map((l) => `<div>${inline(l)}</div>`).join('')}</div>`;
      case 'tabla': return `<table class="data"><tr>${block.encabezados.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>${block.filas.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>${block.pie ? `<p class="cap">${inline(block.pie)}</p>` : ''}`;
      case 'figura': {
        const asset = figures.get(block.id);
        if (!asset) return `<p><span class="todo">[COMPLETAR: figura «${esc(block.id)}»]</span></p>`;
        figureNumber += 1;
        const image = 'svg' in asset ? asset.svg : `<img alt="${esc(block.pie ?? block.id)}" src="data:image/png;base64,${asset.png.toString('base64')}">`;
        return `<figure>${image}${block.pie ? `<figcaption>Figura ${figureNumber}. ${inline(block.pie)}</figcaption>` : ''}</figure>`;
      }
      case 'resultado': return `<div class="answer">${inline(block.texto)}</div>`;
      case 'codigo': return `<pre class="code">${esc(block.texto)}</pre>`;
      case 'referencias': return `<div class="refs">${block.items.map((i) => `<p>${inline(i)}</p>`).join('')}</div>`;
      default: return '';
    }
  }).join('');
  const portada = cover && spec.portada ? `<section class="cover">
    <div class="inst">${esc(cover.institution)}</div>
    <div class="mid"><p class="label">${esc(courseLabel(cover, spec.portada))}</p><h1>${esc(spec.portada.titulo)}</h1>${spec.portada.subtitulo ? `<p class="sub">${esc(spec.portada.subtitulo)}</p>` : ''}<hr></div>
    <div><table class="info">${coverRows(cover).map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table><p class="when">${esc(cover.city)}, ${esc(cover.dateText)}</p></div>
  </section>` : '';
  const hasCover = portada !== '';
  const page = (inner: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(spec.titulo)}</title><style>${PAGE_CSS}${CSS}</style></head><body>${inner}</body></html>`;
  return { cover: hasCover ? page(portada) : null, body: page(`${hasCover ? '' : `<h1 class="doc">${esc(spec.titulo)}</h1>`}${body}`) };
}

// ── Word ────────────────────────────────────────────────────────────────────
const FONT = 'Arial';
function runs(value: unknown, base: { size?: number; bold?: boolean; font?: string; color?: string; italics?: boolean } = {}): TextRun[] {
  const out: TextRun[] = []; const text = String(value ?? '');
  const re = /\*\*(.+?)\*\*|\[COMPLETAR:[^\]]*\]/g; let last = 0; let m: RegExpExecArray | null;
  const push = (t: string, extra: object = {}) => { if (t) out.push(new TextRun({ text: t, font: base.font ?? FONT, size: base.size ?? 22, bold: base.bold, color: base.color, italics: base.italics, ...extra })); };
  while ((m = re.exec(text))) { push(text.slice(last, m.index)); if (m[1]) push(m[1], { bold: true }); else push(m[0], { bold: true, highlight: 'yellow' }); last = m.index + m[0].length; }
  push(text.slice(last));
  return out;
}
const para = (value: unknown, o: { after?: number; before?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; indent?: number; font?: string; size?: number; bold?: boolean; color?: string; italics?: boolean } = {}) =>
  new Paragraph({ children: runs(value, { font: o.font, size: o.size, bold: o.bold, color: o.color, italics: o.italics }), spacing: { after: o.after ?? 120, before: o.before ?? 0, line: 300 }, alignment: o.align ?? AlignmentType.LEFT, indent: o.indent ? { left: o.indent } : undefined });
const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const noBorders = { top: none, bottom: none, left: none, right: none } as const;

function coverChildren(spec: DocumentSpec, cover: CoverData): Array<Paragraph | Table> {
  const portada = spec.portada!;
  const info = new Table({
    alignment: AlignmentType.CENTER, width: { size: 78, type: WidthType.PERCENTAGE }, borders: { ...noBorders, insideHorizontal: none, insideVertical: none },
    rows: coverRows(cover).map(([k, v]) => new TableRow({ children: [
      new TableCell({ width: { size: 38, type: WidthType.PERCENTAGE }, borders: noBorders, verticalAlign: VerticalAlign.CENTER, children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 40 }, children: [new TextRun({ text: k, font: FONT, size: 22, color: '666666' })] })] }),
      new TableCell({ width: { size: 62, type: WidthType.PERCENTAGE }, borders: noBorders, verticalAlign: VerticalAlign.CENTER, margins: { left: 160 }, children: [new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: v, font: FONT, size: 22, bold: true })] })] }),
    ] })),
  });
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400, after: 2200 }, children: [new TextRun({ text: cover.institution, font: 'Times New Roman', size: 42, bold: true, italics: true, color: ACCENT_HEX })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 360 }, children: [new TextRun({ text: courseLabel(cover, portada), font: FONT, size: 21, color: ACCENT_HEX })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160, line: 340 }, children: [new TextRun({ text: portada.titulo, font: FONT, size: 56, bold: true })] }),
    ...(portada.subtitulo ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: portada.subtitulo, font: FONT, size: 28, color: '555555' })] })] : []),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 2400 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT_HEX, space: 1 } }, indent: { left: 3700, right: 3700 }, children: [] }),
    info,
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 700 }, children: [new TextRun({ text: `${cover.city}, ${cover.dateText}`, font: FONT, size: 21, color: '666666' })] }),
  ];
}

export async function buildDocx(spec: DocumentSpec, figures: Map<string, FigureAsset>, cover: CoverData | null): Promise<Buffer> {
  const hasCover = Boolean(cover && spec.portada);
  const children: Array<Paragraph | Table> = [];
  if (!hasCover) children.push(para(spec.titulo, { size: 36, bold: true, after: 200 }));
  let figureNumber = 0;
  for (const block of spec.bloques) {
    switch (block.tipo) {
      case 'seccion': children.push(new Paragraph({ keepNext: true, spacing: { before: 280, after: 100 }, children: [new TextRun({ text: block.titulo, font: FONT, size: 26, bold: true })] })); break;
      case 'parrafo': children.push(para(block.texto)); break;
      case 'lista': block.items.forEach((item, i) => children.push(new Paragraph({ children: runs(block.numerada ? `${i + 1}. ${item}` : item), bullet: block.numerada ? undefined : { level: 0 }, indent: block.numerada ? { left: 360 } : undefined, spacing: { after: 60, line: 300 } }))); break;
      case 'formulas': block.lineas.forEach((l) => children.push(new Paragraph({ children: runs(l, { font: 'Cambria Math', size: 24 }), spacing: { after: 40 }, indent: { left: 360 } }))); break;
      case 'resultado': children.push(new Paragraph({ children: runs(block.texto, { bold: true }), spacing: { before: 120, after: 160 }, border: { top: { style: 'single', size: 8, color: '111111', space: 4 }, bottom: { style: 'single', size: 8, color: '111111', space: 4 }, left: { style: 'single', size: 8, color: '111111', space: 4 }, right: { style: 'single', size: 8, color: '111111', space: 4 } } })); break;
      case 'referencias': block.items.slice(0, 60).forEach((item) => children.push(new Paragraph({ children: runs(item), spacing: { after: 100, line: 300 }, indent: { left: 560, hanging: 560 } }))); break;
      case 'codigo': block.texto.split('\n').slice(0, 400).forEach((l) => children.push(new Paragraph({ children: runs(l || ' ', { font: 'Consolas', size: 19 }), spacing: { after: 0 }, shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' } }))); children.push(para(' ', { after: 80 })); break;
      case 'tabla': {
        const cols = Math.max(block.encabezados.length, 1);
        const cell = (t: string, head = false) => new TableCell({ width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE }, shading: head ? { type: ShadingType.CLEAR, fill: 'ECECEC' } : undefined, children: [new Paragraph({ children: runs(t, { size: 21, bold: head }), alignment: AlignmentType.CENTER, spacing: { after: 40 } })] });
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: block.encabezados.map((h) => cell(h, true)) }), ...block.filas.slice(0, 300).map((r) => new TableRow({ children: Array.from({ length: cols }, (_, i) => cell(r[i] ?? '')) }))] }));
        children.push(block.pie ? para(block.pie, { before: 60, after: 160, align: AlignmentType.CENTER, size: 19, italics: true }) : para(' ', { after: 80 }));
        break;
      }
      case 'figura': {
        const asset = figures.get(block.id);
        if (!asset) { children.push(para(`[COMPLETAR: figura «${block.id}»]`)); break; }
        figureNumber += 1;
        const width = 470; let data: Buffer; let ratio: number;
        if ('png' in asset) { data = asset.png; ratio = asset.height / asset.width; }
        else { const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(asset.svg); ratio = vb ? Number(vb[2]) / Number(vb[1]) : 0.8; data = await svgToPng(asset.svg, 1000); }
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, keepNext: Boolean(block.pie), children: [new ImageRun({ type: 'png', data, transformation: { width, height: Math.round(width * ratio) } })], spacing: { before: 80, after: 40 } }));
        if (block.pie) children.push(para(`Figura ${figureNumber}. ${block.pie}`, { after: 160, align: AlignmentType.CENTER, size: 19, italics: true }));
        break;
      }
      default: break;
    }
  }
  const margin = { top: 1134, bottom: 1250, left: 1247, right: 1247 };
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: '444444' })] })] });
  const sections = hasCover
    ? [{ properties: { page: { margin } }, children: coverChildren(spec, cover!) }, { properties: { page: { margin, pageNumbers: { start: 1 } } }, footers: { default: footer }, children }]
    : [{ properties: { page: { margin } }, footers: { default: footer }, children }];
  const doc = new Document({ creator: '', title: spec.titulo, sections });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Los dos formatos del mismo documento. */
export async function buildDocumentFiles(spec: DocumentSpec, figures: Map<string, FigureAsset>, cover: CoverData | null): Promise<{ pdf: Buffer; docx: Buffer }> {
  const parts = renderParts(spec, figures, cover);
  const [body, coverPdf, docx] = await Promise.all([htmlToPdfNumbered(parts.body), parts.cover ? htmlToPdfCss(parts.cover) : Promise.resolve(null), buildDocx(spec, figures, cover)]);
  if (!coverPdf) return { pdf: body, docx };
  // Portada (sin número) + contenido (numerado desde la página 1), en un solo PDF.
  const merged = await PDFDocument.create();
  for (const bytes of [coverPdf, body]) { const source = await PDFDocument.load(bytes); for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page); }
  return { pdf: Buffer.from(await merged.save()), docx };
}
