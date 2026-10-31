// Avisos por Telegram: vincular el chat de cada persona, mandar los avisos nuevos (con horario de silencio) y atender los comandos del bot.
// Es el mismo contenido que la campana de la web: la fuente es la tabla notifications (columna telegram_sent_at).
import { randomBytes } from 'node:crypto';
import type { Database } from '../../database/connection.js';
import { esc, firstName } from './email-layout.js';
import { scanDeadlines, type NotificationKind } from './notifications.js';
import { TelegramError, type TelegramClient, type TelegramUpdate } from './telegram.js';

const TIME_ZONE = 'America/El_Salvador';
const CODE_TTL_MS = 15 * 60_000;
/** Con silencio de 22:00 a 6:00; solo «vence en pocas horas» se salta el silencio. */
const QUIET_FROM = 22; const QUIET_TO = 6;
const URGENT: NotificationKind[] = ['due_soon'];
const DIGEST_OVER = 5;
const MAX_AGE_HOURS = 48;

const EMOJI: Record<NotificationKind, string> = {
  guide_ready: '📘', homework_ready: '📝', activity_new: '🆕', due_changed: '📅', due_tomorrow: '⏰', due_today: '🔔', due_soon: '⏳',
  grade_new: '✅', grade_changed: '🔄', announcement_new: '📢',
};

const localHour = (date: Date) => Number(date.toLocaleString('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hour12: false })) % 24;
export const inQuietHours = (date: Date) => { const h = localHour(date); return h >= QUIET_FROM || h < QUIET_TO; };

// ── Vincular ─────────────────────────────────────────────────────────────────────────────────────────────

/** Código de un solo uso (15 min) para el enlace t.me/bot?start=CODIGO. Reemplaza los códigos anteriores sin usar. */
export async function createLinkCode(db: Database, userId: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await db.query(`DELETE FROM telegram_link_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await db.query(`INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES ($1, $2, $3)`, [code, userId, expiresAt.toISOString()]);
  return { code, expiresAt };
}

export interface TelegramStatus { linked: boolean; enabled: boolean; username: string | null }
export async function telegramStatus(db: Database, userId: string): Promise<TelegramStatus> {
  const { rows } = await db.query<{ enabled: boolean; tg_username: string | null }>(`SELECT enabled, tg_username FROM telegram_links WHERE user_id = $1`, [userId]);
  return rows[0] ? { linked: true, enabled: rows[0].enabled, username: rows[0].tg_username } : { linked: false, enabled: false, username: null };
}
export const unlinkTelegram = async (db: Database, userId: string) => { await db.query(`DELETE FROM telegram_link_codes WHERE user_id = $1`, [userId]); await db.query(`DELETE FROM telegram_links WHERE user_id = $1`, [userId]); };
export const setTelegramEnabled = async (db: Database, userId: string, enabled: boolean) => { await db.query(`UPDATE telegram_links SET enabled = $2 WHERE user_id = $1`, [userId, enabled]); };
export async function telegramChat(db: Database, userId: string): Promise<number | null> {
  const { rows } = await db.query<{ chat_id: string }>(`SELECT chat_id FROM telegram_links WHERE user_id = $1`, [userId]);
  return rows[0] ? Number(rows[0].chat_id) : null;
}

// ── Comandos del bot ─────────────────────────────────────────────────────────────────────────────────────

const HELP = [
  '<b>Academic Hub</b>', 'Te aviso de entregas por vencer, notas, actividades nuevas, anuncios y guías listas.', '',
  '/pausar · dejo de mandarte avisos', '/reanudar · vuelvo a mandártelos', '/estado · ver si estás conectado',
  '', 'Para conectar tu cuenta usa el botón «Conectar Telegram» en la página de Notificaciones de Academic Hub.',
].join('\n');

export async function handleUpdate(db: Database, client: TelegramClient, update: TelegramUpdate, now = new Date()): Promise<void> {
  const message = update.message;
  if (!message?.text || message.chat.type !== 'private') return;
  const chatId = message.chat.id;
  const [command = '', arg = ''] = message.text.trim().split(/\s+/);
  const reply = (html: string) => client.sendMessage(chatId, html).catch(() => {});

  if (command === '/start' || command.startsWith('/start@')) {
    if (!/^[A-Za-z0-9]{16,64}$/.test(arg)) {
      const { rows } = await db.query(`SELECT 1 FROM telegram_links WHERE chat_id = $1`, [chatId]);
      await reply(rows.length > 0 ? '✅ Ya estás conectado. Usa /ayuda para ver los comandos.' : `${HELP}`);
      return;
    }
    // El código se canjea de forma atómica: solo una vez y solo si no venció.
    const claimed = await db.query<{ user_id: string }>(
      `UPDATE telegram_link_codes SET used_at = now() WHERE code = $1 AND used_at IS NULL AND expires_at > $2::timestamptz RETURNING user_id`, [arg, now.toISOString()]);
    const userId = claimed.rows[0]?.user_id;
    if (!userId) { await reply('⚠️ Ese enlace ya se usó o venció. Genera uno nuevo con «Conectar Telegram» en Academic Hub.'); return; }
    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM telegram_links WHERE chat_id = $1 AND user_id <> $2`, [chatId, userId]);
      await tx.query(
        `INSERT INTO telegram_links (user_id, chat_id, tg_username, enabled) VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, tg_username = EXCLUDED.tg_username, enabled = true, linked_at = now()`,
        [userId, chatId, message.chat.username ?? message.chat.first_name ?? null]);
      // Lo anterior a conectarse no se manda: solo los avisos que lleguen desde ahora.
      await tx.query(`UPDATE notifications SET telegram_sent_at = now() WHERE user_id = $1 AND telegram_sent_at IS NULL`, [userId]);
    });
    const { rows } = await db.query<{ name: string | null }>(`SELECT COALESCE(display_name, username) AS name FROM users WHERE id = $1`, [userId]);
    await reply(`✅ <b>¡Listo${rows[0]?.name ? `, ${esc(firstName(rows[0].name))}` : ''}!</b>\nDesde ahora te aviso aquí de lo mismo que ves en la campana de Academic Hub.\n\nDe 10 p. m. a 6 a. m. guardo los avisos y te los mando en la mañana (solo «vence en pocas horas» llega siempre).\n\n/pausar · /reanudar · /estado`);
    return;
  }

  const link = (await db.query<{ user_id: string; enabled: boolean }>(`SELECT user_id, enabled FROM telegram_links WHERE chat_id = $1`, [chatId])).rows[0];
  if (command === '/pausar' || command === '/stop') {
    if (link) { await setTelegramEnabled(db, link.user_id, false); await reply('⏸️ Listo, pausé los avisos. Usa /reanudar para volver a recibirlos.'); } else await reply(HELP);
  } else if (command === '/reanudar') {
    if (link) {
      await setTelegramEnabled(db, link.user_id, true);
      await db.query(`UPDATE notifications SET telegram_sent_at = now() WHERE user_id = $1 AND telegram_sent_at IS NULL`, [link.user_id]);
      await reply('▶️ Avisos reanudados. Te aviso de lo que llegue desde ahora.');
    } else await reply(HELP);
  } else if (command === '/estado') {
    await reply(link ? (link.enabled ? '✅ Conectado y recibiendo avisos.' : '⏸️ Conectado, pero en pausa. Usa /reanudar.') : '❌ Este chat no está conectado a ninguna cuenta.');
  } else {
    await reply(HELP);
  }
}

