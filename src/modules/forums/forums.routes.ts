import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import type { BlackboardSessions } from '../files/sessions.js';
import { createFileStore } from '../files/store.js';
import { gatherMaterial } from '../guides/material.js';
import { monthlySpend } from '../homework/homework.js';
import { readClassmatePosts, readForumInfo, readPrompt, resolveForum, resolveForumByContent, saveSuggestion, savedSuggestion, type ClassmatePost, type ForumRef } from './forums.js';
import { SuggestError, type ForumSuggester } from './suggest.js';

const uuidParam = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } } as const;
const contentParams = { type: 'object', required: ['courseId', 'contentId'], additionalProperties: false, properties: { courseId: { type: 'string', format: 'uuid' }, contentId: { type: 'string', format: 'uuid' } } } as const;
const suggestionBody = { type: 'object', additionalProperties: false, properties: { includeReplies: { type: 'boolean' }, prompt: { type: 'string', maxLength: 8000 } } } as const;
export interface ForumDeps { db: Database; sessions: BlackboardSessions | null; suggester: ForumSuggester; capUsd: number }
type SuggestBody = { includeReplies?: boolean; prompt?: string };

export async function forumsRoutes(app: FastifyInstance, { db, sessions, suggester, capUsd }: ForumDeps): Promise<void> {
  const auth = requireAuth();
  const userId = (request: Parameters<typeof currentSession>[0]) => currentSession(request).user_id;
  const store = createFileStore(sessions);

  /** Lo que ya se sabe del foro (sin llamar a Blackboard) y la última sugerencia guardada. */
  const state = async (ref: ForumRef) => ({
    isForum: true, title: ref.title, dueAt: ref.dueAt, graded: ref.columnId !== null, prompt: ref.cachedPrompt, canReadLive: Boolean(sessions), aiConfigured: suggester.configured, suggestion: await savedSuggestion(db, ref),
  });

  // Botón «Generar sugerencia de respuesta»: solo se ejecuta cuando el estudiante lo pide.
  const generate = async (ref: ForumRef, body: SuggestBody | undefined) => {
    if (!suggester.configured) throw new HttpError(503, 'ai_not_configured', 'La IA no está conectada.');
    const { spent } = await monthlySpend(db);
    if (spent + 0.05 > capUsd) throw new HttpError(429, 'monthly_cap', 'Se alcanzó el tope mensual de gasto en IA para tareas.');

    const pasted = body?.prompt?.trim() || null;
    let prompt = pasted ?? ref.cachedPrompt; let source: 'teacher_post' | 'pasted' | 'title_only' = pasted ? 'pasted' : prompt ? 'teacher_post' : 'title_only';
    let messageId: string | null = null; let promptStatus: string = prompt ? 'cached' : 'unread';
    // Lectura en vivo (solo lectura): trae la consigna si no se tiene y el identificador del mensaje del docente si se piden respuestas.
    if ((!prompt || body?.includeReplies) && !pasted) {
      const live = await readPrompt(db, sessions, ref);
      promptStatus = live.status; messageId = live.messageId;
      if (live.text) { prompt = live.text; source = 'teacher_post'; }
    } else if (body?.includeReplies && pasted) {
      messageId = (await readPrompt(db, sessions, ref)).messageId;
    }
    // Participaciones de compañeros: solo en memoria, solo si se pidió, y sin sus nombres hacia la IA.
    const classmates: ClassmatePost[] = body?.includeReplies && messageId ? await readClassmatePosts(sessions, ref, messageId) : [];

    // El material de la carpeta se toma de la columna de notas; un foro sin nota no la tiene.
    const material = ref.columnId ? await gatherMaterial(db, store, { guideId: 'forum', enrollmentId: ref.enrollmentId, courseId: ref.courseId, gradebookColumnId: ref.columnId }, 30_000).then(
      (m) => m.docs.filter((d) => d.role !== 'instrucciones').map((d) => `«${d.title}»:\n${d.text}`).join('\n\n').slice(0, 30_000), () => '') : '';
    let result;
    try {
      result = await suggester.suggest({ title: ref.title, dueAt: ref.dueAt, prompt, material, classmates, enrollmentId: ref.enrollmentId, courseId: ref.courseId, columnId: ref.columnId });
    } catch (error) {
      const code = error instanceof SuggestError ? error.code : 'generation_failed';
      throw new HttpError(code === 'openai_rate_limit' ? 429 : 502, code, 'No fue posible generar la sugerencia. Inténtalo de nuevo.');
    }
    const replies = result.replies.map((r) => ({ to: classmates[r.index - 1]!.given || 'compañero', full: classmates[r.index - 1]!.full, text: r.text.replace(/\{nombre\}/gi, classmates[r.index - 1]!.given || 'compañero') }));
    await saveSuggestion(db, ref, { postText: result.postText, replies, promptSource: source, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd });
    return { suggestion: await savedSuggestion(db, ref), promptStatus, repliesRead: classmates.length };
  };

  // Desde una actividad.
  app.get<{ Params: { id: string } }>('/activities/:id/forum', { preHandler: auth, schema: { tags: ['forums'], params: uuidParam } }, async (request) => {
    const ref = await resolveForum(db, userId(request), request.params.id);
    return ref ? state(ref) : { isForum: false };
  });
  app.post<{ Params: { id: string }; Body: SuggestBody }>('/activities/:id/forum/suggestion', { preHandler: auth, schema: { tags: ['forums'], params: uuidParam, body: suggestionBody } }, async (request) => {
    const ref = await resolveForum(db, userId(request), request.params.id);
    if (!ref) throw notFound();
    return generate(ref, request.body);
  });

  // Desde la pestaña de contenido (también foros sin nota). Al abrirlo se lee la consigna en vivo (solo lectura) y se guarda para la próxima vez.
  app.get<{ Params: { courseId: string; contentId: string } }>('/courses/:courseId/content/:contentId/forum', { preHandler: auth, schema: { tags: ['forums'], params: contentParams } }, async (request) => {
    const ref = await resolveForumByContent(db, userId(request), request.params.courseId, request.params.contentId);
    if (!ref) return { isForum: false };
    let promptStatus: string = ref.cachedPrompt ? 'cached' : 'unread';
    if (!ref.cachedPrompt) {
      const live = await readPrompt(db, sessions, ref);
      promptStatus = live.status;
      if (live.text) ref.cachedPrompt = live.text;
    }
    const info = await readForumInfo(sessions, ref);
    return { ...(await state(ref)), promptStatus, availability: info };
  });
  app.post<{ Params: { courseId: string; contentId: string }; Body: SuggestBody }>('/courses/:courseId/content/:contentId/forum/suggestion', {
    preHandler: auth, schema: { tags: ['forums'], params: contentParams, body: suggestionBody },
  }, async (request) => {
    const ref = await resolveForumByContent(db, userId(request), request.params.courseId, request.params.contentId);
    if (!ref) throw notFound();
    return generate(ref, request.body);
  });
}
