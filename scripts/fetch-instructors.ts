// Trae el docente de cada materia desde Blackboard y lo guarda en courses.instructor_name. Solo lectura (GET).
// Pide la lista de participantes del curso, pero SOLO conserva a quienes tienen rol de docente: los demás se descartan en memoria
// (no se guardan, no se registran, no se muestran). Nunca pisa un docente que ya esté guardado.
//   npm run instructors -- rudy.figueroa erick.figueroa
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { BlackboardSessions } from '../src/modules/files/sessions.js';
import { UTEC } from '../src/modules/import/import.service.js';
import { restoreSurnameAccents } from '../src/shared/names.js';

const users = process.argv.slice(2);
if (users.length === 0) { console.error('Uso: npm run instructors -- <usuario> [<usuario> …]'); process.exit(1); }
const config = readConfig();
if (!config.credentialsKey) { console.error('Falta CREDENTIALS_KEY en .env.'); process.exit(1); }
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 2 });
const sessions = new BlackboardSessions({ db, key: config.credentialsKey, baseUrl: UTEC.lmsBaseUrl, visible: config.scheduledLoginVisible });

// En UTEC el rol se llama «P» (profesor); los estudiantes son «S». Otros roles (p. ej. «gestor») no cuentan como docente.
interface Membership { role?: string; user?: { givenName?: string; familyName?: string; preferredDisplayName?: string } }
const titleCase = (value: string) => value.trim().toLowerCase().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const fullName = (m: Membership) => restoreSurnameAccents(titleCase([m.user?.givenName, m.user?.familyName].filter(Boolean).join(' ') || m.user?.preferredDisplayName || ''));

try {
  for (const username of users) {
    const account = await db.query<{ id: string }>(`SELECT ea.id FROM external_accounts ea JOIN users u ON u.id = ea.user_id WHERE u.username = $1 AND ea.link_status <> 'revoked' LIMIT 1`, [username]);
    if (!account.rows[0]) { console.log(`${username}: no existe o no tiene cuenta vinculada.`); continue; }
    const courses = await db.query<{ id: string; external_id: string; name: string; instructor_name: string | null }>(
      `SELECT c.id, c.external_id, c.name, c.instructor_name FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.external_account_id = $1 AND ce.status = 'active' ORDER BY c.name`, [account.rows[0].id]);
    const session = await sessions.acquire(account.rows[0].id);
    for (const course of courses.rows) {
      if (course.instructor_name) { console.log(`${username} · ${course.name}: ya tiene docente (${course.instructor_name}).`); continue; }
      const found: string[] = []; let status = 0; let discarded = 0; const tried: string[] = [];
      // Rutas posibles del listado de participantes, de la más probable a la menos; se usa la primera que responda.
      const candidates = [
        { path: `/learn/api/v1/courses/${course.external_id}/memberships`, query: { expand: 'user', limit: '100' } },
        { path: `/learn/api/public/v1/courses/${course.external_id}/users`, query: { expand: 'user', limit: '100' } },
      ];
      for (const candidate of candidates) {
        let path: string | null = candidate.path; let query: Record<string, string> | undefined = candidate.query; let ok = false;
        for (let page = 0; page < 12 && path; page += 1) {
          const response = await session.transport.get(path, query); status = response.status;
          const body = response.body as { results?: Membership[]; paging?: { nextPage?: string } } | null;
          if (response.status !== 200 || !body) break;
          ok = true;
          for (const membership of body.results ?? []) {
            if (membership.role === 'P') { const name = fullName(membership); if (name && !found.includes(name)) found.push(name); } else discarded += 1;
          }
          const next = body.paging?.nextPage; path = next ? next.split('?')[0]! : null; query = next && next.includes('?') ? Object.fromEntries(new URLSearchParams(next.split('?')[1])) : undefined;
        }
        tried.push(`${candidate.path.replace(course.external_id, '{curso}')} → HTTP ${status}`);
        if (ok) break;
      }
      if (found.length === 0) { console.log(`${username} · ${course.name}: sin resultado (${tried.join(' | ')}; ${discarded} participantes descartados).`); continue; }
      await db.query(`UPDATE courses SET instructor_name = $2, instructor_set_at = now() WHERE id = $1 AND instructor_name IS NULL`, [course.id, found.join(' / ')]);
      console.log(`${username} · ${course.name}: docente → ${found.join(' / ')}  (${discarded} participantes descartados sin guardar)`);
    }
  }
} finally { sessions.closeAll(); await db.close(); }
