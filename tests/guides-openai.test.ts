import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createFileStore } from '../src/modules/files/store.js';
import { GuideError, type GuideRequest } from '../src/modules/guides/guides.js';
import { buildUserPrompt, createOpenAIGenerator, parseGuide } from '../src/modules/guides/openai.js';
import { gatherMaterial } from '../src/modules/guides/material.js';
import { setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const LONG = 'La circunferencia es el conjunto de puntos del plano que equidistan de un punto fijo llamado centro. '.repeat(4);
const GOOD = { summary: 'Resumen de la actividad.', sections: [{ heading: 'Qué te piden', body: 'Texto', bullets: ['uno'] }], sources: [{ file: 'La circunferencia (clase)', note: 'teoría' }, { file: 'Archivo inventado.pdf', note: 'no existe' }] };

const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const completion = (content: string, usage = { prompt_tokens: 2000, completion_tokens: 1000 }) => ({ choices: [{ message: { content } }], usage, model: 'modelo-de-prueba' });

describe('generador de OpenAI (PostgreSQL real, sin llamar a la red)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  let request: GuideRequest;
  let emptyRequest: GuideRequest;
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;

  before(async () => {
    ctx = await setupTestContext();
    const inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    const user = await one(`INSERT INTO users (email, password_hash) VALUES ('ai@test.invalid', 'x') RETURNING id`);
    const account = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [user, inst]);
    const course = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_200_1', 'Matemática I') RETURNING id`, [inst]);
    const enrollment = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [account, inst, course]);
    const item = (external: string, handler: string, title: string, parent: string | null, body: string | null) => one(
      `INSERT INTO course_content_items (course_id, external_id, parent_external_id, handler, title, body_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [course, external, parent, handler, title, body]);
    const task = await item('_t1', 'resource/x-bb-asmt-test-link', 'Actividad sobre la circunferencia', '_semana14', 'Resuelve el problema de la antena.');
    const theory = await item('_d1', 'resource/x-bb-document', 'La circunferencia (clase)', '_clases14', LONG);
    const other = await item('_d2', 'resource/x-bb-document', 'Historia de la computación', '_otra', LONG);
    await item('_f1', 'resource/x-bb-folder', 'Clases de la semana 14', null, null);
    for (const content of [theory, other]) await ctx.db.query(`INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id) VALUES ($1, $2, $3)`, [enrollment, content, course]);
    const column = await one(`INSERT INTO gradebook_columns (course_id, external_id, content_item_id, content_external_id, name, points_possible) VALUES ($1, '_gc1', $2, '_t1', 'Actividad sobre la circunferencia', 10) RETURNING id`, [course, task]);
    await ctx.db.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [enrollment, course, column]);
    request = { guideId: 'g1', enrollmentId: enrollment, courseId: course, gradebookColumnId: column };
    // Actividad sin nada relacionado.
    const lonely = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, points_possible) VALUES ($1, '_gc2', 'Tema sin material alguno', 10) RETURNING id`, [course]);
    await ctx.db.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [enrollment, course, lonely]);
    emptyRequest = { ...request, gradebookColumnId: lonely };
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  const generator = (fetchImpl: typeof fetch) => createOpenAIGenerator({
    apiKey: 'sk-de-prueba', model: 'modelo-de-prueba', priceInPerM: 1, priceOutPerM: 5, maxInputChars: 50_000, db: ctx.db, store: createFileStore(null), fetchImpl,
  });

  test('el material incluye lo relacionado por tema y deja fuera lo que no tiene que ver', async () => {
    const material = await gatherMaterial(ctx.db, createFileStore(null), request, 50_000);
    assert.deepEqual(material.docs.map((doc) => doc.title), ['Instrucciones de la actividad en Blackboard', 'La circunferencia (clase)']);
    assert.ok(!material.docs.some((doc) => doc.title.includes('Historia')));
    assert.match(buildUserPrompt(material), /Actividad: Actividad sobre la circunferencia/);
  });

  test('el tope de material recorta lo que se envía', async () => {
    const material = await gatherMaterial(ctx.db, createFileStore(null), request, 5_000);
    assert.ok(material.totalChars <= 5_000 + 200);
  });

  test('guía lista: el costo sale de los tokens reportados y las fuentes inventadas se descartan', async () => {
    let sent: { model: string; response_format: { type: string } } | null = null;
    const result = await generator((async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      assert.equal((init.headers as Record<string, string>).authorization, 'Bearer sk-de-prueba');
      return new Response(JSON.stringify(completion(JSON.stringify(GOOD))), { status: 200 });
    }) as typeof fetch).generate(request);
    assert.equal(sent!.model, 'modelo-de-prueba');
    assert.equal(sent!.response_format.type, 'json_schema');
    assert.equal(result.costUsd, 0.007);                                  // 2000 × $1/M + 1000 × $5/M
    assert.deepEqual([result.inputTokens, result.outputTokens], [2000, 1000]);
    assert.deepEqual(result.content.sources, [{ file: 'La circunferencia (clase)', note: 'teoría' }]);
  });

  test('sin material relacionado no se llama a OpenAI', async () => {
    let called = false;
    await assert.rejects(generator((async () => { called = true; return new Response('{}'); }) as typeof fetch).generate(emptyRequest), (error: GuideError) => error.code === 'no_material');
    assert.equal(called, false);
  });

  test('los errores de OpenAI se traducen a códigos claros y sin la clave', async () => {
    const code = async (fetchImpl: typeof fetch) => generator(fetchImpl).generate(request).then(() => 'ok', (error: GuideError) => error.code);
    assert.equal(await code(reply({ error: { code: 'invalid_api_key' } }, 401) as typeof fetch), 'openai_auth');
    assert.equal(await code(reply({ error: { code: 'insufficient_quota' } }, 429) as typeof fetch), 'openai_no_credit');
    assert.equal(await code(reply({ error: { code: 'rate_limit_exceeded' } }, 429) as typeof fetch), 'openai_rate_limit');
    assert.equal(await code(reply({}, 503) as typeof fetch), 'openai_unavailable');
    assert.equal(await code((async () => { throw new TypeError('network'); }) as typeof fetch), 'openai_network');
    assert.equal(await code(reply({ choices: [{ message: { content: null, refusal: 'no puedo' } }] }) as typeof fetch), 'ai_refused');
    assert.equal(await code(reply(completion('esto no es JSON')) as typeof fetch), 'bad_output');
    assert.equal(await code(reply(completion(JSON.stringify({ summary: '', sections: [], sources: [] }))) as typeof fetch), 'bad_output');
  });

  test('parseGuide descarta secciones vacías y limpia el texto', () => {
    const material = { course: 'M', activity: { name: 'A', dueAt: null, points: null, category: null }, skipped: [], totalChars: 0, docs: [] };
    const guide = parseGuide(JSON.stringify({ summary: ' Hola ', sections: [{ heading: 'A', body: '', bullets: [] }, { heading: 'B', body: ' Texto ', bullets: [' x ', ''] }], sources: [] }), material);
    assert.deepEqual(guide, { summary: 'Hola', sections: [{ heading: 'B', body: 'Texto', bullets: ['x'] }], sources: [] });
  });
});
