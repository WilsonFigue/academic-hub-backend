// Sondeo de SOLO LECTURA: qué endpoints de Blackboard devuelven datos reales en UTEC para las materias del estudiante.
// Usa las credenciales recordadas (sin ventana), hace únicamente GET y NO guarda ni imprime el contenido: solo el estado HTTP,
// cuántos elementos llegaron y los nombres de los campos. No toca datos de otros usuarios (no pide listas de miembros).
// Uso: npx tsx scripts/probe-endpoints.ts
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { BlackboardSessions } from '../src/modules/files/sessions.js';
import { UTEC } from '../src/modules/import/import.service.js';

const config = readConfig();
if (!config.credentialsKey) { console.error('Falta CREDENTIALS_KEY en .env.'); process.exit(1); }
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 2 });
const sessions = new BlackboardSessions({ db, key: config.credentialsKey, baseUrl: UTEC.lmsBaseUrl });

const V1 = '/learn/api/v1';
const COURSE: Array<[string, string]> = [
  ['asistencia (registros)', '/attendanceRecords'],
  ['asistencia (columna de notas)', '/attendance/gradebook'],
  ['horario de la materia', '/schedule'],
  ['reuniones / clases en vivo', '/meetings'],
  ['foros: cantidades', '/discussionboards/count'],
  ['foros: lista', '/discussionboards/default/forums'],
  ['conversaciones del curso', '/conversations'],
  ['anuncios: contadores', '/announcements/counts'],
  ['notas sin leer', '/gradebook/unreadGradesCount'],
  ['nota final (columna)', '/gradebook/columns/finalGrade'],
  ['ajustes de calificaciones', '/gradebook/settings'],
  ['indicadores de contenido', '/contents/indicators'],
  ['grupos', '/groups'],
  ['herramientas habilitadas', '/tools'],
  ['cantidad de miembros', '/memberships/count'],
];
const GLOBAL: Array<[string, string]> = [
  ['flujo de actividad (stream)', `${V1}/streams/ultra`],
  ['resumen de mensajes', `${V1}/messages/summary`],
  ['conversaciones: contadores', `${V1}/courses/conversations/counts`],
  ['calendarios del usuario', `${V1}/calendars`],
];

/** Resume una respuesta sin exponer su contenido. */
function shape(body: unknown): string {
  if (Array.isArray(body)) return `lista de ${body.length}`;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.results)) return `${record.results.length} resultado(s)${record.results[0] && typeof record.results[0] === 'object' ? ` · campos: ${Object.keys(record.results[0] as object).slice(0, 8).join(', ')}` : ''}`;
    const keys = Object.keys(record);
    return keys.length === 0 ? 'vacío' : `campos: ${keys.slice(0, 8).join(', ')}`;
  }
  return body === undefined || body === null || body === '' ? 'vacío' : typeof body;
}

const table: Record<string, string[]> = {};
const note = (name: string, text: string) => { (table[name] ??= []).push(text); };

try {
  const accounts = await db.query<{ id: string; username: string }>(
    `SELECT ea.id, u.username FROM account_credentials ac JOIN external_accounts ea ON ea.id = ac.external_account_id AND ea.link_status = 'active'
       JOIN users u ON u.id = ea.user_id ORDER BY u.created_at`);
  for (const account of accounts.rows) {
    const session = await sessions.acquire(account.id);
    const courses = await db.query<{ external_id: string; name: string }>(
      `SELECT c.external_id, c.name FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.external_account_id = $1 AND ce.status = 'active' ORDER BY c.name`, [account.id]);
    console.log(`\n== ${account.username}: ${courses.rows.length} materias`);
    for (const [name, path] of GLOBAL) {
      const response = await session.transport.get(path).catch(() => ({ status: 0, body: null }));
      note(`[global] ${name}`, `${account.username}: HTTP ${response.status} · ${shape(response.body)}`);
    }
    for (const course of courses.rows) {
      for (const [name, suffix] of COURSE) {
        const response = await session.transport.get(`${V1}/courses/${encodeURIComponent(course.external_id)}${suffix}`).catch(() => ({ status: 0, body: null }));
        note(name, `${course.name.slice(0, 18)}: HTTP ${response.status} · ${shape(response.body)}`);
      }
    }
  }
  console.log('\n===== RESULTADO (estado HTTP y forma de la respuesta; sin contenido) =====');
  for (const [name, rows] of Object.entries(table)) {
    const statuses = new Map<string, number>();
    for (const row of rows) { const status = /HTTP (\d+)/.exec(row)?.[1] ?? '?'; statuses.set(status, (statuses.get(status) ?? 0) + 1); }
    console.log(`\n${name}  →  ${[...statuses].map(([s, n]) => `${s} ×${n}`).join(', ')}`);
    for (const row of rows.slice(0, 3)) console.log(`   ${row}`);
  }
} finally {
  sessions.closeAll();
  await db.close?.();
}
