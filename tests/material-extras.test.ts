import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeExtras, extractFormat, type Material } from '../src/modules/guides/material.js';
import { buildDocx, renderParts } from '../src/modules/homework/document.js';

const base: Material = { course: 'M', activity: { name: 'Tarea', dueAt: null, points: null, category: null }, docs: [], skipped: [], links: [], tools: [], format: null, totalChars: 0 };
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

test('el formato de entrega se lee del texto de la guía (letra, interlineado, páginas y referencias)', () => {
  const guide = 'Formato de entrega | Documento en PDF, de 3 a 4 páginas, letra Arial 12, interlineado 1.5. Incluir al menos dos referencias bibliográficas.';
  assert.deepEqual(extractFormat(guide), { font: 'Arial', sizePt: 12, lineSpacing: 1.5, pagesMin: 3, pagesMax: 4, refsMin: 2 });
  assert.deepEqual(extractFormat('Entregar con letra Times New Roman 11, doble espacio, máximo 5 páginas.'), { font: 'Times New Roman', sizePt: 11, lineSpacing: 2, pagesMin: null, pagesMax: 5, refsMin: null });
  assert.equal(extractFormat('Resuelve los ejercicios 1 al 13 y entrégalos en Excel.'), null);
});

test('el PDF y el Word salen con la letra, el tamaño y el interlineado exigidos', async () => {
  const spec = { nombre_archivo: 'x', titulo: 'T', formato: { fuente: 'Arial', tamano: 12, interlineado: 1.5 }, bloques: [{ tipo: 'parrafo' as const, texto: 'Hola' }] };
  assert.match(renderParts(spec, new Map(), null).body, /font: 12pt\/1\.5 'Arial'/);
  assert.match(renderParts({ ...spec, formato: undefined }, new Map(), null).body, /font: 11pt\/1\.45 'Arial'/, 'sin formato exigido queda el estándar');
  assert.match(renderParts({ ...spec, formato: { fuente: "x'}</style><script>", tamano: 12 } }, new Map(), null).body, /'Arial'/, 'una fuente rara no entra al CSS');
  const docx = await buildDocx(spec, new Map(), null);
  assert.ok(docx.length > 1000);
});
