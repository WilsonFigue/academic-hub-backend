// Exámenes diferidos: un diferido reemplaza al examen ordinario SOLO si no se hizo el ordinario.
//  - Hiciste el ordinario  → el diferido (que Blackboard deja en 0 automático) NO cuenta ni baja tu promedio.
//  - No hiciste el ordinario y hiciste el diferido → cuenta el diferido; el cero del ordinario no cuenta.
//  - No hiciste ninguno → cuenta un solo cero (el del ordinario), no dos; mientras el diferido siga abierto, ninguno cuenta todavía.
// Es una regla fija (sin IA): el emparejamiento se hace por el número que lleva el nombre («Parcial 2», «Segundo», «diferido no 2»).

export interface GradedRow {
  id: string; courseId: string; name: string; dueAt: Date | string | null; isCalculated: boolean; isAutoZero: boolean;
  score: string | number | null; isSubmitted: boolean | null; isExempt: boolean | null;
}
export interface Ruling { countsInGrade: boolean; gradeNote: string | null }

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ORDINALS: Array<[RegExp, number]> = [[/\bprimer[ao]?\b/, 1], [/\bsegund[ao]\b/, 2], [/\btercer[ao]?\b/, 3], [/\bcuart[ao]\b/, 4], [/\bquint[ao]\b/, 5]];
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

/** Número de evaluación que lleva el nombre (1–5), o null si no se puede saber. */
export function evaluationNumber(name: string): number | null {
  const text = fold(name);
  let best: { at: number; n: number } | null = null;
  const consider = (at: number, n: number) => { if (at >= 0 && (!best || at < best.at)) best = { at, n }; };
  for (const [pattern, n] of ORDINALS) consider(text.search(pattern), n);
  for (const m of name.matchAll(/[A-Za-z0-9]+/g)) {
    const word = m[0]; const at = m.index ?? 0; const after = name[at + word.length] ?? '';
    const suffixed = /^([1-5])(?:era|ra|da|ta|er|ro|do)$/i.exec(word);
    if (/^[1-5]$/.test(word) && after !== '%' && after !== '/') consider(at, Number(word));
    else if (suffixed) consider(at, Number(suffixed[1]));
    else if (/^(II|III|IV)$/.test(word)) consider(at, ROMAN[word.toLowerCase()]!);
    else if (word === 'I' && /parcial|examen/.test(text.slice(0, at))) consider(at, 1);
  }
  return best ? (best as { n: number }).n : null;
}

const isDeferred = (name: string) => /diferid/.test(fold(name));
const isExamColumn = (name: string) => /\b(parcial|examen|evaluacion)\b/.test(fold(name)) && !/control de lectura|lectura|quiz|cuestionario/.test(fold(name));
const took = (row: GradedRow) => row.isSubmitted === true || (row.score !== null && !row.isAutoZero);
const time = (value: Date | string | null) => (value === null ? Infinity : new Date(value).getTime());

/** Qué filas cuentan para la nota. Las que no aparecen en el mapa cuentan normal. */
export function deferredRulings(rows: GradedRow[], now = Date.now()): Map<string, Ruling> {
  const result = new Map<string, Ruling>();
  const byCourse = new Map<string, GradedRow[]>();
  for (const row of rows) if (!row.isCalculated && isExamColumn(row.name)) (byCourse.get(row.courseId) ?? byCourse.set(row.courseId, []).get(row.courseId)!).push(row);

  for (const exams of byCourse.values()) {
    const deferred = exams.filter((e) => isDeferred(e.name)).sort((a, b) => time(a.dueAt) - time(b.dueAt));
    const ordinary = exams.filter((e) => !isDeferred(e.name)).sort((a, b) => time(a.dueAt) - time(b.dueAt));
    deferred.forEach((d, index) => {
      const n = evaluationNumber(d.name) ?? index + 1;
      const candidates = ordinary.filter((o) => evaluationNumber(o.name) === n);
      const ord = candidates.length === 1 ? candidates[0]! : (candidates.length === 0 ? (ordinary.every((o) => evaluationNumber(o.name) === null) ? ordinary[n - 1] : undefined) : candidates[0]);
      if (!ord) return;
      if (took(ord)) {
        result.set(d.id, { countsInGrade: false, gradeNote: 'Hiciste el examen ordinario de esta evaluación: el diferido no cuenta y no baja tu nota.' });
      } else if (took(d)) {
        if (ord.isAutoZero) result.set(ord.id, { countsInGrade: false, gradeNote: 'No lo hiciste y presentaste el diferido: el cero del ordinario no cuenta; cuenta la nota del diferido.' });
      } else {
        result.set(d.id, { countsInGrade: false, gradeNote: 'El diferido sin hacer no cuenta como un segundo cero: solo cuenta el del examen ordinario.' });
        if (ord.isAutoZero && time(d.dueAt) >= now) result.set(ord.id, { countsInGrade: false, gradeNote: 'Todavía puedes presentar el diferido: este cero no cuenta mientras tanto.' });
      }
    });
  }
  return result;
}
