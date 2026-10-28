import { readConfig } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';

// Resumen de la última sincronización: estados, pasos incompletos y conteos. Sin datos personales.
const config = readConfig();
const db = createDatabase(config, config.databaseUrl!, { max: 1 });
const run = await db.query(`SELECT id, status, error_code, started_at, finished_at, stats->'academicData' AS data FROM sync_runs ORDER BY started_at DESC LIMIT 1`);
console.log(JSON.stringify(run.rows[0] ?? null, null, 1));
if (run.rows[0]) {
  const steps = await db.query(
    `SELECT resource, status, count(*)::int AS n, sum(items)::int AS items, bool_and(complete) AS all_complete,
            string_agg(DISTINCT error_code, ',') AS errors, jsonb_agg(DISTINCT http_status_counts) AS http
       FROM sync_run_steps WHERE sync_run_id = $1 GROUP BY resource, status ORDER BY resource`, [run.rows[0].id]);
  console.table(steps.rows.map((r) => ({ ...r, http: JSON.stringify(r.http) })));
}
const totals = await db.query(`SELECT
  (SELECT count(*) FROM users)::int users, (SELECT count(*) FROM external_accounts)::int accounts,
  (SELECT count(*) FROM academic_terms)::int terms, (SELECT count(*) FROM courses)::int courses,
  (SELECT count(*) FROM course_enrollments)::int enrollments, (SELECT count(*) FROM course_content_items)::int content,
  (SELECT count(*) FROM course_content_items WHERE parent_id IS NOT NULL)::int content_with_parent,
  (SELECT count(*) FROM gradebook_columns)::int columns, (SELECT count(*) FROM gradebook_columns WHERE content_item_id IS NOT NULL)::int columns_linked,
  (SELECT count(*) FROM student_grades)::int grade_rows, (SELECT count(*) FROM grade_attempts)::int attempts,
  (SELECT count(*) FROM calendar_items)::int calendar, (SELECT count(*) FROM calendar_items WHERE gradebook_column_id IS NOT NULL)::int calendar_linked,
  (SELECT count(*) FROM course_announcements)::int announcements, (SELECT count(*) FROM todo_observations)::int todo,
  (SELECT count(*) FROM due_date_exceptions)::int exceptions,
  (SELECT bool_and(must_change_password) FROM users)::boolean must_change`);
console.log(totals.rows[0]);
await db.close();
