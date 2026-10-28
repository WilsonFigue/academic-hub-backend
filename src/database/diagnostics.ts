import type { Database } from './connection.js';

export interface DbDiagnostics {
  selectOne: boolean;
  serverVersion: string;
  serverVersionNum: number;
  isPostgres18OrNewer: boolean;
  database: string;
  schema: string;
  schemaExists: boolean;
  schemaTableCount: number;
  uuidv7Available: boolean;
  privileges: {
    connect: boolean;
    createSchemaInDatabase: boolean;
    createInSchema: boolean | null;
    usageOnSchema: boolean | null;
  };
}

/** Comprobación real de la base. No devuelve usuario, host ni cadena de conexión. */
export async function runDiagnostics(db: Database): Promise<DbDiagnostics> {
  const one = await db.query<{ one: number }>('SELECT 1 AS one');
  const info = await db.query<{ version: string; version_num: string; database: string }>(
    `SELECT current_setting('server_version') AS version,
            current_setting('server_version_num') AS version_num,
            current_database() AS database`,
  );
  const schema = await db.query<{ exists: boolean; tables: string }>(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists,
            (SELECT count(*) FROM information_schema.tables WHERE table_schema = $1)::text AS tables`,
    [db.schema],
  );
  const schemaExists = Boolean(schema.rows[0]?.exists);
  const privileges = await db.query<{ connect: boolean; create_db: boolean; create_schema: boolean | null; usage_schema: boolean | null }>(
    `SELECT has_database_privilege(current_database(), 'CONNECT') AS connect,
            has_database_privilege(current_database(), 'CREATE') AS create_db,
            CASE WHEN $2 THEN has_schema_privilege($1, 'CREATE') END AS create_schema,
            CASE WHEN $2 THEN has_schema_privilege($1, 'USAGE') END AS usage_schema`,
    [db.schema, schemaExists],
  );
  const uuid = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') AS ok`,
  );
  const versionNum = Number(info.rows[0]?.version_num ?? 0);
  const row = privileges.rows[0];
  return {
    selectOne: one.rows[0]?.one === 1,
    serverVersion: info.rows[0]?.version ?? 'desconocida',
    serverVersionNum: versionNum,
    isPostgres18OrNewer: versionNum >= 180000,
    database: info.rows[0]?.database ?? 'desconocida',
    schema: db.schema,
    schemaExists,
    schemaTableCount: Number(schema.rows[0]?.tables ?? 0),
    uuidv7Available: Boolean(uuid.rows[0]?.ok),
    privileges: {
      connect: Boolean(row?.connect),
      createSchemaInDatabase: Boolean(row?.create_db),
      createInSchema: row?.create_schema ?? null,
      usageOnSchema: row?.usage_schema ?? null,
    },
  };
}
