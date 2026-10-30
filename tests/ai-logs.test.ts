import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { createFileStore } from '../src/modules/files/store.js';
import { createHomeworkGenerator } from '../src/modules/homework/agent.js';
import { DEFAULT_HOMEWORK_POLICY, HOMEWORK_DIR, HomeworkError, enqueueRoutine, monthlySpend, processQueue, type HomeworkGenerator, type HomeworkRequest, type HomeworkResult } from '../src/modules/homework/homework.js';
import { aiSpend, logAiUsage, monthStart, nextMonthStart, periodOf } from '../src/modules/logs/logs.js';
import { buildMonthlyReport, ensureMonthlyReports, writeMonthlyReport } from '../src/modules/logs/report.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';
const DAY = 86_400_000;

describe('el mes de los topes y reportes se cuenta en hora de El Salvador', () => {
  test('límites del mes (UTC−6)', () => {
    assert.equal(monthStart(new Date('2026-10-15T12:00:00Z')).toISOString(), '2026-10-01T06:00:00.000Z');
    assert.equal(monthStart(new Date('2026-10-01T05:59:59Z')).toISOString(), '2026-09-01T06:00:00.000Z');   // aún es septiembre en El Salvador
    assert.equal(monthStart(new Date('2026-10-01T06:00:00Z')).toISOString(), '2026-10-01T06:00:00.000Z');
    assert.equal(nextMonthStart(monthStart(new Date('2026-12-20T00:00:00Z'))).toISOString(), '2027-01-01T06:00:00.000Z');
    assert.equal(periodOf(new Date('2026-10-01T05:59:59Z')), '2026-09-01');
    assert.equal(periodOf(new Date('2026-10-29T12:00:00Z')), '2026-10-01');
  });
});

