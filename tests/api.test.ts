import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Una-clave-segura-2026';
const skip = !testDatabaseAvailable() && 'Base de datos no configurada';

describe('API Academic Hub (PostgreSQL real, esquema de pruebas)', { skip }, () => {
  let ctx: TestContext;
  const client = () => new TestClient(ctx.app, ctx.config.frontendOrigin);

  before(async () => { ctx = await setupTestContext(); });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  describe('autenticación', () => {
    test('registro crea sesión y no devuelve el hash', async () => {
      const browser = client();
      const response = await browser.request('POST', '/api/v1/auth/register', { email: 'nuevo@test.invalid', password: PASSWORD });
      assert.equal(response.statusCode, 201);
      assert.ok(!response.body.includes('argon2'));
      const cookie = response.cookies.find((c) => c.name === 'ah_session');
      assert.ok(cookie?.httpOnly);
      assert.equal((await browser.request('GET', '/api/v1/auth/session')).statusCode, 200);
    });

    test('registro rechaza contraseñas de menos de 12 caracteres y correos duplicados', async () => {
      assert.equal((await client().request('POST', '/api/v1/auth/register', { email: 'corta@test.invalid', password: 'corta' })).statusCode, 400);
      const duplicate = await client().request('POST', '/api/v1/auth/register', { email: 'NUEVO@test.invalid', password: PASSWORD });
      assert.equal(duplicate.statusCode, 409);
    });

    test('login con credenciales válidas, contraseña incorrecta y usuario inexistente', async () => {
      assert.equal((await client().request('POST', '/api/v1/auth/login', { identifier: 'nuevo@test.invalid', password: PASSWORD })).statusCode, 200);
      const wrong = await client().request('POST', '/api/v1/auth/login', { identifier: 'nuevo@test.invalid', password: 'incorrecta-123456' });
      const missing = await client().request('POST', '/api/v1/auth/login', { identifier: 'nadie@test.invalid', password: 'incorrecta-123456' });
      assert.equal(wrong.statusCode, 401);
      assert.equal(missing.statusCode, 401);
      assert.deepEqual(wrong.json(), missing.json(), 'mismo mensaje para no revelar si la cuenta existe');
    });

    test('sin sesión las rutas personales responden 401', async () => {
      assert.equal((await client().request('GET', '/api/v1/me')).statusCode, 401);
    });

    test('CSRF: POST autenticado sin token responde 403; con token, logout revoca la sesión', async () => {
      const browser = client();
      await browser.request('POST', '/api/v1/auth/login', { identifier: 'nuevo@test.invalid', password: PASSWORD });
      assert.equal((await browser.request('POST', '/api/v1/auth/logout', undefined, { csrf: false })).statusCode, 403);
      const sessionCookie = (await browser.request('GET', '/api/v1/auth/session')).statusCode;
      assert.equal(sessionCookie, 200);
      assert.equal((await browser.request('POST', '/api/v1/auth/logout')).statusCode, 204);
      assert.equal((await browser.request('GET', '/api/v1/auth/session')).statusCode, 401);
    });

    test('Origin ajeno es rechazado en métodos no seguros', async () => {
      const response = await client().request('POST', '/api/v1/auth/login',
        { identifier: 'nuevo@test.invalid', password: PASSWORD }, { origin: 'https://evil.invalid' });
      assert.equal(response.statusCode, 403);
    });

    test('sesión expirada es rechazada', async () => {
      const browser = client();
      await browser.request('POST', '/api/v1/auth/login', { identifier: 'nuevo@test.invalid', password: PASSWORD });
      await ctx.db.query(`UPDATE auth_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE revoked_at IS NULL`);
      assert.equal((await browser.request('GET', '/api/v1/auth/session')).statusCode, 401);
    });

    test('logout-all revoca todas las sesiones del usuario', async () => {
      const first = client();
      const second = client();
      await first.request('POST', '/api/v1/auth/login', { identifier: 'nuevo@test.invalid', password: PASSWORD });
      await second.request('POST', '/api/v1/auth/login', { identifier: 'nuevo@test.invalid', password: PASSWORD });
      assert.equal((await first.request('POST', '/api/v1/auth/logout-all')).statusCode, 200);
      assert.equal((await second.request('GET', '/api/v1/auth/session')).statusCode, 401);
    });

    test('contraseña temporal obliga a cambiarla antes de usar la API', async () => {
      await ctx.db.query(`INSERT INTO users (email, username, password_hash, must_change_password) VALUES ('temp@test.invalid', 'temporal', $1, true)`,
        [await hashPassword('Temporal-inicial-99')]);
      const browser = client();
      const login = await browser.request('POST', '/api/v1/auth/login', { identifier: 'temporal', password: 'Temporal-inicial-99' });
      assert.equal(login.json().user.mustChangePassword, true);
      assert.equal((await browser.request('GET', '/api/v1/me')).json().error.code, 'password_change_required');
      const change = await browser.request('POST', '/api/v1/auth/password', { currentPassword: 'Temporal-inicial-99', newPassword: 'Mi-clave-definitiva-1' });
      assert.equal(change.statusCode, 204);
      assert.equal((await browser.request('GET', '/api/v1/me')).statusCode, 200);
    });

    test('rate limit en login', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        statuses.push((await client().request('POST', '/api/v1/auth/login', { identifier: 'limite@test.invalid', password: 'x-incorrecta-123' })).statusCode);
      }
      assert.ok(statuses.includes(429));
    });
  });

  describe('aislamiento multiusuario', () => {
    const ids: Record<string, string> = {};
    let alice: TestClient;
    let bob: TestClient;

    before(async () => {
      const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
      const hash = await hashPassword(PASSWORD);
      ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode)
        VALUES ('TEST', 'Universidad de Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
      ids.alice = await one(`INSERT INTO users (email, password_hash) VALUES ('alice@test.invalid', $1) RETURNING id`, [hash]);
      ids.bob = await one(`INSERT INTO users (email, password_hash) VALUES ('bob@test.invalid', $1) RETURNING id`, [hash]);
      ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
      ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
      ids.term = await one(`INSERT INTO academic_terms (institution_id, external_id, name, start_at, end_at)
        VALUES ($1, '_t_1', 'Ciclo de prueba', now() - interval '30 days', now() + interval '60 days') RETURNING id`, [ids.inst]);
      ids.shared = await one(`INSERT INTO courses (institution_id, external_id, name, term_id, term_external_id) VALUES ($1, '_c_shared', 'Compartida', $2, '_t_1') RETURNING id`, [ids.inst, ids.term]);
      ids.onlyA = await one(`INSERT INTO courses (institution_id, external_id, name, term_id, term_external_id) VALUES ($1, '_c_a', 'Solo Alice', $2, '_t_1') RETURNING id`, [ids.inst, ids.term]);
      ids.onlyB = await one(`INSERT INTO courses (institution_id, external_id, name, term_id, term_external_id) VALUES ($1, '_c_b', 'Solo Bob', $2, '_t_1') RETURNING id`, [ids.inst, ids.term]);
      const enroll = (account: string, course: string, ext: string) => one(
        `INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, $4) RETURNING id`, [account, ids.inst, course, ext]);
      ids.enASh = await enroll(ids.eaA, ids.shared, '_m1');
      ids.enBSh = await enroll(ids.eaB, ids.shared, '_m2');
      ids.enA = await enroll(ids.eaA, ids.onlyA, '_m3');
      ids.enB = await enroll(ids.eaB, ids.onlyB, '_m4');
      // Contenido compartido: un nodo visible para ambos, otro (liberación adaptativa) solo para Alice.
      ids.nodeAll = await one(`INSERT INTO course_content_items (course_id, external_id, handler, title) VALUES ($1, '_n1', 'resource/x-bb-document', 'Para todos') RETURNING id`, [ids.shared]);
      ids.nodeA = await one(`INSERT INTO course_content_items (course_id, external_id, handler, title) VALUES ($1, '_n2', 'resource/x-bb-document', 'Solo Alice') RETURNING id`, [ids.shared]);
      for (const [enrollment, node] of [[ids.enASh, ids.nodeAll], [ids.enASh, ids.nodeA], [ids.enBSh, ids.nodeAll]]) {
        await ctx.db.query(`INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id) VALUES ($1, $2, $3)`, [enrollment, node, ids.shared]);
      }
      // Columnas: una visible para ambos con notas distintas; otra oculta para Bob; una calculada.
      ids.colTask = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible, due_at) VALUES ($1, '_g1', 'Tarea 1', 10, now() + interval '3 days') RETURNING id`, [ids.shared]);
      ids.colHidden = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible) VALUES ($1, '_g2', 'Columna restringida', 10) RETURNING id`, [ids.shared]);
      ids.colCalc = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, is_calculated, calculated_formula) VALUES ($1, '_g3', 'Promedio', true, '{"aliases":{}}') RETURNING id`, [ids.shared]);
      ids.gA = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id, status, score, is_submitted) VALUES ($1, $2, $3, 'GRADED', 9.5, true) RETURNING id`, [ids.enASh, ids.shared, ids.colTask]);
      ids.gB = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [ids.enBSh, ids.shared, ids.colTask]);
      await ctx.db.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id, is_visible_to_student) VALUES ($1, $2, $3, true), ($4, $2, $3, false)`, [ids.enASh, ids.shared, ids.colHidden, ids.enBSh]);
      await ctx.db.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [ids.enASh, ids.shared, ids.colCalc]);
      // Proyección de calendario de la tarea (no debe duplicarse) y un evento independiente.
      await ctx.db.query(`INSERT INTO calendar_items (institution_id, scope, course_id, source_type, source_external_id, gradebook_column_id, title, start_at)
        VALUES ($1, 'course', $2, 'blackboard.platform.gradebook2.GradableItem', '_g1', $3, 'Tarea 1', now() + interval '3 days')`, [ids.inst, ids.shared, ids.colTask]);
      await ctx.db.query(`INSERT INTO calendar_items (institution_id, scope, course_id, source_type, source_external_id, title, start_at)
        VALUES ($1, 'course', $2, 'blackboard.data.calendar.CalendarEntry', '_e1', 'Clase de repaso', now() + interval '2 days')`, [ids.inst, ids.shared]);

      alice = client();
      bob = client();
      await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
      await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
    });

    test('cada usuario ve solo sus materias', async () => {
      const names = async (browser: TestClient) => (await browser.request('GET', '/api/v1/courses')).json().courses.map((c: { name: string }) => c.name).sort();
      assert.deepEqual(await names(alice), ['Compartida', 'Solo Alice']);
      assert.deepEqual(await names(bob), ['Compartida', 'Solo Bob']);
    });

    test('un UUID de materia ajena devuelve 404 (sin fuga)', async () => {
      assert.equal((await bob.request('GET', `/api/v1/courses/${ids.onlyA}`)).statusCode, 404);
      assert.equal((await bob.request('GET', `/api/v1/courses/${ids.onlyA}/content`)).statusCode, 404);
      assert.equal((await bob.request('GET', `/api/v1/courses/${ids.onlyA}/grades`)).statusCode, 404);
    });

    test('la visibilidad de contenido es independiente por inscripción', async () => {
      const titles = async (browser: TestClient) => (await browser.request('GET', `/api/v1/courses/${ids.shared}/content`)).json().items.map((i: { title: string }) => i.title).sort();
      assert.deepEqual(await titles(alice), ['Para todos', 'Solo Alice']);
      assert.deepEqual(await titles(bob), ['Para todos']);
    });

    test('notas independientes y columna restringida no visible para Bob', async () => {
      const grades = async (browser: TestClient) => (await browser.request('GET', `/api/v1/courses/${ids.shared}/grades`)).json().grades;
      const aliceGrades = await grades(alice);
      const bobGrades = await grades(bob);
      assert.equal(aliceGrades.find((g: { name: string }) => g.name === 'Tarea 1').score, '9.5000');
      assert.equal(bobGrades.find((g: { name: string }) => g.name === 'Tarea 1').score, null);
      assert.ok(!bobGrades.some((g: { name: string }) => g.name === 'Columna restringida'));
    });

    test('Bob no puede leer la actividad de Alice manipulando el UUID', async () => {
      assert.equal((await alice.request('GET', `/api/v1/activities/${ids.gA}`)).statusCode, 200);
      assert.equal((await bob.request('GET', `/api/v1/activities/${ids.gA}`)).statusCode, 404);
    });

    test('actividades excluyen columnas calculadas', async () => {
      const activities = (await alice.request('GET', '/api/v1/activities')).json().activities;
      assert.ok(!activities.some((a: { name: string }) => a.name === 'Promedio'));
    });

    test('el calendario no duplica la tarea con su proyección GradableItem', async () => {
      const items = (await alice.request('GET', '/api/v1/calendar')).json().items as Array<{ title: string; type: string }>;
      assert.equal(items.filter((i) => i.title === 'Tarea 1').length, 1);
      assert.ok(items.some((i) => i.type === 'event' && i.title === 'Clase de repaso'));
    });

    test('períodos derivados de las inscripciones', async () => {
      const current = (await alice.request('GET', '/api/v1/terms/current')).json();
      assert.equal(current.terms.length, 1);
      assert.equal(current.terms[0].name, 'Ciclo de prueba');
    });

    test('la cuenta universitaria ajena no es accesible', async () => {
      assert.equal((await bob.request('GET', `/api/v1/me/university-accounts/${ids.eaA}`)).statusCode, 404);
    });

    test('/grades devuelve solo notas propias e incluye columnas calculadas marcadas', async () => {
      const grades = (await alice.request('GET', '/api/v1/grades')).json().grades as Array<{ id: string; isCalculated: boolean }>;
      assert.ok(grades.some((g) => g.id === ids.gA));
      assert.ok(grades.some((g) => g.isCalculated));
      const bobGrades = (await bob.request('GET', '/api/v1/grades')).json().grades as Array<{ id: string }>;
      assert.ok(!bobGrades.some((g) => g.id === ids.gA));
    });

    test('ciclos evaluativos: guardar, recuperar y validar', async () => {
      const url = `/api/v1/courses/${ids.shared}/evaluation-cycles`;
      const saved = await alice.request('PUT', url, {
        activeNumber: 1,
        cycles: [
          { number: 1, label: null, weightPercent: 20, items: [{ activityId: ids.gA, weightWithinCycle: 50 }] },
          { number: 2, label: null, weightPercent: 20, items: [] },
        ],
      });
      assert.equal(saved.statusCode, 200);
      const loaded = (await alice.request('GET', url)).json();
      assert.equal(loaded.cycles.length, 2);
      assert.equal(loaded.cycles.find((c: { isActive: boolean }) => c.isActive).number, 1);
      assert.equal(loaded.items[0].activityId, ids.gA);
      // Pesos > 100 % y actividad repetida en dos ciclos se rechazan.
      assert.equal((await alice.request('PUT', url, { activeNumber: null, cycles: [{ number: 1, label: null, weightPercent: 80, items: [] }, { number: 2, label: null, weightPercent: 30, items: [] }] })).statusCode, 400);
      assert.equal((await alice.request('PUT', url, { activeNumber: null, cycles: [
        { number: 1, label: null, weightPercent: null, items: [{ activityId: ids.gA, weightWithinCycle: null }] },
        { number: 2, label: null, weightPercent: null, items: [{ activityId: ids.gA, weightWithinCycle: null }] },
      ] })).statusCode, 400);
    });

    test('ciclos: Bob no puede leer ni modificar los de Alice ni usar actividades ajenas', async () => {
      assert.equal((await bob.request('GET', `/api/v1/courses/${ids.onlyA}/evaluation-cycles`)).statusCode, 404);
      assert.equal((await bob.request('PUT', `/api/v1/courses/${ids.onlyA}/evaluation-cycles`, { activeNumber: null, cycles: [] })).statusCode, 404);
      // En la materia compartida, Bob tiene sus propios ciclos y no puede incluir la actividad de Alice.
      const attempt = await bob.request('PUT', `/api/v1/courses/${ids.shared}/evaluation-cycles`, {
        activeNumber: null, cycles: [{ number: 1, label: null, weightPercent: null, items: [{ activityId: ids.gA, weightWithinCycle: null }] }],
      });
      assert.equal(attempt.statusCode, 400);
      assert.equal((await bob.request('GET', `/api/v1/courses/${ids.shared}/evaluation-cycles`)).json().cycles.length, 0);
      assert.equal((await alice.request('GET', `/api/v1/courses/${ids.shared}/evaluation-cycles`)).json().cycles.length, 2);
    });
  });
});
