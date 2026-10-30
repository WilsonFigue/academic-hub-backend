import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/password.js';
import type { BlackboardSessions } from '../src/modules/files/sessions.js';
import type { ForumSuggester, SuggestInput } from '../src/modules/forums/suggest.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';

describe('foros: consigna, participaciones y sugerencia con botón (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: Record<string, any> = {};
  let alice: TestClient; let bob: TestClient;
  const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;

  // Blackboard falso: el foro 'F1' responde con la consigna del docente y 4 respuestas; el foro 'F403' está prohibido.
  const longText = (name: string) => `${name} opina que el interés propio puede beneficiar a otras personas porque quien vende bien también cuida a su clientela y eso genera empleo.`;
  const calls: string[] = [];
  const fakeSessions = {
    acquire: async () => ({
      transport: {
        get: async (path: string) => {
          calls.push(path);
          if (path.includes('/forums/F403/')) return { status: 403, body: null };
          if (path.endsWith('/messages')) return { status: 200, body: { results: [{ id: 'T1', parentId: null, givenName: 'JUAN CARLOS', familyName: 'PEREZ LOPEZ', subject: 'Foro', body: { displayText: '<p>Escriba <b>150 a 200 palabras</b> sobre el interés individual.</p><p>Responda a un compañero.</p>' } }] } };
          if (path.endsWith('/T1/replies')) return { status: 200, body: { results: [
            { id: 'R1', parentId: 'T1', givenName: 'ANA MARIA', familyName: 'RIVERA', postDate: '2026-10-02T10:00:00Z', body: { displayText: longText('Ana') } },
            { id: 'R2', parentId: 'T1', givenName: 'LUIS', familyName: 'MENDEZ', postDate: '2026-10-03T10:00:00Z', body: { displayText: longText('Luis') } },
            { id: 'R3', parentId: 'T1', givenName: 'ALICE', familyName: 'PRUEBA', postDate: '2026-10-04T10:00:00Z', body: { displayText: longText('La propia estudiante') } },
            { id: 'R4', parentId: 'T1', givenName: 'PEDRO', familyName: 'ROSALES', postDate: '2026-10-05T10:00:00Z', body: { displayText: 'ok' } },
          ] } };
          return { status: 404, body: null };
        },
      },
    }),
    drop: () => {},
  } as unknown as BlackboardSessions;

  const received: SuggestInput[] = [];
  const suggester: ForumSuggester = {
    configured: true,
    async suggest(input) {
      received.push(input);
      return { postText: 'Mi participación de ejemplo.', replies: input.classmates.length > 0 ? [{ index: 1, text: 'Hola {nombre}, me gustó tu idea.' }] : [], model: 'fake', inputTokens: 100, outputTokens: 50, costUsd: 0.01 };
    },
  };

  const forumColumn = async (enrollment: string, course: string, forumId: string, name: string) => {
    const contentExternal = `_c_${forumId}`;
    const content = await one(`INSERT INTO course_content_items (course_id, external_id, handler, title, content_detail) VALUES ($1, $2, 'resource/x-bb-forumlink', $3, $4) RETURNING id`, [course, contentExternal, name, JSON.stringify({ id: forumId, conferenceId: '_conf_1' })]);
    const column = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible, due_at, content_item_id, content_external_id) VALUES ($1, $2, $3, 'Discussion.name', 10, now() + interval '5 days', $4, $5) RETURNING id`, [course, `_gc_${forumId}`, name, content, contentExternal]);
    return { content, activity: await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [enrollment, course, column]) };
  };

  before(async () => {
    ctx = await setupTestContext();
    const hash = await hashPassword(PASSWORD);
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, password_hash) VALUES ('alice@test.invalid', $1) RETURNING id`, [hash]);
    ids.bob = await one(`INSERT INTO users (email, password_hash) VALUES ('bob@test.invalid', $1) RETURNING id`, [hash]);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, given_name, family_name, link_status, linked_at) VALUES ($1, $2, '_1_1', 'ALICE', 'PRUEBA', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.course = await one(`INSERT INTO courses (institution_id, external_id, name, instructor_name) VALUES ($1, '_300_1', 'Filosofía', 'Mtro. Juan Carlos Pérez López') RETURNING id`, [ids.inst]);
    ids.enrollA = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [ids.eaA, ids.inst, ids.course]);
    ids.f1 = await forumColumn(ids.enrollA, ids.course, 'F1', 'Foro reflexivo');
    ids.f403 = await forumColumn(ids.enrollA, ids.course, 'F403', 'Foro bloqueado');
    const plainCol = await one(`INSERT INTO gradebook_columns (course_id, external_id, name, category_title, points_possible, due_at) VALUES ($1, '_gc_t', 'Tarea normal', 'Homework.name', 10, now() + interval '5 days') RETURNING id`, [ids.course]);
    ids.plain = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [ids.enrollA, ids.course, plainCol]);
    const app = await buildApp({ config: ctx.config, db: ctx.db, logger: false, blackboardSessions: fakeSessions, forumSuggester: suggester, forumCapUsd: 10 });
    await ctx.app.close();
    ctx.app = app;
    alice = new TestClient(app, ctx.config.frontendOrigin); bob = new TestClient(app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
  });
  after(async () => { if (ctx) await teardownTestContext(ctx); });

  test('una actividad que no es foro lo dice, y el foro aparece sin sugerencia ni lectura en vivo', async () => {
    assert.equal((await alice.request('GET', `/api/v1/activities/${ids.plain}/forum`)).json().isForum, false);
    const state = (await alice.request('GET', `/api/v1/activities/${ids.f1.activity}/forum`)).json();
    assert.equal(state.isForum, true); assert.equal(state.suggestion, null); assert.equal(state.prompt, null);
    assert.equal(calls.length, 0, 'consultar el estado no debe llamar a Blackboard');
  });

  test('con respuestas a compañeros: lee la consigna del docente, manda a la IA solo texto sin nombres y guarda solo la sugerencia', async () => {
    const response = await alice.request('POST', `/api/v1/activities/${ids.f1.activity}/forum/suggestion`, { includeReplies: true });
    assert.equal(response.statusCode, 200);
    const input = received.at(-1)!;
    assert.ok(input.prompt!.includes('150 a 200 palabras'), 'la consigna sale del mensaje del docente');
    assert.equal(input.classmates.length, 2, 'se descartan la propia, la muy corta y la del docente');
    const sent = JSON.stringify({ ...input, classmates: input.classmates.map((c) => c.text) });
    for (const name of ['Rivera', 'RIVERA', 'MENDEZ', 'Méndez', 'ROSALES', 'PRUEBA', 'Pérez', 'PEREZ']) assert.ok(!sent.includes(name), `no debe enviarse el apellido ${name}`);
    const body = response.json();
    assert.equal(body.suggestion.postText, 'Mi participación de ejemplo.');
    assert.equal(body.suggestion.replies[0].text, `Hola ${body.suggestion.replies[0].to}, me gustó tu idea.`);
    assert.ok(['Luis', 'Ana'].includes(body.suggestion.replies[0].to), 'saluda con el nombre de pila, con inicial mayúscula y el resto en minúsculas');
    // La consigna queda guardada como instrucciones de la actividad; el texto de compañeros no se guarda en ningún lado.
    const stored = (await ctx.db.query<{ body_text: string }>(`SELECT body_text FROM course_content_items WHERE id = $1`, [ids.f1.content])).rows[0]!.body_text;
    assert.ok(stored.includes('150 a 200 palabras'));
    const dump = JSON.stringify((await ctx.db.query(`SELECT * FROM forum_suggestions`)).rows);
    assert.ok(!dump.includes('opina que el interés propio'), 'no se guardan textos de compañeros');
    assert.equal((await alice.request('GET', `/api/v1/activities/${ids.f1.activity}/forum`)).json().suggestion.postText, 'Mi participación de ejemplo.');
  });

  test('sin pedir respuestas no se leen participaciones de compañeros', async () => {
    calls.length = 0;
    await alice.request('POST', `/api/v1/activities/${ids.f1.activity}/forum/suggestion`, {});
    assert.ok(!calls.some((c) => c.includes('/replies')), 'no debe pedir las respuestas');
    assert.equal(received.at(-1)!.classmates.length, 0);
  });

  test('foro bloqueado (403): usa el título, o la consigna que el estudiante pegue', async () => {
    const plainTry = await alice.request('POST', `/api/v1/activities/${ids.f403.activity}/forum/suggestion`, { includeReplies: true });
    assert.equal(plainTry.statusCode, 200);
    assert.equal(plainTry.json().suggestion.promptSource, 'title_only'); assert.equal(plainTry.json().promptStatus, 'forbidden');
    assert.equal(received.at(-1)!.prompt, null); assert.equal(received.at(-1)!.classmates.length, 0);
    const pasted = await alice.request('POST', `/api/v1/activities/${ids.f403.activity}/forum/suggestion`, { prompt: 'Comente en 100 palabras la lectura de la semana.' });
    assert.equal(pasted.json().suggestion.promptSource, 'pasted'); assert.equal(received.at(-1)!.prompt, 'Comente en 100 palabras la lectura de la semana.');
  });

  test('otro estudiante no puede ver ni generar la sugerencia de este foro', async () => {
    assert.equal((await bob.request('GET', `/api/v1/activities/${ids.f1.activity}/forum`)).json().isForum, false);
    assert.equal((await bob.request('POST', `/api/v1/activities/${ids.f1.activity}/forum/suggestion`, {})).statusCode, 404);
  });

  test('desde la pestaña de contenido: abre el foro, muestra la consigna y la ventana «condicionado», y sirve también a foros sin nota', async () => {
    // Foro sin nota (sin columna de calificaciones): solo existe en el contenido.
    const content = await one(`INSERT INTO course_content_items (course_id, external_id, handler, title, content_detail) VALUES ($1, '_c_F9', 'resource/x-bb-forumlink', 'Foro de presentación', $2) RETURNING id`, [ids.course, JSON.stringify({ id: 'F1' })]);
    await ctx.db.query(`INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id, visibility) VALUES ($1, $2, $3, 'PARTIALLY_VISIBLE')`, [ids.enrollA, content, ids.course]);
    const open = await alice.request('GET', `/api/v1/courses/${ids.course}/content/${content}/forum`);
    assert.equal(open.statusCode, 200);
    const body = open.json();
    assert.equal(body.isForum, true); assert.equal(body.graded, false);
    assert.ok(body.prompt.includes('150 a 200 palabras'), 'al abrir se lee la consigna del docente');
    const made = await alice.request('POST', `/api/v1/courses/${ids.course}/content/${content}/forum/suggestion`, {});
    assert.equal(made.statusCode, 200);
    assert.equal((await alice.request('GET', `/api/v1/courses/${ids.course}/content/${content}/forum`)).json().suggestion.postText, 'Mi participación de ejemplo.');
    assert.equal((await bob.request('GET', `/api/v1/courses/${ids.course}/content/${content}/forum`)).json().isForum, false);
    // El foro con nota comparte la misma sugerencia desde la actividad y desde el contenido.
    await ctx.db.query(`INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id, visibility) VALUES ($1, $2, $3, 'VISIBLE')`, [ids.enrollA, ids.f1.content, ids.course]);
    const viaContent = (await alice.request('GET', `/api/v1/courses/${ids.course}/content/${ids.f1.content}/forum`)).json();
    assert.equal(viaContent.graded, true); assert.equal(viaContent.suggestion.postText, 'Mi participación de ejemplo.');
  });

  test('con el tope mensual agotado no se llama a la IA', async () => {
    const before = received.length;
    await ctx.db.query(`INSERT INTO ai_usage_log (event, feature, cost_usd, status, period) VALUES ('call', 'homework', 9.99, 'ok', date_trunc('month', now())::date)`);
    const response = await alice.request('POST', `/api/v1/activities/${ids.f1.activity}/forum/suggestion`, {});
    assert.equal(response.statusCode, 429); assert.equal(response.json().error.code, 'monthly_cap');
    assert.equal(received.length, before);
  });
});
