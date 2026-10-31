import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import { DatabaseError, type Database } from './database/connection.js';
import { createAcademicRepository } from './modules/academic/academic.repository.js';
import { academicRoutes } from './modules/academic/academic.routes.js';
import { CSRF_COOKIE, SESSION_COOKIE, assertAllowedOrigin, createSessionLoader, setSessionCookies } from './modules/auth/auth.guard.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { guidesRoutes } from './modules/guides/guides.routes.js';
import { homeworkRoutes } from './modules/homework/homework.routes.js';
import { forumsRoutes } from './modules/forums/forums.routes.js';
import { notificationsRoutes } from './modules/notifications/notifications.routes.js';
import type { TelegramClient } from './modules/notifications/telegram.js';
import { jobsRoutes } from './modules/notifications/jobs.routes.js';
import { notConfiguredMailer, type Mailer } from './modules/notifications/mailer.js';
import { notConfiguredSuggester, type ForumSuggester } from './modules/forums/suggest.js';
import { notConfiguredGenerator, type GuideGenerator, type GuidePolicy } from './modules/guides/guides.js';
import { filesRoutes } from './modules/files/files.routes.js';
import type { BlackboardSessions } from './modules/files/sessions.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { HttpError } from './shared/errors.js';
import { hashIp } from './shared/crypto.js';
import { logApiRequest } from './modules/logs/logs.js';

export interface BuildAppOptions {
  config: AppConfig;
  db: Database | null;
  logger?: boolean;
  /** Registro opcional de rutas internas de desarrollo (nunca en producción). */
  registerInternal?: (app: FastifyInstance) => Promise<void>;
  /** Sesiones de Blackboard para abrir archivos por primera vez (solo desarrollo, con credenciales recordadas). Sin ellas solo se sirven archivos ya guardados. */
  blackboardSessions?: BlackboardSessions | null;
  /** Generador de guías de estudio (IA). Sin él, las solicitudes quedan en cola. */
  guideGenerator?: GuideGenerator;
  /** Topes de las guías de estudio (gasto mensual, guías por corrida). */
  guidePolicy?: GuidePolicy;
  /** Sugerencias de respuesta para foros (botón del estudiante). Sin él, el botón avisa que la IA no está conectada. */
  forumSuggester?: ForumSuggester;
  /** Tope mensual (USD) de gasto en IA para tareas; las sugerencias de foro cuentan en él. */
  forumCapUsd?: number;
  /** Cliente de Telegram para vincular el chat y mandar pruebas. Sin él, la vinculación avisa que no está configurado. */
  telegram?: TelegramClient;
  /** Correo de resumen (Mailchimp) y clave de las rutinas por endpoint (/jobs/*); sin clave esas rutas responden 503. */
  mailer?: Mailer;
  cronSecret?: string | null;
  /** Dirección pública de la web (para el enlace «Abrir en Academic Hub» de los avisos). */
  webUrl?: string | null;
}

