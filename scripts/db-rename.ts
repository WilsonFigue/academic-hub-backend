import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { DatabaseError, createDatabase } from '../src/database/connection.js';

// Uso: DB_NAME=<base de mantenimiento> npm run db:rename -- <actual> <nuevo>
// Renombra una base; se conecta desde otra base porque PostgreSQL no permite renombrar la base en uso.
const [from = '', to = ''] = process.argv.slice(2);
const valid = (name: string) => /^[a-z_][a-z0-9_]{0,62}$/.test(name);

async function main(): Promise<void> {
  if (!valid(from) || !valid(to)) throw new ConfigError(['Uso: npm run db:rename -- <actual> <nuevo>']);
  const config = readConfig();
  const db = createDatabase(config, requireDatabaseUrl(config), { max: 1 });
  try {
    const current = await db.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name === from) throw new ConfigError(['Conéctate desde otra base (DB_NAME distinto de la que se renombra).']);
    if ((await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [to])).rowCount) throw new ConfigError([`La base "${to}" ya existe.`]);
    if (!(await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [from])).rowCount) throw new ConfigError([`La base "${from}" no existe.`]);
    await db.query(`ALTER DATABASE "${from}" RENAME TO "${to}"`);
    console.log(`Base "${from}" renombrada a "${to}".`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else if (error instanceof DatabaseError) console.error(`Error de base de datos [${error.kind}${error.code ? ` ${error.code}` : ''}]: ${error.message}`);
  else console.error('Error inesperado al renombrar la base.');
  process.exitCode = 1;
});
