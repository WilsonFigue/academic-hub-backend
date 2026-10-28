import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createBlackboardGateway, type BlackboardTransport } from '../src/modules/blackboard/gateway.js';
import { importStudent } from '../src/modules/import/import.service.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

// Transporte simulado con la FORMA de las respuestas observadas en UTEC (valores inventados, sin datos reales).
const SELF = '_100_1';
const COURSE = '_200_1';
const page = (results: unknown[]) => ({ results, paging: { nextPage: '' } });

type Routes = Record<string, unknown>;

/** `mutate` simula cambios en Blackboard; `failing` hace que esas rutas respondan 500. */
function fakeTransport(mutate?: (routes: Routes) => void, failing: string[] = []): BlackboardTransport {
  const routes: Record<string, unknown> = {
    '/learn/api/v1/users/me': { id: SELF, uuid: 'u-uuid', foundationsId: 'f-uuid', userName: 'est.prueba', givenName: 'Ana María', familyName: 'López Díaz',
      preferredDisplayName: 'GIVEN_NAME', emailAddress: 'ana@test.invalid', systemRoleIdentifier: 'STUDENT', birthDate: 'no-debe-guardarse' },
    [`/learn/api/public/v1/users/${SELF}`]: { locale: { id: 'es_ES' } },
    '/learn/api/v1/users/me/memberships': {
      results: [{
        id: '_m_1', userId: SELF, courseId: COURSE, role: 'Student', courseRole: { identifier: 'Student', roleBucket: 'STUDENT' },
        isAvailable: true, userHasHidden: false, enrollmentDate: '2026-07-20T10:00:00.000Z',
        course: { id: COURSE, uuid: 'c-uuid', courseId: 'FIS3-01-02-2026', displayId: 'FIS3', name: 'FÍSICA III 01 02-2026', termId: '_t_1',
          isAvailable: true, isOrganization: false, ultraStatus: 'ULTRA',
          term: { id: '_t_1', name: 'Ciclo 02-2026', startDate: '2026-07-20T06:00:00.000Z', endDate: '2026-12-16T05:59:00.000Z', isAvailable: true, durationType: 'DATE_RANGE' } },
      }, { id: '_m_org', course: { id: '_org_1', name: 'Organización', isOrganization: true } }],
      paging: { count: 2 },
    },
    [`/learn/api/v1/courses/${COURSE}/contents/ROOT/children`]: page([
      { id: '_f1', parentId: 'ROOT', title: 'Unidad 1', contentHandler: 'resource/x-bb-folder', position: 0, modifiedDate: 1_780_000_000_000, visibility: 'VISIBLE', contentDetail: { 'resource/x-bb-folder': { isFolder: true } } },
    ]),
    [`/learn/api/v1/courses/${COURSE}/contents/_f1/children`]: page([
      { id: '_d1', parentId: '_f1', title: 'Lectura', contentHandler: 'resource/x-bb-document', position: 0, body: { rawText: '<p>Hola <script>alert(1)</script><b>mundo</b></p>' }, visibility: 'VISIBLE' },
      { id: '_a1', parentId: '_f1', title: 'Tarea 1', contentHandler: 'resource/x-bb-asmt-test-link', position: 1, visibility: 'PARTIALLY_VISIBLE',
        adaptiveReleaseRules: { rules: [] }, genericReadOnlyData: { dueDate: '2026-11-10T05:59:00.000Z', hasGradeColumn: true }, stateCompletion: { total: 1, completed: 0, started: 0 } },
    ]),
    [`/learn/api/v1/courses/${COURSE}/gradebook/schemas`]: page([{ id: '_s1', title: 'Puntaje', scaleType: 'SCORE', isNumeric: true, symbols: [] }]),
    [`/learn/api/v1/courses/${COURSE}/gradebook/columns`]: page([
      { id: '_g1', contentId: '_a1', columnName: 'Tarea 1', possible: 10, dueDate: '2026-11-10T05:59:00.000Z', gradingSchemaId: '_s1', isAttemptBased: true,
        scoreProviderHandle: 'resource/x-bb-assessment', gradebookCategory: { id: '_cat', title: 'Test', localizableTitle: { languageKey: 'Test.name' } }, position: 1 },
      { id: '_g2', columnName: 'Promedio evaluación 01', possible: 100, calculatedFormula: { formula: 'A', aliases: { A: '_g1' } }, position: 2 },
    ]),
    [`/learn/api/v1/courses/${COURSE}/gradebook/grades`]: page([
      { id: '_gr1', userId: SELF, columnId: '_g1', status: 'GRADED', effectiveScore: 8.5, pointsPossible: 10, displayGrade: { score: 8.5 }, version: 3,
        submissionStatus: { status: 'GRADED' }, lastAttemptId: '_at1' },
      { id: null, userId: SELF, columnId: '_g2', submissionStatus: { status: 'NO_STATUS' } },
    ]),
    [`/learn/api/v1/courses/${COURSE}/gradebook/attempts/_at1`]: { id: '_at1', userId: SELF, gradeId: '_gr1', status: 'COMPLETED', attemptDate: '2026-11-01T12:00:00.000Z',
      attemptReceipt: { receiptId: 'r1', submissionDate: '2026-11-01T12:05:00.000Z' }, displayGrade: { score: 8.5 } },
    [`/learn/api/v1/courses/${COURSE}/gradebook/memberships/_m_1/exceptions`]: page([]),
    [`/learn/api/v1/courses/${COURSE}/calendars/calendarItems`]: page([
      { itemSourceType: 'blackboard.platform.gradebook2.GradableItem', itemSourceId: '_g1', calendarId: COURSE, title: 'Tarea 1', startDate: '2026-11-10T05:59:00.000Z', endDate: '2026-11-10T05:59:00.000Z' },
    ]),
    [`/learn/api/v1/courses/${COURSE}/announcements`]: page([{ id: '_an1', title: 'Bienvenida', body: { rawText: '<p>Hola</p>' }, createdDate: '2026-07-20T12:00:00.000Z', readStatus: { isRead: true } }]),
    '/learn/api/v1/calendars/todo/studentItems': { overdueItems: [], dueTodayItems: [], futureDueItems: [{ title: 'Tarea 1', dueDate: '2026-11-10T05:59:00.000Z', column: { id: '_g1', courseId: COURSE } }] },
  };
  mutate?.(routes);
  return {
    async get(path) {
      const clean = path.split('?')[0]!;
      if (failing.some((route) => clean.endsWith(route))) return { status: 500, body: null };
      if (clean.endsWith('/INTERACTIVE/children')) return { status: 404, body: null };
      return clean in routes ? { status: 200, body: routes[clean] } : { status: 404, body: null };
    },
  };
}

