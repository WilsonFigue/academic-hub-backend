import { ConfigError, readConfig, requireDatabaseUrl } from '../src/config/env.js';
import { DatabaseError, createDatabase } from '../src/database/connection.js';

// Uso: npm run db:create -- <nombre>   Crea una base vacía en el mismo servidor. Nunca borra ni modifica bases existentes.
const name = process.argv[2] ?? '';

async function main(): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new ConfigError(['Indica un nombre de base válido (a-z, 0-9, _).']);
  const config = readConfig();
  const db = createDatabase(config, requireDatabaseUrl(config), { max: 1 });
  try {
    const role = await db.query<{ can: boolean }>('SELECT rolcreatedb OR rolsuper AS can FROM pg_roles WHERE rolname = current_user');
    const exists = await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) { console.log(`La base "${name}" ya existe; no se modificó.`); return; }
    if (!role.rows[0]?.can) throw new ConfigError(['El usuario de base de datos no tiene permiso CREATEDB.']);
    await db.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
    console.log(`Base "${name}" creada.`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else if (error instanceof DatabaseError) console.error(`Error de base de datos [${error.kind}${error.code ? ` ${error.code}` : ''}]: ${error.message}`);
  else console.error('Error inesperado al crear la base.');
  process.exitCode = 1;
});
