// Sesiones de Blackboard bajo demanda para abrir archivos: se inicia sesión sin ventana con las credenciales recordadas
// y la sesión se conserva SOLO EN MEMORIA unos minutos (nunca se escribe a disco) para no repetir el inicio de sesión en cada archivo.
import type { Database } from '../../database/connection.js';
import { HttpError } from '../../shared/errors.js';
import { LoginError, type CapturedSession } from '../blackboard/session-login.js';
import { loginStored } from '../blackboard/stored-login.js';
import { loadCredentials } from '../credentials/vault.js';

const IDLE_MS = 15 * 60_000;

export interface SessionPoolOptions { db: Database; key: Buffer; baseUrl: string; visible?: boolean }

export class BlackboardSessions {
  private readonly entries = new Map<string, { session: CapturedSession; timer: NodeJS.Timeout }>();
  private readonly pending = new Map<string, Promise<CapturedSession>>();
  constructor(private readonly options: SessionPoolOptions) {}

  async acquire(accountId: string): Promise<CapturedSession> {
    const cached = this.entries.get(accountId);
    if (cached) { this.touch(accountId, cached.session); return cached.session; }
    let inFlight = this.pending.get(accountId);
    if (!inFlight) {
      inFlight = this.login(accountId).finally(() => this.pending.delete(accountId));
      this.pending.set(accountId, inFlight);
    }
    return inFlight;
  }

  /** Descarta una sesión que Blackboard dejó de aceptar. */
  drop(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.session.dispose();
    this.entries.delete(accountId);
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  private touch(accountId: string, session: CapturedSession): void {
    const previous = this.entries.get(accountId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.drop(accountId), IDLE_MS);
    timer.unref();
    this.entries.set(accountId, { session, timer });
  }

  private async login(accountId: string): Promise<CapturedSession> {
    const credentials = await loadCredentials(this.options.db, this.options.key, accountId);
    if (!credentials) throw new HttpError(503, 'no_stored_credentials', 'Para abrir archivos por primera vez hacen falta las credenciales recordadas (npm run refresh:full → responde "s").');
    try {
      const session = await loginStored(this.options.baseUrl, credentials, { headless: !this.options.visible, timeoutMs: 120_000, failOnMfa: true });
      this.touch(accountId, session);
      return session;
    } catch (error) {
      if (error instanceof LoginError) throw new HttpError(502, error.code === 'mfa_required' ? 'mfa_required' : 'blackboard_login_failed', error.message);
      throw new HttpError(502, 'blackboard_login_failed', 'No fue posible iniciar sesión en Blackboard.');
    }
  }
}
