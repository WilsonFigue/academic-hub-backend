import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { AppConfig } from '../config/env.js';

/** Lo mínimo para ejecutar SQL parametrizado: lo cumplen el pool (Database) y un cliente de transacción. */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

export type DbErrorKind = 'authentication' | 'network' | 'permission' | 'not_found' | 'tls' | 'constraint' | 'unknown';

/** Error de base de datos sin cadena de conexión, host ni credenciales. */
export class DatabaseError extends Error {
  constructor(
    readonly kind: DbErrorKind,
    message: string,
    readonly code: string | undefined,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN']);

export function classifyDbError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const code = (error as { code?: string })?.code;
  const constraint = (error as { constraint?: string })?.constraint;
  const message = error instanceof Error ? error.message : '';
  // 28000 abarca varias causas; el texto del servidor se inspecciona pero nunca se devuelve (incluye host y usuario).
  if (code === '28000' && /no encryption/i.test(message)) {
    return new DatabaseError('tls', 'El servidor exige una conexión cifrada: configura DB_SSL=true (y DB_SSL_CA_FILE si el certificado no es de una CA pública).', code);
  }
  if (code === '28000' && /pg_hba/i.test(message)) {
    return new DatabaseError('permission', 'El servidor no admite conexiones desde esta IP o con este usuario/base (pg_hba.conf o redes autorizadas).', code);
  }
  if (code === '28P01' || code === '28000') return new DatabaseError('authentication', 'Autenticación rechazada por PostgreSQL (usuario o contraseña).', code);
  if (code === '42501') return new DatabaseError('permission', 'El usuario de base de datos no tiene permisos suficientes.', code);
  if (code === '3D000') return new DatabaseError('not_found', 'La base de datos indicada no existe.', code);
  if (code === '23505' || code === '23503' || code === '23514' || code === '23502' || code === '23P01') {
    return new DatabaseError('constraint', 'Se violó una restricción de integridad.', code, constraint);
  }
  if (code && NETWORK_CODES.has(code)) return new DatabaseError('network', 'No fue posible conectar con el servidor PostgreSQL.', code);
  if (/ssl|tls|certificate/i.test(message)) return new DatabaseError('tls', 'Fallo en la negociación TLS con PostgreSQL.', code);
  if (/timeout/i.test(message)) return new DatabaseError('network', 'Tiempo de espera agotado al conectar con PostgreSQL.', code);
  return new DatabaseError('unknown', 'Error inesperado de base de datos.', code);
}

export interface Database {
  readonly pool: pg.Pool;
  readonly schema: string;
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
  transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * `require` cifra el canal pero no autentica al servidor (equivale a sslmode=require de libpq).
 * Solo se acepta fuera de producción; readConfig() lo impone.
 */
function sslOptions(config: AppConfig): pg.PoolConfig['ssl'] {
  if (config.dbSslMode === 'disable') return undefined;
  const ca = config.dbSslCaFile ? { ca: readFileSync(config.dbSslCaFile, 'utf8') } : {};
  if (config.dbSslMode === 'require') return { rejectUnauthorized: false, ...ca };
  return { rejectUnauthorized: true, ...ca, ...(config.dbSslServername ? { servername: config.dbSslServername } : {}) };
}

export function createDatabase(config: AppConfig, connectionString: string, overrides: { max?: number } = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: overrides.max ?? config.dbPoolMax,
    // TLS verificado por defecto; nunca rejectUnauthorized:false.
    ssl: sslOptions(config),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'academic-hub-backend',
    options: `-c search_path=${config.dbSchema},public`,
  });
  // Un cliente inactivo que falla no debe derribar el proceso.
  pool.on('error', () => {});

  let closed = false;
  return {
    pool,
    schema: config.dbSchema,
    async query(text, values) {
      try {
        return await pool.query(text, values);
      } catch (error) {
        throw classifyDbError(error);
      }
    },
    async transaction(fn) {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw classifyDbError(error);
      }
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        // Solo se reclasifican errores del driver; los errores de la aplicación pasan intactos.
        throw error instanceof pg.DatabaseError ? classifyDbError(error) : error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
