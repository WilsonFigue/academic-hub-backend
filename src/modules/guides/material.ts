// Armado del material de una guía de estudio: la actividad, las guías de su carpeta y los archivos de la materia más relacionados.
// Solo se lee lo que la inscripción del estudiante puede ver. Todo lo que se arma aquí es lo ÚNICO que se envía a la IA.
import { readFileSync } from 'node:fs';
import type { Queryable } from '../../database/connection.js';
import { isPreviewable, previewFile } from '../files/extract.js';
import type { createFileStore } from '../files/store.js';
import { GuideError, type GuideRequest } from './guides.js';

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
export interface Material {
  course: string;
  activity: { name: string; dueAt: string | null; points: number | null; category: string | null };
  docs: MaterialDoc[];
  skipped: SkippedDoc[];
  totalChars: number;
}

const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'del', 'y', 'en', 'un', 'una', 'por', 'para', 'con', 'sobre', 'al', 'a', 'o', 'e', 'su', 'sus', 'que', 'se', 'ciclo', 'pdf', 'docx', 'pptx', 'actividad', 'tarea', 'proyecto', 'clase', 'clases', 'videos', 'archivo']);
const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (value: string) => new Set(normalize(value).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word) && !/^\d+$/.test(word)));
const weekOf = (value: string | null) => /semana\s+(\d+)/.exec(normalize(value ?? ''))?.[1] ?? null;
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const word of a) if (b.has(word)) n += 1; return n; };

/** Texto de un archivo: se lee de la copia local (si falta, se descarga con la sesión del estudiante). */
async function fileText(store: FileStore, ref: { id: string; accountId: string; file: { fileName: string; mimeType: string; fileSize: number; permanentUrl?: string } }): Promise<{ text: string } | { skip: string }> {
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
  const scored = rows.map((r): Candidate & { score: number; same: boolean } => {
    const same = row.item_parent !== null && r.parent === row.item_parent;
    const own = tokens(`${r.title} ${r.file?.fileName ?? ''}`);
    const folder = tokens(r.folder ?? '');
    let score = overlap(subject, own) * 3 + overlap(subject, folder) * 2;
    if (week && weekOf(r.folder) === week) score += 2;
    if (same) score += 100;
    return { id: r.id, title: r.title, parent: r.parent, folder: r.folder, file: r.file, body: r.body, score, same };
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
  for (const candidate of scored) {
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
    docs.push({ title: candidate.title, fileName: candidate.file?.fileName ?? null, role: candidate.same ? 'guia' : 'material', score: candidate.score, text: cut, chars: cut.length, truncated });
    used += cut.length;
  }
  return { course: row.course, activity, docs, skipped, totalChars: used };
}
