import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { hashIp, safeEqual, sha256 } from '../../shared/crypto.js';
import { HttpError, forbidden, unauthorized } from '../../shared/errors.js';
import type { AuthRepository, SessionRow } from './auth.repository.js';
import type { IssuedSession, RequestMeta } from './auth.service.js';

export const SESSION_COOKIE = 'ah_session';
export const CSRF_COOKIE = 'ah_csrf';
export const CSRF_HEADER = 'x-csrf-token';

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionRow | null;
  }
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  const agent = request.headers['user-agent'];
  return { ipHash: hashIp(request.ip), userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null };
}

/**
 * Política de cookies:
 * - Desarrollo: el frontend usa el proxy de Vite (mismo origen) → SameSite=Lax funciona.
 * - Frontend y API en subdominios del mismo sitio (app.x.com / api.x.com) → Lax + Secure.
 * - Sitios realmente distintos → COOKIE_SAME_SITE=none exige COOKIE_SECURE=true (validado en env.ts).
 */
export function setSessionCookies(reply: FastifyReply, config: AppConfig, session: IssuedSession): void {
  const base = { path: '/', secure: config.cookieSecure, sameSite: config.cookieSameSite, expires: session.expiresAt } as const;
  reply.setCookie(SESSION_COOKIE, session.token, { ...base, httpOnly: true });
  // Legible por el frontend para reenviarlo en la cabecera (double submit ligado a la sesión).
  reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...base, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  const base = { path: '/', secure: config.cookieSecure, sameSite: config.cookieSameSite } as const;
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, base);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rechaza métodos no seguros cuyo Origin no sea el frontend configurado. */
export function assertAllowedOrigin(request: FastifyRequest, config: AppConfig): void {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== config.frontendOrigin) throw forbidden('origin_not_allowed', 'Origen no permitido.');
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

/** Carga la sesión desde la cookie (sin exigirla). */
export function createSessionLoader(repo: AuthRepository) {
  return async function loadSession(request: FastifyRequest): Promise<void> {
    request.auth = null;
    const token = request.cookies[SESSION_COOKIE];
    if (!token || token.length > 100) return;
    const session = await repo.findActiveSession(sha256(token));
    if (!session) return;
    request.auth = session;
    if (Date.now() - session.last_used_at.getTime() > TOUCH_INTERVAL_MS) await repo.touchSession(session.session_id);
  };
}

export interface GuardOptions {
  /** Permite la ruta aunque la contraseña temporal no se haya cambiado (sesión, cambio de clave, logout). */
  allowPendingPasswordChange?: boolean;
}

/** preHandler: exige sesión válida, CSRF en métodos no seguros y contraseña definitiva. */
export function requireAuth(options: GuardOptions = {}) {
  return async function guard(request: FastifyRequest): Promise<void> {
    const session = request.auth;
    if (!session) throw unauthorized();
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(sha256(header), session.csrf_token_hash)) {
        throw forbidden('csrf_invalid', 'Token CSRF ausente o inválido.');
      }
    }
    if (session.must_change_password && !options.allowPendingPasswordChange) {
      throw new HttpError(403, 'password_change_required', 'Debes cambiar tu contraseña temporal antes de continuar.');
    }
  };
}

/** Usuario autenticado (solo tras requireAuth). */
export function currentSession(request: FastifyRequest): SessionRow {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
