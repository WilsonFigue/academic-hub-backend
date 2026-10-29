// Enciende las guías de estudio automáticas de las materias indicadas para cada estudiante y apaga las demás.
// Uso: npx tsx scripts/study-guide-config.ts            (aplica la configuración de abajo)
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { listSettings, setEnabled } from '../src/modules/guides/guides.js';

// Por estudiante: partes del nombre de las materias que SÍ quieren guías automáticas.
const WANTED: Record<string, string[]> = {
  'rudy.figueroa': ['filosof', 'matem'],
  'erick.figueroa': ['f_sica', 'organiz'],
};
const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const config = readConfig();
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 2 });
try {
  for (const [username, wanted] of Object.entries(WANTED)) {
    const user = await db.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
    if (!user.rows[0]) { console.error(`No existe ${username}.`); continue; }
    const courses = await listSettings(db, user.rows[0].id) as Array<{ courseId: string; name: string }>;
    for (const course of courses) {
      const on = wanted.some((part) => new RegExp(part.replace('_', '.')).test(normalize(course.name)));
      await setEnabled(db, user.rows[0].id, course.courseId, on);
    }
    const after = await listSettings(db, user.rows[0].id) as Array<{ name: string; enabled: boolean }>;
    console.log(`\n${username}`);
    console.table(after.map((course) => ({ materia: course.name.slice(0, 40), 'guías automáticas': course.enabled ? 'ENCENDIDO' : 'apagado' })));
  }
} finally { await db.close?.(); }
