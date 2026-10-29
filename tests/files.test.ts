import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/password.js';
import type { BlackboardSessions } from '../src/modules/files/sessions.js';
import { previewDocx, previewPptx, previewXlsx } from '../src/modules/files/extract.js';
import { convertToPdf, officeAvailable, officeFormat } from '../src/modules/files/office.js';
import { dispatchReviewMarks, isCompleted } from '../src/modules/files/reviews.js';
import { TestClient, setupTestContext, teardownTestContext, testDatabaseAvailable, type TestContext } from './helpers/test-db.js';

const PASSWORD = 'Clave-de-prueba-1';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILES = join(process.cwd(), '.state', 'files');

// ── archivos de ejemplo mínimos (OOXML) ──
const docx = () => zipSync({
  'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Guía de actividad</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hola </w:t></w:r><w:r><w:t>mundo &amp; más &lt;script&gt;</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Primer punto</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Criterio</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Puntos</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Análisis</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`),
});
const pptx = () => zipSync({
  'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Segunda</a:t></a:r></a:p></p:sld>'),
  'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Portada</a:t></a:r></a:p><a:p><a:r><a:t>Subtítulo</a:t></a:r></a:p></p:sld>'),
});
const xlsx = () => zipSync({
  'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Notas" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/sharedStrings.xml': strToU8('<sst><si><t>Nombre</t></si><si><t>Ana</t></si></sst>'),
  'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Nota</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>9.5</v></c></row></sheetData></worksheet>'),
});

describe('vista previa de archivos', () => {
  test('Word: títulos, negrita, listas, tablas y texto escapado', () => {
    const preview = previewDocx(docx());
    assert.equal(preview.kind, 'docx');
    if (preview.kind !== 'docx') return;
    assert.match(preview.html, /<h2>Guía de actividad<\/h2>/);
    assert.match(preview.html, /<strong>Hola <\/strong>mundo &amp; más &lt;script&gt;/);
    assert.match(preview.html, /<li>Primer punto<\/li>/);
    assert.match(preview.html, /<th>Criterio<\/th><th>Puntos<\/th>/);
    assert.ok(!preview.html.includes('<script'));
    assert.match(preview.text, /Análisis \| 40/);
  });

  test('PowerPoint: diapositivas en orden numérico con título y líneas', () => {
    const preview = previewPptx(pptx());
    assert.equal(preview.kind, 'pptx');
    if (preview.kind !== 'pptx') return;
    assert.deepEqual(preview.slides.map((s) => [s.n, s.title, s.lines]), [[1, 'Portada', ['Subtítulo']], [2, 'Segunda', []]]);
  });

  test('Excel: hojas, cadenas compartidas, texto en línea y números', () => {
    const preview = previewXlsx(xlsx());
    assert.equal(preview.kind, 'xlsx');
    if (preview.kind !== 'xlsx') return;
    assert.deepEqual(preview.sheets[0], { name: 'Notas', rows: [['Nombre', 'Nota'], ['Ana', '9.5']], truncated: false });
  });

  test('un archivo que no es OOXML se rechaza en lugar de inventar contenido', () => {
    assert.throws(() => previewDocx(zipSync({ 'otra/cosa.xml': strToU8('x') })));
  });
});

