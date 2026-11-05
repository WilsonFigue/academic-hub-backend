import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveGradeStatus } from '../src/modules/import/persist.js';

test('nota puesta por el docente sin calificar el intento: Blackboard dice NEEDS_GRADING pero está calificada', () => {
  assert.equal(effectiveGradeStatus('NEEDS_GRADING', 'GRADED', 9), 'GRADED');
});

test('sin nota o sin entrega calificada, el estado de Blackboard no se toca', () => {
  assert.equal(effectiveGradeStatus('NEEDS_GRADING', 'SUBMITTED', null), 'NEEDS_GRADING', 'entregada y sin nota: por calificar');
  assert.equal(effectiveGradeStatus('NEEDS_GRADING', 'GRADED', null), 'NEEDS_GRADING', 'GRADED sin nota no cuenta');
  assert.equal(effectiveGradeStatus('GRADED', 'GRADED', 10), 'GRADED');
  assert.equal(effectiveGradeStatus('GRADED', 'PAST_DUE_AUTO_ZERO', 0), 'GRADED');
  assert.equal(effectiveGradeStatus(null, 'NO_STATUS', 4.8), null, 'columna calculada: sin estado');
});
