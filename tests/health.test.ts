import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config/env.js';
import { buildApp } from '../src/app.js';

test('GET /health responde ok sin base de datos', async () => {
  const app = await buildApp({ config: readConfig(), db: null, logger: false });
  const response = await app.inject({ url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  await app.close();
});

test('GET /health/db responde 503 sin revelar configuración cuando no hay base', async () => {
  const app = await buildApp({ config: readConfig(), db: null, logger: false });
  const response = await app.inject({ url: '/health/db' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'unavailable', database: 'not_configured' });
  await app.close();
});
