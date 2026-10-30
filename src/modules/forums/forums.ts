// Foros: lectura de la consigna del docente y de participaciones de compañeros (solo lectura, solo cuando el estudiante lo pide),
// y sugerencia de respuesta con IA. Reglas:
//  - Nunca se publica nada en Blackboard: la IA da el texto y el estudiante lo pega.
//  - A la IA solo llegan la consigna, el material de la carpeta y, si el estudiante lo pide, el TEXTO de algunas participaciones
//    de compañeros SIN nombres. Esos textos no se guardan.
import type { Database } from '../../database/connection.js';
import { HttpError } from '../../shared/errors.js';
import type { BlackboardSessions } from '../files/sessions.js';

export const FORUM_HANDLER = 'resource/x-bb-forumlink';

export interface ForumRef {
  enrollmentId: string; courseId: string; columnId: string | null; contentExternalId: string; accountId: string; courseExternalId: string; forumId: string;
  title: string; dueAt: string | null; instructorName: string | null; contentId: string; cachedPrompt: string | null; submitted: boolean | null; ownGiven: string | null; ownFamily: string | null;
}
export interface ClassmatePost { given: string; full: string; text: string }
export type PromptStatus = 'ok' | 'forbidden' | 'empty' | 'no_session' | 'error';

const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
export const plain = (html: string) => html.replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const bodyOf = (message: Record<string, unknown>) => {
  const body = message.body;
  if (typeof body === 'string') return plain(body);
  const o = (body ?? {}) as { displayText?: string; rawText?: string };
  return plain(o.displayText || o.rawText || '');
};
/** Nombre de pila para saludar: Blackboard lo guarda en mayúsculas («ANA MARIA» → «Ana»). */
const firstName = (given: unknown) => { const w = String(given ?? '').trim().split(/\s+/)[0] ?? ''; return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); };
/** Nombre completo para que el estudiante sepa a quién responder (solo se muestra; no se envía a la IA). */
const fullName = (given: unknown, family: unknown) => `${given ?? ''} ${family ?? ''}`.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const nameMatches = (given: unknown, family: unknown, full: string | null) => {
  if (!full) return false;
  const author = norm(`${given ?? ''} ${family ?? ''}`); const set = new Set(norm(full));
  return author.length > 1 && author.every((w) => set.has(w));
};

type Row = {
  enrollment_id: string; course_id: string; column_id: string | null; account_id: string; course_external_id: string; forum_id: string | null; name: string; due: Date | null;
  instructor_name: string | null; content_id: string; content_external_id: string; body_text: string | null; submitted: boolean | null; given_name: string | null; family_name: string | null;
};
const toRef = (r: Row): ForumRef | null => r.forum_id ? {
  enrollmentId: r.enrollment_id, courseId: r.course_id, columnId: r.column_id, contentExternalId: r.content_external_id, accountId: r.account_id, courseExternalId: r.course_external_id, forumId: r.forum_id, title: r.name,
  dueAt: r.due ? new Date(r.due).toISOString() : null, instructorName: r.instructor_name, contentId: r.content_id, cachedPrompt: r.body_text?.trim() || null, submitted: r.submitted, ownGiven: r.given_name, ownFamily: r.family_name,
} : null;

export interface ForumInfo { available: boolean; windows: Array<{ start: string | null; end: string | null }> }

/** Ventana de disponibilidad del foro en Blackboard (solo lectura): es lo que significa «condicionado». Falla en silencio: es información de apoyo. */
export async function readForumInfo(sessions: BlackboardSessions | null, ref: ForumRef): Promise<ForumInfo | null> {
  if (!sessions) return null;
  try {
    const session = await sessions.acquire(ref.accountId);
    const response = await session.transport.get(`/learn/api/v1/courses/${ref.courseExternalId}/contents/${ref.contentExternalId}`);
    if (response.status !== 200) return null;
    const body = response.body as { adaptiveReleaseRules?: { rules?: Array<{ criteria?: Array<{ type?: string; start?: string; end?: string }> }> } } | null;
    const windows = (body?.adaptiveReleaseRules?.rules ?? []).flatMap((rule) => rule.criteria ?? []).filter((c) => c.type === 'Date_Range').map((c) => ({ start: c.start ?? null, end: c.end ?? null }));
    const now = Date.now();
    return { windows, available: windows.length === 0 || windows.some((w) => (!w.start || Date.parse(w.start) <= now) && (!w.end || Date.parse(w.end) >= now)) };
  } catch { return null; }
}

