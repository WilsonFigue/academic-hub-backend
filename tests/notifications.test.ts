import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { notifyFromRun, notifyGuideReady, scanDeadlines } from '../src/modules/notifications/notifications.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';
const localDay = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });

describe('notificaciones: avisos de entrega, importación y guías (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  let alice: TestClient; let bob: TestClient;
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
  // Mañana a las 8:00 (hora de El Salvador): siempre en el futuro, así el reloj real de la base no estorba.
  const NOW = new Date(`${localDay(new Date(Date.now() + 24 * 3_600_000))}T08:00:00-06:00`);
  const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

  const activity = async (name: string, due: string | null, category = 'Homework.name') => {
    const column = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible, due_at) VALUES ($1, $2, $3, $4, 10, $5) RETURNING id`,
      [ids.course, `_gc_${name}`, name, category, due]);
    return { column, id: await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [ids.enrollA, ids.course, column]) };
  };
  const titles = async (user: string) => (await ctx.db.query<{ kind: string; title: string }>(
    `SELECT kind, title FROM notifications WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY title`, [user])).rows;

  before(async () => {
    ctx = await setupTestContext();
    const hash = await hashPassword(PASSWORD);
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, password_hash) VALUES ('alice@test.invalid', $1) RETURNING id`, [hash]);
    ids.bob = await one(`INSERT INTO users (email, password_hash) VALUES ('bob@test.invalid', $1) RETURNING id`, [hash]);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.course = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_300_1', 'Física III') RETURNING id`, [ids.inst]);
    ids.enrollA = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [ids.eaA, ids.inst, ids.course]);
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin); bob = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('recordatorios: en pocas horas, hoy y mañana; el examen se dice examen; sin repetir', async () => {
    const soon = await activity('Tarea urgente', at(2));
    const today = await activity('Tarea de hoy', at(8));
    const tomorrow = await activity('Tarea de mañana', at(26));
    await activity('Examen parcial 1', at(9), 'Test.name');
    await activity('Tarea lejana', at(120));
    ids.soon = soon; ids.today = today; ids.tomorrow = tomorrow;
    assert.equal(await scanDeadlines(ctx.db, ids.alice, NOW), 4);
    const list = await titles(ids.alice);
    assert.deepEqual(list.map((n) => n.kind).sort(), ['due_soon', 'due_today', 'due_today', 'due_tomorrow']);
    assert.ok(list.some((n) => /^Entrega en 2 h: Tarea urgente/.test(n.title)));
    assert.ok(list.some((n) => /^Examen hoy a las .*Examen parcial 1/.test(n.title)));
    assert.ok(list.some((n) => /^Entrega mañana a las .*Tarea de mañana/.test(n.title)));
    assert.equal(await scanDeadlines(ctx.db, ids.alice, NOW), 0, 'volver a calcular no duplica');
    assert.equal((await titles(ids.bob)).length, 0, 'nadie más recibe los avisos de Alice');
  });

  test('al entregar la actividad, su recordatorio desaparece; al acercarse la fecha, el aviso más urgente reemplaza al anterior', async () => {
    await ctx.db.query(`UPDATE student_grades SET is_submitted = true WHERE id = $1`, [ids.today.id]);
    await scanDeadlines(ctx.db, ids.alice, NOW);
    assert.ok(!(await titles(ids.alice)).some((n) => n.title.includes('Tarea de hoy')));
    // Cuatro horas después ("mañana" pasa a "hoy" y luego "en pocas horas").
    const later = new Date(NOW.getTime() + 24 * 3_600_000 - 6 * 3_600_000);
    await scanDeadlines(ctx.db, ids.alice, later);
    const kinds = (await titles(ids.alice)).filter((n) => n.title.includes('Tarea de mañana')).map((n) => n.kind);
    assert.deepEqual(kinds, ['due_today'], 'queda un solo aviso por actividad');
  });

  test('bandeja por API: lista, cuenta sin leer, marca leído y quita', async () => {
    const list = (await alice.request('GET', '/api/v1/notifications?limit=20')).json();
    assert.ok(list.unread >= 2); assert.equal(list.notifications.length, list.unread);
    const first = list.notifications[0];
    const read = (await alice.request('POST', '/api/v1/notifications/read', { ids: [first.id] })).json();
    assert.equal(read.unread, list.unread - 1);
    const dismissed = (await alice.request('POST', '/api/v1/notifications/dismiss', { ids: [first.id] })).json();
    assert.equal(dismissed.unread, list.unread - 1);
    assert.ok(!(await alice.request('GET', '/api/v1/notifications')).json().notifications.some((n: { id: string }) => n.id === first.id));
    assert.equal((await bob.request('GET', '/api/v1/notifications')).json().notifications.length, 0);
    assert.equal((await alice.request('POST', '/api/v1/notifications/read', { all: true })).json().unread, 0);
    assert.equal((await alice.request('GET', '/api/v1/notifications')).statusCode, 200);
    assert.equal((await new TestClient(ctx.app, ctx.config.frontendOrigin).request('GET', '/api/v1/notifications')).statusCode, 401);
  });

  test('guía lista: aviso con enlace directo; un tipo silenciado no se crea', async () => {
    const pending = await activity('Guía de ejercicios', at(100));
    const guide = await one(`INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, status, trigger, content, finished_at) VALUES ($1, $2, $3, 'ready', 'manual', '{}'::jsonb, now()) RETURNING id`,
      [ids.enrollA, ids.course, pending.column]);
    await notifyGuideReady(ctx.db, guide);
    await notifyGuideReady(ctx.db, guide);
    const rows = (await ctx.db.query<{ title: string; link: string; body: string }>(`SELECT title, link, body FROM notifications WHERE user_id = $1 AND kind = 'guide_ready'`, [ids.alice])).rows;
    assert.equal(rows.length, 1, 'una sola vez');
    assert.equal(rows[0]!.link, `/activities/${pending.id}/guide`);
    assert.match(rows[0]!.body, /Guía de ejercicios · Física III/);

    const muted = (await alice.request('PUT', '/api/v1/notifications/preferences', { muted: ['guide_ready', 'no_existe'] })).json();
    assert.deepEqual(muted.muted, ['guide_ready']);
    const second = await one(`INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, status, trigger, content, finished_at) VALUES ($1, $2, $3, 'ready', 'manual', '{}'::jsonb, now()) RETURNING id`,
      [ids.enrollA, ids.course, (await activity('Otra guía', at(100))).column]);
    await notifyGuideReady(ctx.db, second);
    assert.equal((await ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'guide_ready'`, [ids.alice])).rowCount, 1, 'silenciado: no se crea');
    await alice.request('PUT', '/api/v1/notifications/preferences', { muted: [] });
  });

  test('importación: actividad nueva, cambio de fecha, nota y anuncio llegan solo a quien está inscrito', async () => {
    const run = await one(`INSERT INTO sync_runs (external_account_id, trigger, status, finished_at, adapter_version) VALUES ($1, 'dev_import', 'succeeded', now(), 't') RETURNING id`, [ids.eaA]);
    const fresh = await activity('Laboratorio nuevo', at(72));
    const change = (type: string, entity: string, id: string, scope: string, kind: string, after: object) => ctx.db.query(
      `INSERT INTO entity_changes (sync_run_id, entity_type, entity_id, scope, external_account_id, course_id, change_type, changed_fields, after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [run, type, id, scope, scope === 'personal' ? ids.eaA : null, ids.course, type === 'student_grade' ? 'updated' : 'created', type === 'student_grade' ? ['score'] : [], JSON.stringify({ ...after, kind })]);
    await change('gradebook_column', 'x', fresh.column, 'shared', 'activity_new', {});
    await change('student_grade', 'x', ids.soon.id, 'personal', 'grade_new', { score: 8.5, name: 'Tarea urgente' });
    await change('course_announcement', 'x', '00000000-0000-7000-8000-000000000001', 'shared', 'announcement_new', { title: 'Cambio de aula' });
    assert.equal(await notifyFromRun(ctx.db, run), 3);
    assert.equal(await notifyFromRun(ctx.db, run), 0, 'repetir la misma importación no duplica');
    const rows = (await ctx.db.query<{ kind: string; title: string; body: string }>(`SELECT kind, title, body FROM notifications WHERE user_id = $1 AND kind IN ('activity_new', 'grade_new', 'announcement_new')`, [ids.alice])).rows;
    assert.equal(rows.length, 3);
    assert.match(rows.find((r) => r.kind === 'activity_new')!.title, /Nueva actividad en Física III/);
    assert.match(rows.find((r) => r.kind === 'grade_new')!.body, /Tarea urgente · 8\.5 \/ 10/);
    assert.equal(rows.find((r) => r.kind === 'announcement_new')!.body, 'Cambio de aula');
    assert.equal((await ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [ids.bob])).rowCount, 0);
  });
});