// ── Mandar los avisos pendientes ─────────────────────────────────────────────────────────────────────────

interface Pending { id: string; user_id: string; kind: NotificationKind; title: string; body: string | null; link: string | null; chat_id: string }

function format(item: Pending, webUrl: string | null): string {
  const link = webUrl && item.link ? `\n<a href="${esc(webUrl.replace(/\/$/, '') + item.link)}">Abrir en Academic Hub</a>` : '';
  return `${EMOJI[item.kind] ?? '🔔'} <b>${esc(item.title)}</b>${item.body ? `\n${esc(item.body)}` : ''}${link}`;
}

/**
 * Manda por Telegram los avisos nuevos de quienes tienen el chat conectado. En horario de silencio solo salen los urgentes;
 * los demás se mandan al terminar. Si se juntan muchos, van en un solo mensaje. Lo que ya se leyó en la web no se manda.
 */
export async function dispatchPending(db: Database, client: TelegramClient, options: { now?: Date; webUrl?: string | null } = {}): Promise<{ sent: number; held: number }> {
  const now = options.now ?? new Date();
  if (!client.configured) return { sent: 0, held: 0 };
  const quiet = inQuietHours(now);
  const { rows } = await db.query<Pending>(
    `SELECT n.id, n.user_id, n.kind, n.title, n.body, n.link, l.chat_id
       FROM notifications n JOIN telegram_links l ON l.user_id = n.user_id AND l.enabled
      WHERE n.telegram_sent_at IS NULL AND n.read_at IS NULL AND n.dismissed_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > $1::timestamptz)
        AND n.created_at > $1::timestamptz - make_interval(hours => $2)
      ORDER BY n.user_id, n.created_at`, [now.toISOString(), MAX_AGE_HOURS]);
  const byUser = new Map<string, Pending[]>();
  for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
  let sent = 0; let held = 0;
  for (const [userId, all] of byUser) {
    const items = quiet ? all.filter((i) => URGENT.includes(i.kind)) : all;
    held += all.length - items.length;
    if (items.length === 0) continue;
    const chatId = Number(items[0]!.chat_id);
    const messages = items.length > DIGEST_OVER
      ? [`🔔 <b>Tienes ${items.length} avisos nuevos</b>\n\n${items.slice(0, 12).map((i) => `${EMOJI[i.kind] ?? '•'} ${esc(i.title)}`).join('\n')}${items.length > 12 ? `\n… y ${items.length - 12} más` : ''}`]
      : items.map((i) => format(i, options.webUrl ?? null));
    try {
      for (const text of messages) await client.sendMessage(chatId, text);
      await db.query(`UPDATE notifications SET telegram_sent_at = now() WHERE id = ANY($1::uuid[])`, [items.map((i) => i.id)]);
      sent += items.length;
    } catch (error) {
      // Bloqueó el bot o borró el chat: se desconecta. Cualquier otro fallo se reintenta en la siguiente vuelta.
      if (error instanceof TelegramError && error.code === 'telegram_blocked') await db.query(`UPDATE telegram_links SET enabled = false WHERE user_id = $1`, [userId]);
    }
  }
  return { sent, held };
}

