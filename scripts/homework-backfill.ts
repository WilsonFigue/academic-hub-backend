// Pasa a la base de datos los archivos de tareas listas que solo existen en disco (.state/homework). Es seguro repetirlo.
import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { createDatabase } from '../src/database/connection.js';
import { backfillHomeworkFiles } from '../src/modules/homework/homework.js';

async function main(): Promise<void> {
  const config = readConfig();
  const db = createDatabase(config, requireDatabaseUrl(config), { max: 2 });
  try {
    const result = await backfillHomeworkFiles(db);
    console.log(`Tareas revisadas: ${result.runs} · archivos guardados en la base: ${result.files} · listados sin archivo disponible: ${result.missing}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : 'No fue posible pasar los archivos a la base de datos.');
  process.exitCode = 1;
});
