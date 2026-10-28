import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../database/connection.js';
import { DatabaseError } from '../../database/connection.js';
import { generateToken, sha256 } from '../../shared/crypto.js';
import { HttpError, badRequest, conflict, unauthorized } from '../../shared/errors.js';
import type { AuthRepository, SessionRow, UserRow } from './auth.repository.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';

export interface RequestMeta {
  ipHash: Buffer | null;
  userAgent: string | null;
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
  mustChangePassword: boolean;
  emailVerified: boolean;
  createdAt: string;
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.display_name,
    mustChangePassword: user.must_change_password,
    emailVerified: user.email_verified_at !== null,
    createdAt: user.created_at.toISOString(),
  };
}

export function createAuthService(db: Database, repo: AuthRepository, config: AppConfig) {
  const ttlMs = config.sessionTtlDays * 86_400_000;

  async function issueSession(userId: string, meta: RequestMeta): Promise<IssuedSession> {
    const token = generateToken();
    const csrfToken = generateToken();
    const expiresAt = new Date(Date.now() + ttlMs);
    await repo.insertSession(db, {
      userId, tokenHash: sha256(token), csrfTokenHash: sha256(csrfToken), expiresAt, userAgent: meta.userAgent, ipHash: meta.ipHash,
    });
    return { token, csrfToken, expiresAt };
  }

  return {
    issueSession,

    async register(input: { email: string; password: string; displayName?: string }, meta: RequestMeta) {
      const email = input.email.trim();
      const problem = passwordProblem(input.password, { email });
      if (problem) throw badRequest('weak_password', problem);
      const passwordHash = await hashPassword(input.password);
      let user: UserRow;
      try {
        user = await repo.insertUser(db, {
          email, username: null, passwordHash, displayName: input.displayName?.trim() || null, mustChangePassword: false,
        });
      } catch (error) {
        if (error instanceof DatabaseError && error.code === '23505') throw conflict('email_taken', 'Ya existe una cuenta con ese correo.');
        throw error;
      }
      await repo.audit(db, { userId: user.id, event: 'auth.register', ...meta });
      return { user, session: await issueSession(user.id, meta) };
    },

    async login(input: { identifier: string; password: string }, meta: RequestMeta) {
      const user = await repo.findUserByIdentifier(input.identifier.trim());
      const valid = await verifyPassword(user?.password_hash ?? null, input.password);
      if (!user || !valid || user.status !== 'active') {
        await repo.audit(db, { userId: user?.id ?? null, event: 'auth.login', outcome: 'failure', ...meta });
        // Mismo mensaje para usuario inexistente, contraseña incorrecta o cuenta deshabilitada.
        throw unauthorizedCredentials();
      }
      await repo.audit(db, { userId: user.id, event: 'auth.login', ...meta });
      return { user, session: await issueSession(user.id, meta) };
    },

    async logout(session: SessionRow, meta: RequestMeta) {
      await repo.revokeSession(session.session_id, 'logout');
      await repo.audit(db, { userId: session.user_id, event: 'auth.logout', ...meta });
    },

    async logoutAll(session: SessionRow, meta: RequestMeta) {
      const revoked = await repo.revokeUserSessions(db, session.user_id, 'logout_all');
      await repo.audit(db, { userId: session.user_id, event: 'auth.logout_all', metadata: { revoked }, ...meta });
      return revoked;
    },

    /** Cambia la contraseña, revoca las demás sesiones y conserva la actual. */
    async changePassword(session: SessionRow, input: { currentPassword: string; newPassword: string }, meta: RequestMeta) {
      const user = await repo.findUserById(session.user_id);
      if (!user) throw unauthorized();
      if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
        await repo.audit(db, { userId: user.id, event: 'auth.password_change', outcome: 'failure', ...meta });
        throw new HttpError(400, 'invalid_current_password', 'La contraseña actual no es correcta.');
      }
      if (input.currentPassword === input.newPassword) throw badRequest('password_reused', 'La nueva contraseña debe ser distinta de la actual.');
      const problem = passwordProblem(input.newPassword, { email: user.email, username: user.username });
      if (problem) throw badRequest('weak_password', problem);
      const passwordHash = await hashPassword(input.newPassword);
      await db.transaction(async (client) => {
        await repo.updatePassword(client, user.id, passwordHash);
        await repo.revokeUserSessions(client, user.id, 'password_changed', session.session_id);
        await repo.audit(client, { userId: user.id, event: 'auth.password_change', ...meta });
      });
    },
  };
}

function unauthorizedCredentials(): HttpError {
  return new HttpError(401, 'invalid_credentials', 'Usuario o contraseña incorrectos.');
}

export type AuthService = ReturnType<typeof createAuthService>;
