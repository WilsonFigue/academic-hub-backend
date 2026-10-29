// Archivos FICTICIOS para la demostración: una carpeta con guía (Word), diapositivas, hoja de cálculo, PDF, imagen y un video enlazado,
// ligada a la actividad "Quiz semana 9" de Cálculo II. Escribe copias locales en .state/files (como si ya se hubieran abierto una vez).
// Uso: DB_SCHEMA=academic_hub_demo npx tsx scripts/demo-files.ts   (idempotente; nunca toca el esquema de trabajo)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';

const config = readConfig();
if (config.dbSchema === 'academic_hub' || !config.dbSchema.endsWith('_demo')) {
  console.error('Usa DB_SCHEMA=academic_hub_demo: este script nunca escribe en el esquema de trabajo.');
  process.exit(1);
}
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 2 });
const FILES = join(process.cwd(), '.state', 'files');
mkdirSync(FILES, { recursive: true });

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf', png: 'image/png',
};

const p = (text: string, style = '', bold = false) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
    p('Guía de actividad · Quiz semana 9', 'Heading1'),
    p('Series de potencias y convergencia', 'Heading2'),
    p('Lee las secciones 9.1 a 9.3 y resuelve los ejercicios propuestos antes del quiz.'),
    p('Qué debes saber', '', true),
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Radio e intervalo de convergencia.</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Criterio del cociente y de la raíz.</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Series de Taylor de funciones elementales.</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Criterio</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Puntos</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Procedimiento correcto</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Justificación de la convergencia</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>8</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    p('Formato de entrega: el quiz se responde en línea durante la clase.'),
  ].join('')}</w:body></w:document>`),
});
const pptx = zipSync({
  'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Series de potencias</a:t></a:r></a:p><a:p><a:r><a:t>Cálculo II · Semana 9</a:t></a:r></a:p></p:sld>'),
  'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Definición</a:t></a:r></a:p><a:p><a:r><a:t>Una serie de potencias es una suma infinita de términos c_n (x − a)^n.</a:t></a:r></a:p><a:p><a:r><a:t>Su convergencia depende de x.</a:t></a:r></a:p></p:sld>'),
  'ppt/slides/slide3.xml': strToU8('<p:sld><a:p><a:r><a:t>Radio de convergencia</a:t></a:r></a:p><a:p><a:r><a:t>R = lim |c_n / c_(n+1)|</a:t></a:r></a:p></p:sld>'),
});
const xlsx = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  'xl/workbook.xml': strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ejercicios" sheetId="1" r:id="rId1"/><sheet name="Resumen" sheetId="2" r:id="rId2"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
  'xl/sharedStrings.xml': strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Ejercicio</t></si><si><t>Tema</t></si><si><t>Puntos</t></si><si><t>Series geométricas</t></si><si><t>Criterio del cociente</t></si><si><t>Total</t></si></sst>'),
  'xl/worksheets/sheet1.xml': strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>5</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3" t="s"><v>4</v></c><c r="C3"><v>7</v></c></row></sheetData></worksheet>'),
  'xl/worksheets/sheet2.xml': strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c><c r="B1"><v>12</v></c></row></sheetData></worksheet>'),
});

/** PDF mínimo de dos páginas con texto (Helvetica). */
function pdf(): Buffer {
  const pages = ['Series de potencias: resumen. Convergencia, radio e intervalo.', 'Ejercicios resueltos: criterio del cociente y de la raiz.'];
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((text, i) => {
    const stream = `BT /F1 20 Tf 60 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** PNG de degradado 160×90, generado sin dependencias. */
function png(): Buffer {
  const w = 160; const h = 90;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 255 - x; raw[o + 1] = 80 + y; raw[o + 2] = 120 + (x >> 1); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const byte of b) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

