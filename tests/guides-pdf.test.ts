import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hashPassword } from '../src/modules/auth/password.js';
import { DEFAULT_POLICY, processQueue, type GuideGenerator } from '../src/modules/guides/guides.js';
import { closePdfBrowser, ensureGuidePdf, guidePdfHash, renderGuideHtml, type GuidePdfInput } from '../src/modules/guides/pdf.js';
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

  test('el PDF queda guardado en la base de datos y la segunda vez se sirve desde ahí, sin armarlo de nuevo', async (t) => {
    const first = await alice.request('GET', `/api/v1/activities/${ids.ready}/study-guide/pdf`);
    if (first.statusCode === 503) return t.skip('Este equipo no puede generar PDF (sin Chromium).');
    const stored = await ctx.db.query<{ content: Buffer }>(`SELECT content FROM study_guide_pdfs`);
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0]!.content.subarray(0, 5).toString(), '%PDF-');
    // Si el PDF saliera de Chromium, este cambio se perdería: sale de la base.
    const marker = Buffer.from('%PDF-1.4 desde-la-base');
    await ctx.db.query(`UPDATE study_guide_pdfs SET content = $1`, [marker]);
    const again = await alice.request('GET', `/api/v1/activities/${ids.ready}/study-guide/pdf`);
    assert.equal(again.statusCode, 200);
    assert.equal(again.rawPayload.toString(), marker.toString());
  });

  test('ensureGuidePdf: usa lo guardado si coincide, rehace si cambió y, si no puede rehacer, sirve el guardado', async () => {
    const guide = (await ctx.db.query<{ id: string }>(`SELECT id FROM study_guides LIMIT 1`)).rows[0]!.id;
    await ctx.db.query(`DELETE FROM study_guide_pdfs`);
    let renders = 0;
    const render = async () => { renders += 1; return Buffer.from(`%PDF-render-${renders}`); };
    const base = input();
    // 1. No hay nada guardado: se arma y se guarda.
    assert.deepEqual(await ensureGuidePdf(ctx.db, guide, base, render).then((r) => [r.bytes.toString(), r.fresh]), ['%PDF-render-1', true]);
    // 2. Mismo contenido: no se arma otra vez.
    assert.deepEqual(await ensureGuidePdf(ctx.db, guide, base, render).then((r) => [r.bytes.toString(), r.fresh]), ['%PDF-render-1', false]);
    assert.equal(renders, 1);
    // 3. Cambió la fecha de entrega: se rehace.
    const moved = input({ dueAt: '2026-12-01T05:59:00.000Z' });
    assert.notEqual(guidePdfHash(base), guidePdfHash(moved));
    assert.deepEqual(await ensureGuidePdf(ctx.db, guide, moved, render).then((r) => [r.bytes.toString(), r.fresh]), ['%PDF-render-2', true]);
    // 4. Cambió otra vez pero no se puede armar (sin Chromium): se sirve el guardado.
    const failing = async () => { throw new Error('sin Chromium'); };
    assert.deepEqual(await ensureGuidePdf(ctx.db, guide, input({ points: 99 }), failing).then((r) => [r.bytes.toString(), r.fresh]), ['%PDF-render-2', false]);
    // 5. No hay nada guardado y no se puede armar: falla.
    await ctx.db.query(`DELETE FROM study_guide_pdfs`);
    await assert.rejects(() => ensureGuidePdf(ctx.db, guide, base, failing), /sin Chromium/);
  });

  test('al terminar una guía se arma su PDF con el enlace de la web y queda en la base de datos', async () => {
    const enrollment = (await ctx.db.query<{ enrollment_id: string; course_id: string }>(`SELECT enrollment_id, course_id FROM study_guides LIMIT 1`)).rows[0]!;
    const column = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible, due_at) VALUES ($1, '_c3', 'Tarea 3', 10, now() + interval '4 days') RETURNING id`, [enrollment.course_id]);
    const activity = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [enrollment.enrollment_id, enrollment.course_id, column]);
    const guideId = await one(`INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, trigger, status) VALUES ($1, $2, $3, 'manual', 'requested') RETURNING id`, [enrollment.enrollment_id, enrollment.course_id, column]);
    const generator: GuideGenerator = { configured: true, async generate() { return { content: input().content, model: 'falso', inputTokens: 1, outputTokens: 1, costUsd: 0.01 }; } };
    const seen: GuidePdfInput[] = [];
    const policy = { ...DEFAULT_POLICY, webOrigin: 'https://app.example.com', renderPdf: async (given: GuidePdfInput) => { seen.push(given); return Buffer.from('%PDF-de-la-generacion'); } };
    const summary = await processQueue(ctx.db, generator, policy);
    assert.equal(summary.ready, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.webUrl, `https://app.example.com/activities/${activity}/guide`);
    assert.equal(seen[0]!.title, 'Tarea 3');
    const stored = await ctx.db.query<{ content: Buffer }>(`SELECT content FROM study_guide_pdfs WHERE guide_id = $1`, [guideId]);
    assert.equal(stored.rows[0]!.content.toString(), '%PDF-de-la-generacion');
    // Un fallo al armar el PDF nunca estropea la guía.
    const col4 = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible, due_at) VALUES ($1, '_c4', 'Tarea 4', 10, now() + interval '4 days') RETURNING id`, [enrollment.course_id]);
    await ctx.db.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [enrollment.enrollment_id, enrollment.course_id, col4]);
    const g4 = await one(`INSERT INTO study_guides (enrollment_id, course_id, gradebook_column_id, trigger, status) VALUES ($1, $2, $3, 'manual', 'requested') RETURNING id`, [enrollment.enrollment_id, enrollment.course_id, col4]);
    const broken = { ...DEFAULT_POLICY, renderPdf: async () => { throw new Error('Chromium no disponible'); } };
    assert.equal((await processQueue(ctx.db, generator, broken)).ready, 1);
    assert.equal((await ctx.db.query<{ status: string }>(`SELECT status FROM study_guides WHERE id = $1`, [g4])).rows[0]!.status, 'ready');
  });
});
