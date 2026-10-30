// Bitácoras: peticiones a la API (api_request_log) y uso de IA con tokens y costos (ai_usage_log).
// Registrar nunca debe romper nada: cualquier fallo al escribir un log se descarta en silencio.
import type { Queryable } from '../../database/connection.js';

// El mes de los topes y reportes se cuenta en hora de El Salvador (UTC−6, sin horario de verano).
const SV_OFFSET_MS = 6 * 3_600_000;

/** Instante (UTC) en que empieza el mes de `now` en El Salvador. */
export function monthStart(now: Date = new Date()): Date {
  const local = new Date(now.getTime() - SV_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + SV_OFFSET_MS);
}
export function nextMonthStart(start: Date): Date {
  const local = new Date(start.getTime() - SV_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) + SV_OFFSET_MS);
}
/** 'YYYY-MM-01' del mes de `now` (columna period). */
export function periodOf(now: Date = new Date()): string {
  const local = new Date(monthStart(now).getTime() - SV_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
/** Convierte 'YYYY-MM' en el instante en que empieza ese mes en El Salvador. */
export function monthStartFromKey(key: string): Date | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) + SV_OFFSET_MS) : null;
}

export interface ApiLogEntry {
  requestId?: string | null; method: string; route?: string | null; path: string; status: number; durationMs?: number | null;
  userId?: string | null; ipHash?: Buffer | null; userAgent?: string | null;
  errorCode?: string | null; errorMessage?: string | null; errorDetail?: unknown;
}

export async function logApiRequest(db: Queryable, entry: ApiLogEntry): Promise<void> {
  try {
    const outcome = entry.status >= 500 ? 'server_error' : entry.status >= 400 ? 'client_error' : 'ok';
    const raw = entry.errorDetail === undefined ? null : JSON.stringify(entry.errorDetail);
    const detail = raw !== null && raw.length > 4000 ? JSON.stringify({ truncated: true }) : raw;
    await db.query(
      `INSERT INTO api_request_log (request_id, method, route, path, status, duration_ms, user_id, ip_hash, user_agent, outcome, error_code, error_message, error_detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [entry.requestId ?? null, entry.method, entry.route ?? null, entry.path.slice(0, 500), entry.status, entry.durationMs === null || entry.durationMs === undefined ? null : Math.round(entry.durationMs),
        entry.userId ?? null, entry.ipHash ?? null, entry.userAgent?.slice(0, 300) ?? null, outcome, entry.errorCode ?? null, entry.errorMessage?.slice(0, 500) ?? null,
        detail]);
  } catch { /* un log que falla no debe afectar la petición */ }
}

export interface AiLogEntry {
  event: 'call' | 'run_finished' | 'run_skipped' | 'cap_reached' | 'monthly_report';
  feature: 'homework' | 'study_guide' | 'report';
  runId?: string | null; enrollmentId?: string | null; courseId?: string | null; gradebookColumnId?: string | null; userId?: string | null;
  model?: string | null; turn?: number | null; inputTokens?: number | null; outputTokens?: number | null; cachedTokens?: number | null;
  costUsd?: number; durationMs?: number | null; status?: 'ok' | 'error'; errorCode?: string | null; tools?: string[] | null;
  message?: string | null; detail?: unknown; createdAt?: Date;
}

/** Registra un evento de IA. Si se da la inscripción, el usuario se resuelve solo. */
export async function logAiUsage(db: Queryable, entry: AiLogEntry): Promise<void> {
  try {
    const at = entry.createdAt ?? new Date();
    await db.query(
      `INSERT INTO ai_usage_log (created_at, event, feature, run_id, user_id, enrollment_id, course_id, gradebook_column_id, model, turn, input_tokens, output_tokens, cached_tokens,
                                 cost_usd, duration_ms, status, error_code, tools, period, message, detail)
       VALUES ($1, $2, $3, $4, COALESCE($5::uuid, (SELECT ea.user_id FROM course_enrollments ce JOIN external_accounts ea ON ea.id = ce.external_account_id WHERE ce.id = $6::uuid)),
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [at.toISOString(), entry.event, entry.feature, entry.runId ?? null, entry.userId ?? null, entry.enrollmentId ?? null, entry.courseId ?? null, entry.gradebookColumnId ?? null,
        entry.model ?? null, entry.turn ?? null, entry.inputTokens ?? null, entry.outputTokens ?? null, entry.cachedTokens ?? null, entry.costUsd ?? 0, entry.durationMs === null || entry.durationMs === undefined ? null : Math.round(entry.durationMs),
        entry.status ?? 'ok', entry.errorCode ?? null, entry.tools ?? null, periodOf(at), entry.message?.slice(0, 20_000) ?? null, entry.detail === undefined ? null : JSON.stringify(entry.detail)]);
  } catch { /* un log que falla no debe afectar el trabajo */ }
}

/** Gasto de una función de IA en el mes de `now` (suma de las llamadas registradas). */
export async function aiSpend(db: Queryable, feature: 'homework' | 'study_guide', now: Date = new Date()): Promise<number> {
  const start = monthStart(now);
  const { rows } = await db.query<{ spent: string }>(
    `SELECT COALESCE(sum(cost_usd), 0) AS spent FROM ai_usage_log WHERE event = 'call' AND feature = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
    [feature, start.toISOString(), nextMonthStart(start).toISOString()]);
  return Number(rows[0]!.spent);
}
