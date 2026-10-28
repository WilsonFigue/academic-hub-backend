import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { PASSWORD_MAX_LENGTH } from './password.js';
import type { AuthRepository } from './auth.repository.js';
import { toPublicUser, type AuthService } from './auth.service.js';
import { clearSessionCookies, currentSession, requestMeta, requireAuth, setSessionCookies } from './auth.guard.js';

interface Deps {
  config: AppConfig;
  service: AuthService;
  repo: AuthRepository;
}

const password = { type: 'string', minLength: 1, maxLength: PASSWORD_MAX_LENGTH } as const;
const sessionResponse = {
  type: 'object',
  properties: {
    user: { $ref: 'PublicUser#' },
    csrfToken: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;
// Límite estricto contra fuerza bruta en credenciales (además del global).
// La clave combina IP e identificador: frena la fuerza bruta sobre una cuenta sin bloquear a otros usuarios de la misma IP.
const credentialRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
    // preHandler: el cuerpo ya está parseado y el identificador forma parte de la clave.
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => {
      const body = request.body as { identifier?: unknown; email?: unknown } | undefined;
      const identifier = typeof body?.identifier === 'string' ? body.identifier : typeof body?.email === 'string' ? body.email : '';
      return `${request.ip}|${identifier.trim().toLowerCase().slice(0, 320)}`;
    },
  },
};

export async function authRoutes(app: FastifyInstance, { config, service, repo }: Deps): Promise<void> {
  app.post<{ Body: { email: string; password: string; displayName?: string } }>('/auth/register', {
    config: credentialRateLimit,
    schema: {
      tags: ['auth'],
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 320 },
          password,
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      response: { 201: sessionResponse },
    },
  }, async (request, reply) => {
    const { user, session } = await service.register(request.body, requestMeta(request));
    setSessionCookies(reply, config, session);
    return reply.code(201).send({ user: toPublicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() });
  });

  app.post<{ Body: { identifier: string; password: string } }>('/auth/login', {
    config: credentialRateLimit,
    schema: {
      tags: ['auth'],
      body: {
        type: 'object', additionalProperties: false, required: ['identifier', 'password'],
        properties: { identifier: { type: 'string', minLength: 1, maxLength: 320 }, password },
      },
      response: { 200: sessionResponse },
    },
  }, async (request, reply) => {
    const { user, session } = await service.login(request.body, requestMeta(request));
    setSessionCookies(reply, config, session);
    return { user: toPublicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() };
  });

  app.post('/auth/logout', {
    preHandler: requireAuth({ allowPendingPasswordChange: true }),
    schema: { tags: ['auth'], response: { 204: { type: 'null' } } },
  }, async (request, reply) => {
    await service.logout(currentSession(request), requestMeta(request));
    clearSessionCookies(reply, config);
    return reply.code(204).send();
  });

  app.post('/auth/logout-all', {
    preHandler: requireAuth({ allowPendingPasswordChange: true }),
    schema: { tags: ['auth'], response: { 200: { type: 'object', properties: { revokedSessions: { type: 'integer' } } } } },
  }, async (request, reply) => {
    const revokedSessions = await service.logoutAll(currentSession(request), requestMeta(request));
    clearSessionCookies(reply, config);
    return { revokedSessions };
  });

  app.get('/auth/session', {
    preHandler: requireAuth({ allowPendingPasswordChange: true }),
    schema: {
      tags: ['auth'],
      response: { 200: { type: 'object', properties: { user: { $ref: 'PublicUser#' }, expiresAt: { type: 'string', format: 'date-time' } } } },
    },
  }, async (request) => {
    const session = currentSession(request);
    const user = await repo.findUserById(session.user_id);
    return { user: user ? toPublicUser(user) : null, expiresAt: session.expires_at.toISOString() };
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/auth/password', {
    config: credentialRateLimit,
    preHandler: requireAuth({ allowPendingPasswordChange: true }),
    schema: {
      tags: ['auth'],
      body: {
        type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'],
        properties: { currentPassword: password, newPassword: password },
      },
      response: { 204: { type: 'null' } },
    },
  }, async (request, reply) => {
    await service.changePassword(currentSession(request), request.body, requestMeta(request));
    return reply.code(204).send();
  });
}
