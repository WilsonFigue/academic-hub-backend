import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'test' | 'production';
export type SameSite = 'lax' | 'strict' | 'none';
export type DbSslMode = 'disable' | 'require' | 'verify-full';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string | null;
  testDatabaseUrl: string | null;
  dbPoolMax: number;
  dbSslMode: DbSslMode;
  dbSslCaFile: string | null;
  dbSchema: string;
  frontendOrigin: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
  cookieSameSite: SameSite;
  blackboardReadOnly: boolean;
  /** Habilita las rutas /internal/dev (solo desarrollo, solo loopback). */
  devOperatorToken: string | null;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuración inválida:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

let envFileLoaded = false;

/** Carga `.env` una sola vez sin sobrescribir variables ya definidas en el proceso. */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  if (existsSync(path)) process.loadEnvFile(path);
}

function bool(name: string, fallback: boolean, problems: string[]): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} debe ser "true" o "false".`);
  return fallback;
}

function int(name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} debe ser un entero entre ${min} y ${max}.`);
    return fallback;
  }
  return value;
}

/** Valida forma y protocolo sin devolver nunca el valor en mensajes de error. */
export function validateDatabaseUrl(name: string, raw: string | undefined, problems: string[]): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} no es una URL válida (formato: postgresql://USUARIO:CONTRASEÑA@HOST:5432/BASE).`);
    return null;
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    problems.push(`${name} debe usar el protocolo postgresql://.`);
    return null;
  }
  if (!url.hostname) problems.push(`${name} no indica el host.`);
  if (url.pathname.length <= 1) problems.push(`${name} no indica el nombre de la base de datos.`);
  return value;
}

function sslMode(nodeEnv: NodeEnv, problems: string[]): DbSslMode {
  const raw = (process.env.DB_SSL_MODE ?? 'verify-full').trim().toLowerCase();
  if (raw !== 'disable' && raw !== 'require' && raw !== 'verify-full') {
    problems.push('DB_SSL_MODE debe ser disable, require o verify-full.');
    return 'verify-full';
  }
  // En producción la conexión debe estar cifrada y el servidor autenticado.
  if (nodeEnv === 'production' && raw !== 'verify-full') problems.push('DB_SSL_MODE debe ser verify-full en producción.');
  return raw;
}

/**
 * Construye la URL a partir de DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD cuando no hay URL completa.
 * Usuario y contraseña se codifican para admitir caracteres especiales.
 */
function databaseUrlFromParts(dbName: string | undefined, problems: string[], label: string): string | undefined {
  const host = process.env.DB_HOST?.trim();
  const name = dbName?.trim();
  if (!host && !name) return undefined;
  const user = process.env.DB_USER?.trim();
  const password = process.env.DB_PASSWORD ?? '';
  const port = process.env.DB_PORT?.trim() || '5432';
  const missing = [!host && 'DB_HOST', !name && label, !user && 'DB_USER', !password && 'DB_PASSWORD'].filter(Boolean);
  if (missing.length > 0) {
    problems.push(`Faltan variables de conexión: ${missing.join(', ')}.`);
    return undefined;
  }
  if (!/^\d{1,5}$/.test(port)) {
    problems.push('DB_PORT debe ser numérico.');
    return undefined;
  }
  const hostPart = host!.includes(':') ? `[${host}]` : host;
  return `postgresql://${encodeURIComponent(user!)}:${encodeURIComponent(password)}@${hostPart}:${port}/${encodeURIComponent(name!)}`;
}