export async function buildApp({ config, db, logger = true, registerInternal, blackboardSessions = null, guideGenerator = notConfiguredGenerator, guidePolicy, forumSuggester = notConfiguredSuggester, forumCapUsd = 10, telegram, mailer = notConfiguredMailer, cronSecret = null, webUrl = null }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? {
          level: config.logLevel,
          // Nunca registrar cookies, cabeceras de autorización ni cuerpos con credenciales.
          redact: {
            paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'req.headers["x-dev-operator-token"]',
              'res.headers["set-cookie"]', 'req.body', '*.password', '*.currentPassword', '*.newPassword', '*.temporaryPassword'],
            censor: '[REDACTED]',
          },
        }
      : false,
    trustProxy: config.nodeEnv === 'production',
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  app.addSchema({
    $id: 'PublicUser',
    type: 'object',
    properties: {
      id: { type: 'string' }, email: { type: 'string' }, username: { type: ['string', 'null'] },
      displayName: { type: ['string', 'null'] }, mustChangePassword: { type: 'boolean' },
      emailVerified: { type: 'boolean' }, createdAt: { type: 'string' },
    },
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Academic Hub API', version: '0.1.0' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ah_session' } } },
    },
  });

  // Bitácora de peticiones (api_request_log): el manejador de errores deja aquí el detalle y el hook onResponse lo guarda junto con el resultado.
  const errorInfo = new WeakMap<object, { code: string; message: string; detail?: unknown }>();
  if (db) {
    app.addHook('onResponse', async (request, reply) => {
      const path = request.url.split('?')[0] ?? request.url;
      if (path === '/health' || path.startsWith('/health/') || path === '/openapi.json') return;
      const info = errorInfo.get(request);
      await logApiRequest(db, {
        requestId: request.id, method: request.method, route: request.routeOptions?.url ?? null, path, status: reply.statusCode, durationMs: reply.elapsedTime,
        userId: request.auth?.user_id ?? null, ipHash: hashIp(request.ip), userAgent: request.headers['user-agent'],
        errorCode: info?.code ?? (reply.statusCode >= 400 ? `http_${reply.statusCode}` : null), errorMessage: info?.message ?? null, errorDetail: info?.detail,
      });
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) { errorInfo.set(request, { code: error.code, message: error.message }); return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } }); }
    const fastifyError = error as { validation?: unknown; statusCode?: number; code?: string };
    if (fastifyError.validation) {
      errorInfo.set(request, { code: 'validation_failed', message: 'La solicitud no es válida.', detail: fastifyError.validation });
      return reply.code(400).send({ error: { code: 'validation_failed', message: 'La solicitud no es válida.', details: fastifyError.validation } });
    }
    if (fastifyError.statusCode === 429) errorInfo.set(request, { code: 'rate_limited', message: 'Demasiadas solicitudes.' });
    if (fastifyError.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Demasiadas solicitudes. Intenta más tarde.' } });
    if (error instanceof DatabaseError) {
      errorInfo.set(request, { code: 'database_unavailable', message: error.message, detail: { kind: error.kind, code: error.code } });
      request.log.error({ kind: error.kind, code: error.code }, 'database error');
      return reply.code(503).send({ error: { code: 'database_unavailable', message: 'Servicio temporalmente no disponible.' } });
    }
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      errorInfo.set(request, { code: fastifyError.code ?? 'bad_request', message: (error as Error).message?.slice(0, 300) ?? 'bad_request' });
      return reply.code(fastifyError.statusCode).send({ error: { code: 'bad_request', message: 'La solicitud no es válida.' } });
    }
    errorInfo.set(request, { code: 'internal_error', message: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 400) });
    request.log.error({ err: { name: (error as Error).name } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Error interno.' } });
  });

  await app.register(healthRoutes, { db });
  if (db) await app.register(jobsRoutes, { db, cronSecret, mailer, telegram, capUsd: forumCapUsd, webUrl });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await app.register(async (api) => {
    if (!db) {
      api.addHook('onRequest', async (_request, reply) => reply.code(503).send({ error: { code: 'database_unavailable', message: 'Base de datos no configurada.' } }));
      return;
    }
    const authRepo = createAuthRepository(db);
    const authService = createAuthService(db, authRepo, config);
    const loadSession = createSessionLoader(authRepo, config.sessionTtlDays * 86_400_000);
    api.decorateRequest('auth', null);
    api.addHook('onRequest', async (request, reply) => {
      assertAllowedOrigin(request, config);
      const renewed = await loadSession(request);
      // Renueva también las cookies del navegador para que no venzan mientras se usa la app.
      const token = request.cookies[SESSION_COOKIE]; const csrf = request.cookies[CSRF_COOKIE];
      if (renewed && token && csrf) setSessionCookies(reply, config, { token, csrfToken: csrf, expiresAt: renewed });
    });
    await api.register(authRoutes, { config, service: authService, repo: authRepo });
    await api.register(academicRoutes, { db, repo: createAcademicRepository(db), authRepo });
    await api.register(filesRoutes, { db, sessions: blackboardSessions });
    await api.register(guidesRoutes, { db, generator: guideGenerator, policy: guidePolicy, webOrigin: config.frontendOrigin });
    await api.register(homeworkRoutes, { db });
    await api.register(forumsRoutes, { db, sessions: blackboardSessions, suggester: forumSuggester, capUsd: forumCapUsd });
    await api.register(notificationsRoutes, { db, telegram });
  }, { prefix: '/api/v1' });

  if (registerInternal) await registerInternal(app);
  return app;
}
