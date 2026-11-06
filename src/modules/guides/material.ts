// Armado del material de una guía de estudio: la actividad, las guías de su carpeta y los archivos de la materia más relacionados.
// Solo se lee lo que la inscripción del estudiante puede ver. Todo lo que se arma aquí es lo ÚNICO que se envía a la IA.
import { readFileSync } from 'node:fs';
import type { Queryable } from '../../database/connection.js';
import { isPreviewable, previewFile } from '../files/extract.js';
import type { createFileStore } from '../files/store.js';
import { GuideError, type GuideRequest } from './guides.js';
import { TOOLS, detectTools } from './tools.js';

export type FileStore = ReturnType<typeof createFileStore>;

export interface MaterialDoc {
  title: string;
  fileName: string | null;
  /** 'guia' = archivo de la misma carpeta de la actividad; 'material' = clase o documento relacionado por tema o semana. */
  role: 'instrucciones' | 'guia' | 'material';
  score: number;
  text: string;
  chars: number;
  truncated: boolean;
}
export interface SkippedDoc { title: string; reason: string }
/** Formato de entrega que exige la actividad (si lo dice): se lee del texto, sin IA. */
export interface DeliveryFormat { font: string | null; sizePt: number | null; lineSpacing: number | null; pagesMin: number | null; pagesMax: number | null; refsMin: number | null }

