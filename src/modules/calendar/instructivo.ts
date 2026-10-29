// Lector del calendario académico del instructivo anual de UTEC (PDF público, igual para todos los estudiantes).
// Es un lector determinista: la tabla trae siempre las mismas filas en el mismo orden y las fechas en español ("Lunes 16 al domingo 22 de febrero").
// Antes de devolver algo se valida de forma estricta (orden de las filas, día de la semana de cada fecha, secuencia de evaluaciones);
// si algo no cuadra, ese ciclo no se acepta y se explica por qué. Nada se inventa.

export interface EvaluationDates {
  number: number;
  examStart: string; examEnd: string;
  deferredRequestDeadline: string; deferredStart: string; deferredEnd: string;
  gradesCorrectionDeadline: string;
}
export interface TermCalendar {
  name: string;
  classesStart: string; classesEnd: string; withdrawalDeadline: string;
  evaluations: EvaluationDates[];
}
export interface ParsedCalendar { terms: TermCalendar[]; skipped: Array<{ term: string; reason: string }> }

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Filas de la tabla, en el orden en que aparecen en el instructivo (se comprueba antes de leer fechas). */
const ROW_TITLES = [
  'Inscripción ordinaria de asignaturas', 'Inicio de clases', 'Inscripción extraordinaria', 'Primer examen parcial',
  'Fecha límite para tramitar examen diferido de 1', 'Examen diferido de 1', 'Segundo examen parcial',
  'Fecha límite para tramitar examen diferido de 2', 'Examen diferido de 2', 'Fecha límite para retiro parcial',
  'Tercer examen parcial', 'Fecha límite para tramitar examen diferido de 3', 'Examen diferido de 3', 'Cuarto examen parcial',
  'Fecha límite para tramitar examen diferido de 4', 'Examen diferido de 4', 'Finalización de clases', 'Quinto examen parcial',
  'Fecha límite para tramitar examen diferido 5', 'Examen diferido de 5', 'Fecha límite para corrección de notas',
  'Solicitar carta de egresado',
];
/** 20 filas con fecha + 5 correcciones de notas + carta de egresado. */
const DATES_PER_TERM = 26;

const DAY = String.raw`(lunes|martes|miércoles|jueves|viernes|sábado|domingo)\s+(\d{1,2})(?:\s+de\s+(${MONTHS.join('|')}))?(?:\s+(?:de\s+)?(\d{4}))?`;
const EXPRESSION = new RegExp(String.raw`${DAY}(?:\s+(?:al|y)\s+${DAY})?`, 'gi');

interface Span { start: string; end: string }

