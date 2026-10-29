import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, test as it } from 'node:test';
import { currentEvaluation, evaluationFor } from '../src/modules/calendar/calendar.service.js';
import { parseCalendar } from '../src/modules/calendar/instructivo.js';

const page = readFileSync(new URL('./fixtures/calendar-2026.txt', import.meta.url), 'utf8');
const expected = JSON.parse(readFileSync(new URL('./fixtures/calendar-2026.expected.json', import.meta.url), 'utf8')) as { terms: unknown[] };

describe('lector del instructivo', () => {
  it('lee los ciclos 01 y 02 de 2026 igual que la lectura manual del instructivo', () => {
    assert.deepEqual(parseCalendar(page).terms, expected.terms);
  });

  it('rechaza (no inventa) el interciclo, que tiene otra forma', () => {
    assert.deepEqual(parseCalendar(page).skipped.map((item) => item.term), ['Ciclo 03-2026']);
  });

  it('falla si la tabla cambia de orden o de filas', () => {
    assert.throws(() => parseCalendar(page.replace('Inicio de clases', 'Arranque de clases')), /cambió/);
  });

  it('descarta un ciclo cuyo día de la semana no coincide con la fecha', () => {
    const parsed = parseCalendar(page.replace('Lunes 16 al domingo 22 de febrero', 'Martes 16 al domingo 22 de febrero'));
    assert.deepEqual(parsed.terms.map((term) => term.name), ['Ciclo 02-2026']);
    assert.match(parsed.skipped.find((item) => item.term === 'Ciclo 01-2026')?.reason ?? '', /no cuadra/);
  });

  it('entiende "Jueves 19 y viernes 20 de diciembre" como un rango', () => {
    const text = page.replace('Domingo 13 de diciembre', 'Domingo 13 y lunes 14 de diciembre');
    const term = parseCalendar(text).terms.find((item) => item.name === 'Ciclo 02-2026');
    assert.equal(term?.evaluations[4]?.deferredStart, '2026-12-13');
    assert.equal(term?.evaluations[4]?.deferredEnd, '2026-12-14');
  });
});

const windows = [
  { number: 1, examEnd: '2026-08-23', deferredStart: '2026-09-02', deferredEnd: '2026-09-08' },
  { number: 2, examEnd: '2026-09-23', deferredStart: '2026-10-02', deferredEnd: '2026-10-08' },
  { number: 3, examEnd: '2026-10-23', deferredStart: '2026-11-03', deferredEnd: '2026-11-09' },
  { number: 4, examEnd: '2026-11-22', deferredStart: '2026-11-25', deferredEnd: '2026-12-01' },
  { number: 5, examEnd: '2026-12-10', deferredStart: '2026-12-13', deferredEnd: '2026-12-13' },
];

describe('reparto de actividades en evaluaciones', () => {
  it('asigna por fecha de entrega', () => {
    assert.equal(evaluationFor('Tarea 1', '2026-08-10', windows), 1);
    assert.equal(evaluationFor('Foro', '2026-09-10', windows), 2);
    assert.equal(evaluationFor('Parcial 3', '2026-10-19', windows), 3);
    assert.equal(evaluationFor('Tarea final', '2026-12-20', windows), 5);
  });

  it('un examen diferido va a la evaluación de su ventana de diferidos', () => {
    assert.equal(evaluationFor('Examen Diferido 1', '2026-09-07', windows), 1);
    assert.equal(evaluationFor('Examen Parcial DIFERIDO no 2', '2026-10-05', windows), 2);
    assert.equal(evaluationFor('Segundo examen parcial diferido', '2026-10-03', windows), 2);
  });

  it('la evaluación en curso es la primera cuyo examen aún no pasó', () => {
    assert.equal(currentEvaluation('2026-10-29', windows), 4);
    assert.equal(currentEvaluation('2026-08-01', windows), 1);
    assert.equal(currentEvaluation('2027-01-10', windows), 5);
  });
});