const WORD_NUMBERS: Record<string, number> = { una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
const asNumber = (value: string) => WORD_NUMBERS[value.toLowerCase()] ?? Number(value);
const FONT_NAMES: Record<string, string> = { arial: 'Arial', 'times new roman': 'Times New Roman', calibri: 'Calibri', verdana: 'Verdana', cambria: 'Cambria', georgia: 'Georgia', tahoma: 'Tahoma', garamond: 'Garamond' };

export function extractFormat(text: string): DeliveryFormat | null {
  const t = text.replace(/\s+/g, ' ');
  const fontMatch = /\b(arial|times new roman|calibri|verdana|cambria|georgia|tahoma|garamond)\b(?:\s*(?:,|de|tama[ñn]o)?\s*(\d{1,2})\b)?/i.exec(t);
  const sizeMatch = fontMatch?.[2] ? null : /(?:tama[ñn]o|letra|fuente)\s*(?:de\s*)?(\d{1,2})\b/i.exec(t);
  const size = Number(fontMatch?.[2] ?? sizeMatch?.[1] ?? 0);
  let spacing: number | null = null;
  const spacingMatch = /interlineado\s*(?:de\s*)?(\d(?:[.,]\d+)?)/i.exec(t);
  if (spacingMatch) spacing = Number(spacingMatch[1]!.replace(',', '.'));
  else if (/doble espacio|interlineado doble/i.test(t)) spacing = 2;
  else if (/espacio y medio/i.test(t)) spacing = 1.5;
  let pagesMin: number | null = null; let pagesMax: number | null = null;
  const range = /(\d+)\s*(?:a|-|–|y)\s*(\d+)\s*p[aá]ginas/i.exec(t);
  const most = /(?:m[aá]ximo|hasta)\s*(?:de\s*)?(\d+)\s*p[aá]ginas/i.exec(t);
  if (range) { pagesMin = Number(range[1]); pagesMax = Number(range[2]); } else if (most) pagesMax = Number(most[1]);
  const refs = /(?:al menos|m[ií]nimo(?: de)?|por lo menos)\s*(\d+|una|un|dos|tres|cuatro|cinco|seis)\s*(?:\w+\s*)?referencias/i.exec(t);
  const format: DeliveryFormat = {
    font: fontMatch ? FONT_NAMES[fontMatch[1]!.toLowerCase()] ?? null : null,
    sizePt: size >= 8 && size <= 20 ? size : null,
    lineSpacing: spacing !== null && spacing >= 1 && spacing <= 3 ? spacing : null,
    pagesMin, pagesMax,
    refsMin: refs ? asNumber(refs[1]!) : null,
  };
  return Object.values(format).some((value) => value !== null) ? format : null;
}

function describeFormat(format: DeliveryFormat): string {
  const parts = [
    format.font || format.sizePt ? `letra ${[format.font, format.sizePt].filter(Boolean).join(' ')}` : null,
    format.lineSpacing ? `interlineado ${format.lineSpacing}` : null,
    format.pagesMin && format.pagesMax ? `de ${format.pagesMin} a ${format.pagesMax} páginas` : format.pagesMax ? `máximo ${format.pagesMax} páginas` : null,
    format.refsMin ? `al menos ${format.refsMin} referencias bibliográficas` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

/** Enlace de la carpeta de la actividad (video, tutorial…): no se abre, pero su título dice el tema o la herramienta. */
export interface MaterialLink { title: string; url: string | null }
export interface Material {
  course: string;
  activity: { name: string; dueAt: string | null; points: number | null; category: string | null };
  docs: MaterialDoc[];
  skipped: SkippedDoc[];
  links: MaterialLink[];
  /** Herramientas que la actividad parece pedir (ids de tools.ts), vistas en su nombre, sus instrucciones, sus guías y los títulos de los enlaces. */
  tools: string[];
  /** Formato de entrega que dice la actividad (letra, interlineado, páginas, referencias), si lo dice. */
  format: DeliveryFormat | null;
  totalChars: number;
}

/**
 * Lo que la IA debe saber además de los documentos: los enlaces de la carpeta, las herramientas que parecen necesarias
 * y, si la actividad no trae instrucciones propias (solo es un buzón para subir algo), que use la guía o los ejercicios de la carpeta.
 */
export function describeExtras(material: Material): string {
  const lines: string[] = [];
  if (material.links.length > 0) {
    lines.push('Enlaces de la misma carpeta (no se pueden abrir; el título dice el tema o la herramienta):');
    for (const link of material.links) lines.push(`- ${link.title}`);
  }
  if (material.tools.length > 0) {
    lines.push(`Herramientas que parecen necesarias: ${material.tools.map((id) => TOOLS.find((tool) => tool.id === id)?.label ?? id).join(', ')}.`);
  }
  if (material.format) lines.push(`Formato de entrega exigido: ${describeFormat(material.format)}.`);
  if (!material.docs.some((doc) => doc.role === 'instrucciones')) {
    lines.push('Nota: esta actividad no trae instrucciones propias en Blackboard (puede ser solo el lugar donde se sube lo que se pidió en otro archivo). Toma como instrucciones la guía, los ejercicios o el documento relacionado de abajo; si no hay ninguno, dilo.');
  }
  return lines.join('\n');
}

const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'del', 'y', 'en', 'un', 'una', 'por', 'para', 'con', 'sobre', 'al', 'a', 'o', 'e', 'su', 'sus', 'que', 'se', 'ciclo', 'pdf', 'docx', 'pptx', 'actividad', 'tarea', 'proyecto', 'clase', 'clases', 'videos', 'archivo']);
const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (value: string) => new Set(normalize(value).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word) && !/^\d+$/.test(word)));
const weekOf = (value: string | null) => /semana\s+(\d+)/.exec(normalize(value ?? ''))?.[1] ?? null;
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const word of a) if (b.has(word)) n += 1; return n; };

/** Texto de un archivo: se lee de la copia local (si falta, se descarga con la sesión del estudiante). */
export async function fileText(store: FileStore, ref: { id: string; accountId: string; file: { fileName: string; mimeType: string; fileSize: number; permanentUrl?: string } }): Promise<{ text: string } | { skip: string }> {
  if (!isPreviewable(ref.file.mimeType, ref.file.fileName)) return { skip: 'tipo de archivo sin texto' };
  if (ref.file.fileSize > 25 * 1024 * 1024) return { skip: 'archivo demasiado grande' };
  let path: string;
  try { path = await store.ensure(ref); } catch { return { skip: 'no se pudo descargar' }; }
  const preview = await previewFile(readFileSync(path), ref.file.mimeType, ref.file.fileName).catch(() => null);
  if (!preview) return { skip: 'no se pudo leer' };
  if (preview.kind === 'pdf' && preview.scanned) return { skip: 'PDF escaneado (sin texto)' };
  const text = preview.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length < 40 ? { skip: 'sin texto útil' } : { text };
}

/**
 * Explica en una frase por qué una actividad no tiene material para armar la guía. Sin IA: sale de lo que hay en la base
 * (si la actividad trae instrucciones en Blackboard, qué archivos tiene la materia y por qué se descartaron).
 */
