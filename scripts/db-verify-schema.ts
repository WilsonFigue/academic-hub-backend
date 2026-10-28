import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';

// Verifica la estructura y prueba restricciones dentro de una transacción que SIEMPRE se revierte.
// No deja datos en la base.
const config = readConfig();
const db = createDatabase(config, requireDatabaseUrl(config), { max: 1 });
const schema = config.dbSchema;

const tables = await db.query<{ table_name: string; rows: string }>(
  `SELECT table_name,
          (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text AS rows
     FROM information_schema.tables
    WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    ORDER BY table_name`,
  [schema],
);
console.log(`Tablas (${tables.rowCount}):`);
for (const table of tables.rows) console.log(`  ${table.table_name.padEnd(32)} filas=${table.rows}`);

const counts = await db.query(
  `SELECT (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND contype = 'f')::int AS foreign_keys,
          (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND contype = 'u')::int AS unique_constraints,
          (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND contype = 'c')::int AS checks,
          (SELECT count(*) FROM pg_indexes WHERE schemaname = $1)::int AS indexes,
          (SELECT count(*) FROM information_schema.views WHERE table_schema = $1)::int AS views`,
  [schema],
);
console.log('Restricciones:', counts.rows[0]);

const results: Array<[string, boolean]> = [];
const ROLLBACK = Symbol('rollback');