/** Resuelve un foro desde la pestaña de contenido (con o sin nota); null si el usuario no lo ve. */
export async function resolveForumByContent(db: Database, userId: string, courseId: string, contentId: string): Promise<ForumRef | null> {
  const { rows } = await db.query<Row>(
    `SELECT ce.id AS enrollment_id, ci.course_id, gc.id AS column_id, ea.id AS account_id, c.external_id AS course_external_id, ci.content_detail->>'id' AS forum_id,
            COALESCE(gc.name, ci.title) AS name, COALESCE(sg.effective_due_at, gc.due_at, ci.due_at) AS due, c.instructor_name, ci.id AS content_id, ci.external_id AS content_external_id,
            ci.body_text, (sg.is_submitted IS TRUE OR EXISTS (SELECT 1 FROM grade_attempts a WHERE a.student_grade_id = sg.id AND a.status <> 'IN_PROGRESS')) AS submitted, ea.given_name, ea.family_name
       FROM course_enrollments ce
       JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.user_id = $1 AND ea.link_status <> 'revoked'
       JOIN enrollment_content_visibility v ON v.enrollment_id = ce.id AND v.missing_since IS NULL
       JOIN course_content_items ci ON ci.id = v.content_item_id AND ci.removed_at_source IS NULL AND ci.handler = $4
       JOIN courses c ON c.id = ci.course_id
       LEFT JOIN gradebook_columns gc ON gc.content_item_id = ci.id
       LEFT JOIN student_grades sg ON sg.enrollment_id = ce.id AND sg.gradebook_column_id = gc.id
      WHERE ce.status = 'active' AND ce.course_id = $2 AND ci.id = $3`, [userId, courseId, contentId, FORUM_HANDLER]);
  return rows[0] ? toRef(rows[0]) : null;
}

/** Resuelve el foro de una actividad del usuario; null si no es un foro suyo. */
export async function resolveForum(db: Database, userId: string, activityId: string): Promise<ForumRef | null> {
  const { rows } = await db.query<Row>(
    `SELECT sg.enrollment_id, sg.course_id, sg.gradebook_column_id AS column_id, ea.id AS account_id, c.external_id AS course_external_id, ci.content_detail->>'id' AS forum_id,
            gc.name, COALESCE(sg.effective_due_at, gc.due_at) AS due, c.instructor_name, ci.id AS content_id, ci.external_id AS content_external_id, ci.body_text, (sg.is_submitted IS TRUE OR EXISTS (SELECT 1 FROM grade_attempts a WHERE a.student_grade_id = sg.id AND a.status <> 'IN_PROGRESS')) AS submitted, ea.given_name, ea.family_name
       FROM student_grades sg
       JOIN course_enrollments ce ON ce.id = sg.enrollment_id
       JOIN external_accounts ea ON ea.id = ce.external_account_id
       JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
       JOIN courses c ON c.id = sg.course_id
       JOIN course_content_items ci ON ci.id = gc.content_item_id AND ci.handler = $3
      WHERE sg.id = $2 AND ea.user_id = $1 AND ea.link_status <> 'revoked' AND ce.status = 'active'`, [userId, activityId, FORUM_HANDLER]);
  return rows[0] ? toRef(rows[0]) : null;
}

const base = (ref: ForumRef) => `/learn/api/v1/courses/${ref.courseExternalId}/discussionboards/default/forums/${ref.forumId}/messages`;
type Message = Record<string, unknown> & { id?: string; subject?: string; givenName?: string; familyName?: string; createdDate?: string; postDate?: string; parentId?: string | null };

/** Consigna del foro = el primer mensaje del docente (en Blackboard el docente publica ahí lo que hay que hacer). */
export async function readPrompt(db: Database, sessions: BlackboardSessions | null, ref: ForumRef): Promise<{ status: PromptStatus; text: string | null; messageId: string | null }> {
  if (!sessions) return { status: 'no_session', text: null, messageId: null };
  try {
    const session = await sessions.acquire(ref.accountId);
    const response = await session.transport.get(base(ref), { limit: '100' });
    if (response.status === 401) { sessions.drop(ref.accountId); return { status: 'error', text: null, messageId: null }; }
    if (response.status === 403) return { status: 'forbidden', text: null, messageId: null };
    if (response.status !== 200) return { status: 'error', text: null, messageId: null };
    const list = ((response.body as { results?: Message[] } | null)?.results ?? []).filter((m) => !m.parentId);
    const teacher = list.find((m) => nameMatches(m.givenName, m.familyName, ref.instructorName)) ?? (ref.instructorName ? undefined : list[0]);
    if (!teacher) return { status: 'empty', text: null, messageId: null };
    const text = bodyOf(teacher);
    if (text.length < 20) return { status: 'empty', text: null, messageId: teacher.id ?? null };
    // Se guarda como instrucciones de la actividad: la ven la pantalla y el agente de tareas.
    await db.query(`UPDATE course_content_items SET body_text = $2 WHERE id = $1 AND COALESCE(btrim(body_text), '') = ''`, [ref.contentId, text.slice(0, 20_000)]);
    return { status: 'ok', text, messageId: teacher.id ?? null };
  } catch (error) {
    if (error instanceof HttpError) return { status: 'no_session', text: null, messageId: null };
    return { status: 'error', text: null, messageId: null };
  }
}