export async function explainNoMaterial(db: Queryable, request: GuideRequest, material: Material): Promise<string> {
  const { rows } = await db.query<{ linked: boolean; body: string | null; files: number; links: number }>(
    `SELECT gc.content_item_id IS NOT NULL AS linked, ci.body_text AS body,
            (SELECT count(*)::int FROM enrollment_content_visibility v JOIN course_content_items f ON f.id = v.content_item_id AND f.removed_at_source IS NULL
              WHERE v.enrollment_id = $1 AND v.missing_since IS NULL AND f.handler = 'resource/x-bb-file') AS files,
            (SELECT count(*)::int FROM enrollment_content_visibility v JOIN course_content_items f ON f.id = v.content_item_id AND f.removed_at_source IS NULL
              WHERE v.enrollment_id = $1 AND v.missing_since IS NULL AND (f.handler LIKE '%externallink%' OR f.handler LIKE '%blti%' OR f.handler LIKE '%video%')) AS links
       FROM gradebook_columns gc LEFT JOIN course_content_items ci ON ci.id = gc.content_item_id
      WHERE gc.id = $2`, [request.enrollmentId, request.gradebookColumnId]);
  const info = rows[0] ?? { linked: false, body: null, files: 0, links: 0 };
  const outside = /\b(teams|meet|zoom|seminario|presencial|exposici[oó]n)\b/i.test(`${material.activity.name} ${info.body ?? ''}`);
  const head = 'Esta actividad no tiene material de la materia para armar una guía';
  if (material.skipped.length > 0) {
    const reasons = [...new Set(material.skipped.map((doc) => doc.reason))].join(', ');
    return `${head}: encontré archivos relacionados pero no se pudieron usar (${reasons}).`;
  }
  if (!info.linked && outside) return `${head}: se hace fuera de Blackboard (Teams o presencial) y no trae instrucciones ni archivos para estudiar.`;
  if (!info.linked) return `${head}: en Blackboard no tiene instrucciones ni archivos ligados.`;
  if (info.files === 0 && info.links > 0) return `${head}: la materia solo tiene videos o enlaces, y por ahora la guía solo lee documentos.`;
  if (info.files === 0) return `${head}: la materia todavía no tiene archivos para leer.`;
  return `${head}: ninguno de los ${info.files} archivos de la materia se relaciona con esta actividad.`;
}

interface Candidate {
  id: string; title: string; parent: string | null; folder: string | null;
  file: { fileName: string; mimeType: string; fileSize: number; permanentUrl?: string } | null; body: string | null;
}

