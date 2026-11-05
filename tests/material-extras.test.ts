import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeExtras, type Material } from '../src/modules/guides/material.js';

const base: Material = { course: 'M', activity: { name: 'Tarea', dueAt: null, points: null, category: null }, docs: [], skipped: [], links: [], tools: [], totalChars: 0 };
const doc = (role: 'instrucciones' | 'guia' | 'material') => ({ title: 'x', fileName: null, role, score: 1, text: 'texto', chars: 5, truncated: false });

test('sin instrucciones propias: la nota manda usar la guía o los ejercicios de la carpeta', () => {
  assert.match(describeExtras({ ...base, docs: [doc('guia')] }), /no trae instrucciones propias/);
});

test('con instrucciones propias no hay nota, y sin enlaces ni herramientas no se agrega nada', () => {
  assert.equal(describeExtras({ ...base, docs: [doc('instrucciones')] }), '');
});

test('los enlaces de la carpeta y las herramientas detectadas llegan a la IA', () => {
  const text = describeExtras({ ...base, docs: [doc('instrucciones')], links: [{ title: 'Distribución binomial en Excel', url: null }], tools: ['excel'] });
  assert.match(text, /Distribución binomial en Excel/);
  assert.match(text, /Herramientas que parecen necesarias: Excel \/ hoja de cálculo/);
});
