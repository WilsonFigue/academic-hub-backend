import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';

describe('docente de la materia (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  let alice: TestClient;
  let bob: TestClient;
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;

  before(async () => {
    ctx = await setupTestContext();
    const hash = await hashPassword(PASSWORD);
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, password_hash) VALUES ('alice@test.invalid', $1) RETURNING id`, [hash]);
    ids.bob = await one(`INSERT INTO users (email, password_hash) VALUES ('bob@test.invalid', $1) RETURNING id`, [hash]);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.mate = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_200_1', 'Matemática I') RETURNING id`, [ids.inst]);
    ids.filo = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_201_1', 'Filosofía') RETURNING id`, [ids.inst]);
    await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [ids.eaA, ids.inst, ids.mate]);
    await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m2') RETURNING id`, [ids.eaB, ids.inst, ids.filo]);
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin); bob = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  const instructorOf = async (client: TestClient, id: string) => (await client.request('GET', `/api/v1/courses/${id}`)).json().course.instructorName as string | null;

  test('quien cursa la materia guarda el nombre completo y aparece en la materia; se limpian los espacios', async () => {
    assert.equal(await instructorOf(alice, ids.mate), null);
    const saved = await alice.request('PUT', `/api/v1/courses/${ids.mate}/instructor`, { name: '  Mtro. Lic.   Joaquín Ernesto Aparicio Pacheco ' });
    assert.equal(saved.statusCode, 200);
    assert.equal(await instructorOf(alice, ids.mate), 'Mtro. Lic. Joaquín Ernesto Aparicio Pacheco');
  });

  test('no se puede cambiar el docente de una materia ajena', async () => {
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.filo}/instructor`, { name: 'Otro Docente' })).statusCode, 404);
    assert.equal((await bob.request('PUT', `/api/v1/courses/${ids.mate}/instructor`, { name: 'Otro Docente' })).statusCode, 404);
    assert.equal(await instructorOf(alice, ids.mate), 'Mtro. Lic. Joaquín Ernesto Aparicio Pacheco');
  });

  test('un nombre demasiado corto se rechaza y null (o vacío) borra el docente', async () => {
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.mate}/instructor`, { name: 'Jo' })).statusCode, 400);
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.mate}/instructor`, { name: null })).statusCode, 200);
    assert.equal(await instructorOf(alice, ids.mate), null);
    await alice.request('PUT', `/api/v1/courses/${ids.mate}/instructor`, { name: 'Docente Nuevo Ejemplo' });
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.mate}/instructor`, { name: '   ' })).statusCode, 200);
    assert.equal(await instructorOf(alice, ids.mate), null);
  });
});
