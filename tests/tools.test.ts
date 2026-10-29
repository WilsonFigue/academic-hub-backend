import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectDeliverables, detectTools } from '../src/modules/guides/tools.js';

describe('detección de herramientas en el texto de una actividad', () => {
  test('encuentra GeoGebra y otras herramientas con sus variantes', () => {
    assert.deepEqual(detectTools('Graficar los puntos en GeoGebra para validar'), ['geogebra']);
    assert.deepEqual(detectTools('Entregar en Excel y un informe en Word').sort(), ['excel', 'word']);
    assert.ok(detectTools('Usar Python o Java').includes('python'));
    assert.ok(detectTools('hoja de cálculo').includes('excel'));
  });

  test('no confunde palabras comunes con herramientas', () => {
    assert.deepEqual(detectTools('Este circuito eléctrico tiene un resultado excelente'), []);
    assert.ok(!detectTools('JavaScript es distinto').includes('java'));
    assert.ok(!detectTools('Una palabra cualquiera').includes('word'));
  });

  test('detecta el formato de entrega pedido', () => {
    assert.ok(detectDeliverables('Elaborar un informe y una exposición').includes('informe'));
    assert.ok(detectDeliverables('Elaborar un informe y una exposición').includes('presentacion'));
    assert.ok(detectDeliverables('Participa en el foro de discusión').includes('foro'));
  });
});
