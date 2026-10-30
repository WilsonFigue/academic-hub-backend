// Endpoint interno que dispara los correos de resumen. Solo desarrollo, loopback y con token de operador
// (el mismo esquema que /internal/dev/utec/*). Quien programe las rutinas lo llama una vez al día.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../../database/connection.js';
import { safeEqual, sha256 } from '../../shared/crypto.js';
import { HttpError, notFound } from '../../shared/errors.js';
import type { Mailer } from './mailer.js';
import { sendSummaries } from './summary.js';
import { sendWeekly } from './weekly.js';
import { notConfiguredTelegram, type TelegramClient } from './telegram.js';
import { dispatchPending, scanEveryone } from './telegram-service.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function emailRoutes(app: FastifyInstance, { db, operatorToken, mailer, capUsd, telegram = notConfiguredTelegram, webUrl = null }: { db: Database; operatorToken: string; mailer: Mailer; capUsd: number; telegram?: TelegramClient; webUrl?: string | null }): Promise<void> {
  const tokenHash = sha256(operatorToken);
  function authorizeOperator(request: FastifyRequest): void {
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw notFound();
    if (request.headers.origin !== undefined) throw new HttpError(403, 'browser_not_allowed', 'Este endpoint no acepta solicitudes desde navegadores.');
    const header = request.headers['x-dev-operator-token'];
    if (typeof header !== 'string' || !safeEqual(sha256(header), tokenHash)) throw new HttpError(401, 'operator_unauthorized', 'Token de operador inválido.');
  }

  // Cuerpo opcional: { kind?: 'summary' (diario, por defecto) | 'weekly', userId?, dryRun?, force?, reviewTo? }. dryRun arma los correos sin enviar nada; reviewTo manda todos a esa dirección como prueba.
  app.post<{ Body?: { userId?: string; dryRun?: boolean; force?: boolean; reviewTo?: string; kind?: 'summary' | 'weekly' } }>('/internal/dev/notifications/email-summary', {
    schema: { hide: true, body: { type: ['object', 'null'], additionalProperties: false, properties: { userId: { type: 'string', format: 'uuid' }, dryRun: { type: 'boolean' }, force: { type: 'boolean' }, reviewTo: { type: 'string', format: 'email', maxLength: 320 }, kind: { type: 'string', enum: ['summary', 'weekly'] } } } },
  }, async (request) => {
    authorizeOperator(request);
    const options = request.body ?? {};
    if (!options.dryRun && !mailer.configured) throw new HttpError(503, 'mail_not_configured', 'Mailchimp no está configurado (falta MAILCHIMP_API_KEY).');
    const send = options.kind === 'weekly' ? sendWeekly : sendSummaries;
    const results = await send(db, mailer, { capUsd, userId: options.userId, dryRun: options.dryRun, force: options.force, reviewTo: options.reviewTo });
    return { results: results.map(({ html, ...rest }) => (options.dryRun ? { ...rest, htmlLength: html?.length ?? 0 } : rest)) };
  });

  // Recalcula los recordatorios de entrega de todos y manda por Telegram los avisos pendientes (respeta el horario de silencio).
  // El servidor ya lo hace solo cada 10 minutos; esto sirve para dispararlo desde otra rutina.
  app.post('/internal/dev/notifications/scan', { schema: { hide: true } }, async (request) => {
    authorizeOperator(request);
    const created = await scanEveryone(db);
    return { created, telegram: await dispatchPending(db, telegram, { webUrl }) };
  });
}
