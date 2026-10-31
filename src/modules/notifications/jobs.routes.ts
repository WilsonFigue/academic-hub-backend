// Rutinas por endpoint: todo lo que antes corría solo en segundo plano ahora se dispara desde fuera (un programador de tareas).
// Sirven en producción: se protegen con CRON_SECRET (cabecera «Authorization: Bearer …»; Vercel Cron la manda igual).
// El webhook de Telegram es público pero solo acepta mensajes con el secreto que Telegram reenvía.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../../database/connection.js';
import { safeEqual, sha256 } from '../../shared/crypto.js';
import { HttpError } from '../../shared/errors.js';
import type { Mailer } from './mailer.js';
import { sendSummaries } from './summary.js';
import { notConfiguredTelegram, TelegramError, type TelegramClient, type TelegramUpdate } from './telegram.js';
import { dispatchPending, handleUpdate, pollOnce, scanEveryone } from './telegram-service.js';
import { sendWeekly } from './weekly.js';

export interface JobsDeps { db: Database; cronSecret: string | null; mailer: Mailer; telegram?: TelegramClient; capUsd: number; webUrl?: string | null }

export async function jobsRoutes(app: FastifyInstance, { db, cronSecret, mailer, telegram = notConfiguredTelegram, capUsd, webUrl = null }: JobsDeps): Promise<void> {
  const secretHash = cronSecret ? sha256(cronSecret) : null;
  function authorize(request: FastifyRequest): void {
    if (!secretHash) throw new HttpError(503, 'jobs_not_configured', 'Las rutinas no están configuradas (falta CRON_SECRET).');
    const match = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''));
    if (!match || !safeEqual(sha256(match[1]!), secretHash)) throw new HttpError(401, 'jobs_unauthorized', 'No autorizado.');
  }
  // GET y POST: los programadores de tareas suelen llamar con GET.
  const job = (path: string, handler: (request: FastifyRequest) => Promise<unknown>, querystring?: object) => {
    for (const method of ['GET', 'POST'] as const) {
      app.route({ method, url: path, schema: { hide: true, ...(querystring ? { querystring } : {}) }, handler: async (request) => { authorize(request); return handler(request); } });
    }
  };

  // Recordatorios de entrega de todos + avisos pendientes por Telegram (respeta el silencio). Llamar cada 5–10 minutos.
  job('/jobs/notifications', async () => ({ created: await scanEveryone(db), telegram: await dispatchPending(db, telegram, { webUrl }) }));

  // Resumen por correo: kind=summary (diario, por defecto) o weekly. Una vez por persona y por periodo; force=1 lo repite.
  job('/jobs/email-summary', async (request) => {
    if (!mailer.configured) throw new HttpError(503, 'mail_not_configured', 'Mailchimp no está configurado.');
    const query = request.query as { kind?: string; force?: string };
    const send = query.kind === 'weekly' ? sendWeekly : sendSummaries;
    const results = await send(db, mailer, { capUsd, force: query.force === '1' });
    return { results: results.map(({ html: _html, ...rest }) => rest) };
  }, { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['summary', 'weekly'] }, force: { type: 'string', maxLength: 1 } } });

  // Sin webhook (por ejemplo en local): atiende de una vez los mensajes pendientes del bot. Llamar cada minuto.
  job('/jobs/telegram/poll', async () => ({ handled: await pollOnce(db, telegram) }));

  // Registrar o quitar el webhook: POST /jobs/telegram/webhook {"baseUrl":"https://mi-api.example.com"} | DELETE con {"remove":true}.
  app.post<{ Body: { baseUrl?: string; remove?: boolean } }>('/jobs/telegram/webhook', {
    schema: { hide: true, body: { type: 'object', additionalProperties: false, properties: { baseUrl: { type: 'string', maxLength: 300 }, remove: { type: 'boolean' } } } },
  }, async (request) => {
    authorize(request);
    if (!telegram.configured) throw new HttpError(503, 'telegram_not_configured', 'Telegram no está configurado.');
    try {
      if (request.body?.remove) { await telegram.deleteWebhook(); return { webhook: null }; }
      const base = request.body?.baseUrl?.replace(/\/$/, '') ?? '';
      if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(base)) throw new HttpError(400, 'bad_url', 'baseUrl debe ser una dirección https pública.');
      await telegram.setWebhook(`${base}/telegram/webhook`);
      return { webhook: `${base}/telegram/webhook` };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, error instanceof TelegramError ? error.code : 'telegram_failed', 'Telegram no aceptó el webhook.');
    }
  });

  // Telegram avisa aquí de cada mensaje. Se responde 200 siempre que el secreto sea correcto, para que no reintente en bucle.
  app.post<{ Body: TelegramUpdate }>('/telegram/webhook', { schema: { hide: true, body: { type: 'object', additionalProperties: true } } }, async (request) => {
    const secret = telegram.webhookSecret();
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (!secret || typeof header !== 'string' || !safeEqual(sha256(header), sha256(secret))) throw new HttpError(401, 'webhook_unauthorized', 'No autorizado.');
    try { await handleUpdate(db, telegram, request.body); } catch { /* un mensaje con problemas no debe hacer que Telegram reintente */ }
    return { ok: true };
  });
}