const iso = (year: number, month: number, day: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function checkWeekday(date: string, weekday: string): void {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new Error(`fecha inexistente ${date}`);
  if (WEEKDAYS[d.getUTCDay()] !== weekday.toLowerCase()) throw new Error(`"${weekday} ${date}" no cuadra con el calendario real`);
}

function parseDates(chunk: string, baseYear: number): Span[] {
  const spans: Span[] = [];
  for (const m of chunk.matchAll(EXPRESSION)) {
    const [, wd1, d1, mo1, y1, wd2, d2, mo2, y2] = m;
    if (wd2 === undefined) {
      // Fecha suelta: lleva siempre mes.
      if (!mo1) throw new Error(`fecha sin mes: "${m[0]}"`);
      const month = MONTHS.indexOf(mo1.toLowerCase());
      const date = iso(y1 ? Number(y1) : baseYear, month, Number(d1));
      checkWeekday(date, wd1!);
      spans.push({ start: date, end: date });
      continue;
    }
    // Rango: el mes del final siempre viene; el del inicio puede omitirse ("Lunes 16 al domingo 22 de febrero").
    const endMonth = MONTHS.indexOf(mo2!.toLowerCase());
    const startMonth = mo1 ? MONTHS.indexOf(mo1.toLowerCase()) : endMonth;
    const endYear = y2 ? Number(y2) : y1 ? Number(y1) : baseYear;
    let startYear = y1 ? Number(y1) : endYear;
    if (!y1 && startMonth > endMonth) startYear = endYear - 1;
    const start = iso(startYear, startMonth, Number(d1));
    const end = iso(endYear, endMonth, Number(d2));
    checkWeekday(start, wd1!); checkWeekday(end, wd2);
    if (end < start) throw new Error(`rango invertido: "${m[0]}"`);
    spans.push({ start, end });
  }
  return spans;
}

/** Busca el texto de la página del calendario entre las páginas del PDF. */
export function findCalendarPage(pages: string[]): string | null {
  const page = pages.find((text) => /Inicio de clases/i.test(text) && /Primer examen parcial/i.test(text) && /Ciclo\s+0\d-\d{4}/.test(text) && /Solicitar carta de egresado/i.test(text));
  return page ? page.replace(/\s+/g, ' ') : null;
}

export function parseCalendar(pageText: string): ParsedCalendar {
  const text = pageText.replace(/\s+/g, ' ');
  // Las filas deben aparecer en el orden esperado: si el instructivo cambia su tabla, no se interpreta nada.
  let cursor = 0;
  for (const title of ROW_TITLES) {
    const at = text.toLowerCase().indexOf(title.toLowerCase(), cursor);
    if (at < 0) throw new Error(`La tabla del instructivo cambió: no se encontró la fila "${title}" en el orden esperado.`);
    cursor = at + title.length;
  }
  const headers = [...text.matchAll(/Ciclo\s+(0\d)-(\d{4})/g)].filter((m) => m.index! >= cursor);
  if (headers.length === 0) throw new Error('No se encontraron las columnas de ciclos (Ciclo 01-AAAA…).');

  const result: ParsedCalendar = { terms: [], skipped: [] };
  headers.forEach((header, i) => {
    const name = `Ciclo ${header[1]}-${header[2]}`;
    const chunk = text.slice(header.index! + header[0].length, headers[i + 1]?.index ?? text.length);
    try {
      const spans = parseDates(chunk, Number(header[2]));
      if (spans.length !== DATES_PER_TERM) throw new Error(`se esperaban ${DATES_PER_TERM} fechas y hay ${spans.length}`);
      const at = (i: number) => spans[i]!;
      const evaluations: EvaluationDates[] = [];
      const examRows = [3, 6, 10, 13, 17];                 // fila del examen parcial N
      const limitRows = [4, 7, 11, 14, 18];                // fecha límite del diferido N
      const deferredRows = [5, 8, 12, 15, 19];             // diferido N
      for (let n = 0; n < 5; n += 1) {
        const exam = at(examRows[n]!); const limit = at(limitRows[n]!); const deferred = at(deferredRows[n]!); const correction = at(20 + n);
        if (limit.end < exam.end) throw new Error(`la fecha límite del diferido ${n + 1} es anterior al examen`);
        if (deferred.start < exam.end) throw new Error(`el diferido ${n + 1} empieza antes de terminar el examen`);
        evaluations.push({
          number: n + 1, examStart: exam.start, examEnd: exam.end, deferredRequestDeadline: limit.start,
          deferredStart: deferred.start, deferredEnd: deferred.end, gradesCorrectionDeadline: correction.start,
        });
      }
      for (let n = 1; n < 5; n += 1) {
        if (evaluations[n]!.examStart <= evaluations[n - 1]!.examEnd) throw new Error(`las evaluaciones ${n} y ${n + 1} se traslapan`);
      }
      const classesStart = at(1).start; const classesEnd = at(16).start;
      if (classesStart >= evaluations[0]!.examStart) throw new Error('el inicio de clases es posterior al primer examen');
      if (classesEnd < evaluations[3]!.examEnd) throw new Error('las clases terminan antes del cuarto examen');
      result.terms.push({ name, classesStart, classesEnd, withdrawalDeadline: at(9).start, evaluations });
    } catch (error) {
      result.skipped.push({ term: name, reason: (error as Error).message });
    }
  });
  return result;
}

/** Dirección pública del instructivo del año (solo UTEC, solo HTTPS). */
export function instructivoUrl(year: number): string {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('Año inválido.');
  return `https://www.utec.edu.sv/media/publicaciones/flips/Instructivo-Academico/instructivoacademico-${year}/files/file.pdf`;
}
