import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { DatabaseError, createDatabase } from '../src/database/connection.js';
import { runDiagnostics } from '../src/database/diagnostics.js';

const useTestDb = process.argv.includes('--test-db');

async function main(): Promise<number> {
  const config = readConfig();
  const url = requireDatabaseUrl(config, useTestDb ? 'TEST_DATABASE_URL' : 'DATABASE_URL');
  const db = createDatabase(config, url, { max: 1 });
  try {
    const d = await runDiagnostics(db);
    const mark = (ok: boolean | null) => (ok === null ? '—' : ok ? 'OK' : 'NO');
    console.log(`Conexión ............................ OK`);
    console.log(`SELECT 1 ............................ ${mark(d.selectOne)}`);
    console.log(`Versión del servidor ................ PostgreSQL ${d.serverVersion}`);
    console.log(`PostgreSQL 18 o superior ............ ${mark(d.isPostgres18OrNewer)}`);
    console.log(`uuidv7() disponible ................. ${mark(d.uuidv7Available)}`);
    console.log(`Base seleccionada ................... ${d.database}`);
    console.log(`Esquema de trabajo .................. ${d.schema} (${d.schemaExists ? `existe, ${d.schemaTableCount} tablas` : 'aún no existe'})`);
    console.log(`Privilegio CONNECT .................. ${mark(d.privileges.connect)}`);
    console.log(`Puede crear esquemas en la base ..... ${mark(d.privileges.createSchemaInDatabase)}`);
    console.log(`USAGE en el esquema ................. ${mark(d.privileges.usageOnSchema)}`);
    console.log(`CREATE en el esquema ................ ${mark(d.privileges.createInSchema)}`);

    const problems: string[] = [];
    if (!d.isPostgres18OrNewer) problems.push('Se requiere PostgreSQL 18 o superior.');
    if (!d.uuidv7Available) problems.push('uuidv7() no está disponible.');
    const canCreate = d.schemaExists ? d.privileges.createInSchema : d.privileges.createSchemaInDatabase;
    if (!canCreate) problems.push(`El usuario no puede crear objetos en el esquema "${d.schema}".`);
    if (problems.length > 0) {
      console.error(`\nComprobación fallida:\n- ${problems.join('\n- ')}`);
      return 1;
    }
    console.log('\nResultado: la base cumple los requisitos de Academic Hub.');
    return 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) console.error(error.message);
    else if (error instanceof DatabaseError) console.error(`Error de base de datos [${error.kind}${error.code ? ` ${error.code}` : ''}]: ${error.message}`);
    else console.error('Error inesperado durante la comprobación.');
    process.exitCode = 1;
  });
