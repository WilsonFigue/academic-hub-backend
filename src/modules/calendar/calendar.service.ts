// Calendario académico global (una vez al año) y su aplicación a cada estudiante.
// - importCalendar: baja el instructivo del año, lo lee y (solo si se confirma) lo guarda en institution_terms / institution_evaluations.
// - applyCalendar: reparte las actividades de cada inscripción en las 5 evaluaciones según su fecha de entrega.
//   Nunca toca la configuración manual del estudiante: si ya guardó sus ciclos a mano, esa inscripción se respeta.
import { extractText, getDocumentProxy } from 'unpdf';
import type { Database } from '../../database/connection.js';
import { findCalendarPage, instructivoUrl, parseCalendar, type ParsedCalendar, type TermCalendar } from './instructivo.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const LOCAL_OFFSET_MS = -6 * 3600 * 1000;            // El Salvador, UTC-6 todo el año

export type FetchPdf = (url: string) => Promise<Uint8Array>;

export const downloadPdf: FetchPdf = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`El instructivo no está disponible (HTTP ${response.status}).`);
  if (new URL(response.url).hostname !== 'www.utec.edu.sv') throw new Error('La descarga fue redirigida fuera de utec.edu.sv.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) throw new Error('El instructivo es demasiado grande.');
  return bytes;
};

export interface CalendarImport extends ParsedCalendar { year: number; source: string; saved: boolean }

export async function importCalendar(db: Database, year: number, options: { confirm: boolean; fetchPdf?: FetchPdf }): Promise<CalendarImport> {
  const bytes = await (options.fetchPdf ?? downloadPdf)(instructivoUrl(year));
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const page = findCalendarPage(text);
  if (!page) throw new Error('No se encontró la página del calendario académico en el instructivo.');
  const parsed = parseCalendar(page);
  const source = `Instructivo académico ${year}`;
  const result: CalendarImport = { year, source, saved: false, ...parsed };
  if (options.confirm) {
    if (parsed.terms.length === 0) throw new Error('No hay ciclos válidos para guardar.');
    await saveCalendar(db, 'UTEC', source, parsed.terms);
    result.saved = true;
  }
  return result;
}

