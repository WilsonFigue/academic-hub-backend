// Cliente mínimo de la API de bots de Telegram (solo lo que usamos): getMe, sendMessage, getUpdates y webhook.
// El token va en la URL, así que nunca se registra ni se devuelve en errores.
import { createHash } from 'node:crypto';

export class TelegramError extends Error {
  constructor(readonly code: string, readonly status: number | null = null, message?: string) { super(message ?? code); this.name = 'TelegramError'; }
}


export interface TelegramUpdate { update_id: number; message?: { chat: { id: number; type: string; username?: string; first_name?: string }; text?: string } }

export interface TelegramClient {
  readonly configured: boolean;
  /** Usuario del bot (sin @), para armar el enlace de vinculación. */
  username(): Promise<string | null>;
  sendMessage(chatId: number, html: string): Promise<void>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]>;
  /** Registra la URL a la que Telegram avisa de cada mensaje (con el secreto que Telegram reenvía en una cabecera). */
  setWebhook(url: string): Promise<void>;
  deleteWebhook(): Promise<void>;
  /** Secreto derivado del token para verificar que el webhook viene de Telegram; vacío si no hay bot. */
  webhookSecret(): string;
}

export const notConfiguredTelegram: TelegramClient = {
  configured: false,
  async username() { return null; },
  async sendMessage() { throw new TelegramError('telegram_not_configured'); },
  async getUpdates() { return []; },
  async setWebhook() { throw new TelegramError('telegram_not_configured'); },
  async deleteWebhook() { throw new TelegramError('telegram_not_configured'); },
  webhookSecret() { return ''; },
};

export function createTelegramClient(options: { token: string; fetchFn?: typeof fetch }): TelegramClient {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(options.token)) throw new TelegramError('telegram_bad_token', null, 'El token de Telegram no tiene el formato esperado (123456:ABC…).');
  const doFetch = options.fetchFn ?? fetch;
  const base = `https://api.telegram.org/bot${options.token}`;
  let cachedName: string | null = null;
  const webhookSecret = createHash('sha256').update(`ah-webhook:${options.token}`).digest('hex');

  async function call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal });
    } catch {
      throw new TelegramError('telegram_network');
    }
    let data: { ok?: boolean; result?: T; error_code?: number; description?: string } = {};
    try { data = await response.json() as typeof data; } catch { /* sin JSON */ }
    if (!response.ok || !data.ok) {
      // 403: la persona bloqueó el bot o borró el chat. 429: demasiados mensajes.
      throw new TelegramError(response.status === 403 ? 'telegram_blocked' : response.status === 429 ? 'telegram_rate_limited' : `telegram_${response.status}`, response.status, data.description?.slice(0, 200));
    }
    return data.result as T;
  }

  return {
    configured: true,
    async username() {
      if (cachedName) return cachedName;
      cachedName = (await call<{ username?: string }>('getMe')).username ?? null;
      return cachedName;
    },
    async sendMessage(chatId, html) {
      await call('sendMessage', { chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
    },
    async getUpdates(offset, timeoutSeconds) {
      return call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message'] });
    },
    async setWebhook(url) {
      await call('setWebhook', { url, secret_token: webhookSecret, allowed_updates: ['message'] });
    },
    async deleteWebhook() {
      await call('deleteWebhook', {});
    },
    webhookSecret() { return webhookSecret; },
  };
}
