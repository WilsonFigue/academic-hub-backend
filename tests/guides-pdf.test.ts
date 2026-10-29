import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { closePdfBrowser, renderGuideHtml, type GuidePdfInput } from '../src/modules/guides/pdf.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const input = (overrides: Partial<GuidePdfInput> = {}): GuidePdfInput => ({
  title: 'Actividad <b>uno</b>', course: 'Matemática I', dueAt: '2026-11-02T05:59:00.000Z', points: 10, webUrl: 'http://localhost:5173/activities/x/guide', wantsGeoGebra: false, generatedAt: null,
  content: {
    summary: 'Resumen <script>alert(1)</script>',
    sections: [
      { heading: 'Cómo abordarla paso a paso', body: 'Línea 1\nLínea 2', bullets: ['1. Primero', '2. Después'] },
      { heading: 'Antes de entregar', body: '', bullets: ['Revisé "todo" & más'] },
      { heading: 'Lo que el material no cubre', body: 'Nada <img src=x onerror=alert(1)>', bullets: [] },
    ],
    sources: [{ file: 'Clase 1.pdf', note: 'teoría' }],
  },
  ...overrides,
});

describe('HTML del PDF de la guía', () => {
  test('todo el texto de la IA se escapa: nada se interpreta como HTML', () => {
    const html = renderGuideHtml(input());
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<b>uno</b>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Revisé &quot;todo&quot; &amp; más/);
  });

  test('pasos numerados, lista de verificación y sección de lo que no cubre', () => {
    const html = renderGuideHtml(input());
    assert.match(html, /<ol class="steps"><li>Primero<\/li><li>Después<\/li><\/ol>/);
    assert.match(html, /<ul class="checks"><li>/);
    assert.match(html, /<section class="missing">/);
  });

  test('la nota de GeoGebra solo aparece cuando la actividad lo pide', () => {
    assert.ok(!renderGuideHtml(input()).includes('class="geo"'));
    const html = renderGuideHtml(input({ wantsGeoGebra: true }));
    assert.match(html, /class="geo"/);
    assert.match(html, /http:\/\/localhost:5173\/activities\/x\/guide/);
  });
});

describe('PDF de la guía por la API (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  let alice: TestClient;
  let bob: TestClient;
  const ids: Record<string, string> = {};
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;

  before(async () => {
    ctx = await setupTestContext();
    const hash = await hashPassword('Clave-de-prueba-1');
    const inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    const a = await one(`INSERT INTO users (email, password_hash) VALUES ('alice@test.invalid', $1) RETURNING id`, [hash]);
    const b = await one(`INSERT INTO users (email, password_hash) VALUES ('bob@test.invalid', $1) RETURNING id`, [hash]);
    const eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [a, inst]);
    await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [b, inst]);
    const course = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_200_1', 'Matemática I') RETURNING id`, [inst]);
    const enrollment = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [eaA, inst, course]);
    const column = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible, due_at) VALUES ($1, '_c1', 'Tarea 1', 10, now() + interval '5 days') RETURNING id`, [course]);
    ids.ready = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [enrollment, course, column]);
    await ctx.db.query(`INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, trigger, status, content, finished_at) VALUES ($1, $2, $3, 'manual', 'ready', $4, now())`,
      [enrollment, course, column, JSON.stringify(input().content)]);
    const column2 = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible, due_at) VALUES ($1, '_c2', 'Tarea 2', 10, now() + interval '6 days') RETURNING id`, [course]);
    ids.none = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [enrollment, course, column2]);
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin);
    bob = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: 'Clave-de-prueba-1' });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: 'Clave-de-prueba-1' });
  });
  after(async () => { await closePdfBrowser(); if (ctx) await teardownTestContext(ctx); });

  test('el dueño recibe un PDF real; con ?download=1 se descarga; otro usuario y una actividad sin guía reciben 404', async (t) => {
    const view = await alice.request('GET', `/api/v1/activities/${ids.ready}/study-guide/pdf`);
    if (view.statusCode === 503) return t.skip('Este equipo no puede generar PDF (sin Chromium).');
    assert.equal(view.statusCode, 200);
    assert.equal(view.headers['content-type'], 'application/pdf');
    assert.equal(view.rawPayload.subarray(0, 5).toString(), '%PDF-');
    assert.match(String(view.headers['content-disposition']), /^inline; filename\*=UTF-8''Gu%C3%ADa%20de%20estudio%20-%20Tarea%201\.pdf/);
    assert.equal(view.headers['x-content-type-options'], 'nosniff');
    const download = await alice.request('GET', `/api/v1/activities/${ids.ready}/study-guide/pdf?download=1`);
    assert.match(String(download.headers['content-disposition']), /^attachment;/);
    assert.equal((await bob.request('GET', `/api/v1/activities/${ids.ready}/study-guide/pdf`)).statusCode, 404);
    assert.equal((await alice.request('GET', `/api/v1/activities/${ids.none}/study-guide/pdf`)).statusCode, 404);
  });
});
