// Genera (o simula) la guía de estudio de UNA actividad.
// Uso:  npx tsx scripts/study-guide.ts --user rudy.figueroa --activity "circunferencia" --dry    (prueba en seco: no llama a OpenAI)
//       npx tsx scripts/study-guide.ts --user rudy.figueroa --activity "circunferencia"          (genera de verdad y guarda la guía)
// La prueba en seco arma el material, muestra qué archivos se enviarían y escribe el texto exacto en .state/guides-dry/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { createFileStore } from '../src/modules/files/store.js';
import { BlackboardSessions } from '../src/modules/files/sessions.js';
import { DEFAULT_POLICY, monthlySpend, processQueue, requestGuide } from '../src/modules/guides/guides.js';
import { SYSTEM_PROMPT, createOpenAIGenerator } from '../src/modules/guides/openai.js';
import { UTEC } from '../src/modules/import/import.service.js';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const dry = process.argv.includes('--dry');
const username = arg('user'); const needle = arg('activity');
if (!username || !needle) { console.error('Indica --user y --activity (parte del nombre).'); process.exit(1); }

const config = readConfig();
if (!config.openaiApiKey) { console.error('Falta OPENAI_API_KEY en .env.'); process.exit(1); }
const db = createDatabase(config, requireDatabaseUrl(config, 'DATABASE_URL'), { max: 2 });
const sessions = config.credentialsKey ? new BlackboardSessions({ db, key: config.credentialsKey, baseUrl: UTEC.lmsBaseUrl, visible: config.scheduledLoginVisible }) : null;
const generator = createOpenAIGenerator({
  apiKey: config.openaiApiKey, model: config.openaiModel, priceInPerM: config.openaiPriceInPerM, priceOutPerM: config.openaiPriceOutPerM,
  maxInputChars: config.studyGuideMaxInputChars, db, store: createFileStore(sessions),
});
const policy = { ...DEFAULT_POLICY, monthlyCapUsd: config.studyGuideMonthlyCapUsd, maxPerRun: config.studyGuideMaxPerRun };

try {
  const found = await db.query<{ user_id: string; activity_id: string; enrollment_id: string; course_id: string; column_id: string; name: string; course: string }>(
    `SELECT u.id AS user_id, sg.id AS activity_id, sg.enrollment_id, sg.course_id, sg.gradebook_column_id AS column_id, gc.name, c.name AS course
       FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id JOIN course_enrollments ce ON ce.id = sg.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id JOIN users u ON u.id = ea.user_id JOIN courses c ON c.id = sg.course_id
      WHERE u.username = $1 AND gc.name ILIKE $2 AND NOT gc.is_calculated`, [username, `%${needle}%`]);
  if (found.rows.length !== 1) { console.error(found.rows.length === 0 ? 'No encontré esa actividad.' : `Hay ${found.rows.length} actividades que coinciden; sé más específico.`); process.exit(1); }
  const row = found.rows[0]!;
  console.log(`Actividad: «${row.name}» · ${row.course}`);
  console.log(`Modelo: ${config.openaiModel} · precios configurados: $${config.openaiPriceInPerM} entrada / $${config.openaiPriceOutPerM} salida por millón de tokens\n`);

  if (dry) {
    const plan = await generator.describe({ guideId: 'dry-run', enrollmentId: row.enrollment_id, courseId: row.course_id, gradebookColumnId: row.column_id });
    console.log('MATERIAL QUE SE ENVIARÍA:');
    console.table(plan.material.docs.map((doc) => ({ documento: doc.title.slice(0, 52), rol: doc.role, caracteres: doc.chars, recortado: doc.truncated })));
    if (plan.material.skipped.length > 0) { console.log('Descartados:'); console.table(plan.material.skipped); }
    console.log(`Total: ${plan.material.totalChars} caracteres de material · ~${plan.estimatedInputTokens} tokens de entrada · costo estimado ≈ $${plan.estimatedCostUsd.toFixed(4)}`);
    const dir = join(process.cwd(), '.state', 'guides-dry'); mkdirSync(dir, { recursive: true });
    const file = join(dir, `${row.activity_id}.txt`);
    writeFileSync(file, `### INSTRUCCIONES DEL SISTEMA\n${SYSTEM_PROMPT}\n\n### MENSAJE CON EL MATERIAL\n${plan.prompt}\n`, { mode: 0o600 });
    console.log(`\nTexto exacto que se enviaría: ${file}\n(No se llamó a OpenAI.)`);
  } else {
    const spend = await monthlySpend(db);
    console.log(`Gasto de guías este mes antes de empezar: $${spend.spent.toFixed(4)} (tope $${policy.monthlyCapUsd})`);
    const guide = await requestGuide(db, row.user_id, row.activity_id);
    console.log(`Solicitud registrada (${guide.status}). Generando…`);
    const result = await processQueue(db, generator, policy, { limit: 1 });
    const final = await db.query<{ status: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: string | null; error_code: string | null; content: unknown }>(
      `SELECT status, model, input_tokens, output_tokens, cost_usd, error_code, content FROM study_guides WHERE id = $1`, [guide.id]);
    const g = final.rows[0]!;
    console.log(`Resultado: ${g.status}${g.error_code ? ` (${g.error_code})` : ''} · cola: ${JSON.stringify(result)}`);
    if (g.status === 'ready') {
      console.log(`Modelo usado: ${g.model} · tokens: ${g.input_tokens} de entrada, ${g.output_tokens} de salida · COSTO REAL ≈ $${Number(g.cost_usd).toFixed(5)}`);
      console.log('\n──────── GUÍA ────────');
      const content = g.content as { summary: string; sections: Array<{ heading: string; body: string; bullets?: string[] }>; sources: Array<{ file: string; note?: string }> };
      console.log(content.summary + '\n');
      for (const section of content.sections) {
        console.log(`## ${section.heading}`);
        if (section.body) console.log(section.body);
        for (const bullet of section.bullets ?? []) console.log(`  • ${bullet}`);
        console.log('');
      }
      console.log('Fuentes: ' + content.sources.map((source) => source.file).join(' | '));
    }
  }
} finally {
  sessions?.closeAll();
  await db.close?.();
}
