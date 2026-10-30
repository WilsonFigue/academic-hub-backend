import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { KINDS, dismiss, listNotifications, markRead, mutedKinds, scanIfStale, setMutedKinds, unreadCount } from './notifications.js';

const idList = { type: 'array', maxItems: 100, items: { type: 'string', format: 'uuid' } } as const;
const target = { type: 'object', additionalProperties: false, properties: { ids: idList, all: { type: 'boolean' } } } as const;

export async function notificationsRoutes(app: FastifyInstance, { db }: { db: Database }): Promise<void> {
  const auth = requireAuth();
  const userId = (request: Parameters<typeof currentSession>[0]) => currentSession(request).user_id;

  // Bandeja: al abrirla se recalculan (como máximo cada 5 minutos) los recordatorios de entrega.
  app.get<{ Querystring: { before?: string; limit?: string; unread?: string } }>('/notifications', {
    preHandler: auth,
    schema: { tags: ['notifications'], querystring: { type: 'object', additionalProperties: false, properties: {
      before: { type: 'string', maxLength: 120 }, limit: { type: 'string', pattern: '^[0-9]{1,3}$' }, unread: { type: 'string', maxLength: 5 } } } },
  }, async (request) => {
    const user = userId(request);
    await scanIfStale(db, user);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 30), 1), 100);
    let before: { at: Date; id: string } | undefined;
    if (request.query.before) {
      const [at, id] = String(request.query.before).split('|');
      const date = at ? new Date(at) : null;
      if (date && !Number.isNaN(date.getTime()) && id && /^[0-9a-f-]{36}$/i.test(id)) before = { at: date, id };
    }
    const notifications = await listNotifications(db, user, { limit, before, unreadOnly: request.query.unread === '1' });
    const last = notifications[notifications.length - 1];
    return { notifications, unread: await unreadCount(db, user), nextCursor: notifications.length === limit && last ? `${last.createdAt}|${last.id}` : null };
  });

  app.post<{ Body: { ids?: string[]; all?: boolean } }>('/notifications/read', { preHandler: auth, schema: { tags: ['notifications'], body: target } }, async (request) => {
    const user = userId(request);
    await markRead(db, user, request.body ?? {});
    return { unread: await unreadCount(db, user) };
  });

  app.post<{ Body: { ids?: string[]; all?: boolean } }>('/notifications/dismiss', { preHandler: auth, schema: { tags: ['notifications'], body: target } }, async (request) => {
    const user = userId(request);
    await dismiss(db, user, request.body ?? {});
    return { unread: await unreadCount(db, user) };
  });

  app.get('/notifications/preferences', { preHandler: auth, schema: { tags: ['notifications'] } }, async (request) => ({ kinds: KINDS, muted: await mutedKinds(db, userId(request)) }));

  app.put<{ Body: { muted: string[] } }>('/notifications/preferences', {
    preHandler: auth,
    schema: { tags: ['notifications'], body: { type: 'object', additionalProperties: false, required: ['muted'], properties: { muted: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } } } } },
  }, async (request) => ({ kinds: KINDS, muted: await setMutedKinds(db, userId(request), request.body.muted) }));
}
