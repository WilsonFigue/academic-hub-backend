import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { DEFAULT_POLICY, getGuide, listSettings, processQueue, requestGuide, setEnabled, type GuideGenerator, type GuidePolicy } from './guides.js';
import { HttpError } from '../../shared/errors.js';

const uuidParam = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } } as const;

export interface GuidesDeps { db: Database; generator: GuideGenerator; policy?: GuidePolicy }

export async function guidesRoutes(app: FastifyInstance, { db, generator, policy = DEFAULT_POLICY }: GuidesDeps): Promise<void> {
  const auth = requireAuth();
  const userId = (request: Parameters<typeof currentSession>[0]) => currentSession(request).user_id;

  // Ajuste por materia (apagado por defecto).
  app.get('/study-guides/settings', { preHandler: auth, schema: { tags: ['study-guides'] } }, async (request) => ({ courses: await listSettings(db, userId(request)) }));

  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>('/courses/:id/study-guides/setting', {
    preHandler: auth,
    schema: { tags: ['study-guides'], params: uuidParam, body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (request) => {
    if (!(await setEnabled(db, userId(request), request.params.id, request.body.enabled))) throw new HttpError(404, 'not_found', 'Recurso no encontrado.');
    return { courseId: request.params.id, enabled: request.body.enabled };
  });

  // Estado de la guía de una actividad.
  app.get<{ Params: { id: string } }>('/activities/:id/study-guide', { preHandler: auth, schema: { tags: ['study-guides'], params: uuidParam } },
    async (request) => getGuide(db, userId(request), request.params.id));

  // Botón manual: pide la guía de ESTA actividad aunque la materia esté apagada. Si ya existe, 409.
  app.post<{ Params: { id: string } }>('/activities/:id/study-guide', { preHandler: auth, schema: { tags: ['study-guides'], params: uuidParam } }, async (request, reply) => {
    const guide = await requestGuide(db, userId(request), request.params.id);
    // Con IA conectada la generación sigue en segundo plano; la pantalla consulta el estado. Sin IA queda en cola.
    if (generator.configured) void processQueue(db, generator, policy, { limit: 1 }).catch(() => {});
    return reply.code(202).send({ guide, queued: !generator.configured || guide.status === 'requested' });
  });
}