try {
  const { rows } = await db.query<{ enrollment_id: string; course_id: string; column_id: string }>(
    `SELECT ce.id AS enrollment_id, ce.course_id, gc.id AS column_id
       FROM users u JOIN external_accounts ea ON ea.user_id = u.id JOIN course_enrollments ce ON ce.external_account_id = ea.id
       JOIN gradebook_columns gc ON gc.course_id = ce.course_id AND gc.name = 'Quiz semana 9'
      WHERE u.username = 'camila.rivas' LIMIT 1`);
  const base = rows[0];
  if (!base) throw new Error('No encontré la actividad "Quiz semana 9" de la demo; corre primero demo-seed.');
  await db.query(`UPDATE gradebook_columns SET content_item_id = NULL, content_external_id = NULL WHERE id = $1`, [base.column_id]);
  await db.query(`DELETE FROM course_content_items WHERE course_id = $1 AND external_id LIKE '_demo_%'`, [base.course_id]);

  const insert = async (external: string, handler: string, title: string, parent: string | null, position: number, detail: unknown, extra: { url?: string; body?: string } = {}) =>
    (await db.query<{ id: string }>(
      `INSERT INTO course_content_items (course_id, external_id, parent_external_id, handler, title, position, depth, content_detail, external_url, body_text, body_html_sanitized)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [base.course_id, external, parent, handler, title, position, parent ? 1 : 0, detail ? JSON.stringify(detail) : null, extra.url ?? null, extra.body ? extra.body.replace(/<[^>]+>/g, '') : null, extra.body ?? null])).rows[0]!.id;
  const file = (name: string, mimeType: string, size: number) => ({ file: { xid: 'xid-demo', fileName: name, mimeType, fileSize: size, permanentUrl: '/bbcswebdav/pid-demo-dt-content-rid-demo/xid-demo' } });

  const folder = await insert('_demo_folder', 'resource/x-bb-folder', 'Semana 9 · Series de potencias', null, 90, { isFolder: true });
  const pdfBytes = pdf(); const pngBytes = png(); const docxBytes = Buffer.from(docx); const pptxBytes = Buffer.from(pptx); const xlsxBytes = Buffer.from(xlsx);
  const items = [
    ['_demo_guide', 'Guía de actividad Quiz semana 9', 'Guía de actividad Quiz semana 9.docx', MIME.docx, docxBytes],
    ['_demo_slides', 'Presentación: Series de potencias', 'Series de potencias.pptx', MIME.pptx, pptxBytes],
    ['_demo_sheet', 'Ejercicios y puntajes', 'Ejercicios semana 9.xlsx', MIME.xlsx, xlsxBytes],
    ['_demo_pdf', 'Resumen de la semana (PDF)', 'Resumen semana 9.pdf', MIME.pdf, pdfBytes],
    ['_demo_img', 'Diagrama de convergencia', 'Convergencia.png', MIME.png, pngBytes],
  ] as const;
  const ids: string[] = [folder];
  let position = 0;
  for (const [external, title, fileName, mime, bytes] of items) {
    const id = await insert(external, 'resource/x-bb-file', title, '_demo_folder', position++, file(fileName, mime, bytes.length));
    writeFileSync(join(FILES, id), bytes);
    ids.push(id);
  }
  ids.push(await insert('_demo_video', 'resource/x-bb-externallink', 'Video: convergencia explicada', '_demo_folder', position++, { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }, { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }));
  ids.push(await insert('_demo_doc', 'resource/x-bb-document', 'Notas del docente', '_demo_folder', position++, null, { body: '<div><h4>Antes del quiz</h4><p>Repasa la <strong>definición</strong> de serie de potencias y practica con tres ejercicios del libro.</p><ul><li>Radio de convergencia</li><li>Intervalo de convergencia</li></ul></div>' }));
  const task = await insert('_demo_task', 'resource/x-bb-asmt-test-link', 'Quiz semana 9', '_demo_folder', position++, { test: {} });
  ids.push(task);
  await db.query(`UPDATE course_content_items child SET parent_id = parent.id FROM course_content_items parent WHERE child.course_id = $1 AND parent.course_id = $1 AND parent.external_id = child.parent_external_id AND child.external_id LIKE '_demo_%'`, [base.course_id]);
  await db.query(`UPDATE gradebook_columns SET content_item_id = $2, content_external_id = '_demo_task' WHERE id = $1`, [base.column_id, task]);
  for (const id of ids) {
    await db.query(`INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id, visibility) VALUES ($1, $2, $3, 'VISIBLE') ON CONFLICT DO NOTHING`, [base.enrollment_id, id, base.course_id]);
  }
  // Una marca ya enviada y una pendiente, y un contenido que UTEC ya muestra completado.
  const guide = (await db.query<{ id: string }>(`SELECT id FROM course_content_items WHERE course_id = $1 AND external_id = '_demo_slides'`, [base.course_id])).rows[0]!.id;
  const sheet = (await db.query<{ id: string }>(`SELECT id FROM course_content_items WHERE course_id = $1 AND external_id = '_demo_sheet'`, [base.course_id])).rows[0]!.id;
  const pdfId = (await db.query<{ id: string }>(`SELECT id FROM course_content_items WHERE course_id = $1 AND external_id = '_demo_pdf'`, [base.course_id])).rows[0]!.id;
  await db.query(`INSERT INTO content_review_marks (enrollment_id, content_item_id, course_id, state, sent_at) VALUES ($1, $2, $3, 'sent', now()) ON CONFLICT DO NOTHING`, [base.enrollment_id, guide, base.course_id]);
  await db.query(`INSERT INTO content_review_marks (enrollment_id, content_item_id, course_id, state) VALUES ($1, $2, $3, 'pending') ON CONFLICT DO NOTHING`, [base.enrollment_id, sheet, base.course_id]);
  await db.query(`UPDATE enrollment_content_visibility SET completion = '{"total":1,"started":1,"completed":1}'::jsonb WHERE enrollment_id = $1 AND content_item_id = $2`, [base.enrollment_id, pdfId]);
  console.log(`Demo: ${ids.length} elementos creados en la materia de Cálculo II; archivos en ${FILES}`);
} finally {
  await db.close();
}
