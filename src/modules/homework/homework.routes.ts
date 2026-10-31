import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { HttpError } from '../../shared/errors.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { getDeliverable, getHomework, listSettings, setEnabled } from './homework.js';

const uuidParam = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } } as const;
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ggb: 'application/vnd.geogebra.file' } as const;

export async function homeworkRoutes(app: FastifyInstance, { db }: { db: Database }): Promise<void> {
  const auth = requireAuth();
  const userId = (request: Parameters<typeof currentSession>[0]) => currentSession(request).user_id;

  // Bandera por materia (apagada por defecto). Es independiente de la de las guías de estudio.
  app.get('/homework/settings', { preHandler: auth, schema: { tags: ['homework'] } }, async (request) => ({ courses: await listSettings(db, userId(request)) }));

  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>('/courses/:id/homework/setting', {
    preHandler: auth,
    schema: { tags: ['homework'], params: uuidParam, body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (request) => {
    if (!(await setEnabled(db, userId(request), request.params.id, request.body.enabled))) throw new HttpError(404, 'not_found', 'Recurso no encontrado.');
    return { courseId: request.params.id, enabled: request.body.enabled };
  });

  // Estado de la tarea de una actividad y lista de archivos.
  app.get<{ Params: { id: string } }>('/activities/:id/homework', { preHandler: auth, schema: { tags: ['homework'], params: uuidParam } },
    async (request) => getHomework(db, userId(request), request.params.id));

  // Descarga de un archivo de la tarea (solo el dueño; el nombre debe estar en la lista de entregables).
  app.get<{ Params: { id: string; name: string } }>('/activities/:id/homework/files/:name', {
    preHandler: auth,
    schema: { tags: ['homework'], params: { type: 'object', required: ['id', 'name'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (request, reply) => {
    const { bytes, kind } = await getDeliverable(db, userId(request), request.params.id, request.params.name);
    return reply.header('Content-Type', MIME[kind]).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${kind === 'pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(request.params.name)}`)
      .header('Content-Length', bytes.length).send(bytes);
  });
}
