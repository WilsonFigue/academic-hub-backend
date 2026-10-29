import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { DEFAULT_POLICY, GuideError, enqueueRoutine, monthlySpend, processQueue, type GuideGenerator } from '../src/modules/guides/guides.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';
const DAY = 86_400_000;

describe('guías de estudio: reglas, cola y rutina (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  const ids: Record<string, string> = {};
  let alice: TestClient;
  let bob: TestClient;

  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  /** Crea una actividad con su calificación personal para una inscripción. */
  const activity = async (enrollment: string, course: string, external: string, name: string, dueInDays: number | null, extra: { score?: number; submitted?: boolean } = {}) => {
    const column = await one(
      `INSERT INTO gradebook_columns (course_id, external_id, name, points_possible, due_at) VALUES ($1, $2, $3, 10, $4) RETURNING id`,
      [course, external, name, dueInDays === null ? null : new Date(Date.now() + dueInDays * DAY).toISOString()]);
    return one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id, score, is_submitted) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [enrollment, course, column, extra.score ?? null, extra.submitted ?? false]);
  };
  const guideRows = async (enrollment: string) => (await ctx.db.query<{ status: string; trigger: string }>(`SELECT status, trigger FROM study_guides WHERE enrollment_id = $1`, [enrollment])).rows;

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
    const enroll = (account: string, course: string, external: string) =>
      one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, $4) RETURNING id`, [account, ids.inst, course, external]);
    ids.aMate = await enroll(ids.eaA, ids.mate, '_m1');
    ids.aFilo = await enroll(ids.eaA, ids.filo, '_m2');
    ids.bMate = await enroll(ids.eaB, ids.mate, '_m3');
    ids.tarea1 = await activity(ids.aMate, ids.mate, '_c1', 'Tarea 1', 5);
    ids.tarea2 = await activity(ids.aMate, ids.mate, '_c2', 'Tarea 2', 9);
    ids.vencida = await activity(ids.aMate, ids.mate, '_c3', 'Vencida', -3);
    ids.entregada = await activity(ids.aMate, ids.mate, '_c4', 'Entregada', 4, { submitted: true });
    ids.calificada = await activity(ids.aMate, ids.mate, '_c5', 'Calificada', 6, { score: 8 });
    ids.sinFecha = await activity(ids.aMate, ids.mate, '_c6', 'Sin fecha', null);
    ids.ensayo = await activity(ids.aFilo, ids.filo, '_f1', 'Ensayo', 7);
    ids.bTarea = await activity(ids.bMate, ids.mate, '_b1', 'Tarea de Bob', 3);
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin);
    bob = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  const settings = async (client: TestClient) => ((await client.request('GET', '/api/v1/study-guides/settings')).json().courses as Array<{ courseId: string; enabled: boolean }>);

  test('por defecto todas las materias están apagadas', async () => {
    const courses = await settings(alice);
    assert.equal(courses.length, 2);
    assert.ok(courses.every((course) => course.enabled === false));
  });

  test('el estudiante enciende y apaga una materia sin afectar a otra ni a otro usuario', async () => {
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.mate}/study-guides/setting`, { enabled: true })).statusCode, 200);
    const mine = await settings(alice);
    assert.deepEqual(mine.map((c) => [c.courseId === ids.mate, c.enabled]).sort(), [[false, false], [true, true]]);
    assert.ok((await settings(bob)).every((course) => course.enabled === false), 'Bob sigue apagado');
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.mate}/study-guides/setting`, { enabled: false })).statusCode, 200);
    assert.ok((await settings(alice)).every((course) => course.enabled === false));
  });

  test('no se puede cambiar el ajuste de una materia ajena', async () => {
    assert.equal((await bob.request('PUT', `/api/v1/courses/${ids.filo}/study-guides/setting`, { enabled: true })).statusCode, 404);
    assert.equal((await bob.request('GET', `/api/v1/activities/${ids.tarea1}/study-guide`)).statusCode, 404);
    assert.equal((await bob.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`)).statusCode, 404);
  });

  test('botón manual: funciona con la materia apagada, queda en cola sin IA y no se puede duplicar', async () => {
    const before = (await alice.request('GET', `/api/v1/activities/${ids.tarea1}/study-guide`)).json();
    assert.deepEqual([before.courseEnabled, before.guide, before.canRequest], [false, null, true]);
    const created = await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`);
    assert.equal(created.statusCode, 202);
    assert.deepEqual([created.json().guide.status, created.json().guide.trigger, created.json().queued], ['requested', 'manual', true]);
    const after = (await alice.request('GET', `/api/v1/activities/${ids.tarea1}/study-guide`)).json();
    assert.equal(after.canRequest, false);
    const again = await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'study_guide_exists');
    assert.equal((await ctx.db.query(`SELECT 1 FROM study_guides WHERE enrollment_id = $1`, [ids.aMate])).rowCount, 1);
  });

  test('la rutina ignora las materias apagadas', async () => {
    await ctx.db.query('DELETE FROM study_guides');
    const summary = await enqueueRoutine(ctx.db);
    assert.equal(summary.enqueued, 0);
    assert.deepEqual(await guideRows(ids.aMate!), []);
  });

  test('la rutina encola solo lo pendiente (sin entregar, sin nota, vigente), no duplica y no mezcla usuarios', async () => {
    await alice.request('PUT', `/api/v1/courses/${ids.mate}/study-guides/setting`, { enabled: true });
    const first = await enqueueRoutine(ctx.db);
    assert.equal(first.enqueued, 2, 'Tarea 1 y Tarea 2; no la vencida, la entregada, la calificada ni la sin fecha');
    const rows = await ctx.db.query<{ name: string; trigger: string }>(
      `SELECT gc.name, g.trigger FROM study_guides g JOIN gradebook_columns gc ON gc.id = g.gradebook_column_id WHERE g.enrollment_id = $1 ORDER BY gc.name`, [ids.aMate]);
    assert.deepEqual(rows.rows, [{ name: 'Tarea 1', trigger: 'routine' }, { name: 'Tarea 2', trigger: 'routine' }]);
    assert.deepEqual(await guideRows(ids.aFilo!), [], 'Filosofía sigue apagada');
    assert.deepEqual(await guideRows(ids.bMate!), [], 'Bob no activó nada');
    assert.equal((await enqueueRoutine(ctx.db)).enqueued, 0, 'segunda corrida: no duplica');
  });

  test('si la actividad ya tiene guía (aunque sea del botón manual), la rutina no la vuelve a crear', async () => {
    await ctx.db.query('DELETE FROM study_guides');
    await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`);
    assert.equal((await enqueueRoutine(ctx.db)).enqueued, 1, 'solo Tarea 2');
    const manual = (await ctx.db.query(`SELECT trigger FROM study_guides g JOIN gradebook_columns gc ON gc.id = g.gradebook_column_id WHERE gc.name = 'Tarea 1'`)).rows[0];
    assert.equal(manual?.trigger, 'manual');
  });

  test('tope de guías por corrida y tope de gasto mensual', async () => {
    await ctx.db.query('DELETE FROM study_guides');
    assert.equal((await enqueueRoutine(ctx.db, { ...DEFAULT_POLICY, maxPerRun: 1 })).enqueued, 1);
    await ctx.db.query('DELETE FROM study_guides');
    // El tope mensual se agota con lo ya gastado: no se encola nada.
    const column = (await ctx.db.query<{ gradebook_column_id: string }>(`SELECT gradebook_column_id FROM student_grades WHERE id = $1`, [ids.vencida])).rows[0]!.gradebook_column_id;
    await ctx.db.query(
      `INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, trigger, status, content, cost_usd, finished_at) VALUES ($1, $2, $3, 'manual', 'ready', '{"summary":"","sections":[],"sources":[]}', 4.99, now())`,
      [ids.aMate, ids.mate, column]);
    const capped = await enqueueRoutine(ctx.db, { ...DEFAULT_POLICY, monthlyCapUsd: 5 });
    assert.deepEqual([capped.enqueued, capped.skipped], [0, 'monthly_cap']);
    assert.ok((await monthlySpend(ctx.db)).spent >= 4.99);
    await ctx.db.query('DELETE FROM study_guides');
  });

  test('sin IA conectada la cola no se procesa y nada se pierde', async () => {
    await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`);
    const result = await processQueue(ctx.db, { configured: false, generate: async () => { throw new Error('no debe llamarse'); } });
    assert.deepEqual([result.processed, result.skipped], [0, 'ai_not_configured']);
    assert.deepEqual((await guideRows(ids.aMate!)).map((row) => row.status), ['requested']);
  });

  test('con un generador: la guía queda lista con su costo; si falla se puede reintentar y no se duplica', async () => {
    await ctx.db.query('DELETE FROM study_guides');
    await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`);
    let fail = true;
    const generator: GuideGenerator = {
      configured: true,
      async generate() {
        if (fail) throw new GuideError('model_unavailable');
        return { content: { summary: 'Resumen', sections: [{ heading: 'Qué te piden', body: 'Texto' }], sources: [{ file: 'Clase 1.pdf' }] }, model: 'modelo-de-prueba', inputTokens: 1000, outputTokens: 200, costUsd: 0.04 };
      },
    };
    const failed = await processQueue(ctx.db, generator);
    assert.deepEqual([failed.processed, failed.failed], [1, 1]);
    const state = (await alice.request('GET', `/api/v1/activities/${ids.tarea1}/study-guide`)).json();
    assert.deepEqual([state.guide.status, state.guide.errorCode, state.canRequest], ['failed', 'model_unavailable', true]);

    const retry = await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`);
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.json().guide.status, 'requested');
    fail = false;
    const ok = await processQueue(ctx.db, generator);
    assert.deepEqual([ok.processed, ok.ready], [1, 1]);
    const ready = (await alice.request('GET', `/api/v1/activities/${ids.tarea1}/study-guide`)).json();
    assert.equal(ready.guide.status, 'ready');
    assert.equal(ready.guide.content.sources[0].file, 'Clase 1.pdf');
    assert.equal(ready.canRequest, false);
    assert.equal((await alice.request('POST', `/api/v1/activities/${ids.tarea1}/study-guide`)).statusCode, 409);
    const spend = await monthlySpend(ctx.db);
    assert.equal(spend.spent, 0.04);
    assert.equal((await ctx.db.query(`SELECT 1 FROM study_guides`)).rowCount, 1);
  });

  test('una guía abandonada en "generando" vuelve a la cola', async () => {
    await ctx.db.query(`UPDATE study_guides SET status = 'generating', started_at = now() - interval '1 hour', content = NULL, cost_usd = NULL`);
    const generator: GuideGenerator = { configured: true, generate: async () => ({ content: { summary: 'ok', sections: [], sources: [] }, model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.01 }) };
    const result = await processQueue(ctx.db, generator);
    assert.deepEqual([result.processed, result.ready], [1, 1]);
  });
});
