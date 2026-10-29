// Vista previa de archivos: texto y estructura de PDF, Word, PowerPoint y Excel, sin conversores externos.
// El HTML que se devuelve se construye aquí solo con texto escapado; nunca se copia HTML del archivo original.
import { strFromU8, unzipSync } from 'fflate';

export type Preview =
  | { kind: 'docx'; html: string; text: string; images: number }
  | { kind: 'pptx'; slides: Array<{ n: number; title: string; lines: string[] }>; text: string }
  | { kind: 'xlsx'; sheets: Array<{ name: string; rows: string[][]; truncated: boolean }>; text: string }
  | { kind: 'pdf'; pages: number; text: string; scanned: boolean }
  | { kind: 'text'; text: string };

const MAX_TEXT = 1_500_000;
const MAX_ROWS = 200;
const MAX_COLS = 30;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
  if (code[0] === '#') {
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : match;
  }
  return ENTITIES[code.toLowerCase()] ?? match;
});
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  // Se descomprimen solo las partes necesarias (evita expandir medios pesados).
  return unzipSync(bytes, { filter: (file) => /^(word\/(document|styles)\.xml|word\/media\/.+|ppt\/slides\/slide\d+\.xml|xl\/(workbook|sharedStrings)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/[^/]+\.xml)$/.test(file.name) && file.originalSize < 40_000_000 });
}
const read = (files: Record<string, Uint8Array>, name: string) => (files[name] ? strFromU8(files[name]) : '');

// ── Word ──
/** Texto de un párrafo de Word con negrita y cursiva; tabulaciones y saltos como espacio o <br>. */
function wordRuns(paragraph: string): { html: string; text: string } {
  let html = '';
  let text = '';
  for (const run of paragraph.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? []) {
    const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';
    const bold = /<w:b(?: [^>]*)?\/>/.test(props) && !/<w:b w:val="(?:0|false)"/.test(props);
    const italic = /<w:i(?: [^>]*)?\/>/.test(props) && !/<w:i w:val="(?:0|false)"/.test(props);
    let piece = '';
    for (const part of run.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) piece += part[1] !== undefined ? decode(part[1]) : part[0] === '<w:tab/>' ? '\t' : '\n';
    if (!piece) continue;
    text += piece;
    let out = escapeHtml(piece).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
    if (bold) out = `<strong>${out}</strong>`;
    if (italic) out = `<em>${out}</em>`;
    html += out;
  }
  return { html, text };
}

