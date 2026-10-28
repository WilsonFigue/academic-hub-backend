import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { readConfig } from '../src/config/env.js';
import type { Database } from '../src/database/connection.js';
import { buildApp } from '../src/app.js';
import { devImportRoutes } from '../src/modules/import/dev-import.routes.js';

// Ninguna prueba envía una solicitud válida completa: eso abriría Chromium contra UTEC.
const TOKEN = 'x'.repeat(40);
const URL = '/internal/dev/utec/create-user';
const body = { username: 'usuario', password: 'contraseña' };

describe('protecciones de /internal/dev/utec/create-user', () => {
  let app: FastifyInstance;

  before(async () => {
    const config = { ...readConfig(), nodeEnv: 'development' as const };
    app = await buildApp({
      config, db: null, logger: false,
      registerInternal: async (instance) => { await instance.register(devImportRoutes, { db: {} as Database, operatorToken: TOKEN }); },
    });
  });
  after(async () => { await app.close(); });

  test('sin token de operador → 401', async () => {
    const response = await app.inject({ method: 'POST', url: URL, payload: body });
    assert.equal(response.statusCode, 401);
  });

  test('token incorrecto → 401', async () => {
    const response = await app.inject({ method: 'POST', url: URL, payload: body, headers: { 'x-dev-operator-token': 'y'.repeat(40) } });
    assert.equal(response.statusCode, 401);
  });

  test('solicitud con Origin (navegador) → 403', async () => {
    const response = await app.inject({ method: 'POST', url: URL, payload: body, headers: { 'x-dev-operator-token': TOKEN, origin: 'http://localhost:5173' } });
    assert.equal(response.statusCode, 403);
  });

  test('origen de red no loopback → 404', async () => {
    const response = await app.inject({ method: 'POST', url: URL, payload: body, remoteAddress: '10.0.0.5', headers: { 'x-dev-operator-token': TOKEN } });
    assert.equal(response.statusCode, 404);
  });

  test('campos adicionales en el BODY → 400', async () => {
    const response = await app.inject({ method: 'POST', url: URL, payload: { ...body, email: 'x@y.z' }, headers: { 'x-dev-operator-token': TOKEN } });
    assert.equal(response.statusCode, 400);
  });

  test('las credenciales no aparecen en la respuesta de error', async () => {
    const response = await app.inject({ method: 'POST', url: URL, payload: body });
    assert.ok(!response.body.includes('contraseña'));
  });

  test('operación inexistente → 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/internal/dev/utec/imports/00000000-0000-4000-8000-000000000000', headers: { 'x-dev-operator-token': TOKEN } });
    assert.equal(response.statusCode, 404);
  });

  test('sin registerInternal (producción) la ruta no existe', async () => {
    const production = await buildApp({ config: readConfig(), db: null, logger: false });
    const response = await production.inject({ method: 'POST', url: URL, payload: body, headers: { 'x-dev-operator-token': TOKEN } });
    assert.equal(response.statusCode, 404);
    await production.close();
  });
});
