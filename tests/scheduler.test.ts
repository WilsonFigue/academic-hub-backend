import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseMonthly, parseTimes, parseWeekly } from '../src/config/schedule.js';
import type { Mail, Mailer } from '../src/modules/notifications/mailer.js';
import { sendMonthly } from '../src/modules/notifications/monthly.js';
import { buildJobs, type JobCall } from '../src/modules/scheduler/jobs.js';
import { createScheduler, dueSlot, type Job } from '../src/modules/scheduler/scheduler.js';
import { setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

// Hora de El Salvador (UTC-6) → instante UTC.
const sv = (text: string) => Date.parse(`${text}-06:00`);
const HOUR = 3_600_000;

describe('horarios: lectura de la configuración', () => {
  test('horas del día, semanal, mensual y «off»', () => {
    assert.deepEqual(parseTimes('06:00,13:00,20:00'), [{ hour: 6, minute: 0 }, { hour: 13, minute: 0 }, { hour: 20, minute: 0 }]);
    assert.deepEqual(parseTimes('off'), []);
    assert.deepEqual(parseWeekly('dom@20:00'), [{ hour: 20, minute: 0, weekday: 0 }]);
    assert.deepEqual(parseMonthly('1@08:00'), [{ hour: 8, minute: 0, dayOfMonth: 1 }]);
    assert.deepEqual(parseWeekly('OFF'), []);
  });
  test('valores mal escritos se rechazan', () => {
    for (const bad of ['25:00', '6', '06:00,xx', '06:60']) assert.equal(parseTimes(bad), null, bad);
    for (const bad of ['domingo@20:00', 'dom', 'dom@99:00']) assert.equal(parseWeekly(bad), null, bad);
    for (const bad of ['0@08:00', '31@08:00', 'uno@08:00', '1']) assert.equal(parseMonthly(bad), null, bad);
  });
});

describe('qué horario toca ahora (dueSlot)', () => {
  const daily = parseTimes('06:00,13:00,20:00')!;
  test('tres veces al día: toca el horario que acaba de pasar, y se recupera hasta 3 h después', () => {
    assert.equal(dueSlot(daily, sv('2026-10-31T05:59:00'), 3 * HOUR), null, 'antes de las 6:00 todavía no (y el de anoche ya pasó hace más de 3 h)');
    assert.equal(dueSlot(daily, sv('2026-10-31T06:00:30'), 3 * HOUR)?.key, '2026-10-31@06:00');
    assert.equal(dueSlot(daily, sv('2026-10-31T08:59:00'), 3 * HOUR)?.key, '2026-10-31@06:00', 'si la PC estaba apagada, se recupera dentro de la ventana');
    assert.equal(dueSlot(daily, sv('2026-10-31T09:30:00'), 3 * HOUR), null, 'pasada la ventana ya no se recupera');
    assert.equal(dueSlot(daily, sv('2026-10-31T13:10:00'), 3 * HOUR)?.key, '2026-10-31@13:00');
    assert.equal(dueSlot(daily, sv('2026-10-31T22:30:00'), 3 * HOUR)?.key, '2026-10-31@20:00');
    assert.equal(dueSlot(daily, sv('2026-11-01T01:00:00'), 6 * HOUR)?.key, '2026-10-31@20:00', 'pasada la medianoche, el horario de las 20:00 sigue siendo el del día anterior');
  });
  test('si faltaron varios horarios solo se toma el más reciente', () => {
    assert.equal(dueSlot(daily, sv('2026-10-31T21:00:00'), 24 * HOUR)?.key, '2026-10-31@20:00');
  });
  test('semanal: domingo en la noche; mensual: día 1 por la mañana', () => {
    const weekly = parseWeekly('dom@20:00')!;
    assert.equal(dueSlot(weekly, sv('2026-11-01T19:59:00'), 12 * HOUR), null);
    assert.equal(dueSlot(weekly, sv('2026-11-01T20:05:00'), 12 * HOUR)?.key, '2026-11-01@20:00');          // 1 nov 2026 es domingo
    assert.equal(dueSlot(weekly, sv('2026-11-02T06:00:00'), 12 * HOUR)?.key, '2026-11-01@20:00', 'el lunes temprano todavía lo recupera');
    assert.equal(dueSlot(weekly, sv('2026-11-02T09:00:00'), 12 * HOUR), null);
    assert.equal(dueSlot(weekly, sv('2026-10-31T20:30:00'), 12 * HOUR), null, 'un sábado no');
    const monthly = parseMonthly('1@08:00')!;
    assert.equal(dueSlot(monthly, sv('2026-11-01T07:59:00'), 5 * 24 * HOUR), null);
    assert.equal(dueSlot(monthly, sv('2026-11-01T09:00:00'), 5 * 24 * HOUR)?.key, '2026-11-01@08:00');
    assert.equal(dueSlot(monthly, sv('2026-11-04T12:00:00'), 5 * 24 * HOUR)?.key, '2026-11-01@08:00', 'si la PC estuvo apagada, dentro de 5 días lo manda');
    assert.equal(dueSlot(monthly, sv('2026-11-08T12:00:00'), 5 * 24 * HOUR), null);
  });
});

describe('programador y cierre mensual (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  const sent: Mail[] = [];
  const mailer: Mailer = { configured: true, async send(mail) { sent.push(mail); return { ref: 'c1' }; } };

  before(async () => {
    ctx = await setupTestContext();
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, username, display_name, contact_email, password_hash) VALUES ('alice@test.invalid', 'alice', 'ALICE PRUEBA', 'alice.p@example.com', 'x') RETURNING id`);
    ids.bob = await one(`INSERT INTO users (email, username, display_name, contact_email, password_hash) VALUES ('bob@test.invalid', 'bob', 'BOB PRUEBA', 'bob.p@example.com', 'x') RETURNING id`);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.course = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_300_1', 'FÍSICA III SECCIÓN 02 02-2026') RETURNING id`, [ids.inst]);
    ids.enrA = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [ids.eaA, ids.inst, ids.course]);
    ids.enrB = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m2') RETURNING id`, [ids.eaB, ids.inst, ids.course]);
    ids.col = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible) VALUES ($1, '_gc_1', 'Tarea de vectores', 'Homework.name', 10) RETURNING id`, [ids.course]);
    // Gasto de OCTUBRE (el mes que cierra el 1 de noviembre): Alice 0.50 + 0.25 en tareas y 0.05 en guía; Bob 2.00. Y algo de septiembre.
    const use = (enrollment: string, feature: string, cost: number, at: string) => ctx.db.query(
      `INSERT INTO ai_usage_log (event, feature, enrollment_id, course_id, gradebook_column_id, input_tokens, output_tokens, cost_usd, period, created_at) VALUES ('call', $1, $2, $3, $4, 1000, 500, $5, $6::date, $7::timestamptz)`,
      [feature, enrollment, ids.course, ids.col, cost, at.slice(0, 7) + '-01', at]);
    await use(ids.enrA, 'homework', 0.5, '2026-10-15T12:00:00Z'); await use(ids.enrA, 'homework', 0.25, '2026-10-20T12:00:00Z');
    await use(ids.enrA, 'study_guide', 0.05, '2026-10-21T12:00:00Z'); await use(ids.enrB, 'homework', 2, '2026-10-22T12:00:00Z');
    await use(ids.enrA, 'homework', 0.1, '2026-09-10T12:00:00Z');
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('cada horario corre una sola vez, aunque se revise muchas veces o se reinicie el servidor', async () => {
    let runs = 0;
    const jobs: Job[] = [{ name: 'prueba', slots: parseTimes('06:00,13:00')!, catchupMs: 3 * HOUR, async run() { runs += 1; return { hecho: true }; } }];
    let now = sv('2026-10-31T06:01:00');
    const scheduler = () => createScheduler({ db: ctx.db, jobs, now: () => now });
    assert.deepEqual((await scheduler().tick()).map((r) => [r.slot, r.status]), [['2026-10-31@06:00', 'ok']]);
    assert.equal((await scheduler().tick()).length, 0, 'un servidor nuevo (reinicio) tampoco la repite');
    now = sv('2026-10-31T08:00:00'); await scheduler().tick();
    assert.equal(runs, 1);
    now = sv('2026-10-31T13:02:00');
    assert.deepEqual((await scheduler().tick()).map((r) => r.slot), ['2026-10-31@13:00']);
    assert.equal(runs, 2);
    const rows = (await ctx.db.query<{ status: string; detail: { hecho: boolean } }>(`SELECT status, detail FROM scheduled_job_runs WHERE job_name = 'prueba' ORDER BY slot_key`)).rows;
    assert.deepEqual(rows.map((r) => [r.status, r.detail.hecho]), [['ok', true], ['ok', true]]);
  });

  test('una rutina que falla queda registrada y no frena a las demás; la siguiente se ejecuta normal', async () => {
    const order: string[] = [];
    const jobs: Job[] = [
      { name: 'falla', slots: parseTimes('07:00')!, catchupMs: 3 * HOUR, async run() { order.push('falla'); throw Object.assign(new Error('Blackboard no respondió'), { code: 'blackboard_down' }); } },
      { name: 'sigue', slots: parseTimes('07:00')!, catchupMs: 3 * HOUR, async run() { order.push('sigue'); } },
    ];
    const results = await createScheduler({ db: ctx.db, jobs, now: () => sv('2026-10-31T07:05:00') }).tick();
    assert.deepEqual(results.map((r) => [r.job, r.status]), [['falla', 'failed'], ['sigue', 'ok']]);
    assert.deepEqual(order, ['falla', 'sigue'], 'corren de una en una y en orden');
    const failed = (await ctx.db.query<{ error_code: string; detail: { message: string } }>(`SELECT error_code, detail FROM scheduled_job_runs WHERE job_name = 'falla'`)).rows[0]!;
    assert.equal(failed.error_code, 'blackboard_down'); assert.match(failed.detail.message, /Blackboard no respondió/);
  });

  test('si llega otra revisión mientras una rutina corre, no arranca otra: espera a la que ya está en curso', async () => {
    let runs = 0; let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs: Job[] = [{ name: 'larga', slots: parseTimes('09:00')!, catchupMs: 3 * HOUR, async run() { runs += 1; await gate; } }];
    const scheduler = createScheduler({ db: ctx.db, jobs, now: () => sv('2026-10-31T09:01:00') });
    const first = scheduler.tick(); const second = scheduler.tick();
    let secondDone = false; void second.then(() => { secondDone = true; });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(secondDone, false, 'la segunda llamada sigue esperando mientras la rutina trabaja');
    release();
    assert.deepEqual((await second).map((r) => [r.job, r.status]), [['larga', 'ok']]);
    assert.deepEqual(await first, await second);
    assert.equal(runs, 1);
    assert.equal((await scheduler.tick()).length, 0, 'terminada, la siguiente revisión ya no tiene nada que hacer');
  });

  test('al arrancar, una rutina que quedó «corriendo» por un cierre se marca como interrumpida', async () => {
    await ctx.db.query(`INSERT INTO scheduled_job_runs (job_name, slot_key, status) VALUES ('colgada', '2026-10-30@06:00', 'running')`);
    const stop = createScheduler({ db: ctx.db, jobs: [] }).start(); stop();
    await new Promise((r) => setTimeout(r, 300));
    const row = (await ctx.db.query<{ status: string; error_code: string }>(`SELECT status, error_code FROM scheduled_job_runs WHERE job_name = 'colgada'`)).rows[0]!;
    assert.deepEqual([row.status, row.error_code], ['failed', 'interrupted']);
  });

  test('la rutina de actualizar: espera a que termine la actualización y luego calendario, guías, tareas y avisos', async () => {
    const calls: string[] = []; let polls = 0;
    const call: JobCall = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === '/jobs/utec/refresh') return { status: 202, json: { operationId: 'op1' } };
      if (path === '/jobs/utec/imports/op1') { polls += 1; return { status: 200, json: polls < 3 ? { status: 'extracting' } : { status: 'completed', stored: [{ username: 'a', ok: true }, { username: 'b', ok: true }] } }; }
      return { status: 200, json: {} };
    };
    const jobs = buildJobs({ call, db: ctx.db, sleep: async () => {}, config: { scheduleRefresh: '06:00,13:00,20:00', scheduleWeeklyEmail: 'off', scheduleMonthlyEmail: 'off', scheduleDailyEmail: 'off', homeworkMonthlyCapUsd: 10 } });
    assert.deepEqual(jobs.map((j) => j.name), ['actualizar'], 'lo apagado («off») no se programa');
    assert.equal(jobs[0]!.slots.length, 3);
    const detail = await jobs[0]!.run();
    assert.equal(polls, 3);
    assert.deepEqual(calls, ['POST /jobs/utec/refresh', 'GET /jobs/utec/imports/op1', 'GET /jobs/utec/imports/op1', 'GET /jobs/utec/imports/op1',
      'POST /jobs/utec/calendar', 'POST /jobs/utec/study-guides', 'POST /jobs/utec/homework?wait=1', 'POST /jobs/notifications']);
    assert.deepEqual((detail as { steps: Record<string, string> }).steps, { actualizar: 'ok', calendario: 'ok', guias: 'ok', tareas: 'ok', avisos: 'ok' });
  });

  test('si la actualización falla o ya hay una en curso: lo demás igual corre y el resultado lo dice', async () => {
    const calls: string[] = [];
    const failing: JobCall = async (method, path) => {
      calls.push(path);
      if (path === '/jobs/utec/refresh') return { status: 202, json: { operationId: 'op2' } };
      if (path === '/jobs/utec/imports/op2') return { status: 200, json: { status: 'completed', stored: [{ username: 'erick', ok: false, errorCode: 'invalid_credentials' }] } };
      return { status: 200, json: {} };
    };
    const cfg = { scheduleRefresh: '06:00', scheduleWeeklyEmail: 'off', scheduleMonthlyEmail: 'off', scheduleDailyEmail: 'off', homeworkMonthlyCapUsd: 10 };
    await assert.rejects(() => buildJobs({ call: failing, db: ctx.db, sleep: async () => {}, config: cfg })[0]!.run(), (e: Error & { code: string }) => e.code === 'invalid_credentials' && /erick/.test(e.message));
    assert.ok(calls.includes('/jobs/utec/study-guides') && calls.includes('/jobs/notifications'), 'aunque falle la actualización, se siguen las guías y los avisos');
    const busy: JobCall = async (_m, path) => (path === '/jobs/utec/refresh' ? { status: 409, json: { error: { code: 'import_in_progress' } } } : { status: 200, json: {} });
    const out = await buildJobs({ call: busy, db: ctx.db, sleep: async () => {}, config: cfg })[0]!.run();
    assert.equal((out as { steps: Record<string, string> }).steps.actualizar, 'omitido');
  });

  test('correo semanal (domingo 20:00) y mensual (día 1) se programan con su ruta; el diario está apagado por defecto', async () => {
    const calls: string[] = [];
    const call: JobCall = async (_m, path) => { calls.push(path); return { status: 200, json: { results: [] } }; };
    const jobs = buildJobs({ call, db: ctx.db, sleep: async () => {}, config: { scheduleRefresh: 'off', scheduleWeeklyEmail: 'dom@20:00', scheduleMonthlyEmail: '1@08:00', scheduleDailyEmail: 'off', homeworkMonthlyCapUsd: 10 } });
    assert.deepEqual(jobs.map((j) => j.name), ['correo-semanal', 'correo-mensual']);
    // Ventanas de recuperación: el semanal hasta 3 días después (domingo 20:00 → miércoles 20:00); el mensual hasta 5 días.
    assert.deepEqual(jobs.map((j) => j.catchupMs), [3 * 24 * HOUR, 5 * 24 * HOUR]);
    const weekly = jobs[0]!.slots;
    assert.equal(dueSlot(weekly, sv('2026-11-02T10:00:00'), jobs[0]!.catchupMs)?.key, '2026-11-01@20:00', 'si la PC se enciende el lunes a media mañana, el semanal sale');
    assert.equal(dueSlot(weekly, sv('2026-11-04T19:00:00'), jobs[0]!.catchupMs)?.key, '2026-11-01@20:00', 'y todavía el miércoles por la tarde');
    assert.equal(dueSlot(weekly, sv('2026-11-04T21:00:00'), jobs[0]!.catchupMs), null, 'pasados 3 días ya no');
    for (const job of jobs) await job.run();
    assert.deepEqual(calls, ['/jobs/email-summary?kind=weekly', '/jobs/email-summary?kind=monthly']);
    // El cierre mensual deja guardado el reporte definitivo del mes que terminó (el tope de gasto se cuenta por mes y vuelve a empezar solo).
    const reports = await ctx.db.query(`SELECT period FROM ai_usage_log WHERE event = 'monthly_report' ORDER BY period`);
    assert.ok(reports.rows.length >= 1);
  });

  test('cierre mensual por correo: gasto de octubre por persona, con el tope y el aviso del reinicio; una sola vez por mes', async () => {
    const nov1 = new Date(sv('2026-11-01T08:05:00'));
    const results = await sendMonthly(ctx.db, mailer, { capUsd: 10, now: nov1 });
    assert.deepEqual(results.map((r) => [r.username, r.to, r.status]), [['alice', 'alice.p@example.com', 'sent'], ['bob', 'bob.p@example.com', 'sent']]);
    const alice = sent.find((m) => m.to === 'alice.p@example.com')!;
    assert.match(alice.subject, /^Cierre de octubre: tu gasto de IA fue \$0\.80$/, 'Alice: 0.50 + 0.25 + 0.05');
    assert.ok(alice.html.includes('Tareas y foros') && alice.html.includes('Guías de estudio'));
    assert.ok(alice.html.includes('Física III') && alice.html.includes('Tarea de vectores'), 'por materia y actividad');
    assert.ok(alice.html.includes('$2.75') && alice.html.includes('de $10.00') && alice.html.includes('(28%)'), 'tareas de todos: 0.50 + 0.25 + 2.00 = 2.75 de 10 (28%); las guías van aparte');
    assert.ok(alice.html.includes('se reinicia hoy') && alice.html.includes('noviembre'), 'avisa que el tope vuelve a empezar');
    assert.ok(!alice.html.includes('Bob'), 'no mezcla personas');
    assert.ok(sent.find((m) => m.to === 'bob.p@example.com')!.subject.endsWith('$2.00'));
    assert.deepEqual((await sendMonthly(ctx.db, mailer, { capUsd: 10, now: nov1 })).map((r) => r.status), ['already_sent', 'already_sent'], 'el mismo mes no se manda dos veces');
    assert.equal((await ctx.db.query(`SELECT period_key FROM email_summaries WHERE kind = 'monthly' LIMIT 1`)).rows[0]!.period_key, '2026-10');
  });
});
