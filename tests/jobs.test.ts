import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { Mail, Mailer } from '../src/modules/notifications/mailer.js';
import type { TelegramClient, TelegramUpdate } from '../src/modules/notifications/telegram.js';
import { createLinkCode } from '../src/modules/notifications/telegram-service.js';
import { setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const CRON = 'secreto-de-rutinas-de-prueba-0123456789abcdef';
const WEBHOOK = 'secreto-del-webhook';

describe('rutinas por endpoint y webhook de Telegram (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  const outbox: Array<{ chat: number; text: string }> = [];
  const offsets: number[] = [];
  let queue: TelegramUpdate[] = [];
  const webhooks: Array<string | null> = [];
  const sentMail: Mail[] = [];
  const client: TelegramClient = {
    configured: true,
    async username() { return 'academic_test_bot'; },
    async sendMessage(chat, text) { outbox.push({ chat, text }); },
    async getUpdates(offset) { offsets.push(offset); return queue.filter((u) => u.update_id >= offset); },
    async setWebhook(url) { webhooks.push(url); },
    async deleteWebhook() { webhooks.push(null); },
    webhookSecret() { return WEBHOOK; },
  };
  const mailer: Mailer = { configured: true, async send(mail) { sentMail.push(mail); return { ref: 'c1' }; } };
  const auth = { authorization: `Bearer ${CRON}` };
  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, payload?: object) =>
    ctx.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const say = (id: number, chat: number, text: string): TelegramUpdate => ({ update_id: id, message: { chat: { id: chat, type: 'private', username: 'persona' }, text } });

  before(async () => {
    ctx = await setupTestContext();
    ids.alice = await one(`INSERT INTO users (email, username, display_name, contact_email, password_hash) VALUES ('alice@test.invalid', 'alice', 'ALICE PRUEBA', 'alice.p@example.com', 'x') RETURNING id`);
    await ctx.app.close();
    ctx.app = await buildApp({ config: ctx.config, db: ctx.db, logger: false, telegram: client, mailer, cronSecret: CRON });
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('sin clave o con clave equivocada no se ejecuta nada; con clave sí (GET y POST)', async () => {
    assert.equal((await call('GET', '/jobs/notifications')).statusCode, 401);
    assert.equal((await call('GET', '/jobs/notifications', { authorization: 'Bearer otra-clave' })).statusCode, 401);
    assert.equal((await call('POST', '/jobs/email-summary', { authorization: CRON })).statusCode, 401, 'sin la palabra Bearer');
    const get = await call('GET', '/jobs/notifications', auth);
    assert.equal(get.statusCode, 200);
    assert.deepEqual(Object.keys(get.json()).sort(), ['created', 'telegram']);
    assert.equal((await call('POST', '/jobs/notifications', auth)).statusCode, 200);
  });

  test('sin CRON_SECRET configurada las rutinas responden 503', async () => {
    const bare = await buildApp({ config: ctx.config, db: ctx.db, logger: false });
    assert.equal((await bare.inject({ method: 'GET', url: '/jobs/notifications' })).statusCode, 503);
    await bare.close();
  });

  test('resumen por correo: diario por defecto, semanal con kind=weekly, una vez por periodo', async () => {
    const daily = await call('GET', '/jobs/email-summary', auth);
    assert.equal(daily.statusCode, 200);
    assert.equal(daily.json().results[0].status, 'sent');
    assert.ok(sentMail.at(-1)!.subject.startsWith('Tu resumen del'));
    assert.equal((await call('GET', '/jobs/email-summary', auth)).json().results[0].status, 'already_sent');
    const weekly = await call('GET', '/jobs/email-summary?kind=weekly', auth);
    assert.equal(weekly.json().results[0].status, 'sent');
    assert.ok(sentMail.at(-1)!.subject.startsWith('Tu semana en Academic Hub'));
    assert.equal((await call('GET', '/jobs/email-summary?kind=otro', auth)).statusCode, 400);
    assert.equal((await call('GET', '/jobs/email-summary?force=1', auth)).json().results[0].status, 'sent', 'force repite');
  });

  test('webhook: sin secreto de Telegram se rechaza; con secreto conecta el chat con el código', async () => {
    const { code } = await createLinkCode(ctx.db, ids.alice);
    const update = say(10, 555, `/start ${code}`);
    assert.equal((await call('POST', '/telegram/webhook', {}, update)).statusCode, 401);
    assert.equal((await call('POST', '/telegram/webhook', { 'x-telegram-bot-api-secret-token': 'falso' }, update)).statusCode, 401);
    assert.equal((await ctx.db.query(`SELECT 1 FROM telegram_links`)).rowCount, 0);
    const ok = await call('POST', '/telegram/webhook', { 'x-telegram-bot-api-secret-token': WEBHOOK }, update);
    assert.equal(ok.statusCode, 200);
    assert.equal((await ctx.db.query(`SELECT chat_id FROM telegram_links WHERE user_id = $1`, [ids.alice])).rows[0]!.chat_id, '555');
    assert.match(outbox.at(-1)!.text, /¡Listo, Alice!/);
  });

  test('consulta de una sola pasada: atiende lo pendiente y no repite lo ya atendido', async () => {
    queue = [say(21, 555, '/estado'), say(22, 555, '/pausar')];
    assert.equal((await call('GET', '/jobs/telegram/poll', auth)).json().handled, 2);
    assert.equal((await ctx.db.query(`SELECT enabled FROM telegram_links`)).rows[0]!.enabled, false, '/pausar se aplicó');
    assert.equal((await call('GET', '/jobs/telegram/poll', auth)).json().handled, 0, 'la segunda vez no hay nada nuevo');
    assert.equal(offsets.at(-1), 23, 'pide desde el siguiente al último atendido');
    assert.equal((await ctx.db.query(`SELECT last_update_id FROM telegram_state`)).rows[0]!.last_update_id, '22');
  });

  test('registrar y quitar el webhook (solo https público)', async () => {
    assert.equal((await call('POST', '/jobs/telegram/webhook', auth, { baseUrl: 'http://localhost:4000' })).statusCode, 400);
    const set = await call('POST', '/jobs/telegram/webhook', auth, { baseUrl: 'https://api.ejemplo.com/' });
    assert.equal(set.statusCode, 200); assert.equal(webhooks.at(-1), 'https://api.ejemplo.com/telegram/webhook');
    assert.equal((await call('POST', '/jobs/telegram/webhook', auth, { remove: true })).statusCode, 200);
    assert.equal(webhooks.at(-1), null);
    assert.equal((await call('POST', '/jobs/telegram/webhook', {}, { baseUrl: 'https://api.ejemplo.com' })).statusCode, 401);
  });
});
