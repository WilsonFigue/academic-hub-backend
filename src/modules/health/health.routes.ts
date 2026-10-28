import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';

export async function healthRoutes(app: FastifyInstance, opts: { db: Database | null }): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  // Respuesta mínima: no revela usuario, host, base ni configuración.
  app.get('/health/db', async (_request, reply) => {
    if (!opts.db) return reply.code(503).send({ status: 'unavailable', database: 'not_configured' });
    const started = Date.now();
    try {
      await opts.db.query('SELECT 1');
      return { status: 'ok', database: 'reachable', latencyMs: Date.now() - started };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'unreachable' });
    }
  });
}