/** Participaciones de compañeros (respuestas a la consigna). Solo en memoria; el nombre de pila es para saludar al mostrar el resultado. */
export async function readClassmatePosts(sessions: BlackboardSessions | null, ref: ForumRef, promptMessageId: string, limit = 6): Promise<ClassmatePost[]> {
  if (!sessions) return [];
  try {
    const session = await sessions.acquire(ref.accountId);
    const response = await session.transport.get(`${base(ref)}/${promptMessageId}/replies`, { limit: '100' });
    if (response.status !== 200) return [];
    const own = ref.ownGiven && ref.ownFamily ? norm(`${ref.ownGiven} ${ref.ownFamily}`).join(' ') : null;
    const replies = ((response.body as { results?: Message[] } | null)?.results ?? [])
      .filter((m) => !nameMatches(m.givenName, m.familyName, ref.instructorName))
      .filter((m) => !own || norm(`${m.givenName ?? ''} ${m.familyName ?? ''}`).join(' ') !== own)
      .map((m) => ({ m, text: bodyOf(m) })).filter(({ text }) => text.length >= 60)
      .sort((a, b) => String(b.m.postDate ?? b.m.createdDate ?? '').localeCompare(String(a.m.postDate ?? a.m.createdDate ?? '')));
    return replies.slice(0, limit).map(({ m, text }) => ({ given: firstName(m.givenName), full: fullName(m.givenName, m.familyName), text: text.slice(0, 1_500) }));
  } catch { return []; }
}

/**
 * ¿Ya participaste en este foro? Con nota: lo dice Blackboard (entrega registrada). Sin nota: se busca tu nombre entre los mensajes del foro
 * (solo lectura). null = no se pudo saber (p. ej. el foro está bloqueado para leerlo).
 */
export async function hasParticipated(sessions: BlackboardSessions | null, ref: ForumRef): Promise<boolean | null> {
  if (ref.submitted === true) return true;
  if (ref.columnId && ref.submitted === false) return false;
  if (!sessions || !ref.ownGiven || !ref.ownFamily) return null;
  try {
    const session = await sessions.acquire(ref.accountId);
    const list = await session.transport.get(base(ref), { limit: '100' });
    if (list.status !== 200) return null;
    const top = ((list.body as { results?: Message[] } | null)?.results ?? []).filter((m) => !m.parentId);
    const own = (m: Message) => nameMatches(m.givenName, m.familyName, `${ref.ownGiven} ${ref.ownFamily}`);
    if (top.some(own)) return true;
    const teacher = top.find((m) => nameMatches(m.givenName, m.familyName, ref.instructorName)) ?? (ref.instructorName ? undefined : top[0]);
    if (!teacher?.id) return false;
    const replies = await session.transport.get(`${base(ref)}/${teacher.id}/replies`, { limit: '100' });
    if (replies.status !== 200) return null;
    return ((replies.body as { results?: Message[] } | null)?.results ?? []).some(own);
  } catch { return null; }
}

export interface SavedSuggestion { postText: string; replies: Array<{ to: string; full?: string; text: string }>; promptSource: 'teacher_post' | 'pasted' | 'title_only'; model: string | null; costUsd: number | null; updatedAt: string }

export async function savedSuggestion(db: Database, ref: Pick<ForumRef, 'enrollmentId' | 'contentId'>): Promise<SavedSuggestion | null> {
  const { rows } = await db.query<{ post_text: string; replies: Array<{ to: string; full?: string; text: string }>; prompt_source: SavedSuggestion['promptSource']; model: string | null; cost_usd: string | null; updated_at: Date }>(
    `SELECT post_text, replies, prompt_source, model, cost_usd, updated_at FROM forum_suggestions WHERE enrollment_id = $1 AND content_item_id = $2`, [ref.enrollmentId, ref.contentId]);
  const r = rows[0];
  return r ? { postText: r.post_text, replies: r.replies, promptSource: r.prompt_source, model: r.model, costUsd: r.cost_usd === null ? null : Number(r.cost_usd), updatedAt: new Date(r.updated_at).toISOString() } : null;
}

export async function saveSuggestion(db: Database, ref: ForumRef, s: { postText: string; replies: Array<{ to: string; text: string }>; promptSource: SavedSuggestion['promptSource']; model: string; inputTokens: number; outputTokens: number; costUsd: number }): Promise<void> {
  await db.query(
    `INSERT INTO forum_suggestions (enrollment_id, course_id, content_item_id, gradebook_column_id, post_text, replies, prompt_source, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $11, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (enrollment_id, content_item_id) DO UPDATE SET post_text = EXCLUDED.post_text, replies = EXCLUDED.replies, prompt_source = EXCLUDED.prompt_source, model = EXCLUDED.model,
       input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, cost_usd = EXCLUDED.cost_usd`,
    [ref.enrollmentId, ref.courseId, ref.contentId, s.postText, JSON.stringify(s.replies), s.promptSource, s.model, s.inputTokens, s.outputTokens, s.costUsd, ref.columnId]);
}
