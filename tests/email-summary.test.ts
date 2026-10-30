import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MailError, createMailchimpMailer, type Mail, type Mailer } from '../src/modules/notifications/mailer.js';
import { isoWeekKey, sendSummaries } from '../src/modules/notifications/summary.js';
import { sendWeekly } from '../src/modules/notifications/weekly.js';
import { setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

describe('correo de resumen: destino, una vez al día y gasto de IA (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  const sent: Mail[] = [];
  let failNext = false;
  const mailer: Mailer = {
    configured: true,
    async send(mail) {
      if (failNext) { failNext = false; throw new MailError('mailchimp_500', 'caído'); }
      sent.push(mail); return { ref: `c${sent.length}` };
    },
  };
  const usage = (user: string | null, enrollment: string | null, cost: number) => ctx.db.query(
    `INSERT INTO ai_usage_log (event, feature, user_id, enrollment_id, input_tokens, output_tokens, cost_usd, period) VALUES ('call', 'homework', $1, $2, 1000, 500, $3, date_trunc('month', now())::date)`, [user, enrollment, cost]);

  before(async () => {
    ctx = await setupTestContext();
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, username, display_name, contact_email, password_hash) VALUES ('alice@test.invalid', 'alice', 'Alice Prueba', 'alice.personal@example.com', 'x') RETURNING id`);
    ids.bob = await one(`INSERT INTO users (email, username, display_name, password_hash) VALUES ('bob@test.invalid', 'bob', 'Bob Prueba', 'x') RETURNING id`);
    ids.carol = await one(`INSERT INTO users (email, username, password_hash) VALUES ('carol@test.invalid', 'carol', 'x') RETURNING id`);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, institutional_email, link_status, linked_at) VALUES ($1, $2, '_1_1', 'alice@mail.utec.test', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, institutional_email, link_status, linked_at) VALUES ($1, $2, '_2_1', 'bob@mail.utec.test', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.course = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_300_1', 'Física III') RETURNING id`, [ids.inst]);
    ids.enrollA = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [ids.eaA, ids.inst, ids.course]);
    ids.enrollB = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m2') RETURNING id`, [ids.eaB, ids.inst, ids.course]);
    const column = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible, due_at) VALUES ($1, '_gc_1', 'Tarea de vectores', 'Homework.name', 10, now() + interval '3 days') RETURNING id`, [ids.course]);
    await ctx.db.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [ids.enrollA, ids.course, column]);
    await usage(null, ids.enrollA, 0.5); await usage(null, ids.enrollA, 0.25); await usage(null, ids.enrollB, 2);
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('modo prueba: arma los correos sin enviar ni registrar; sin correo y sin cuenta no hay destino', async () => {
    const results = await sendSummaries(ctx.db, mailer, { capUsd: 10, dryRun: true });
    assert.deepEqual(results.map((r) => [r.username, r.to, r.status]), [
      ['alice', 'alice.personal@example.com', 'dry_run'], ['bob', 'bob@mail.utec.test', 'dry_run'], ['carol', null, 'no_email']]);
    assert.equal(sent.length, 0);
    assert.equal((await ctx.db.query('SELECT 1 FROM email_summaries')).rowCount, 0);
  });

  test('el correo personal manda; si no hay, el institucional. El gasto sale por persona y el total de la app', async () => {
    const results = await sendSummaries(ctx.db, mailer, { capUsd: 10 });
    assert.deepEqual(results.map((r) => r.status), ['sent', 'sent', 'no_email']);
    const alice = sent.find((m) => m.to === 'alice.personal@example.com')!;
    assert.ok(alice.html.includes('$0.75'), 'lo de Alice: 0.50 + 0.25');
    assert.ok(alice.html.includes('$2.75') && alice.html.includes('de $10.00 de tope (28%)'), 'total de la app, con tope');
    assert.match(alice.html, /3[ ,. ]?000 tokens/, 'tokens de Alice: 2 llamadas × (1000 + 500)');
    assert.ok(alice.html.includes('Tarea de vectores') && alice.html.includes('Física III'), 'lo que viene');
    assert.ok(alice.html.includes('*|UNSUB|*') && alice.text.includes('*|UNSUB|*'), 'enlace para darse de baja');
    assert.ok(sent.find((m) => m.to === 'bob@mail.utec.test')!.html.includes('$2.00'), 'lo de Bob: 2.00');
    assert.ok(!alice.html.includes('Bob'), 'el correo de uno no menciona al otro');
  });

  test('una vez por día; force reenvía; un fallo se registra y se puede reintentar', async () => {
    assert.deepEqual((await sendSummaries(ctx.db, mailer, { capUsd: 10 })).map((r) => r.status), ['already_sent', 'already_sent', 'no_email']);
    assert.equal(sent.length, 2);
    failNext = true;
    const forced = await sendSummaries(ctx.db, mailer, { capUsd: 10, userId: ids.alice, force: true });
    assert.equal(forced[0]!.status, 'failed'); assert.equal(forced[0]!.code, 'mailchimp_500');
    assert.equal((await ctx.db.query(`SELECT status FROM email_summaries WHERE user_id = $1`, [ids.alice])).rows[0]!.status, 'failed');
    assert.equal((await sendSummaries(ctx.db, mailer, { capUsd: 10, userId: ids.alice })).at(0)!.status, 'sent', 'al fallar queda abierto para reintentar');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM email_summaries`)).rows[0]!.n, 2);
  });

  test('semanal: una vez por semana, con el desglose y registrado aparte del diario', async () => {
    const before = sent.length;
    const results = await sendWeekly(ctx.db, mailer, { capUsd: 10 });
    assert.deepEqual(results.map((r) => r.status), ['sent', 'sent', 'no_email']);
    const alice = sent[before]!;
    assert.ok(alice.subject.startsWith('Tu semana en Academic Hub'));
    assert.ok(alice.html.includes('Tarea de vectores') && alice.html.includes('Pendientes'), 'lo que viene y los contadores');
    assert.ok(alice.html.includes('*|UNSUB|*'));
    assert.deepEqual((await sendWeekly(ctx.db, mailer, { capUsd: 10 })).map((r) => r.status), ['already_sent', 'already_sent', 'no_email']);
    assert.equal((await sendWeekly(ctx.db, mailer, { capUsd: 10, force: true, userId: ids.alice })).at(0)!.status, 'sent');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM email_summaries WHERE kind = 'weekly'`)).rows[0]!.n, 2);
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM email_summaries WHERE kind = 'summary'`)).rows[0]!.n, 2, 'el diario no se mezcla');
  });

  test('la semana ISO: lunes a domingo', () => {
    assert.equal(isoWeekKey(new Date('2026-10-30T18:00:00Z')), '2026-W44');
    assert.equal(isoWeekKey(new Date('2026-11-01T18:00:00Z')), '2026-W44', 'el domingo sigue en la misma semana');
    assert.equal(isoWeekKey(new Date('2026-11-02T18:00:00Z')), '2026-W45');
    assert.equal(isoWeekKey(new Date('2027-01-01T18:00:00Z')), '2026-W53');
  });
});