describe('ver tal cual: conversión a PDF con Office', () => {
  test('se reconoce el formato por tipo o extensión; los formatos con macros no se convierten', () => {
    assert.deepEqual(officeFormat(DOCX_MIME, 'x.docx'), { kind: 'word', ext: 'docx', legacy: false });
    assert.equal(officeFormat('application/octet-stream', 'Clase.PPTX')?.kind, 'powerpoint');
    assert.equal(officeFormat('application/msword', 'x.doc')?.legacy, true);
    assert.equal(officeFormat('application/vnd.ms-excel.sheet.macroEnabled.12', 'x.xlsm'), null);
    assert.equal(officeFormat('application/pdf', 'x.pdf'), null);
  });

  test('con Office instalado, un Word válido se convierte a un PDF real (si no hay Office, se omite)', { skip: !officeAvailable('word') && 'Office no está instalado' }, async () => {
    const dir = join(FILES, 'office-test');
    mkdirSync(dir, { recursive: true });
    const input = join(dir, 'entrada');
    const output = join(dir, 'salida.pdf');
    writeFileSync(input, zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hola desde la prueba</w:t></w:r></w:p></w:body></w:document>'),
    }));
    try {
      assert.equal(await convertToPdf(input, officeFormat(DOCX_MIME, 'x.docx')!, output), 'ok');
      assert.equal(readFileSync(output).subarray(0, 5).toString('latin1'), '%PDF-');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('marcas de revisado (envío a Blackboard)', () => {
  test('completado: todas las partes completadas', () => {
    assert.equal(isCompleted({ total: 2, started: 2, completed: 2 }), true);
    assert.equal(isCompleted({ total: 2, started: 2, completed: 1 }), false);
    assert.equal(isCompleted(null), false);
  });
});

describe('archivos, guías y marcas (PostgreSQL real)', { skip: !testDatabaseAvailable() && 'Base de datos no configurada' }, () => {
  let ctx: TestContext;
  const ids: Record<string, string> = {};
  let alice: TestClient;
  let bob: TestClient;
  const cleanup: string[] = [];

  before(async () => {
    ctx = await setupTestContext();
    mkdirSync(FILES, { recursive: true });
    const one = async (sql: string, values: unknown[] = []) => (await ctx.db.query<{ id: string }>(sql, values)).rows[0]!.id;
    const hash = await hashPassword(PASSWORD);
    ids.inst = await one(`INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode) VALUES ('TEST', 'Prueba', 'blackboard_learn_ultra', 'https://lms.test.invalid', 'America/El_Salvador', 'user_session') RETURNING id`);
    ids.alice = await one(`INSERT INTO users (email, password_hash) VALUES ('alice@test.invalid', $1) RETURNING id`, [hash]);
    ids.bob = await one(`INSERT INTO users (email, password_hash) VALUES ('bob@test.invalid', $1) RETURNING id`, [hash]);
    ids.eaA = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`, [ids.alice, ids.inst]);
    ids.eaB = await one(`INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`, [ids.bob, ids.inst]);
    ids.course = await one(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_200_1', 'Filosofía') RETURNING id`, [ids.inst]);
    ids.enA = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`, [ids.eaA, ids.inst, ids.course]);
    ids.enB = await one(`INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m2') RETURNING id`, [ids.eaB, ids.inst, ids.course]);
    const item = (external: string, handler: string, title: string, detail: unknown, parent: string | null = '_f1') => one(
      `INSERT INTO course_content_items (course_id, external_id, parent_external_id, handler, title, content_detail) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ids.course, external, parent, handler, title, detail ? JSON.stringify(detail) : null]);
    const file = (name: string, mime: string, size: number) => ({ file: { fileName: name, mimeType: mime, fileSize: size, permanentUrl: `/bbcswebdav/pid-1-dt-content-rid-9_1/xid-9_1` } });
    ids.guide = await item('_g1', 'resource/x-bb-file', 'Guía de actividad', file('Guía.docx', DOCX_MIME, 1000));
    ids.slides = await item('_g2', 'resource/x-bb-file', 'Diapositivas', file('Clase.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 1000));
    ids.sheet = await item('_g3', 'resource/x-bb-file', 'Notas', file('Notas.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 1000));
    ids.uncached = await item('_g4', 'resource/x-bb-file', 'Sin copia', file('Pesado.pdf', 'application/pdf', 5000));
    ids.task = await item('_g5', 'resource/x-bb-asmt-test-link', 'Ellacuría y Dussel', { test: {} });
    ids.hidden = await item('_g6', 'resource/x-bb-file', 'Solo para Bob', file('Privado.docx', DOCX_MIME, 1000));
    for (const [enrollment, content] of [[ids.enA, ids.guide], [ids.enA, ids.slides], [ids.enA, ids.sheet], [ids.enA, ids.uncached], [ids.enA, ids.task], [ids.enB, ids.hidden]]) {
      await ctx.db.query(`INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id) VALUES ($1, $2, $3)`, [enrollment, content, ids.course]);
    }
    ids.column = await one(`INSERT INTO gradebook_columns (course_id, external_id, content_item_id, content_external_id, name, points_possible) VALUES ($1, '_gc1', $2, '_g5', 'Ellacuría y Dussel', 10) RETURNING id`, [ids.course, ids.task]);
    ids.grade = await one(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3) RETURNING id`, [ids.enA, ids.course, ids.column]);
    // Copias locales ya guardadas (sin sesión de Blackboard).
    for (const [id, bytes] of [[ids.guide, docx()], [ids.slides, pptx()], [ids.sheet, xlsx()]] as const) {
      writeFileSync(join(FILES, id!), bytes);
      cleanup.push(join(FILES, id!), join(FILES, `${id}.preview.json`));
    }
    alice = new TestClient(ctx.app, ctx.config.frontendOrigin);
    bob = new TestClient(ctx.app, ctx.config.frontendOrigin);
    await alice.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    await bob.request('POST', '/api/v1/auth/login', { identifier: 'bob@test.invalid', password: PASSWORD });
  });
  after(async () => {
    for (const path of cleanup) if (existsSync(path)) rmSync(path);
    if (ctx) await teardownTestContext(ctx);
  });

  const url = (id: string, tail: string) => `/api/v1/courses/${ids.course}/content/${id}/${tail}`;

  test('el archivo se sirve con su tipo y cabeceras seguras', async () => {
    const whole = await alice.request('GET', url(ids.guide!, 'file'));
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers['content-type'], DOCX_MIME);
    assert.match(String(whole.headers['content-disposition']), /^attachment; filename\*=UTF-8''Gu%C3%ADa\.docx/);
    assert.equal(whole.headers['x-content-type-options'], 'nosniff');
    const part = await alice.request('GET', url(ids.guide!, 'file'));
    assert.equal(part.rawPayload.length, Number(whole.headers['content-length']));
  });

  test('un archivo que no es visible para la inscripción responde 404', async () => {
    assert.equal((await bob.request('GET', url(ids.guide!, 'file'))).statusCode, 404);
    assert.equal((await alice.request('GET', url(ids.hidden!, 'file'))).statusCode, 404);
    assert.equal((await bob.request('GET', url(ids.guide!, 'preview'))).statusCode, 404);
  });

  test('sin copia local y sin sesión de Blackboard: 503 claro, sin inventar nada', async () => {
    const response = await alice.request('GET', url(ids.uncached!, 'file'));
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'files_unavailable');
  });

  test('vista previa de Word, PowerPoint y Excel desde la copia local', async () => {
    const word = (await alice.request('GET', url(ids.guide!, 'preview'))).json();
    assert.equal(word.preview.kind, 'docx');
    assert.match(word.preview.html, /Guía de actividad/);
    const slides = (await alice.request('GET', url(ids.slides!, 'preview'))).json();
    assert.equal(slides.preview.slides.length, 2);
    const sheet = (await alice.request('GET', url(ids.sheet!, 'preview'))).json();
    assert.equal(sheet.preview.sheets[0].rows[1][1], '9.5');
  });

  test('las guías de una actividad son los archivos de su misma carpeta que la inscripción puede ver', async () => {
    const detail = (await alice.request('GET', `/api/v1/activities/${ids.grade}`)).json();
    assert.deepEqual(detail.guides.map((g: { title: string }) => g.title).sort(), ['Diapositivas', 'Guía de actividad', 'Notas', 'Sin copia']);
    assert.equal((await bob.request('GET', `/api/v1/activities/${ids.grade}`)).statusCode, 404);
  });

  test('marcar como revisado: queda pendiente, se puede quitar y no cruza usuarios', async () => {
    const mark = await alice.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: true });
    assert.equal(mark.statusCode, 200);
    assert.equal(mark.json().review.state, 'pending');
    assert.equal((await alice.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: true })).json().review.state, 'pending', 'idempotente');
    assert.equal((await bob.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: true })).statusCode, 404);
    const content = (await alice.request('GET', `/api/v1/courses/${ids.course}/content`)).json().items;
    assert.equal(content.find((i: { id: string }) => i.id === ids.guide).review.state, 'pending');
    assert.equal(content.find((i: { id: string }) => i.id === ids.guide).file.name, 'Guía.docx');
    assert.equal((await alice.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: false })).json().review, null);
  });

  test('el envío: solo lo pendiente, una vez, sin duplicar y respetando lo que Blackboard ya muestra completado', async () => {
    await alice.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: true });
    await alice.request('PUT', url(ids.slides!, 'reviewed'), { reviewed: true });
    await ctx.db.query(`UPDATE enrollment_content_visibility SET completion = '{"total":1,"started":1,"completed":1}'::jsonb WHERE enrollment_id = $1 AND content_item_id = $2`, [ids.enA, ids.slides]);
    const calls: string[] = [];
    const summary = await dispatchReviewMarks(ctx.db, ids.eaA!, async (course, content, reviewed) => { calls.push(`${course}/${content}/${reviewed}`); return { status: 200 }; });
    assert.deepEqual(calls, ['_200_1/_g1/true']);
    assert.deepEqual(summary, { sent: 1, alreadyCompleted: 1, failed: 0, retry: 0 });
    const again = await dispatchReviewMarks(ctx.db, ids.eaA!, async () => { throw new Error('no debe volver a enviarse'); });
    assert.deepEqual(again, { sent: 0, alreadyCompleted: 0, failed: 0, retry: 0 });
    const rows = (await ctx.db.query(`SELECT state, already_completed FROM content_review_marks ORDER BY content_item_id`)).rows;
    assert.ok(rows.every((row) => row.state === 'sent'));
    const undo = await alice.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: false });
    assert.equal(undo.statusCode, 409);
    assert.equal(undo.json().error.code, 'review_already_sent');
  });

  test('si Blackboard rechaza la marca se reintenta y al tercer intento queda como fallida', async () => {
    await alice.request('PUT', url(ids.sheet!, 'reviewed'), { reviewed: true });
    const reject = async () => ({ status: 403 });
    assert.deepEqual(await dispatchReviewMarks(ctx.db, ids.eaA!, reject), { sent: 0, alreadyCompleted: 0, failed: 0, retry: 1 });
    assert.deepEqual(await dispatchReviewMarks(ctx.db, ids.eaA!, reject), { sent: 0, alreadyCompleted: 0, failed: 0, retry: 1 });
    assert.deepEqual(await dispatchReviewMarks(ctx.db, ids.eaA!, reject), { sent: 0, alreadyCompleted: 0, failed: 1, retry: 0 });
    const row = (await ctx.db.query(`SELECT state, last_error_code, attempts FROM content_review_marks WHERE content_item_id = $1`, [ids.sheet])).rows[0];
    assert.deepEqual(row, { state: 'failed', last_error_code: 'http_403', attempts: 3 });
    // El estudiante puede volver a marcarla: vuelve a pendiente con 0 intentos.
    assert.equal((await alice.request('PUT', url(ids.sheet!, 'reviewed'), { reviewed: true })).json().review.state, 'pending');
  });

  test('al presionar el botón con sesión disponible, la marca se envía en el momento; si Blackboard la rechaza, queda pendiente para la actualización', async () => {
    const calls: string[] = [];
    let status = 200;
    const fake = {
      acquire: async () => ({ markReviewed: async (course: string, content: string, reviewed: boolean) => { calls.push(`${course}/${content}/${reviewed}`); return { status }; }, dispose() {} }),
      drop() {}, closeAll() {},
    } as unknown as BlackboardSessions;
    const app = await buildApp({ config: ctx.config, db: ctx.db, logger: false, blackboardSessions: fake });
    const live = new TestClient(app, ctx.config.frontendOrigin);
    await live.request('POST', '/api/v1/auth/login', { identifier: 'alice@test.invalid', password: PASSWORD });
    try {
      await ctx.db.query('DELETE FROM content_review_marks');
      const sent = (await live.request('PUT', url(ids.guide!, 'reviewed'), { reviewed: true })).json().review;
      assert.deepEqual([sent.state, sent.sendFailed], ['sent', false]);
      assert.deepEqual(calls, ['_200_1/_g1/true']);
      await ctx.db.query('UPDATE enrollment_content_visibility SET completion = NULL WHERE enrollment_id = $1 AND content_item_id = $2', [ids.enA, ids.slides]);
      status = 403;
      const rejected = (await live.request('PUT', url(ids.slides!, 'reviewed'), { reviewed: true })).json().review;
      assert.deepEqual([rejected.state, rejected.sendFailed], ['pending', true]);
      const row = (await ctx.db.query('SELECT attempts, last_error_code FROM content_review_marks WHERE content_item_id = $1', [ids.slides])).rows[0];
      assert.deepEqual(row, { attempts: 0, last_error_code: 'http_403' }, 'un fallo inmediato no gasta intentos');
      // Si UTEC ya lo tenía completado, no se envía nada.
      await ctx.db.query(`UPDATE enrollment_content_visibility SET completion = '{"total":1,"started":1,"completed":1}'::jsonb WHERE enrollment_id = $1 AND content_item_id = $2`, [ids.enA, ids.sheet]);
      calls.length = 0;
      const done = (await live.request('PUT', url(ids.sheet!, 'reviewed'), { reviewed: true })).json().review;
      assert.deepEqual([done.state, done.alreadyCompleted], ['sent', true]);
      assert.deepEqual(calls, []);
    } finally {
      await app.close();
    }
  });
});
