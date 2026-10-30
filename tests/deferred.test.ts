import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deferredRulings, evaluationNumber, type GradedRow } from '../src/modules/academic/deferred.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
let n = 0;
const row = (courseId: string, name: string, due: string, took: boolean, score: number | null = took ? 10 : 0): GradedRow => ({
  id: `r${++n}`, courseId, name, dueAt: due, isCalculated: false, isAutoZero: !took, score, isSubmitted: took ? true : false, isExempt: false,
});

describe('exámenes diferidos: no bajan la nota si hiciste el ordinario', () => {
  test('el número de evaluación sale del nombre', () => {
    const cases: Array<[string, number | null]> = [
      ['Examen Diferido 1', 1], ['Examen Parcial DIFERIDO no 2', 2], ['Parcial 1 ·ordinario· 60% 0226', 1], ['0226_EV2_Examen Parcial #2 / Ordinario / 60%', 2],
      ['EVA3_26_Examen Parcial Ordinario 3 - 60%', 3], ['EXAMEN 2 ORDINARIO', 2], ['Examen 3 de Matemática I 60%', 3], ['Segundo Examen parcial diferido EI-01 (60%)', 2],
      ['Primera evaluación parcial EI-01', 1], ['(60%) Parcial I - ORDINARIO - 02-2026', 1], ['Parcial III - ORDINARIO', 3], ['Examen Parcial 3era evaluación 19-octubre-2026.', 3],
      ['Primer Parcial Ordinario 17/08/2026', 1], ['Tarea sin número', null],
    ];
    for (const [name, expected] of cases) assert.equal(evaluationNumber(name), expected, name);
  });

  test('hiciste el ordinario: el diferido en cero no cuenta (caso Física III)', () => {
    const o1 = row('fis', 'Parcial 1 ·ordinario· 60% 0226', '2026-08-24', true);
    const d1 = row('fis', 'Examen Diferido 1', '2026-09-07', false);
    const lectura = row('fis', 'A1E1 - Examen Control de Lectura 10%- 0226', '2026-08-03', true);
    const rulings = deferredRulings([o1, d1, lectura], NOW);
    assert.equal(rulings.get(d1.id)?.countsInGrade, false);
    assert.equal(rulings.has(o1.id), false, 'el ordinario hecho cuenta normal');
    assert.equal(rulings.has(lectura.id), false, 'un control de lectura no es un parcial');
  });

  test('no hiciste el ordinario pero sí el diferido: cuenta el diferido y no el cero del ordinario', () => {
    const o = row('c', 'Parcial 2 ordinario', '2026-09-20', false);
    const d = row('c', 'Examen diferido 2', '2026-10-05', true, 8);
    const rulings = deferredRulings([o, d], NOW);
    assert.equal(rulings.get(o.id)?.countsInGrade, false);
    assert.equal(rulings.has(d.id), false);
  });

  test('no hiciste ninguno (caso Matemática I): cuenta un solo cero, el del ordinario', () => {
    const o = row('mat', 'EXAMEN 2 ORDINARIO', '2026-09-20', false);
    const d = row('mat', 'Examen Diferido 2', '2026-10-05', false);
    const rulings = deferredRulings([o, d], NOW);
    assert.equal(rulings.get(d.id)?.countsInGrade, false);
    assert.equal(rulings.has(o.id), false);
  });

  test('si el diferido todavía no vence, el cero del ordinario no cuenta mientras tanto', () => {
    const o = row('c', 'Parcial 3 ordinario', '2026-10-20', false);
    const d = row('c', 'Examen diferido 3', '2026-11-10', false);
    const rulings = deferredRulings([o, d], NOW);
    assert.equal(rulings.get(o.id)?.countsInGrade, false);
    assert.equal(rulings.get(d.id)?.countsInGrade, false);
  });

  test('cada materia se evalúa por separado', () => {
    const a = row('a', 'Parcial 1 ordinario', '2026-08-20', true);
    const b = row('b', 'Examen diferido 1', '2026-09-07', false);
    assert.equal(deferredRulings([a, b], NOW).has(b.id), false, 'sin ordinario en su materia, el diferido no se empareja');
  });
});
