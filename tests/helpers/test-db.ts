import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { readConfig, type AppConfig } from '../../src/config/env.js';
import { createDatabase, type Database } from '../../src/database/connection.js';
import { migrate } from '../../src/database/migrator.js';
import { buildApp } from '../../src/app.js';

// Las pruebas usan un esquema propio y desechable; nunca el esquema de trabajo.
export const TEST_SCHEMA = 'academic_hub_test';

export interface TestContext {
  config: AppConfig;
  db: Database;
  app: FastifyInstance;
}

export function testDatabaseAvailable(): boolean {
  try {
    return Boolean(readConfig().databaseUrl);
  } catch {
    return false;
  }
}

export async function setupTestContext(): Promise<TestContext> {
  process.env.DB_SCHEMA = TEST_SCHEMA;
  const config = { ...readConfig(), dbSchema: TEST_SCHEMA, nodeEnv: 'test' as const };
  if (config.dbSchema === 'academic_hub') throw new Error('Las pruebas no pueden usar el esquema de trabajo.');
  const db = createDatabase(config, config.databaseUrl!, { max: 4 });
  await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await migrate(db);
  const app = await buildApp({ config, db, logger: false });
  return { config, db, app };
}

export async function teardownTestContext(context: TestContext): Promise<void> {
  await context.app.close();
  await context.db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await context.db.close();
}

/** Cliente con "cookie jar" mínimo para simular un navegador. */
export class TestClient {
  private cookies = new Map<string, string>();
  csrf: string | null = null;

  constructor(private readonly app: FastifyInstance, private readonly origin: string) {}

  async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, options: { csrf?: boolean; origin?: string | null } = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && options.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf;
    if (options.origin !== null) headers.origin = options.origin ?? this.origin;
    const response = await this.app.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
    for (const cookie of response.cookies) {
      if (cookie.value === '' || (cookie.expires && cookie.expires.getTime() < Date.now())) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    const csrfCookie = this.cookies.get('ah_csrf');
    this.csrf = csrfCookie ?? null;
    return response;
  }
}
