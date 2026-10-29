// "Marcar como revisado": cola de marcas del estudiante que se envían a Blackboard cuando hay una sesión (en las actualizaciones).
// Solo se envían marcas que el estudiante pidió explícitamente; nunca se marca nada por inferencia.
import type { Database } from '../../database/connection.js';

export const MAX_ATTEMPTS = 3;

/** Blackboard ya muestra el elemento como completado (todas sus partes). */
export function isCompleted(completion: unknown): boolean {
  if (!completion || typeof completion !== 'object') return false;
  const { total, completed } = completion as { total?: number; completed?: number };
  return typeof total === 'number' && total > 0 && typeof completed === 'number' && completed >= total;
}

export type SendOutcome = 'sent' | 'already_completed' | 'retry' | 'failed';

/**
 * Envía una marca pendiente. Estados posibles: ya completado en Blackboard (no se envía nada), enviada, para reintentar o fallida (tras MAX_ATTEMPTS).
 * `countAttempt` = false en el envío inmediato del clic: un fallo ahí no gasta un intento (la actualización lo reintentará).
 */
export async function sendReviewMark(
  db: Database,
  mark: { enrollmentId: string; contentItemId: string; courseExternalId: string; contentExternalId: string; completion: unknown; attempts: number },
  send: Send,
  countAttempt = true,
): Promise<SendOutcome> {
  const key = [mark.enrollmentId, mark.contentItemId];
  if (isCompleted(mark.completion)) {
    await db.query(`UPDATE content_review_marks SET state = 'sent', sent_at = now(), already_completed = true, last_error_code = NULL WHERE enrollment_id = $1 AND content_item_id = $2`, key);
    return 'already_completed';
  }
  const { status } = await send(mark.courseExternalId, mark.contentExternalId, true).catch(() => ({ status: 0 }));
  if (status >= 200 && status < 300) {
    await db.query(`UPDATE content_review_marks SET state = 'sent', sent_at = now(), attempts = attempts + 1, last_error_code = NULL WHERE enrollment_id = $1 AND content_item_id = $2`, key);
    return 'sent';
  }
  const attempts = mark.attempts + (countAttempt ? 1 : 0);
  const final = countAttempt && attempts >= MAX_ATTEMPTS;
  await db.query(`UPDATE content_review_marks SET attempts = $3, state = $4, last_error_code = $5 WHERE enrollment_id = $1 AND content_item_id = $2`,
    [...key, attempts, final ? 'failed' : 'pending', status === 0 ? 'network_error' : `http_${status}`]);
  return final ? 'failed' : 'retry';
}

export interface ReviewDispatchSummary { sent: number; alreadyCompleted: number; failed: number; retry: number }

export type Send = (courseExternalId: string, contentExternalId: string, reviewed: boolean) => Promise<{ status: number }>;

/**
 * Envía las marcas pendientes de una cuenta, una por una.
 * - Si Blackboard ya lo muestra completado: se da por enviada sin tocar nada (already_completed).
 * - 2xx: enviada. Otro estado: se reintenta en la siguiente actualización, hasta MAX_ATTEMPTS; después queda 'failed'.
 */
export async function dispatchReviewMarks(db: Database, accountId: string, send: Send): Promise<ReviewDispatchSummary> {
  const summary: ReviewDispatchSummary = { sent: 0, alreadyCompleted: 0, failed: 0, retry: 0 };
  const { rows } = await db.query<{ enrollment_id: string; content_item_id: string; attempts: number; course_external_id: string; content_external_id: string; completion: unknown }>(
    `SELECT m.enrollment_id, m.content_item_id, m.attempts, c.external_id AS course_external_id, ci.external_id AS content_external_id, v.completion
       FROM content_review_marks m
       JOIN course_enrollments ce ON ce.id = m.enrollment_id AND ce.external_account_id = $1 AND ce.status = 'active'
       JOIN courses c ON c.id = m.course_id
       JOIN course_content_items ci ON ci.id = m.content_item_id
       LEFT JOIN enrollment_content_visibility v ON v.enrollment_id = m.enrollment_id AND v.content_item_id = m.content_item_id
      WHERE m.state = 'pending'
      ORDER BY m.marked_at`,
    [accountId],
  );
  for (const row of rows) {
    const outcome = await sendReviewMark(db, { enrollmentId: row.enrollment_id, contentItemId: row.content_item_id, courseExternalId: row.course_external_id,
      contentExternalId: row.content_external_id, completion: row.completion, attempts: row.attempts }, send);
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome === 'already_completed') summary.alreadyCompleted += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else summary.retry += 1;
  }
  return summary;
}