export function previewDocx(bytes: Uint8Array): Preview {
  const files = unzip(bytes);
  const xml = read(files, 'word/document.xml');
  if (!xml) throw new Error('docx_invalid');
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const out: string[] = [];
  const plain: string[] = [];
  let list = false;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const block of body.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    if (block.startsWith('<w:tbl>')) {
      closeList();
      const rows = (block.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map((row) => (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((cell) => (cell.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) => wordRuns(p).text).join(' ').trim()));
      out.push(`<table>${rows.map((row, i) => `<tr>${row.map((cell) => `<${i === 0 ? 'th' : 'td'}>${escapeHtml(cell)}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table>`);
      plain.push(rows.map((row) => row.join(' | ')).join('\n'));
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? '';
    const { html, text } = wordRuns(block);
    if (!text.trim()) { closeList(); continue; }
    const heading = /^(?:Heading|Ttulo|Título|Title)\s*(\d)?$/i.exec(style);
    if (heading) {
      closeList();
      const level = Math.min(4, Math.max(2, Number(heading[1] ?? 1) + 1));
      out.push(`<h${level}>${escapeHtml(text.trim())}</h${level}>`);
    } else if (/<w:numPr>/.test(block)) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${html}</li>`);
    } else {
      closeList();
      out.push(`<p>${html}</p>`);
    }
    plain.push(text);
  }
  closeList();
  const images = Object.keys(files).filter((name) => name.startsWith('word/media/')).length;
  return { kind: 'docx', html: cut(out.join('')), text: cut(plain.join('\n')), images };
}

// ── PowerPoint ──
export function previewPptx(bytes: Uint8Array): Preview {
  const files = unzip(bytes);
  const names = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (names.length === 0) throw new Error('pptx_invalid');
  const slides = names.map((name, index) => {
    const lines = (strFromU8(files[name]!).match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1]!)).join(''))
      .map((line) => line.trim()).filter(Boolean);
    return { n: index + 1, title: lines[0] ?? `Diapositiva ${index + 1}`, lines: lines.slice(1) };
  });
  return { kind: 'pptx', slides, text: cut(slides.map((s) => [s.title, ...s.lines].join('\n')).join('\n\n')) };
}

// ── Excel ──
const colIndex = (ref: string) => [...(/^([A-Z]+)/.exec(ref)?.[1] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function previewXlsx(bytes: Uint8Array): Preview {
  const files = unzip(bytes);
  const shared = (read(files, 'xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) => [...si.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1]!)).join(''));
  const rels = new Map([...read(files, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  const sheets: Array<{ name: string; rows: string[][]; truncated: boolean }> = [];
  for (const sheet of read(files, 'xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const target = rels.get(sheet[2]!)?.replace(/^\/?(xl\/)?/, 'xl/');
    const xml = target ? read(files, target) : '';
    if (!xml) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const row of xml.match(/<row [\s\S]*?<\/row>/g) ?? []) {
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      const cells: string[] = [];
      for (const cell of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(cell[1]!)?.[1];
        if (!ref || colIndex(ref) >= MAX_COLS) continue;
        const type = /t="([^"]+)"/.exec(cell[1]!)?.[1];
        const inner = cell[2] ?? '';
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        cells[colIndex(ref)] = type === 's' && value !== undefined ? shared[Number(value)] ?? '' : type === 'inlineStr' ? decode(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '') : decode(value ?? '');
      }
      rows.push(Array.from(cells, (c) => c ?? ''));
    }
    sheets.push({ name: decode(sheet[1]!), rows, truncated });
  }
  if (sheets.length === 0) throw new Error('xlsx_invalid');
  return { kind: 'xlsx', sheets, text: cut(sheets.map((s) => `${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`).join('\n\n')) };
}

// ── PDF ──
export async function previewPdf(bytes: Uint8Array): Promise<Preview> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const joined = pages.map((page, i) => `— Página ${i + 1} —\n${page.trim()}`).join('\n\n');
  const scanned = pages.every((page) => page.replace(/\s+/g, '').length < 10);
  return { kind: 'pdf', pages: pages.length, text: scanned ? '' : cut(joined), scanned };
}

export const OFFICE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/** ¿Hay una forma de leer este archivo como texto? (evita descargar videos o imágenes solo para intentarlo). */
export function isPreviewable(mimeType: string, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return mimeType === OFFICE.docx || mimeType === OFFICE.pptx || mimeType === OFFICE.xlsx || mimeType === 'application/pdf' || mimeType.startsWith('text/')
    || /\.(docx|pptx|xlsx|pdf|txt|csv|md|json)$/.test(lower);
}

/** Vista previa según el tipo de archivo; null si no hay una forma de leerlo (p. ej. video, .doc antiguo). */
export async function previewFile(bytes: Uint8Array, mimeType: string, fileName: string): Promise<Preview | null> {
  const lower = fileName.toLowerCase();
  if (mimeType === OFFICE.docx || lower.endsWith('.docx')) return previewDocx(bytes);
  if (mimeType === OFFICE.pptx || lower.endsWith('.pptx')) return previewPptx(bytes);
  if (mimeType === OFFICE.xlsx || lower.endsWith('.xlsx')) return previewXlsx(bytes);
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) return previewPdf(bytes);
  if (mimeType.startsWith('text/') || /\.(txt|csv|md|json)$/.test(lower)) return { kind: 'text', text: cut(Buffer.from(bytes).toString('utf8')) };
  return null;
}