describe('importador (transporte simulado, PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  before(async () => { ctx = await setupTestContext(); });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('primera importación: crea cuenta, datos relacionados y contraseña temporal', async () => {
    const summary = await importStudent(ctx.db, createBlackboardGateway(fakeTransport()), () => {});
    assert.equal(summary.created, true);
    assert.ok(summary.temporaryPassword && summary.temporaryPassword.length >= 20);
    assert.equal(summary.user.username, 'ana.lopez');
    assert.equal(summary.user.displayName, 'Ana María López Díaz', 'la plantilla GIVEN_NAME se ignora');
    assert.equal(summary.sync.status, 'succeeded');
    assert.deepEqual(
      { terms: summary.academicData.terms, courses: summary.academicData.courses, content: summary.academicData.contentItems,
        columns: summary.academicData.gradebookColumns, activities: summary.academicData.activities, grades: summary.academicData.grades, attempts: summary.academicData.attempts },
      { terms: 1, courses: 1, content: 3, columns: 2, activities: 1, grades: 1, attempts: 1 },
    );
    const parent = await ctx.db.query(`SELECT count(*)::int AS n FROM course_content_items WHERE parent_id IS NOT NULL`);
    assert.equal(parent.rows[0]!.n, 2, 'jerarquía reconstruida');
    const body = await ctx.db.query(`SELECT body_html_sanitized FROM course_content_items WHERE external_id = '_d1'`);
    assert.ok(!String(body.rows[0]!.body_html_sanitized).includes('script'), 'HTML sanitizado');
    const link = await ctx.db.query(`SELECT count(*)::int AS n FROM gradebook_columns gc JOIN course_content_items ci ON ci.id = gc.content_item_id WHERE gc.external_id = '_g1'`);
    assert.equal(link.rows[0]!.n, 1, 'columna enlazada a su contenido');
    const pii = await ctx.db.query(`SELECT to_jsonb(ea) ? 'birth_date' AS has FROM external_accounts ea LIMIT 1`);
    assert.equal(pii.rows[0]!.has, false);
  });

  test('segunda importación: reutiliza el usuario, no genera contraseña ni duplicados', async () => {
    const before = await ctx.db.query(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM course_content_items) c, (SELECT count(*) FROM student_grades) g, (SELECT count(*) FROM calendar_items) k`);
    const summary = await importStudent(ctx.db, createBlackboardGateway(fakeTransport()), () => {});
    assert.equal(summary.created, false);
    assert.equal(summary.temporaryPassword, null);
    const afterCounts = await ctx.db.query(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM course_content_items) c, (SELECT count(*) FROM student_grades) g, (SELECT count(*) FROM calendar_items) k`);
    assert.deepEqual(afterCounts.rows[0], before.rows[0]);
    assert.equal(summary.rows.course_content_items?.inserted, 0);
    assert.equal(summary.rows.course_content_items?.updated, 0, 'sin cambios, sin reescrituras');
  });

  test('login con la cuenta generada exige cambiar la contraseña y luego muestra los datos', async () => {
    await ctx.db.query(`UPDATE users SET password_hash = $1 WHERE username = 'ana.lopez'`, [await (await import('../src/modules/auth/password.js')).hashPassword('Temporal-de-prueba-1')]);
    const browser = new TestClient(ctx.app, ctx.config.frontendOrigin);
    const login = await browser.request('POST', '/api/v1/auth/login', { identifier: 'ana.lopez', password: 'Temporal-de-prueba-1' });
    assert.equal(login.json().user.mustChangePassword, true);
    assert.equal((await browser.request('POST', '/api/v1/auth/password', { currentPassword: 'Temporal-de-prueba-1', newPassword: 'Definitiva-segura-2026' })).statusCode, 204);
    const dashboard = (await browser.request('GET', '/api/v1/dashboard')).json();
    assert.equal(dashboard.summary.courses, 1);
    assert.equal(dashboard.summary.activities, 1, 'la columna calculada no cuenta como actividad');
    assert.equal(dashboard.terms.all[0].name, 'Ciclo 02-2026');
    const calendar = (await browser.request('GET', '/api/v1/calendar?from=2026-11-01T00:00:00.000Z&to=2026-11-30T00:00:00.000Z')).json();
    assert.equal(calendar.items.length, 1, 'el GradableItem no duplica la actividad');
  });

  test('línea base: las dos primeras importaciones no generaron novedades', async () => {
    const changes = await ctx.db.query(`SELECT count(*)::int AS n FROM entity_changes`);
    assert.equal(changes.rows[0]!.n, 0);
  });

  test('una importación con cambios reales registra solo esos cambios', async () => {
    const summary = await importStudent(ctx.db, createBlackboardGateway(fakeTransport((routes) => {
      const columns = (routes[`/learn/api/v1/courses/${COURSE}/gradebook/columns`] as { results: Array<Record<string, unknown>> }).results;
      columns[0]!.dueDate = '2026-11-12T05:59:00.000Z';                                    // vencimiento modificado
      columns.push({ id: '_g3', columnName: 'Tarea 2', possible: 10, dueDate: '2026-11-20T05:59:00.000Z', scoreProviderHandle: 'resource/x-bb-assessment', position: 3 });
      const grades = (routes[`/learn/api/v1/courses/${COURSE}/gradebook/grades`] as { results: Array<Record<string, unknown>> }).results;
      grades[0]!.effectiveScore = 9.5;                                                     // nota modificada
      grades[0]!.version = 4;
      const announcements = (routes[`/learn/api/v1/courses/${COURSE}/announcements`] as { results: unknown[] }).results;
      announcements.push({ id: '_an2', title: 'Cambio de aula', body: { rawText: '<p>Aula 3</p>' }, createdDate: '2026-11-01T12:00:00.000Z' });
    })), () => {});
    assert.equal(summary.sync.baseline, false);
    const { rows } = await ctx.db.query<{ kind: string; scope: string }>(
      `SELECT after->>'kind' AS kind, scope FROM entity_changes ORDER BY kind`);
    assert.deepEqual(rows.map((row) => row.kind), ['activity_new', 'announcement_new', 'due_changed', 'grade_changed']);
    assert.equal(summary.sync.changesRecorded, 4);
  });

  test('repetir la misma importación no genera novedades falsas', async () => {
    const before = (await ctx.db.query(`SELECT count(*)::int AS n FROM entity_changes`)).rows[0]!.n;
    // Mismo estado que la importación anterior.
    await importStudent(ctx.db, createBlackboardGateway(fakeTransport((routes) => {
      const columns = (routes[`/learn/api/v1/courses/${COURSE}/gradebook/columns`] as { results: Array<Record<string, unknown>> }).results;
      columns[0]!.dueDate = '2026-11-12T05:59:00.000Z';
      columns.push({ id: '_g3', columnName: 'Tarea 2', possible: 10, dueDate: '2026-11-20T05:59:00.000Z', scoreProviderHandle: 'resource/x-bb-assessment', position: 3 });
      const grades = (routes[`/learn/api/v1/courses/${COURSE}/gradebook/grades`] as { results: Array<Record<string, unknown>> }).results;
      grades[0]!.effectiveScore = 9.5;
      grades[0]!.version = 4;
      (routes[`/learn/api/v1/courses/${COURSE}/announcements`] as { results: unknown[] }).results
        .push({ id: '_an2', title: 'Cambio de aula', body: { rawText: '<p>Aula 3</p>' }, createdDate: '2026-11-01T12:00:00.000Z' });
    })), () => {});
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM entity_changes`)).rows[0]!.n, before);
  });

  test('una lectura fallida no borra registros ni inventa cambios', async () => {
    const countsBefore = (await ctx.db.query(`SELECT (SELECT count(*) FROM gradebook_columns)::int c, (SELECT count(*) FROM student_grades)::int g, (SELECT count(*) FROM entity_changes)::int e`)).rows[0];
    const summary = await importStudent(ctx.db, createBlackboardGateway(fakeTransport(undefined, ['/gradebook/columns', '/gradebook/grades'])), () => {});
    assert.equal(summary.sync.status, 'partial');
    const countsAfter = (await ctx.db.query(`SELECT (SELECT count(*) FROM gradebook_columns)::int c, (SELECT count(*) FROM student_grades)::int g, (SELECT count(*) FROM entity_changes)::int e`)).rows[0];
    assert.deepEqual(countsAfter, countsBefore);
  });

  test('el feed /changes muestra las novedades al dueño y no a otro usuario', async () => {
    const owner = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await owner.request('POST', '/api/v1/auth/login', { identifier: 'ana.lopez', password: 'Definitiva-segura-2026' });
    const feed = (await owner.request('GET', '/api/v1/changes')).json();
    assert.equal(feed.changes.length, 4);
    assert.ok(feed.changes.some((change: { kind: string; activityId: string | null }) => change.kind === 'grade_changed' && change.activityId));

    const stranger = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await stranger.request('POST', '/api/v1/auth/register', { email: 'otro@test.invalid', password: 'Otra-clave-segura-1' });
    assert.equal((await stranger.request('GET', '/api/v1/changes')).json().changes.length, 0);
  });
});
