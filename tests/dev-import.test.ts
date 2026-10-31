import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { readConfig } from '../src/config/env.js';
import type { Database } from '../src/database/connection.js';
import { buildApp } from '../src/app.js';
import { devImportRoutes } from '../src/modules/import/dev-import.routes.js';

// Ninguna prueba envía una solicitud válida completa: eso abriría Chromium contra UTEC.
const TOKEN = 'x'.repeat(40);
const URLS = ['/internal/dev/utec/create-user', '/internal/dev/utec/refresh/full', '/internal/dev/utec/refresh/daily'];
const body = { username: 'usuario', password: 'contraseña' };

describe('protecciones de /internal/dev/utec (crear usuario, actualización completa y diaria)', () => {
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
    for (const URL of URLS) {
      const response = await app.inject({ method: 'POST', url: URL, payload: body });
      assert.equal(response.statusCode, 401);
    }
  });

  test('token incorrecto → 401', async () => {
    for (const URL of URLS) {
      const response = await app.inject({ method: 'POST', url: URL, payload: body, headers: { 'x-dev-operator-token': 'y'.repeat(40) } });
      assert.equal(response.statusCode, 401);
    }
  });

  test('solicitud con Origin (navegador) → 403', async () => {
    for (const URL of URLS) {
      const response = await app.inject({ method: 'POST', url: URL, payload: body, headers: { 'x-dev-operator-token': TOKEN, origin: 'http://localhost:5173' } });
      assert.equal(response.statusCode, 403);
    }
  });

  test('origen de red no loopback → 404', async () => {
    for (const URL of URLS) {
      const response = await app.inject({ method: 'POST', url: URL, payload: body, remoteAddress: '10.0.0.5', headers: { 'x-dev-operator-token': TOKEN } });
      assert.equal(response.statusCode, 404);
    }
  });

  test('campos adicionales en el BODY → 400', async () => {
    for (const URL of URLS) {
      const response = await app.inject({ method: 'POST', url: URL, payload: { ...body, email: 'x@y.z' }, headers: { 'x-dev-operator-token': TOKEN } });
      assert.equal(response.statusCode, 400);
    }
  });

  test('las credenciales no aparecen en la respuesta de error', async () => {
    for (const URL of URLS) {
      const response = await app.inject({ method: 'POST', url: URL, payload: body });
      assert.ok(!response.body.includes('contraseña'));
    }
  });

  test('operación inexistente → 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/internal/dev/utec/imports/00000000-0000-4000-8000-000000000000', headers: { 'x-dev-operator-token': TOKEN } });
    assert.equal(response.statusCode, 404);
  });

  test('sin registerInternal (producción) la ruta no existe', async () => {
    const production = await buildApp({ config: readConfig(), db: null, logger: false });
    for (const URL of URLS) {
        const response = await production.inject({ method: 'POST', url: URL, payload: body, headers: { 'x-dev-operator-token': TOKEN } });
        assert.equal(response.statusCode, 404);
    }
    await production.close();
  });
});

describe('rutinas de producción /jobs/utec (protegidas con CRON_SECRET)', () => {
  const SECRET = 'rutinas-secretas-0123456789-abcdefghijklmnop';
  const auth = { authorization: `Bearer ${SECRET}` };
  let app: FastifyInstance; let bare: FastifyInstance;
  const make = async (cronSecret: string | null) => buildApp({
    config: { ...readConfig(), nodeEnv: 'production' as const }, db: null, logger: false,
    registerInternal: async (instance) => { await instance.register(devImportRoutes, { db: {} as Database, mode: 'jobs', cronSecret }); },
  });
  before(async () => { app = await make(SECRET); bare = await make(null); });
  after(async () => { await app.close(); await bare.close(); });

  test('sin clave o con clave equivocada → 401; sin CRON_SECRET configurada → 503', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/jobs/utec/refresh' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/jobs/utec/refresh', headers: { authorization: 'Bearer otra' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/jobs/utec/imports/00000000-0000-4000-8000-000000000000' })).statusCode, 401);
    assert.equal((await bare.inject({ method: 'POST', url: '/jobs/utec/refresh', headers: auth })).statusCode, 503);
  });

  test('con la clave correcta la rutina arranca sus comprobaciones (aquí falla por no haber CREDENTIALS_KEY, antes de tocar nada)', async () => {
    const response = await app.inject({ method: 'POST', url: '/jobs/utec/refresh', headers: auth });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'credentials_key_missing');
    assert.equal((await app.inject({ method: 'GET', url: '/jobs/utec/imports/00000000-0000-4000-8000-000000000000', headers: auth })).statusCode, 404);
  });

  test('en producción NO existen las rutas que reciben contraseñas ni las de desarrollo', async () => {
    for (const url of ['/jobs/utec/create-user', '/jobs/utec/refresh/full', '/jobs/utec/refresh/daily', '/jobs/utec/calendar/import', '/internal/dev/utec/refresh/stored', '/internal/dev/utec/create-user']) {
      assert.equal((await app.inject({ method: 'POST', url, headers: auth, payload: body })).statusCode, 404, url);
    }
  });
});