describe('bitácoras, tope mensual duro y reporte (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  let alice: TestClient;
  const createdRuns: string[] = [];
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  const column = async (enrollment: string, course: string, external: string, name: string) => {
    const col = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible, due_at) VALUES ($1, $2, $3, 'Homework.name', 10, $4) RETURNING id`, [course, external, name, new Date(Date.now() + 5 * DAY).toISOString()]);
    await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [enrollment, course, col]);
    return col;
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const value = await fn(); if (value !== undefined) return value; if (Date.now() > end) throw new Error('tiempo agotado'); await new Promise((r) => setTimeout(r, 50)); }
  };
  const clean = async () => { await ctx.db.query(`DELETE FROM ai_usage_log`); await ctx.db.query(`DELETE FROM homework_runs`); };
  const fake = (fn: (request: HomeworkRequest) => Promise<HomeworkResult>): HomeworkGenerator => ({ configured: true, generate: fn });
  const result = (costUsd: number): HomeworkResult => ({ deliverables: [{ name: 't.pdf', kind: 'pdf', bytes: 1 }], summary: 'ok', report: { turns: 1, tools: {}, assumptions: [], pending: [], placeholders: [], warnings: [], materialDocs: [] }, model: 'fake', inputTokens: 1, outputTokens: 1, costUsd });

  before(async () => {
    ctx = await setupTestContext();
    const hash = await hashPassword(PASSWORD);
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ('alice@test.invalid', $1, 'ALICE EJEMPLO PRUEBA') RETURNING id`, [hash]);
    ids.bob = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ('bob@test.invalid', $1, 'BOB EJEMPLO') RETURNING id`, [hash]);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, lms_username, link_status, linked_at) VALUES ($1, $2, '_1_1', '2900001', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.mate = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_200_1', 'MATEMÁTICA I SECCIÓN 01 02-2026') RETURNING id`, [ids.inst]);
    ids.estad = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_201_1', 'ESTADÍSTICA 01 02-2026') RETURNING id`, [ids.inst]);
    const enroll = (account: string, course: string, external: string) =>
      one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, $4) RETURNING id`, [account, ids.inst, course, external]);
    ids.aMate = await enroll(ids.eaA, ids.mate, '_m1');
    ids.bEstad = await enroll(ids.eaB, ids.estad, '_m2');
    ids.colA = await column(ids.aMate, ids.mate, '_c1', 'Actividad sobre la circunferencia');
    ids.colB = await column(ids.bEstad, ids.estad, '_c2', 'Tarea de probabilidades');
    await ctx.db.query(`INSERT INTO homework_settings (enrollment_id, enabled) VALUES ($1, true), ($2, true)`, [ids.aMate, ids.bEstad]);
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin);
  });
  after(async () => {
    for (const id of createdRuns) rmSync(join(HOMEWORK_DIR, id), { recursive: true, force: true });
    if (ctx) await teardownTestContext(ctx);
  });

  test('api_request_log: guarda cada petición con su resultado y el detalle de los errores, sin cuerpos ni secretos', async () => {
    await ctx.db.query(`DELETE FROM api_request_log`);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: 'incorrecta-1234' });
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await alice.request('GET', '/api/v1/activities/00000000-0000-4000-8000-000000000000/homework');
    await alice.request('PUT', '/api/v1/courses/no-es-uuid/homework/setting', { enabled: true });
    await ctx.app.inject({ method: 'GET', url: '/health' });
    const rows = await waitFor(async () => { const r = (await ctx.db.query<Record<string, unknown>>(`SELECT * FROM api_request_log ORDER BY created_at`)).rows; return r.length >= 4 ? r : undefined; });
    assert.equal(rows.length, 4);                                                   // /health no se registra
    const [bad, good, missing, invalid] = rows;
    assert.equal(bad!.status, 401); assert.equal(bad!.outcome, 'client_error'); assert.ok(bad!.error_code);
    assert.equal(good!.status, 200); assert.equal(good!.outcome, 'ok'); assert.equal(good!.route, '/api/v1/auth/login'); assert.equal(good!.error_code, null);
    assert.equal(missing!.status, 404); assert.equal(missing!.route, '/api/v1/activities/:id/homework'); assert.equal(missing!.user_id, ids.alice);
    assert.equal(invalid!.status, 400); assert.equal(invalid!.error_code, 'validation_failed'); assert.ok(invalid!.error_detail);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes('incorrecta-1234') && !dump.includes(PASSWORD), 'no debe guardar contraseñas');
  });

  test('tope mensual duro: cada tarea recibe como presupuesto lo que queda del mes y el total nunca pasa del tope', async () => {
    await clean();
    const policy = { ...DEFAULT_HOMEWORK_POLICY, monthlyCapUsd: 10, estimatedCostUsd: 0.1 };
    const budgets: number[] = [];
    // Cada tarea gasta hasta 0,4 pero nunca más de su presupuesto, como obliga el agente real.
    const generator = fake(async (request) => { budgets.push(Math.round(request.budgetUsd! * 1e4) / 1e4); const spend = Math.min(0.4, request.budgetUsd!); await logAiUsage(ctx.db, { event: 'call', feature: 'homework', enrollmentId: request.enrollmentId, costUsd: spend }); return result(spend); });
    // El mes pasado no cuenta: el mes nuevo empieza de cero.
    await logAiUsage(ctx.db, { event: 'call', feature: 'homework', costUsd: 9.99, createdAt: new Date(monthStart().getTime() - 3 * DAY) });
    assert.equal((await monthlySpend(ctx.db)).spent, 0);
    // Este mes ya se gastaron 9,3: quedan 0,7.
    await logAiUsage(ctx.db, { event: 'call', feature: 'homework', costUsd: 9.3 });
    assert.equal((await enqueueRoutine(ctx.db, policy)).enqueued, 2);
    const summary = await processQueue(ctx.db, generator, policy);
    assert.deepEqual(budgets, [0.7, 0.3]);                                            // la primera usa 0,4 y a la segunda le quedan 0,3
    assert.equal(summary.ready, 2);
    assert.ok(Math.abs((await monthlySpend(ctx.db)).spent - 10) < 1e-9);               // llegó exacto al tope, sin pasarlo
    const again = await processQueue(ctx.db, generator, policy);
    assert.equal(again.processed, 0);
  });

  test('si lo que queda del mes es menos que el mínimo, no se llama a la IA y queda el evento cap_reached', async () => {
    await clean();
    await logAiUsage(ctx.db, { event: 'call', feature: 'homework', costUsd: 9.95 });
    await enqueueRoutine(ctx.db, { ...DEFAULT_HOMEWORK_POLICY, monthlyCapUsd: 20 });   // se encola (con otro tope) pero no se procesa con el tope real
    const generator = fake(async () => { throw new Error('no debe llamarse'); });
    const summary = await processQueue(ctx.db, generator, { ...DEFAULT_HOMEWORK_POLICY, monthlyCapUsd: 10 });
    assert.equal(summary.skippedReason, 'monthly_cap');
    assert.equal(summary.processed, 0);
    const events = (await ctx.db.query<{ event: string; error_code: string }>(`SELECT event, error_code FROM ai_usage_log WHERE event = 'cap_reached'`)).rows;
    assert.deepEqual(events.map((e) => e.error_code), ['monthly_cap']);
    assert.equal((await enqueueRoutine(ctx.db, { ...DEFAULT_HOMEWORK_POLICY, monthlyCapUsd: 10 })).skipped, 'monthly_cap');
  });

  test('agente: nunca pasa de su presupuesto, registra cada llamada y guarda el costo aunque falle', async () => {
    await clean();
    const bodies: Array<{ max_output_tokens: number; input: unknown[] }> = [];
    const responses = [
      { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'calcular', arguments: JSON.stringify({ expresiones: ['2+2'] }) }], usage: { input_tokens: 5000, output_tokens: 2000, input_tokens_details: { cached_tokens: 1200 } } },
      { status: 'completed', output: [{ type: 'function_call', call_id: 'c2', name: 'calcular', arguments: JSON.stringify({ expresiones: ['3+3'] }) }], usage: { input_tokens: 7500, output_tokens: 1000 } },
    ];
    let n = 0;
    const generator = createHomeworkGenerator({
      apiKey: 'sk-test', model: 'modelo-falso', priceInPerM: 2, priceOutPerM: 10, maxInputChars: 100_000, maxPerTaskUsd: 1.5, maxTurns: 8, db: ctx.db, store: createFileStore(null), outDir: HOMEWORK_DIR,
      fetchImpl: (async (_url: unknown, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(responses[n++]), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch,
    });
    const run = await one(`INSERT INTO homework_runs (enrollment_id, course_id, gradebook_column_id, trigger) VALUES ($1, $2, $3, 'routine') RETURNING id`, [ids.aMate, ids.mate, ids.colA]);
    createdRuns.push(run);
    const budget = 0.05;
    await assert.rejects(() => generator.generate({ runId: run, enrollmentId: ids.aMate, courseId: ids.mate, gradebookColumnId: ids.colA, budgetUsd: budget }),
      (error: unknown) => error instanceof HomeworkError && error.code === 'task_cost_cap' && error.usage!.costUsd === 0.03);
    // Tras la primera llamada (0,03) ya no cabía otra dentro de 0,05: se detuvo sin llamar. Y la salida pedida cabía en el presupuesto.
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0]!.max_output_tokens * 10 / 1e6 <= budget, 'la salida máxima no cabe en el presupuesto');
    const logged = (await ctx.db.query<{ turn: number; input_tokens: number; output_tokens: number; cached_tokens: number | null; cost_usd: string; tools: string[]; user_id: string; status: string }>(
      `SELECT turn, input_tokens, output_tokens, cached_tokens, cost_usd, tools, user_id, status FROM ai_usage_log WHERE event = 'call' ORDER BY turn`)).rows;
    assert.equal(logged.length, 1);
    assert.deepEqual(logged.map((l) => [l.turn, l.input_tokens, l.output_tokens, l.cached_tokens, Number(l.cost_usd), l.tools]), [[1, 5000, 2000, 1200, 0.03, ['calcular']]]);
    assert.ok(logged.every((l) => l.user_id === ids.alice && l.status === 'ok'));
    assert.equal((await ctx.db.query(`SELECT 1 FROM ai_usage_log WHERE event = 'cap_reached' AND error_code = 'task_budget'`)).rowCount, 1);
    assert.equal(await aiSpend(ctx.db, 'homework'), 0.03);
  });

  test('agente: un error de la API también queda registrado, con su código y sin costo', async () => {
    await clean();
    const generator = createHomeworkGenerator({
      apiKey: 'sk-test', model: 'modelo-falso', priceInPerM: 2, priceOutPerM: 10, maxInputChars: 100_000, maxPerTaskUsd: 1.5, maxTurns: 8, db: ctx.db, store: createFileStore(null), outDir: HOMEWORK_DIR,
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 'bad', message: 'Parámetro inválido' } }), { status: 400 })) as unknown as typeof fetch,
    });
    await assert.rejects(() => generator.generate({ runId: ids.colA, enrollmentId: ids.aMate, courseId: ids.mate, gradebookColumnId: ids.colA, budgetUsd: 1 }), (e: unknown) => e instanceof HomeworkError && e.code === 'openai_http_400');
    const row = (await ctx.db.query<{ status: string; error_code: string; cost_usd: string; detail: { http: number; message: string } }>(`SELECT status, error_code, cost_usd, detail FROM ai_usage_log WHERE event = 'call'`)).rows;
    assert.deepEqual(row.map((r) => [r.status, r.error_code, Number(r.cost_usd), r.detail.http, r.detail.message]), [['error', 'openai_http_400', 0, 400, 'Parámetro inválido']]);
    createdRuns.push(ids.colA);
  });

  test('reporte mensual: desglose por persona, materia y actividad; se guarda una sola vez por mes', async () => {
    await clean();
    const last = new Date(monthStart().getTime() - 5 * DAY);                       // un día del mes pasado
    const mk = (enrollment: string, course: string, column: string, cost: number, feature: 'homework' | 'study_guide', input: number, output: number) =>
      logAiUsage(ctx.db, { event: 'call', feature, enrollmentId: enrollment, courseId: course, gradebookColumnId: column, model: 'gpt-x', inputTokens: input, outputTokens: output, costUsd: cost, createdAt: last, turn: 1 });
    await mk(ids.aMate, ids.mate, ids.colA, 0.061, 'homework', 40_271, 4_147);
    await mk(ids.aMate, ids.mate, ids.colA, 0.0103, 'study_guide', 2_103, 1_648);
    await mk(ids.bEstad, ids.estad, ids.colB, 0.315, 'homework', 250_901, 12_820);
    const start = monthStart(last);
    const report = await buildMonthlyReport(ctx.db, start, { capUsd: 10, now: new Date() });
    assert.equal(report.partial, false);
    assert.equal(Math.round(report.homeworkUsd * 1e4) / 1e4, 0.376);
    assert.equal(Math.round(report.studyGuideUsd * 1e4) / 1e4, 0.0103);
    assert.deepEqual(report.users.map((u) => u.name), ['Bob', 'Alice']);               // ordenados por gasto
    assert.ok(report.message.includes('Bob, gastaste USD 0,3150 en tokens este mes (250 901 de entrada y 12 820 de salida, 1 llamada).'));
    assert.ok(report.message.includes('Alice, gastaste USD 0,0713'));
    assert.ok(report.message.includes('• MATEMÁTICA I: USD 0,0713') && report.message.includes('– Actividad sobre la circunferencia (tarea): USD 0,0610') && report.message.includes('(guía de estudio): USD 0,0103'));
    assert.ok(report.message.includes('Quedan USD 9,6240'));
    // Un reporte parcial guardado durante el mes (con el mes aún en curso) se reemplaza por el definitivo al terminar el mes.
    await writeMonthlyReport(ctx.db, start, { capUsd: 10, force: true, now: new Date(start.getTime() + 2 * DAY) });
    assert.equal((await ctx.db.query(`SELECT 1 FROM ai_usage_log WHERE event = 'monthly_report' AND (detail->>'partial')::boolean`)).rowCount, 1);
    // Se genera una sola vez y de forma automática para el mes ya terminado.
    assert.deepEqual(await ensureMonthlyReports(ctx.db, { capUsd: 10 }), [periodOf(last).slice(0, 7)]);
    assert.deepEqual(await ensureMonthlyReports(ctx.db, { capUsd: 10 }), []);
    const stored = (await ctx.db.query<{ message: string; detail: { users: unknown[] } }>(`SELECT message, detail FROM ai_usage_log WHERE event = 'monthly_report'`)).rows;
    assert.equal(stored.length, 1);
    assert.ok(!stored[0]!.message.includes('parcial'));
    assert.ok(stored[0]!.message.includes('Bob, gastaste'));
    assert.equal(stored[0]!.detail.users.length, 2);
    // Regenerarlo a la fuerza reemplaza el reporte del mes en lugar de duplicarlo.
    await writeMonthlyReport(ctx.db, start, { capUsd: 10, force: true });
    assert.equal((await ctx.db.query(`SELECT 1 FROM ai_usage_log WHERE event = 'monthly_report'`)).rowCount, 1);
    // Los reportes no cuentan como gasto.
    assert.equal(await aiSpend(ctx.db, 'homework', last), 0.376);
  });
});
