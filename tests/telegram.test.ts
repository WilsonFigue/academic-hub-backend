import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { notify } from '../src/modules/notifications/notifications.js';
import { TelegramError, createTelegramClient, type TelegramClient, type TelegramUpdate } from '../src/modules/notifications/telegram.js';
import { createLinkCode, dispatchPending, handleUpdate, inQuietHours } from '../src/modules/notifications/telegram-service.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';
// 2026-10-30 10:00 en El Salvador (día) y 2026-10-30 23:30 (silencio).
const DAY = new Date('2026-10-30T16:00:00Z');
const NIGHT = new Date('2026-10-31T05:30:00Z');

describe('cliente de Telegram', () => {
  test('el token se valida y los errores no lo revelan', async () => {
    assert.throws(() => createTelegramClient({ token: 'mal' }), (e: TelegramError) => e.code === 'telegram_bad_token');
    const client = createTelegramClient({ token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', fetchFn: (async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), { status: 403 })) as typeof fetch });
    await assert.rejects(() => client.sendMessage(1, 'hola'), (e: TelegramError) => e.code === 'telegram_blocked' && !JSON.stringify(e).includes('AAAA') && !e.message.includes('AAAA'));
  });
  test('horario de silencio de 10 p. m. a 6 a. m. (hora de El Salvador)', () => {
    assert.equal(inQuietHours(DAY), false); assert.equal(inQuietHours(NIGHT), true);
    assert.equal(inQuietHours(new Date('2026-10-31T12:00:00Z')), false, '6:00 ya no es silencio');
    assert.equal(inQuietHours(new Date('2026-10-31T04:00:00Z')), true, '22:00 empieza el silencio');
  });
});

describe('Telegram: vincular, mandar y respetar el silencio (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  const outbox: Array<{ chat: number; text: string }> = [];
  let blocked = false;
  const client: TelegramClient = {
    configured: true,
    async username() { return 'academic_test_bot'; },
    async sendMessage(chat, text) { if (blocked) throw new TelegramError('telegram_blocked', 403); outbox.push({ chat, text }); },
    async getUpdates() { return []; },
  };
  const say = (chat: number, text: string): TelegramUpdate => ({ update_id: 1, message: { chat: { id: chat, type: 'private', username: 'persona' }, text } });
  const push = (user: string, kind: Parameters<typeof notify>[1]['kind'], title: string, key: string) => notify(ctx.db, { userId: user, kind, title, body: 'Física III', dedupeKey: key, link: '/activities' });
  let alice: TestClient;

  before(async () => {
    ctx = await setupTestContext();
    const hash = await hashPassword(PASSWORD);
    ids.alice = await one(`INSERT INTO users (email, username, display_name, password_hash) VALUES ('alice@test.invalid', 'alice', 'ALICE PRUEBA', $1) RETURNING id`, [hash]);
    ids.bob = await one(`INSERT INTO users (email, username, password_hash) VALUES ('bob@test.invalid', 'bob', $1) RETURNING id`, [hash]);
    const app = (await import('../src/app.js'));
    await ctx.app.close();
    ctx.app = await app.buildApp({ config: ctx.config, db: ctx.db, logger: false, telegram: client });
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('la web genera un enlace de un solo uso y el bot lo canjea con /start', async () => {
    assert.equal((await alice.request('GET', '/api/v1/notifications/telegram')).json().linked, false);
    const { url } = (await alice.request('POST', '/api/v1/notifications/telegram/link', {})).json();
    assert.match(url, /^https:\/\/t\.me\/academic_test_bot\?start=[0-9a-f]{32}$/);
    const code = url.split('=')[1];
    await handleUpdate(ctx.db, client, say(111, `/start ${code}`));
    assert.match(outbox.at(-1)!.text, /¡Listo, Alice!/);
    const status = (await alice.request('GET', '/api/v1/notifications/telegram')).json();
    assert.equal(status.linked, true); assert.equal(status.enabled, true);
    // El código no sirve dos veces ni para otro chat.
    await handleUpdate(ctx.db, client, say(222, `/start ${code}`));
    assert.match(outbox.at(-1)!.text, /ya se usó o venció/);
    assert.equal((await ctx.db.query(`SELECT 1 FROM telegram_links WHERE chat_id = 222`)).rowCount, 0);
  });

  test('un código vencido o inventado no conecta nada', async () => {
    const { code } = await createLinkCode(ctx.db, ids.bob, new Date(Date.now() - 3_600_000));
    await handleUpdate(ctx.db, client, say(333, `/start ${code}`));
    await handleUpdate(ctx.db, client, say(333, '/start 0000000000000000000000000000abcd'));
    assert.equal((await ctx.db.query(`SELECT 1 FROM telegram_links WHERE user_id = $1`, [ids.bob])).rowCount, 0);
  });

  test('lo anterior a conectarse no se manda; lo nuevo sí, una sola vez, con su emoji y sin enlace en localhost', async () => {
    await push(ids.alice, 'due_today', 'Entrega hoy a las 8:00 p. m.: Tarea 3', 'k1');
    outbox.length = 0;
    assert.deepEqual(await dispatchPending(ctx.db, client, { now: DAY }), { sent: 1, held: 0 });
    assert.equal(outbox.length, 1);
    assert.match(outbox[0]!.text, /^🔔 <b>Entrega hoy a las 8:00 p\. m\.: Tarea 3<\/b>\nFísica III$/);
    assert.equal(outbox[0]!.chat, 111);
    assert.deepEqual(await dispatchPending(ctx.db, client, { now: DAY }), { sent: 0, held: 0 }, 'no se repite');
    await push(ids.alice, 'announcement_new', 'Nuevo anuncio', 'k2');
    outbox.length = 0;
    await dispatchPending(ctx.db, client, { now: DAY, webUrl: 'https://hub.example.com' });
    assert.match(outbox[0]!.text, /href="https:\/\/hub\.example\.com\/activities"/);
  });

  test('de noche solo sale lo urgente; el resto espera a la mañana', async () => {
    await push(ids.alice, 'grade_new', 'Ya hay nota', 'n1');
    await push(ids.alice, 'due_soon', 'Entrega en 2 h: Tarea 4', 'n2');
    outbox.length = 0;
    assert.deepEqual(await dispatchPending(ctx.db, client, { now: NIGHT }), { sent: 1, held: 1 });
    assert.match(outbox[0]!.text, /Entrega en 2 h/);
    outbox.length = 0;
    assert.deepEqual(await dispatchPending(ctx.db, client, { now: new Date('2026-10-31T13:00:00Z') }), { sent: 1, held: 0 }, 'a las 7:00 llega lo que esperaba');
    assert.match(outbox[0]!.text, /Ya hay nota/);
  });

  test('si se juntan muchos avisos van en un solo mensaje; lo ya leído en la web no se manda', async () => {
    for (let i = 0; i < 7; i += 1) await push(ids.alice, 'activity_new', `Actividad ${i}`, `m${i}`);
    const read = await push(ids.alice, 'grade_changed', 'Leída en la web', 'leida');
    assert.ok(read);
    await ctx.db.query(`UPDATE notifications SET read_at = now() WHERE dedupe_key = 'leida'`);
    outbox.length = 0;
    const result = await dispatchPending(ctx.db, client, { now: DAY });
    assert.equal(result.sent, 7); assert.equal(outbox.length, 1);
    assert.match(outbox[0]!.text, /Tienes 7 avisos nuevos/); assert.ok(!outbox[0]!.text.includes('Leída en la web'));
  });

  test('pausar, reanudar y bloqueo del bot', async () => {
    await handleUpdate(ctx.db, client, say(111, '/pausar'));
    await push(ids.alice, 'guide_ready', 'Tu guía está lista', 'p1');
    outbox.length = 0;
    assert.equal((await dispatchPending(ctx.db, client, { now: DAY })).sent, 0, 'en pausa no manda');
    await handleUpdate(ctx.db, client, say(111, '/reanudar'));
    assert.equal((await dispatchPending(ctx.db, client, { now: DAY })).sent, 0, 'al reanudar no llega lo de la pausa');
    await push(ids.alice, 'homework_ready', 'Tu tarea está lista', 'p2');
    blocked = true;
    await dispatchPending(ctx.db, client, { now: DAY });
    assert.equal((await alice.request('GET', '/api/v1/notifications/telegram')).json().enabled, false, 'si bloqueó el bot se desconecta solo');
    blocked = false;
  });

  test('probar y desconectar desde la web', async () => {
    await alice.request('POST', '/api/v1/notifications/telegram/enabled', { enabled: true });
    outbox.length = 0;
    assert.equal((await alice.request('POST', '/api/v1/notifications/telegram/test', {})).statusCode, 200);
    assert.match(outbox[0]!.text, /Mensaje de prueba/);
    assert.equal((await alice.request('POST', '/api/v1/notifications/telegram/unlink', {})).json().linked, false);
    assert.equal((await alice.request('POST', '/api/v1/notifications/telegram/test', {})).statusCode, 409);
  });
});
