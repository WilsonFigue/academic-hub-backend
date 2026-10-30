// Enciende o apaga la bandera de tareas con IA de una materia.
//   npm run homework:flag -- <usuario> <parte del nombre de la materia> on|off
//   npm run homework:flag -- status
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';

const [username, needle, state] = process.argv.slice(2);
const config = readConfig();
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 1 });
try {
  if (username === 'status') {
    const { rows } = await db.query(
      `SELECT u.username AS usuario, c.name AS materia, COALESCE(s.enabled, false) AS tareas_con_ia
         FROM course_enrollments ce JOIN external_accounts ea ON ea.id = ce.external_account_id JOIN users u ON u.id = ea.user_id JOIN courses c ON c.id = ce.course_id
         LEFT JOIN homework_settings s ON s.enrollment_id = ce.id WHERE ce.status = 'active' ORDER BY u.username, c.name`);
    console.table(rows);
  } else if (username && needle && (state === 'on' || state === 'off')) {
    const found = await db.query<{ id: string; name: string }>(
      `SELECT ce.id, c.name FROM course_enrollments ce JOIN external_accounts ea ON ea.id = ce.external_account_id JOIN users u ON u.id = ea.user_id JOIN courses c ON c.id = ce.course_id
        WHERE u.username = $1 AND c.name ILIKE $2 AND ce.status = 'active'`, [username, `%${needle}%`]);
    if (found.rows.length !== 1) { console.error(found.rows.length === 0 ? 'No encontré esa materia.' : `Hay ${found.rows.length} materias que coinciden; sé más específico.`); process.exitCode = 1; }
    else {
      await db.query(`INSERT INTO homework_settings (enrollment_id, enabled) VALUES ($1, $2) ON CONFLICT (enrollment_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [found.rows[0]!.id, state === 'on']);
      console.log(`${found.rows[0]!.name}: tareas con IA ${state === 'on' ? 'ACTIVADAS' : 'apagadas'} para ${username}.`);
    }
  } else { console.error('Uso: npm run homework:flag -- <usuario> <materia> on|off   |   npm run homework:flag -- status'); process.exitCode = 1; }
} finally { await db.close(); }
