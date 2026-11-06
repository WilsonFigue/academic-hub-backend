import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import pg from 'pg';
import { ConfigError, loadEnvFile, readConfig, usesSocket } from '../src/config/env.js';
import { trimFileCache } from '../src/modules/files/store.js';

// El .env local se carga antes para que no pise después las variables de cada prueba.
loadEnvFile();
const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

const production = { NODE_ENV: 'production', DATABASE_URL: '', DB_NAME: 'base', DB_USER: 'usuario', DB_PASSWORD: 'cl@ve/rara', DB_SSL_MODE: 'require', DB_SSL_CA_FILE: '',
  COOKIE_SECURE: 'true', DEV_OPERATOR_TOKEN: '', FRONTEND_ORIGIN: 'https://web.example.com' };

test('Cloud Run: DB_HOST con la ruta del socket de Cloud SQL conecta por socket y sin TLS propio, también en producción', () => {
  Object.assign(process.env, production, { DB_HOST: '/cloudsql/proyecto:us-central1:instancia' });
  const config = readConfig();
  assert.equal(usesSocket(config.databaseUrl), true);
  assert.equal(config.dbSslMode, 'disable');
  // Lo que pg entiende de esa URL (sin conectarse): el directorio del socket, la base y la contraseña con sus símbolos intactos.
  const client = new pg.Client({ connectionString: config.databaseUrl! });
  assert.deepEqual([client.host, client.database, client.user, client.password, client.port], ['/cloudsql/proyecto:us-central1:instancia', 'base', 'usuario', 'cl@ve/rara', 5432]);
});

test('por red (IP o nombre) producción sigue exigiendo verify-full', () => {
  Object.assign(process.env, production, { DB_HOST: '10.0.0.5' });
  assert.throws(() => readConfig(), (error: ConfigError) => error instanceof ConfigError && error.problems.some((p) => p.includes('verify-full')));
  assert.equal(usesSocket('postgresql://u:p@10.0.0.5:5432/base'), false);
});

test('FILES_CACHE_MAX_MB: la copia local de archivos se recorta borrando primero lo más viejo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-cache-'));
  try {
    for (const [name, age] of [['viejo', 300], ['medio', 200], ['nuevo', 100]] as const) {
      writeFileSync(join(dir, name), Buffer.alloc(1000));
      utimesSync(join(dir, name), new Date(Date.now() - age * 1000), new Date(Date.now() - age * 1000));
    }
    assert.equal(trimFileCache(5000, dir), 0, 'bajo el tope no se borra nada');
    assert.equal(trimFileCache(1500, dir), 2);
    assert.deepEqual(readdirSync(dir), ['nuevo']);
    assert.equal(trimFileCache(1500, join(dir, 'no-existe')), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