/** Recalcula los recordatorios de entrega de todos (así llegan aunque nadie abra la web). */
export async function scanEveryone(db: Database, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE status = 'active'`);
  let created = 0;
  for (const user of rows) { try { created += await scanDeadlines(db, user.id, now); } catch { /* un usuario con problemas no frena a los demás */ } }
  return created;
}

// ── Atender al bot ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Atiende los mensajes pendientes del bot (getUpdates). Sin espera sirve para llamarlo desde una rutina cada minuto; con espera (long polling)
 * lo usa el servidor para atender al bot al instante. Recuerda el último mensaje atendido en la base de datos.
 */
export async function pollOnce(db: Database, client: TelegramClient, waitSeconds = 0): Promise<number> {
  if (!client.configured) return 0;
  const { rows } = await db.query<{ last: string }>(`SELECT last_update_id AS last FROM telegram_state WHERE id`);
  const updates = await client.getUpdates(rows[0] ? Number(rows[0].last) + 1 : 0, waitSeconds);
  let last = rows[0] ? Number(rows[0].last) : -1;
  for (const update of updates) {
    last = Math.max(last, update.update_id);
    try { await handleUpdate(db, client, update); } catch { /* un mensaje con problemas no frena a los demás */ }
  }
  if (updates.length > 0) {
    await db.query(`INSERT INTO telegram_state (id, last_update_id) VALUES (true, $1) ON CONFLICT (id) DO UPDATE SET last_update_id = EXCLUDED.last_update_id, updated_at = now()`, [last]);
  }
  return updates.length;
}

// ── Procesos en segundo plano (el servidor los arranca solo; con BACKGROUND_JOBS=false se usan los endpoints /jobs/*) ──

export interface LoopOptions {
  webUrl?: string | null;
  onError?: (error: unknown) => void;
  /** Cada cuánto se mandan por Telegram los avisos pendientes (30 s por defecto). */
  dispatchEveryMs?: number;
  /** Cada cuánto se recalculan los recordatorios de entrega de todos (10 min por defecto). */
  scanEveryMs?: number;
  /** Primer cálculo de recordatorios tras arrancar (5 s por defecto). */
  firstScanAfterMs?: number;
  /** Espera tras un error al consultar a Telegram (5 s por defecto). */
  errorDelayMs?: number;
}

/** Atiende al bot con long polling (no necesita dirección pública), manda los avisos cada 30 s y recalcula los recordatorios cada 10 min. Devuelve la función para detenerlo. */
export function startTelegramLoops(db: Database, client: TelegramClient, options: LoopOptions = {}): () => void {
  let running = true;
  const report = (error: unknown) => options.onError?.(error);
  const deliver = () => dispatchPending(db, client, { webUrl: options.webUrl });
  const scanAndDeliver = () => scanEveryone(db).then(deliver);

  void (async () => {
    while (running) {
      try { await pollOnce(db, client, 25); } catch (error) {
        report(error);
        await new Promise((resolve) => setTimeout(resolve, options.errorDelayMs ?? 5000));
      }
    }
  })();

  const tick = setInterval(() => { void deliver().catch(report); }, options.dispatchEveryMs ?? 30_000);
  const scan = setInterval(() => { void scanAndDeliver().catch(report); }, options.scanEveryMs ?? 10 * 60_000);
  const first = setTimeout(() => { void scanAndDeliver().catch(report); }, options.firstScanAfterMs ?? 5000);
  tick.unref(); scan.unref(); first.unref();
  return () => { running = false; clearInterval(tick); clearInterval(scan); clearTimeout(first); };
}
