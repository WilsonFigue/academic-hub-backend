import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { DatabaseError, createDatabase } from '../src/database/connection.js';
import { runDiagnostics } from '../src/database/diagnostics.js';
import { MigrationSafetyError, migrate } from '../src/database/migrator.js';

const useTestDb = process.argv.includes('--test-db');

async function main(): Promise<void> {
  const config = readConfig();
  const db = createDatabase(config, requireDatabaseUrl(config, useTestDb ? 'TEST_DATABASE_URL' : 'DATABASE_URL'), { max: 2 });
  try {
    const diagnostics = await runDiagnostics(db);
    if (!diagnostics.isPostgres18OrNewer) throw new MigrationSafetyError(`Se requiere PostgreSQL 18; el servidor es ${diagnostics.serverVersion}.`);
    const applied = await migrate(db);
    if (applied.length === 0) console.log('No hay migraciones pendientes.');
    else for (const name of applied) console.log(`Aplicada: ${name}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof MigrationSafetyError) console.error(error.message);
  else if (error instanceof DatabaseError) console.error(`Error de base de datos [${error.kind}${error.code ? ` ${error.code}` : ''}]: ${error.message}`);
  else console.error('Error inesperado durante la migración.');
  process.exitCode = 1;
});