export function readConfig(): AppConfig {
  loadEnvFile();
  const problems: string[] = [];

  const nodeEnvRaw = (process.env.NODE_ENV ?? 'development').trim();
  const nodeEnv: NodeEnv = nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';
  if (!['development', 'test', 'production'].includes(nodeEnvRaw)) {
    problems.push('NODE_ENV debe ser development, test o production.');
  }

  const sameSiteRaw = (process.env.COOKIE_SAME_SITE ?? 'lax').trim().toLowerCase();
  const cookieSameSite: SameSite = sameSiteRaw === 'strict' || sameSiteRaw === 'none' ? sameSiteRaw : 'lax';
  if (!['lax', 'strict', 'none'].includes(sameSiteRaw)) problems.push('COOKIE_SAME_SITE debe ser lax, strict o none.');

  const cookieSecure = bool('COOKIE_SECURE', nodeEnv === 'production', problems);
  if (nodeEnv === 'production' && !cookieSecure) problems.push('COOKIE_SECURE debe ser true en producción.');
  if (cookieSameSite === 'none' && !cookieSecure) problems.push('COOKIE_SAME_SITE=none exige COOKIE_SECURE=true.');

  const dbSchema = (process.env.DB_SCHEMA ?? 'academic_hub').trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbSchema)) problems.push('DB_SCHEMA debe ser un identificador en minúsculas (a-z, 0-9, _).');

  const frontendOrigin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').trim();
  try {
    const origin = new URL(frontendOrigin);
    if (origin.origin !== frontendOrigin) problems.push('FRONTEND_ORIGIN debe ser un origen exacto (sin ruta ni barra final).');
  } catch {
    problems.push('FRONTEND_ORIGIN no es una URL válida.');
  }

  const config: AppConfig = {
    nodeEnv,
    port: int('PORT', 4000, 1, 65535, problems),
    host: (process.env.HOST ?? '127.0.0.1').trim(),
    logLevel: (process.env.LOG_LEVEL ?? 'info').trim(),
    databaseUrl: validateDatabaseUrl('DATABASE_URL',
      process.env.DATABASE_URL?.trim() || databaseUrlFromParts(process.env.DB_NAME, problems, 'DB_NAME'), problems),
    testDatabaseUrl: validateDatabaseUrl('TEST_DATABASE_URL',
      process.env.TEST_DATABASE_URL?.trim() || (process.env.TEST_DB_NAME?.trim()
        ? databaseUrlFromParts(process.env.TEST_DB_NAME, problems, 'TEST_DB_NAME') : undefined), problems),
    dbSslCaFile: (process.env.DB_SSL_CA_FILE ?? '').trim() || null,
    dbPoolMax: int('DB_POOL_MAX', 10, 1, 100, problems),
    dbSslMode: sslMode(nodeEnv, problems),
    dbSchema,
    frontendOrigin,
    sessionTtlDays: int('SESSION_TTL_DAYS', 7, 1, 90, problems),
    cookieSecure,
    cookieSameSite,
    blackboardReadOnly: bool('BLACKBOARD_READ_ONLY', true, problems),
    devOperatorToken: (process.env.DEV_OPERATOR_TOKEN ?? '').trim() || null,
  };
  if (config.devOperatorToken && config.devOperatorToken.length < 32) problems.push('DEV_OPERATOR_TOKEN debe tener al menos 32 caracteres.');
  if (config.devOperatorToken && nodeEnv === 'production') problems.push('DEV_OPERATOR_TOKEN no puede definirse en producción.');
  if (!config.blackboardReadOnly) problems.push('BLACKBOARD_READ_ONLY debe permanecer en true en esta fase.');

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Devuelve la URL de base de datos o un error que indica qué configurar. */
export function requireDatabaseUrl(config: AppConfig, which: 'DATABASE_URL' | 'TEST_DATABASE_URL' = 'DATABASE_URL'): string {
  const value = which === 'DATABASE_URL' ? config.databaseUrl : config.testDatabaseUrl;
  if (!value) {
    throw new ConfigError([
      which === 'DATABASE_URL'
        ? 'No hay conexión configurada. Completa DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD (o DATABASE_URL) en academic-hub-backend/.env.'
        : 'No hay base de pruebas configurada. Completa TEST_DB_NAME (o TEST_DATABASE_URL) en academic-hub-backend/.env.',
    ]);
  }
  return value;
}