export async function gatherMaterial(db: Queryable, store: FileStore, request: GuideRequest, maxChars: number): Promise<Material> {
  const info = await db.query<{
    name: string; points: string | null; due: Date | null; category: string | null; course: string; account_id: string;
    item_title: string | null; item_body: string | null; item_parent: string | null;
  }>(
    `SELECT gc.name, gc.points_possible AS points, COALESCE(sg.effective_due_at, gc.due_at) AS due, gc.category_title AS category, c.name AS course, ea.id AS account_id,
            ci.title AS item_title, ci.body_text AS item_body, ci.parent_external_id AS item_parent
       FROM student_grades sg
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN courses c ON c.id = sg.course_id
       LEFT JOIN course_content_items ci ON ci.id = gc.content_item_id
      WHERE sg.enrollment_id = $1 AND sg.gradebook_column_id = $2`, [request.enrollmentId, request.gradebookColumnId]);
  const row = info.rows[0];
  if (!row) throw new GuideError('activity_not_found');
  const activity = { name: row.name, dueAt: row.due ? new Date(row.due).toISOString() : null, points: row.points === null ? null : Number(row.points), category: row.category };

  const { rows } = await db.query<{
    id: string; title: string; parent: string | null; folder: string | null; file: Candidate['file']; body: string | null;
  }>(
    `SELECT f.id, f.title, f.parent_external_id AS parent, folder.title AS folder, f.content_detail->'file' AS file, f.body_text AS body
       FROM enrollment_content_visibility v
       JOIN course_content_items f ON f.id = v.content_item_id AND f.removed_at_source IS NULL
       LEFT JOIN course_content_items folder ON folder.course_id = f.course_id AND folder.external_id = f.parent_external_id
      WHERE v.enrollment_id = $1 AND v.missing_since IS NULL
        AND ((f.handler = 'resource/x-bb-file' AND f.content_detail->'file' IS NOT NULL) OR (f.handler = 'resource/x-bb-document' AND length(COALESCE(f.body_text, '')) > 200))`,
    [request.enrollmentId]);

  const subject = tokens(`${activity.name} ${row.item_title ?? ''} ${(row.item_body ?? '').slice(0, 400)}`);
  const week = weekOf(rows.find((r) => r.parent === row.item_parent)?.folder ?? null);
  const scored = rows.map((r): Candidate & { score: number; same: boolean; guideLike: boolean } => {
    const same = row.item_parent !== null && r.parent === row.item_parent;
    const own = tokens(`${r.title} ${r.file?.fileName ?? ''}`);
    const folder = tokens(r.folder ?? '');
    let score = overlap(subject, own) * 3 + overlap(subject, folder) * 2;
    if (week && weekOf(r.folder) === week) score += 2;
    // Un archivo que se llama «guía», «instrucciones» o «rúbrica» y comparte el tema con la actividad es SU guía, aunque esté en otra carpeta.
    const guideLike = /gu[ií]a|instruc|r[uú]brica|lineamiento/i.test(r.title) && overlap(subject, own) >= 1;
    if (guideLike) score += 50;
    if (same) score += 100;
    return { id: r.id, title: r.title, parent: r.parent, folder: r.folder, file: r.file, body: r.body, score, same, guideLike };
  }).filter((r) => r.same || r.score >= 3).sort((a, b) => b.score - a.score);

  const docs: MaterialDoc[] = [];
  const skipped: SkippedDoc[] = [];
  let used = 0;
  const instructions = (row.item_body ?? '').trim();
  if (instructions.length > 20) {
    docs.push({ title: 'Instrucciones de la actividad en Blackboard', fileName: null, role: 'instrucciones', score: 1000, text: instructions.slice(0, 20_000), chars: Math.min(instructions.length, 20_000), truncated: instructions.length > 20_000 });
    used += docs[0]!.chars;
  }
  const perDoc = Math.max(8_000, Math.floor(maxChars / 2));
  const seen = new Set<string>();
  for (const candidate of scored) {
    const key = `${candidate.title}|${candidate.file?.fileSize ?? ''}`;
    if (seen.has(key)) { skipped.push({ title: candidate.title, reason: 'duplicado' }); continue; }
    seen.add(key);
    if (used >= maxChars) { skipped.push({ title: candidate.title, reason: 'fuera del tope de material' }); continue; }
    let text: string;
    if (candidate.file) {
      const read = await fileText(store, { id: candidate.id, accountId: row.account_id, file: candidate.file });
      if ('skip' in read) { skipped.push({ title: candidate.title, reason: read.skip }); continue; }
      text = read.text;
    } else {
      text = (candidate.body ?? '').trim();
    }
    const room = Math.min(perDoc, maxChars - used);
    const truncated = text.length > room;
    const cut = truncated ? text.slice(0, room) : text;
    docs.push({ title: candidate.title, fileName: candidate.file?.fileName ?? null, role: candidate.same || candidate.guideLike ? 'guia' : 'material', score: candidate.score, text: cut, chars: cut.length, truncated });
    used += cut.length;
  }
  const links = row.item_parent === null ? [] : (await db.query<MaterialLink>(
    `SELECT f.title, f.external_url AS url
       FROM enrollment_content_visibility v
       JOIN course_content_items f ON f.id = v.content_item_id AND f.removed_at_source IS NULL
      WHERE v.enrollment_id = $1 AND v.missing_since IS NULL AND f.course_id = $2 AND f.parent_external_id = $3
        AND (f.handler LIKE '%externallink%' OR f.handler LIKE '%blti%')
      ORDER BY f.position NULLS LAST, f.title LIMIT 15`, [request.enrollmentId, request.courseId, row.item_parent])).rows;
  // Las herramientas se buscan solo donde hablan de ESTA actividad (no en todas las clases, que mencionan de todo).
  const about = [activity.name, ...docs.filter((doc) => doc.role !== 'material').map((doc) => doc.text), ...links.map((link) => link.title)].join('\n');
  return { course: row.course, activity, docs, skipped, links, tools: detectTools(about), format: extractFormat(about), totalChars: used };
}
