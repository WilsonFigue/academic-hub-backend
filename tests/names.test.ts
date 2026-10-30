import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreSurnameAccents } from '../src/shared/names.js';

test('devuelve la tilde solo a apellidos conocidos y no toca lo demás', () => {
  assert.equal(restoreSurnameAccents('Genaro Antonio Hernandez Lemus'), 'Genaro Antonio Hernández Lemus');
  assert.equal(restoreSurnameAccents('Jorge Alberto Acevedo Diaz'), 'Jorge Alberto Acevedo Díaz');
  assert.equal(restoreSurnameAccents('Fabio Bautista Perez'), 'Fabio Bautista Pérez');
  assert.equal(restoreSurnameAccents('Omar Otoniel Flores Cortez'), 'Omar Otoniel Flores Cortez');   // sin cambios
  assert.equal(restoreSurnameAccents('Mtro. Lic. Joaquín Ernesto Aparicio Pacheco'), 'Mtro. Lic. Joaquín Ernesto Aparicio Pacheco');
  assert.equal(restoreSurnameAccents('Perezoso Diazepam'), 'Perezoso Diazepam');                       // solo palabras completas
});
