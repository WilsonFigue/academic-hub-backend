import type { Database, Queryable } from '../../database/connection.js';

export interface UserRow {
  id: string;
  email: string;
  username: string | null;
  password_hash: string;
  must_change_password: boolean;
  display_name: string | null;
  status: 'active' | 'disabled';
  email_verified_at: Date | null;
  created_at: Date;
}

export interface SessionRow {
  session_id: string;
  user_id: string;
  csrf_token_hash: Buffer;
  expires_at: Date;
  last_used_at: Date;
  email: string;
  username: string | null;
  display_name: string | null;
  must_change_password: boolean;
}

const USER_COLUMNS = 'id, email, username, password_hash, must_change_password, display_name, status, email_verified_at, created_at';

export function createAuthRepository(db: Database) {
  return {
    async findUserByIdentifier(identifier: string): Promise<UserRow | null> {
      const { rows } = await db.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users
          WHERE deleted_at IS NULL AND (lower(email) = lower($1) OR username = lower($1))
          LIMIT 1`,
        [identifier],
      );
      return rows[0] ?? null;
    },

    async findUserById(id: string): Promise<UserRow | null> {
      const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
      return rows[0] ?? null;
    },

    async insertUser(client: Queryable, user: {
      email: string; username: string | null; passwordHash: string; displayName: string | null; mustChangePassword: boolean;
    }): Promise<UserRow> {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (email, username, password_hash, display_name, must_change_password, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING ${USER_COLUMNS}`,
        [user.email, user.username, user.passwordHash, user.displayName, user.mustChangePassword],
      );
      return rows[0]!;
    },

    async insertSession(client: Queryable, session: {
      userId: string; tokenHash: Buffer; csrfTokenHash: Buffer; expiresAt: Date; userAgent: string | null; ipHash: Buffer | null;
    }): Promise<void> {
      await client.query(
        `INSERT INTO auth_sessions (user_id, token_hash, csrf_token_hash, expires_at, user_agent, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [session.userId, session.tokenHash, session.csrfTokenHash, session.expiresAt, session.userAgent, session.ipHash],
      );
    },

    /** Sesión vigente (no revocada, no expirada) de un usuario activo. */
    async findActiveSession(tokenHash: Buffer): Promise<SessionRow | null> {
      const { rows } = await db.query<SessionRow>(
        `SELECT s.id AS session_id, s.user_id, s.csrf_token_hash, s.expires_at, s.last_used_at,
                u.email, u.username, u.display_name, u.must_change_password
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.status = 'active' AND u.deleted_at IS NULL`,
        [tokenHash],
      );
      return rows[0] ?? null;
    },

    async touchSession(sessionId: string): Promise<void> {
      await db.query(`UPDATE auth_sessions SET last_used_at = now() WHERE id = $1`, [sessionId]);
    },

    async revokeSession(sessionId: string, reason: string): Promise<void> {
      await db.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
    },

    async revokeUserSessions(client: Queryable, userId: string, reason: string, exceptSessionId: string | null = null): Promise<number> {
      const result = await client.query(
        `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
          WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
        [userId, reason, exceptSessionId],
      );
      return result.rowCount ?? 0;
    },

    async updatePassword(client: Queryable, userId: string, passwordHash: string): Promise<void> {
      await client.query(
        `UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1`,
        [userId, passwordHash],
      );
    },

    async audit(client: Queryable, event: {
      userId: string | null; event: string; outcome?: 'success' | 'failure'; ipHash?: Buffer | null; userAgent?: string | null; metadata?: object;
    }): Promise<void> {
      await client.query(
        `INSERT INTO audit_events (user_id, event, outcome, ip_hash, user_agent, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.userId, event.event, event.outcome ?? 'success', event.ipHash ?? null, event.userAgent ?? null, JSON.stringify(event.metadata ?? {})],
      );
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
