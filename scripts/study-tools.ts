// Estudio de SOLO LECTURA: qué herramientas y formatos de entrega piden las actividades de los estudiantes.
// Para cada actividad se lee su descripción en Blackboard y los archivos de su misma carpeta (guías), y se buscan herramientas por palabras.
// No usa IA y no escribe nada. Uso: npx tsx scripts/study-tools.ts
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { createFileStore } from '../src/modules/files/store.js';
import { BlackboardSessions } from '../src/modules/files/sessions.js';
import { fileText } from '../src/modules/guides/material.js';
import { DELIVERABLES, TOOLS, detectDeliverables, detectTools } from '../src/modules/guides/tools.js';
import { UTEC } from '../src/modules/import/import.service.js';

const config = readConfig();
if (!config.credentialsKey) { console.error('Falta CREDENTIALS_KEY.'); process.exit(1); }
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 2 });
const sessions = new BlackboardSessions({ db, key: config.credentialsKey, baseUrl: UTEC.lmsBaseUrl, visible: config.scheduledLoginVisible });
const store = createFileStore(sessions);
const short = (name: string) => name.replace(/\s+\d{2}\s+\d{2}-\d{4}$/, '').replace(/ SECCIÓN.*$/, '').slice(0, 26);

interface Row { snips: Record<string, string>; user: string; course: string; activity: string; texts: number; chars: number; tools: string[]; ownTools: string[]; deliverables: string[]; instructions: boolean }
const rows: Row[] = [];
try {
  const activities = await db.query<{ username: string; account_id: string; enrollment_id: string; course: string; name: string; col: string; body: string | null; parent: string | null; item_id: string | null }>(
    `SELECT u.username, ea.id AS account_id, sg.enrollment_id, c.name AS course, gc.name, gc.id AS col, ci.body_text AS body, ci.parent_external_id AS parent, ci.id AS item_id
       FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id JOIN external_accounts ea ON ea.id = ce.external_account_id JOIN users u ON u.id = ea.user_id
       JOIN courses c ON c.id = sg.course_id LEFT JOIN course_content_items ci ON ci.id = gc.content_item_id
      WHERE ce.status = 'active' AND NOT gc.is_calculated AND NOT gc.is_deleted_at_source AND gc.removed_at_source IS NULL AND sg.is_visible_to_student
      ORDER BY u.username, c.name, gc.name`);
  let done = 0;
  for (const a of activities.rows) {
    const own = `${a.name}\n${a.body ?? ''}`;
    let text = own; let texts = a.body ? 1 : 0;
    if (a.parent && a.item_id) {
      const files = await db.query<{ id: string; title: string; file: { fileName: string; mimeType: string; fileSize: number; permanentUrl?: string } | null; body: string | null }>(
        `SELECT f.id, f.title, f.content_detail->'file' AS file, f.body_text AS body
           FROM enrollment_content_visibility v JOIN course_content_items f ON f.id = v.content_item_id AND f.removed_at_source IS NULL
          WHERE v.enrollment_id = $1 AND v.missing_since IS NULL AND f.parent_external_id = $2 AND f.id <> $3
            AND ((f.handler = 'resource/x-bb-file' AND f.content_detail->'file' IS NOT NULL) OR (f.handler = 'resource/x-bb-document' AND length(COALESCE(f.body_text, '')) > 100))`,
        [a.enrollment_id, a.parent, a.item_id]);
      for (const f of files.rows) {
        if (f.file) {
          const read = await fileText(store, { id: f.id, accountId: a.account_id, file: f.file });
          if ('text' in read) { text += `\n${f.title}\n${read.text}`; texts += 1; }
        } else if (f.body) { text += `\n${f.body}`; texts += 1; }
      }
    }
    const snips: Record<string, string> = {};
    for (const tool of TOOLS) { const m = tool.pattern.exec(text); if (m) snips[tool.id] = text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).replace(/\s+/g, ' '); }
    rows.push({ snips, user: a.username, course: short(a.course), activity: a.name, texts, chars: text.length, tools: detectTools(text), ownTools: detectTools(own), deliverables: detectDeliverables(text), instructions: texts > 0 });
    done += 1; if (done % 10 === 0) console.error(`… ${done}/${activities.rows.length}`);
  }
} finally { sessions.closeAll(); await db.close?.(); }

console.log(`\nActividades analizadas: ${rows.length} · con descripción o guías legibles: ${rows.filter((r) => r.instructions).length} · sin ningún texto: ${rows.filter((r) => !r.instructions).length}`);
for (const user of [...new Set(rows.map((r) => r.user))]) {
  const mine = rows.filter((r) => r.user === user);
  console.log(`\n=========== ${user}: ${mine.length} actividades ===========`);
  const tally = (items: Array<{ id: string; label: string }>, pick: (r: Row) => string[]) => items.map((item) => {
    const hit = mine.filter((r) => pick(r).includes(item.id));
    const courses = [...new Set(hit.map((r) => r.course))];
    const direct = hit.filter((r) => r.ownTools.includes(item.id)).length;
    return { herramienta: item.label, actividades: hit.length, 'en su descripcion': direct, 'solo en guias de su carpeta': hit.length - direct, materias: courses.join(', ') };
  }).filter((x) => x.actividades > 0).sort((a, b) => b.actividades - a.actividades);
  console.log('HERRAMIENTAS que aparecen en sus actividades:'); console.table(tally(TOOLS, (r) => r.tools));
  console.log('FORMATOS DE ENTREGA / tipo de trabajo:'); console.table(tally(DELIVERABLES, (r) => r.deliverables));
  const byCourse = new Map<string, { n: number; text: number }>();
  for (const r of mine) { const x = byCourse.get(r.course) ?? { n: 0, text: 0 }; x.n += 1; if (r.instructions) x.text += 1; byCourse.set(r.course, x); }
  console.log('COBERTURA (actividades con texto legible):'); console.table([...byCourse].map(([course, x]) => ({ materia: course, actividades: x.n, 'con texto': x.text })));
  const geo = mine.filter((r) => r.tools.includes('geogebra')); if (geo.length) { console.log('Actividades que mencionan GeoGebra:'); console.table(geo.map((r) => ({ materia: r.course, actividad: r.activity }))); }
}

if (process.argv.includes('--context')) {
  console.log('\n===== CONTEXTO DE CADA COINCIDENCIA (primeras por herramienta) =====');
  const seen = new Map<string, number>();
  for (const r of rows) for (const id of r.tools) {
    const key = r.user + id; const n = seen.get(key) ?? 0; if (n >= 2) continue; seen.set(key, n + 1);
    console.log(`[${r.user.split('.')[0]}] ${id.padEnd(14)} ${r.course} · ${r.activity.slice(0, 30)} → «…${r.snips[id]}…»`);
  }
}