describe('Mailchimp: cada correo va a UN solo destinatario', () => {
  const fake = (recipientCount: number, calls: string[]) => (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(/^https:\/\/us16\.api\.mailchimp\.com\/3\.0/, '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path.split('?')[0]}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path.startsWith('/lists?')) return json({ lists: [{ id: 'L1', campaign_defaults: { from_email: 'from@example.com' } }] });
    if (method === 'PUT' && path.includes('/members/')) return json({ status: 'subscribed' });
    if (path.includes('/segments?')) return json({ segments: [] });
    if (method === 'POST' && path.endsWith('/segments')) return json({ id: 77 });
    if (method === 'POST' && path === '/campaigns') return json({ id: 'CAMP' });
    if (method === 'GET' && path.startsWith('/campaigns/CAMP?')) return json({ recipients: { recipient_count: recipientCount } });
    if (method === 'PUT' && path.endsWith('/content')) return json({});
    if (path.endsWith('/send-checklist')) return json({ is_ready: true });
    if (path.endsWith('/actions/send')) return new Response(null, { status: 204 });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json({}, 404);
  }) as typeof fetch;
  const mail: Mail = { to: 'x@example.com', subject: 'Hola', html: '<p>*|UNSUB|*</p>', text: 'hola' };

  test('con un destinatario envía la campaña', async () => {
    const calls: string[] = [];
    const out = await createMailchimpMailer({ apiKey: 'k-us16', fromName: 'AH', fetchFn: fake(1, calls) }).send(mail);
    assert.equal(out.ref, 'CAMP');
    assert.ok(calls.includes('POST /campaigns/CAMP/actions/send'));
  });

  test('si la campaña apunta a otra cantidad de personas, la borra y NO envía', async () => {
    const calls: string[] = [];
    await assert.rejects(() => createMailchimpMailer({ apiKey: 'k-us16', fromName: 'AH', fetchFn: fake(2, calls) }).send(mail), (error: MailError) => error.code === 'mail_segment_mismatch');
    assert.ok(!calls.includes('POST /campaigns/CAMP/actions/send'));
    assert.ok(calls.includes('DELETE /campaigns/CAMP'));
  });

  test('una llave sin sufijo de centro de datos se rechaza', () => {
    assert.throws(() => createMailchimpMailer({ apiKey: 'sinsufijo', fromName: 'AH' }), (error: MailError) => error.code === 'mail_bad_key');
  });
});
