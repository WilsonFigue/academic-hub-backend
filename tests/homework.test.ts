import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { classifyActivity } from '../src/modules/homework/eligibility.js';
import { DEFAULT_HOMEWORK_POLICY, HOMEWORK_DIR, HomeworkError, enqueueRoutine, monthlySpend, processQueue, type HomeworkGenerator, type HomeworkResult } from '../src/modules/homework/homework.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';
const DAY = 86_400_000;

describe('elegibilidad: nunca exámenes, sí las guías y entregas', () => {
  const kind = (category: string | null, name: string) => classifyActivity(category, name).kind;
  test('las categorías de tarea entran aunque el nombre hable de examen', () => {
    assert.equal(kind('Homework.name', 'Guia de ejercicios 2'), 'activity');
    assert.equal(kind('Assignment.name', 'Guía de ejercicios para el examen 2'), 'activity');
    assert.equal(kind('Discussion.name', 'Foro: Algebra de Boole'), 'activity');
    assert.equal(kind('Journal.name', 'Actividad para semana 6'), 'activity');
  });
  test('los exámenes y cuestionarios en línea quedan bloqueados', () => {
    assert.equal(kind('Test.name', 'EXAMEN 2 ORDINARIO'), 'exam');
    assert.equal(kind('Exam.name', 'Primera evaluación parcial EI-01'), 'exam');
    assert.equal(kind('Test.name', 'Cuestionario Semanal'), 'exam');
    assert.equal(kind('Test.name', 'Control de Lectura 3'), 'exam');
    assert.equal(kind('Test.name', 'Entrega del examen parcial'), 'exam');
    assert.equal(kind('Test.name', 'Algo sin pistas'), 'exam');
  });
  test('una entrega guardada como Test sigue siendo una actividad', () => {
    assert.equal(kind('Test.name', 'Enntrega tercera actividad - 40%'), 'activity');
  });
  test('sin categoría decide el nombre y ante la duda se bloquea', () => {
    assert.equal(kind(null, 'Tarea de repaso'), 'activity');
    assert.equal(kind(null, 'Parcial 1'), 'exam');
    assert.equal(kind(null, 'Cosa rara'), 'exam');
  });
});

