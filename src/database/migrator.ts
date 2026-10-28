import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './connection.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Clave arbitraria y fija para pg_advisory_lock: impide dos migradores simultáneos.
const LOCK_KEY = 4_820_771_302;

export interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  state: 'applied' | 'pending' | 'checksum_mismatch';
  appliedAt: Date | null;
}

export class MigrationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationSafetyError';
  }
}

export function loadMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const versions = new Set<string>();
  return files.map((file) => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) throw new MigrationSafetyError(`Nombre de migración inválido: ${file} (esperado 0001_nombre.sql).`);
    const [, version, name] = match as unknown as [string, string, string];
    if (versions.has(version)) throw new MigrationSafetyError(`Versión de migración duplicada: ${version}.`);
    versions.add(version);
    const sql = readFileSync(join(dir, file), 'utf8');
    return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Se niega a operar sobre un esquema que ya contiene tablas ajenas: si existe el esquema,
 * tiene tablas y no tiene nuestro registro de migraciones, no es una base de Academic Hub.
 */
export async function assertSchemaIsOurs(db: Database): Promise<void> {
  const { rows } = await db.query<{ tables: string; has_registry: boolean }>(
    `SELECT count(*)::text AS tables,
            bool_or(table_name = 'schema_migrations') AS has_registry
       FROM information_schema.tables
      WHERE table_schema = $1`,
    [db.schema],
  );
  const tables = Number(rows[0]?.tables ?? 0);
  if (tables > 0 && !rows[0]?.has_registry) {
    throw new MigrationSafetyError(
      `El esquema "${db.schema}" ya contiene ${tables} tabla(s) sin registro de migraciones de Academic Hub. ` +
        'No se aplicará ninguna migración. Usa una base vacía o cambia DB_SCHEMA.',
    );
  }
}

async function ensureRegistry(db: Database): Promise<void> {
  const schema = quoteIdent(db.schema);
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
       version    text PRIMARY KEY,
       name       text NOT NULL,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedMigrations(db: Database): Promise<Map<string, { checksum: string; applied_at: Date }>> {
  const exists = await db.query<{ ok: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [`${quoteIdent(db.schema)}.schema_migrations`],
  );
  if (!exists.rows[0]?.ok) return new Map();
  const { rows } = await db.query<{ version: string; checksum: string; applied_at: Date }>(
    `SELECT version, checksum, applied_at FROM ${quoteIdent(db.schema)}.schema_migrations ORDER BY version`,
  );
  return new Map(rows.map((row) => [row.version, row]));
}

export async function migrationStatus(db: Database, files = loadMigrationFiles()): Promise<MigrationStatus[]> {
  const applied = await appliedMigrations(db);
  return files.map((file) => {
    const row = applied.get(file.version);
    if (!row) return { version: file.version, name: file.name, state: 'pending', appliedAt: null };
    return {
      version: file.version,
      name: file.name,
      state: row.checksum === file.checksum ? 'applied' : 'checksum_mismatch',
      appliedAt: row.applied_at,
    };
  });
}

/** Aplica migraciones pendientes, cada una en su propia transacción y bajo un advisory lock. */
export async function migrate(db: Database, files = loadMigrationFiles()): Promise<string[]> {
  await assertSchemaIsOurs(db);
  const client = await db.pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureRegistry(db);
    const status = await migrationStatus(db, files);
    const mismatch = status.find((item) => item.state === 'checksum_mismatch');
    if (mismatch) {
      throw new MigrationSafetyError(
        `La migración ${mismatch.version}_${mismatch.name} ya aplicada fue modificada. Crea una migración nueva en lugar de editarla.`,
      );
    }
    for (const file of files) {
      if (status.find((item) => item.version === file.version)?.state !== 'pending') continue;
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO ${quoteIdent(db.schema)}, public`);
        await client.query(file.sql);
        await client.query(
          `INSERT INTO ${quoteIdent(db.schema)}.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
          [file.version, file.name, file.checksum],
        );
        await client.query('COMMIT');
        appliedNow.push(`${file.version}_${file.name}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        throw new MigrationSafetyError(`Falló la migración ${file.version}_${file.name}: ${message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return appliedNow;
}
