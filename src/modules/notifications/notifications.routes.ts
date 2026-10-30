import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { HttpError } from '../../shared/errors.js';
import { KINDS, dismiss, listNotifications, markRead, mutedKinds, scanIfStale, setMutedKinds, unreadCount } from './notifications.js';
import { TelegramError, notConfiguredTelegram, type TelegramClient } from './telegram.js';
import { createLinkCode, setTelegramEnabled, telegramChat, telegramStatus, unlinkTelegram } from './telegram-service.js';

const idList = { type: 'array', maxItems: 100, items: { type: 'string', format: 'uuid' } } as const;
const target = { type: 'object', additionalProperties: false, properties: { ids: idList, all: { type: 'boolean' } } } as const;

export async function notificationsRoutes(app: FastifyInstance, { db, telegram = notConfiguredTelegram }: { db: Database; telegram?: TelegramClient }): Promise<void> {
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

  // ── Telegram ──
  app.get('/notifications/telegram', { preHandler: auth, schema: { tags: ['notifications'] } }, async (request) => ({
    configured: telegram.configured, botUsername: telegram.configured ? await telegram.username().catch(() => null) : null, ...(await telegramStatus(db, userId(request))),
  }));

  // Enlace de un solo uso (15 min): al abrirlo y pulsar «Iniciar», el bot conecta ese chat con esta cuenta.
  app.post('/notifications/telegram/link', { preHandler: auth, schema: { tags: ['notifications'] } }, async (request) => {
    if (!telegram.configured) throw new HttpError(503, 'telegram_not_configured', 'Telegram no está configurado todavía.');
    const bot = await telegram.username().catch(() => null);
    if (!bot) throw new HttpError(503, 'telegram_unavailable', 'No pude hablar con Telegram. Inténtalo de nuevo en un momento.');
    const { code, expiresAt } = await createLinkCode(db, userId(request));
    return { url: `https://t.me/${bot}?start=${code}`, expiresAt: expiresAt.toISOString() };
  });

  app.post('/notifications/telegram/unlink', { preHandler: auth, schema: { tags: ['notifications'] } }, async (request) => {
    await unlinkTelegram(db, userId(request));
    return telegramStatus(db, userId(request));
  });

  app.post<{ Body: { enabled: boolean } }>('/notifications/telegram/enabled', {
    preHandler: auth,
    schema: { tags: ['notifications'], body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (request) => {
    await setTelegramEnabled(db, userId(request), request.body.enabled);
    return telegramStatus(db, userId(request));
  });

  app.post('/notifications/telegram/test', { preHandler: auth, schema: { tags: ['notifications'] } }, async (request) => {
    const chat = await telegramChat(db, userId(request));
    if (chat === null) throw new HttpError(409, 'telegram_not_linked', 'Conecta Telegram primero.');
    try {
      await telegram.sendMessage(chat, '🔔 <b>Mensaje de prueba</b>\nAsí te llegarán los avisos de Academic Hub.');
    } catch (error) {
      throw new HttpError(502, error instanceof TelegramError ? error.code : 'telegram_failed', 'No pude mandar el mensaje de prueba.');
    }
    return { sent: true };
  });
}