await db
  .transaction(async (client) => {
    const id = async (sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows[0].id as string;
    const mustFail = async (label: string, sql: string, values: unknown[] = []) => {
      await client.query('SAVEPOINT probe');
      try {
        await client.query(sql, values);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        results.push([label, false]);
      } catch {
        results.push([label, true]);
      }
      await client.query('ROLLBACK TO SAVEPOINT probe');
    };

    const inst = await id(
      `INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode)
       VALUES ('ZZTEST', 'Prueba', 'blackboard_learn_ultra', 'https://x.invalid', 'America/El_Salvador', 'user_session') RETURNING id`,
    );
    const userA = await id(`INSERT INTO users (email, password_hash) VALUES ('a@x.invalid', 'h') RETURNING id`);
    const userB = await id(`INSERT INTO users (email, password_hash) VALUES ('b@x.invalid', 'h') RETURNING id`);
    await mustFail('email duplicado sin distinguir mayúsculas', `INSERT INTO users (email, password_hash) VALUES ('A@X.invalid', 'h')`);

    const accountA = await id(
      `INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now()) RETURNING id`,
      [userA, inst],
    );
    const accountB = await id(
      `INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_2_1', 'active', now()) RETURNING id`,
      [userB, inst],
    );
    await mustFail('misma identidad Blackboard en dos usuarios',
      `INSERT INTO external_accounts (user_id, institution_id, lms_user_id, link_status, linked_at) VALUES ($1, $2, '_1_1', 'active', now())`, [userB, inst]);
    await mustFail('cuenta activa sin identidad verificada',
      `INSERT INTO external_accounts (user_id, institution_id, link_status) VALUES ($1, $2, 'active')`, [userB, inst]);

    const term = await id(`INSERT INTO academic_terms (institution_id, external_id, name) VALUES ($1, '_9_1', 'T') RETURNING id`, [inst]);
    const course1 = await id(
      `INSERT INTO courses (institution_id, external_id, name, term_id, term_external_id) VALUES ($1, '_10_1', 'C1', $2, '_9_1') RETURNING id`, [inst, term]);
    const course2 = await id(`INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_11_1', 'C2') RETURNING id`, [inst]);
    await mustFail('materia duplicada por ID externo', `INSERT INTO courses (institution_id, external_id, name) VALUES ($1, '_10_1', 'Otro nombre')`, [inst]);

    const enrollmentA = await id(
      `INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m1') RETURNING id`,
      [accountA, inst, course1]);
    await client.query(
      `INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m2')`, [accountB, inst, course1]);
    results.push(['dos estudiantes inscritos en la misma materia', true]);
    await mustFail('inscripción duplicada',
      `INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id) VALUES ($1, $2, $3, '_m3')`, [accountA, inst, course1]);

    const column1 = await id(`INSERT INTO gradebook_columns (course_id, external_id, name) VALUES ($1, '_c1', 'Tarea') RETURNING id`, [course1]);
    const column2 = await id(`INSERT INTO gradebook_columns (course_id, external_id, name) VALUES ($1, '_c2', 'Otra') RETURNING id`, [course2]);
    await client.query(`INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [enrollmentA, course1, column1]);
    await mustFail('nota duplicada (inscripción + columna)',
      `INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [enrollmentA, course1, column1]);
    await mustFail('nota con columna de otra materia',
      `INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id) VALUES ($1, $2, $3)`, [enrollmentA, course2, column2]);

    const node2 = await id(
      `INSERT INTO course_content_items (course_id, external_id, handler, title) VALUES ($1, '_n2', 'resource/x-bb-folder', 'F') RETURNING id`, [course2]);
    await mustFail('visibilidad de contenido de otra materia',
      `INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id) VALUES ($1, $2, $3)`, [enrollmentA, node2, course2]);
    await mustFail('padre de contenido en otra materia',
      `INSERT INTO course_content_items (course_id, external_id, handler, title, parent_id) VALUES ($1, '_n3', 'x', 'x', $2)`, [course1, node2]);

    await client.query(
      `INSERT INTO calendar_items (institution_id, scope, course_id, source_type, source_external_id, gradebook_column_id, title)
       VALUES ($1, 'course', $2, 'blackboard.platform.gradebook2.GradableItem', '_c1', $3, 'Tarea')`, [inst, course1, column1]);
    await mustFail('evento de calendario duplicado con otro título',
      `INSERT INTO calendar_items (institution_id, scope, course_id, source_type, source_external_id, title)
       VALUES ($1, 'course', $2, 'blackboard.platform.gradebook2.GradableItem', '_c1', 'Otro título')`, [inst, course1]);

    const cycle = await id(
      `INSERT INTO evaluation_cycles (enrollment_id, number, confirmed_at, is_active) VALUES ($1, 1, now(), true) RETURNING id`, [enrollmentA]);
    await mustFail('dos ciclos activos en la misma inscripción',
      `INSERT INTO evaluation_cycles (enrollment_id, number, confirmed_at, is_active) VALUES ($1, 2, now(), true)`, [enrollmentA]);
    await mustFail('sugerencia activa sin confirmar',
      `INSERT INTO evaluation_cycles (enrollment_id, number, source, is_active) VALUES ($1, 3, 'formula_suggestion', true)`, [enrollmentA]);
    await mustFail('ciclo número 11', `INSERT INTO evaluation_cycles (enrollment_id, number, confirmed_at) VALUES ($1, 11, now())`, [enrollmentA]);
    await mustFail('ítem de ciclo con columna de otra materia',
      `INSERT INTO evaluation_cycle_items (cycle_id, enrollment_id, course_id, gradebook_column_id, confirmed_at) VALUES ($1, $2, $3, $4, now())`,
      [cycle, enrollmentA, course2, column2]);

    await client.query(`INSERT INTO sync_runs (external_account_id, trigger, adapter_version) VALUES ($1, 'manual', 't')`, [accountA]);
    await mustFail('dos sincronizaciones simultáneas',
      `INSERT INTO sync_runs (external_account_id, trigger, adapter_version) VALUES ($1, 'manual', 't')`, [accountA]);

    const view = await client.query(`SELECT count(*)::int AS n FROM student_terms WHERE external_account_id = $1`, [accountA]);
    results.push(['student_terms deriva el período desde la inscripción', view.rows[0].n === 1]);

    throw ROLLBACK;
  })
  .catch((error: unknown) => {
    if (error !== ROLLBACK) throw error;
  });

for (const [label, ok] of results) console.log(`${ok ? 'OK   ' : 'FALLA'} ${label}`);
const remaining = await db.query<{ n: string }>(`SELECT ((SELECT count(*) FROM users) + (SELECT count(*) FROM institutions))::text AS n`);
console.log(`Filas remanentes tras revertir: ${remaining.rows[0]?.n}`);
await db.close();
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
