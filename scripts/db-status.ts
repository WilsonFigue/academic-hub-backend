import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { DatabaseError, createDatabase } from '../src/database/connection.js';
import { migrationStatus } from '../src/database/migrator.js';

const useTestDb = process.argv.includes('--test-db');

async function main(): Promise<void> {
  const config = readConfig();
  const db = createDatabase(config, requireDatabaseUrl(config, useTestDb ? 'TEST_DATABASE_URL' : 'DATABASE_URL'), { max: 1 });
  try {
    const status = await migrationStatus(db);
    if (status.length === 0) console.log('No existen archivos de migración.');
    for (const item of status) {
      const when = item.appliedAt ? ` (${item.appliedAt.toISOString()})` : '';
      console.log(`${item.state.padEnd(18)} ${item.version}_${item.name}${when}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else if (error instanceof DatabaseError) console.error(`Error de base de datos [${error.kind}${error.code ? ` ${error.code}` : ''}]: ${error.message}`);
  else console.error('Error inesperado al consultar el estado.');
  process.exitCode = 1;
});