export async function saveCalendar(db: Database, institutionCode: string, source: string, terms: TermCalendar[]): Promise<void> {
  const institution = await db.query<{ id: string }>('SELECT id FROM institutions WHERE code = $1', [institutionCode]);
  if (!institution.rows[0]) throw new Error(`No existe la institución ${institutionCode}.`);
  await db.transaction(async (client) => {
    for (const term of terms) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO institution_terms (institution_id, term_name, classes_start, classes_end, withdrawal_deadline, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (institution_id, term_name) DO UPDATE SET classes_start = EXCLUDED.classes_start, classes_end = EXCLUDED.classes_end,
           withdrawal_deadline = EXCLUDED.withdrawal_deadline, source = EXCLUDED.source RETURNING id`,
        [institution.rows[0]!.id, term.name, term.classesStart, term.classesEnd, term.withdrawalDeadline, source]);
      for (const e of term.evaluations) {
        await client.query(
          `INSERT INTO institution_evaluations (term_id, number, exam_start, exam_end, deferred_request_deadline, deferred_start, deferred_end, grades_correction_deadline)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (term_id, number) DO UPDATE SET exam_start = EXCLUDED.exam_start, exam_end = EXCLUDED.exam_end,
             deferred_request_deadline = EXCLUDED.deferred_request_deadline, deferred_start = EXCLUDED.deferred_start,
             deferred_end = EXCLUDED.deferred_end, grades_correction_deadline = EXCLUDED.grades_correction_deadline`,
          [rows[0]!.id, e.number, e.examStart, e.examEnd, e.deferredRequestDeadline, e.deferredStart, e.deferredEnd, e.gradesCorrectionDeadline]);
      }
    }
  });
}

interface EvaluationWindow { number: number; examEnd: string; deferredStart: string | null; deferredEnd: string | null }

/** Fecha local (El Salvador) de un instante, como AAAA-MM-DD. */
export function localDate(instant: Date): string {
  return new Date(instant.getTime() + LOCAL_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Evaluación a la que pertenece una columna según su fecha de entrega.
 * - Un examen diferido (el nombre lo dice) va a la evaluación cuya ventana de diferidos contiene la fecha.
 * - El resto va a la primera evaluación cuyo examen termina en o después de la fecha; lo posterior al último examen va a la última.
 */
export function evaluationFor(name: string, due: string, windows: EvaluationWindow[]): number {
  if (/diferid/i.test(name)) {
    const hit = windows.find((w) => w.deferredStart && w.deferredEnd && due >= w.examEnd && due <= w.deferredEnd);
    if (hit) return hit.number;
  }
  const hit = windows.find((w) => due <= w.examEnd);
  return (hit ?? windows[windows.length - 1]!).number;
}

/** Evaluación en curso hoy: la primera cuyo examen aún no pasó; al final del ciclo, la última. */
export function currentEvaluation(today: string, windows: EvaluationWindow[]): number {
  return (windows.find((w) => today <= w.examEnd) ?? windows[windows.length - 1]!).number;
}

export interface ApplySummary { enrollments: number; assigned: number; unassigned: number; skippedManual: number; skippedNoCalendar: number }

export async function applyCalendar(db: Database, scope: { userId?: string } = {}, now: Date = new Date()): Promise<ApplySummary> {
  const summary: ApplySummary = { enrollments: 0, assigned: 0, unassigned: 0, skippedManual: 0, skippedNoCalendar: 0 };
  const today = localDate(now);
  const enrollments = await db.query<{ id: string; course_id: string; term_id: string | null; term_name: string | null }>(
    `SELECT ce.id, ce.course_id, c.term_id, t.name AS term_name
       FROM course_enrollments ce
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN courses c ON c.id = ce.course_id
       LEFT JOIN academic_terms t ON t.id = c.term_id
      WHERE ce.status = 'active' AND ($1::uuid IS NULL OR ea.user_id = $1)`,
    [scope.userId ?? null]);

  for (const enrollment of enrollments.rows) {
    const term = enrollment.term_name
      ? await db.query<{ id: string }>(`SELECT it.id FROM institution_terms it JOIN institutions i ON i.id = it.institution_id WHERE i.code = 'UTEC' AND it.term_name = $1`, [enrollment.term_name])
      : null;
    if (!term?.rows[0]) { summary.skippedNoCalendar += 1; continue; }
    const manual = await db.query(`SELECT 1 FROM evaluation_cycles WHERE enrollment_id = $1 AND source = 'manual' LIMIT 1`, [enrollment.id]);
    if (manual.rows.length > 0) { summary.skippedManual += 1; continue; }

    const evaluations = await db.query<{ number: number; exam_end: string; deferred_start: string | null; deferred_end: string | null }>(
      `SELECT number, exam_end::text, deferred_start::text, deferred_end::text FROM institution_evaluations WHERE term_id = $1 ORDER BY number`, [term.rows[0].id]);
    const windows: EvaluationWindow[] = evaluations.rows.map((row) => ({ number: row.number, examEnd: row.exam_end, deferredStart: row.deferred_start, deferredEnd: row.deferred_end }));
    if (windows.length === 0) { summary.skippedNoCalendar += 1; continue; }
    const weight = await db.query<{ evaluation_weight_percent: string }>(`SELECT evaluation_weight_percent FROM institution_terms WHERE id = $1`, [term.rows[0].id]);

    const columns = await db.query<{ id: string; name: string; due_at: Date | null }>(
      `SELECT DISTINCT gc.id, gc.name, gc.due_at
         FROM gradebook_columns gc JOIN student_grades sg ON sg.gradebook_column_id = gc.id AND sg.enrollment_id = $1
        WHERE gc.course_id = $2 AND NOT gc.is_deleted_at_source`, [enrollment.id, enrollment.course_id]);

    const active = currentEvaluation(today, windows);
    await db.transaction(async (client) => {
      await client.query(`DELETE FROM evaluation_cycles WHERE enrollment_id = $1 AND source = 'institution_calendar'`, [enrollment.id]);
      const cycleIds = new Map<number, string>();
      for (const w of windows) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO evaluation_cycles (enrollment_id, number, label, weight_percent, is_active, source, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, 'institution_calendar', now()) RETURNING id`,
          [enrollment.id, w.number, `Evaluación ${w.number}`, weight.rows[0]!.evaluation_weight_percent, w.number === active]);
        cycleIds.set(w.number, created.rows[0]!.id);
      }
      for (const column of columns.rows) {
        if (!column.due_at) { summary.unassigned += 1; continue; }
        const number = evaluationFor(column.name, localDate(column.due_at), windows);
        await client.query(
          `INSERT INTO evaluation_cycle_items (cycle_id, enrollment_id, course_id, gradebook_column_id, source, confirmed_at)
           VALUES ($1, $2, $3, $4, 'institution_calendar', now())`,
          [cycleIds.get(number), enrollment.id, enrollment.course_id, column.id]);
        summary.assigned += 1;
      }
    });
    summary.enrollments += 1;
  }
  return summary;
}