describe('tareas con IA: reglas, cola y rutina (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  let alice: TestClient;
  let bob: TestClient;
  const createdRuns: string[] = [];

  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  const activity = async (enrollment: string, course: string, external: string, name: string, category: string, dueInDays: number | null, extra: { score?: number; submitted?: boolean } = {}) => {
    const column = await one(
      `INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible, due_at) VALUES ($1, $2, $3, $4, 10, $5) RETURNING id`,
      [course, external, name, category, dueInDays === null ? null : new Date(Date.now() + dueInDays * DAY).toISOString()]);
    return one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id, score, is_submitted) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [enrollment, course, column, extra.score ?? null, extra.submitted ?? false]);
  };
  const runs = async (enrollment: string) => (await ctx.db.query<{ status: string; trigger: string; error_code: string | null }>(`SELECT status, trigger, error_code FROM homework_runs WHERE enrollment_id = $1`, [enrollment])).rows;
  const fake = (fn: (runId: string) => Promise<HomeworkResult>): HomeworkGenerator => ({ configured: true, generate: (request) => fn(request.runId) });
  const result = (costUsd = 0.25): HomeworkResult => ({ deliverables: [{ name: 'tarea.pdf', kind: 'pdf', bytes: 4 }], summary: 'ok', report: { turns: 2, tools: {}, assumptions: [], pending: [], placeholders: [], warnings: [], materialDocs: [] }, model: 'fake', inputTokens: 100, outputTokens: 200, costUsd });

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
    ids.guia = await activity(ids.aMate, ids.mate, '_c1', 'Guía de ejercicios 2', 'Homework.name', 5);
    ids.tarea = await activity(ids.aMate, ids.mate, '_c2', 'Tarea 2', 'Assignment.name', 9);
    ids.examen = await activity(ids.aMate, ids.mate, '_c3', 'EXAMEN 2 ORDINARIO', 'Test.name', 6);
    ids.vencida = await activity(ids.aMate, ids.mate, '_c4', 'Tarea vencida', 'Homework.name', -3);
    ids.entregada = await activity(ids.aMate, ids.mate, '_c5', 'Tarea entregada', 'Homework.name', 4, { submitted: true });
    ids.calificada = await activity(ids.aMate, ids.mate, '_c6', 'Tarea calificada', 'Homework.name', 6, { score: 8 });
    ids.ensayo = await activity(ids.aFilo, ids.filo, '_f1', 'Ensayo', 'Assignment.name', 7);
    ids.bTarea = await activity(ids.bMate, ids.mate, '_b1', 'Tarea de Bob', 'Homework.name', 3);
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin);
    bob = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
  });
  after(async () => {
    for (const id of createdRuns) rmSync(join(HOMEWORK_DIR, id), { recursive: true, force: true });
    if (ctx) await teardownTestContext(ctx);
  });

  const settings = async (client: TestClient) => ((await client.request('GET', '/api/v1/homework/settings')).json().courses as Array<{ courseId: string; enabled: boolean }>);

  test('por defecto todas las materias están apagadas y la rutina no encola nada', async () => {
    assert.ok((await settings(alice)).every((course) => !course.enabled));
    const summary = await enqueueRoutine(ctx.db);
    assert.equal(summary.enqueued, 0);
    assert.equal((await runs(ids.aMate)).length, 0);
  });

  test('el estudiante enciende una materia sin afectar a otra ni a otro usuario; una ajena da 404', async () => {
    assert.equal((await alice.request('PUT', `/api/v1/courses/${ids.mate}/homework/setting`, { enabled: true })).statusCode, 200);
    assert.equal((await settings(alice)).find((c) => c.courseId === ids.mate)!.enabled, true);
    assert.equal((await settings(alice)).find((c) => c.courseId === ids.filo)!.enabled, false);
    assert.equal((await settings(bob)).find((c) => c.courseId === ids.mate)!.enabled, false);
    assert.equal((await bob.request('PUT', `/api/v1/courses/${ids.filo}/homework/setting`, { enabled: true })).statusCode, 404);
  });

  test('la rutina encola solo lo pendiente y que no sea examen, sin duplicar ni mezclar usuarios', async () => {
    const first = await enqueueRoutine(ctx.db);
    assert.equal(first.enqueued, 2);                 // guía y tarea; el examen, lo vencido, lo entregado y lo calificado no entran
    assert.equal(first.blockedExams, 1);
    assert.deepEqual((await runs(ids.aMate)).map((r) => r.trigger), ['routine', 'routine']);
    assert.equal((await runs(ids.aFilo)).length, 0);
    assert.equal((await runs(ids.bMate)).length, 0);
    assert.equal((await enqueueRoutine(ctx.db)).enqueued, 0);
  });

  test('sin IA conectada la cola no se procesa y nada se pierde', async () => {
    const summary = await processQueue(ctx.db, { configured: false, generate: async () => { throw new Error('no debe llamarse'); } });
    assert.equal(summary.skippedReason, 'ai_not_configured');
    assert.equal((await runs(ids.aMate)).filter((r) => r.status === 'requested').length, 2);
  });

  test('con un generador: quedan listas con su costo; un fallo guarda igualmente el costo gastado', async () => {
    let calls = 0;
    const generator = fake(async (runId) => {
      calls += 1;
      if (calls === 2) throw new HomeworkError('bad_output', { inputTokens: 1000, outputTokens: 2000, costUsd: 0.04 });
      mkdirSync(join(HOMEWORK_DIR, runId), { recursive: true }); writeFileSync(join(HOMEWORK_DIR, runId, 'tarea.pdf'), '%PDF'); createdRuns.push(runId);
      return result(0.25);
    });
    const summary = await processQueue(ctx.db, generator);
    assert.deepEqual([summary.processed, summary.ready, summary.failed], [2, 1, 1]);
    const rows = (await ctx.db.query<{ status: string; cost_usd: string; error_code: string | null }>(`SELECT status, cost_usd, error_code FROM homework_runs WHERE enrollment_id = $1 ORDER BY status`, [ids.aMate])).rows;
    assert.deepEqual(rows.map((r) => [r.status, Number(r.cost_usd)]), [['failed', 0.04], ['ready', 0.25]]);
    assert.equal(rows.find((r) => r.status === 'failed')!.error_code, 'bad_output');
    assert.equal((await monthlySpend(ctx.db)).spent, 0.29);
  });

  test('si algo deja de estar pendiente o resulta ser un examen antes de procesarlo, se omite sin llamar a la IA', async () => {
    await ctx.db.query(`UPDATE homework_settings SET enabled = true WHERE enrollment_id = $1`, [ids.aMate]);
    const lateTask = await activity(ids.aMate, ids.mate, '_c7', 'Tarea tardía', 'Homework.name', 2);
    const sneaky = await activity(ids.aMate, ids.mate, '_c8', 'Cuestionario de repaso', 'Test.name', 2);
    assert.equal((await enqueueRoutine(ctx.db)).enqueued, 1);
    // Forzamos una fila de examen en cola (por ejemplo, creada por un cambio de categoría posterior) y entregamos la otra.
    const col = (await ctx.db.query<{ gradebook_column_id: string; course_id: string }>(`SELECT gradebook_column_id, course_id FROM student_grades WHERE id = $1`, [sneaky])).rows[0]!;
    await ctx.db.query(`INSERT INTO homework_runs (enrollment_id, course_id, gradebook_column_id, trigger) VALUES ($1, $2, $3, 'routine')`, [ids.aMate, col.course_id, col.gradebook_column_id]);
    await ctx.db.query(`UPDATE student_grades SET is_submitted = true WHERE id = $1`, [lateTask]);
    const generator = fake(async () => { throw new Error('no debe llamarse'); });
    const summary = await processQueue(ctx.db, generator);
    assert.deepEqual([summary.processed, summary.skipped], [0, 2]);
    const rows = (await ctx.db.query<{ error_code: string }>(`SELECT error_code FROM homework_runs WHERE status = 'skipped' ORDER BY error_code`)).rows;
    assert.deepEqual(rows.map((r) => r.error_code), ['exam_blocked', 'not_pending']);
  });

  test('tope de gasto mensual: con el presupuesto agotado no se encola ni se procesa', async () => {
    const policy = { ...DEFAULT_HOMEWORK_POLICY, monthlyCapUsd: 0.3 };
    await activity(ids.aMate, ids.mate, '_c9', 'Tarea nueva', 'Homework.name', 3);
    assert.equal((await enqueueRoutine(ctx.db, policy)).skipped, 'monthly_cap');
    const generator = fake(async () => { throw new Error('no debe llamarse'); });
    assert.equal((await processQueue(ctx.db, generator, policy)).skippedReason, 'monthly_cap');
  });

  test('el dueño ve su tarea y descarga sus archivos; otro usuario recibe 404', async () => {
    const state = (await alice.request('GET', `/api/v1/activities/${ids.guia}/homework`)).json() as { eligible: boolean; homework: { status: string; deliverables: Array<{ name: string }> } | null };
    const ready = state.homework?.status === 'ready' ? state : (await alice.request('GET', `/api/v1/activities/${ids.tarea}/homework`)).json();
    assert.equal(ready.homework.status, 'ready');
    const activityId = state.homework?.status === 'ready' ? ids.guia : ids.tarea;
    const file = await alice.request('GET', `/api/v1/activities/${activityId}/homework/files/tarea.pdf`);
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'application/pdf');
    assert.equal((await bob.request('GET', `/api/v1/activities/${activityId}/homework/files/tarea.pdf`)).statusCode, 404);
    assert.equal((await alice.request('GET', `/api/v1/activities/${activityId}/homework/files/otro.pdf`)).statusCode, 404);
    assert.equal((await alice.request('GET', `/api/v1/activities/${ids.examen}/homework`)).json().eligible, false);
  });
});
