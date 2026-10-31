import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { DEFAULT_POLICY, getGuide, getGuidePdfSource, listSettings, processQueue, requestGuide, setEnabled, type GuideGenerator, type GuidePolicy } from './guides.js';
import { guideDocx } from './docx.js';
import { ensureGuidePdf } from './pdf.js';
import { HttpError } from '../../shared/errors.js';

const uuidParam = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } } as const;

export interface GuidesDeps { db: Database; generator: GuideGenerator; policy?: GuidePolicy; /** Origen de la web (para los enlaces dentro del PDF). */ webOrigin?: string }

export async function guidesRoutes(app: FastifyInstance, { db, generator, policy = DEFAULT_POLICY, webOrigin = 'http://localhost:5173' }: GuidesDeps): Promise<void> {
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

  // PDF de la guía (se arma desde el texto guardado y queda en caché). Con ?download=1 se descarga; sin él se abre en el visor del navegador.
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/activities/:id/study-guide/pdf', {
    preHandler: auth,
    schema: { tags: ['study-guides'], params: uuidParam, querystring: { type: 'object', additionalProperties: false, properties: { download: { type: 'string' } } } },
  }, async (request, reply) => {
    const source = await getGuidePdfSource(db, userId(request), request.params.id);
    let bytes: Buffer;
    try {
      bytes = (await ensureGuidePdf(db, source.guideId, {
        title: source.title, course: source.course, dueAt: source.dueAt, points: source.points, content: source.content, generatedAt: source.generatedAt,
        webUrl: `${webOrigin}/activities/${request.params.id}/guide`, wantsGeoGebra: source.tools.includes('geogebra'),
      })).bytes;
    } catch {
      throw new HttpError(503, 'pdf_unavailable', 'No fue posible generar el PDF en este equipo.');
    }
    const fileName = `Guía de estudio - ${source.title}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return reply.header('Content-Type', 'application/pdf').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=60')
      .header('Content-Disposition', `${request.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}.pdf`)
      .header('Content-Length', bytes.length).send(bytes);
  });

  // La misma guía en Word.
  app.get<{ Params: { id: string } }>('/activities/:id/study-guide/docx', { preHandler: auth, schema: { tags: ['study-guides'], params: uuidParam } }, async (request, reply) => {
    const source = await getGuidePdfSource(db, userId(request), request.params.id);
    const fileName = `Guía de estudio - ${source.title}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const bytes = await guideDocx(source);
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=60')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}.docx`).header('Content-Length', bytes.length).send(bytes);
  });

  // Botón manual: pide la guía de ESTA actividad aunque la materia esté apagada. Si ya existe, 409.
  app.post<{ Params: { id: string } }>('/activities/:id/study-guide', { preHandler: auth, schema: { tags: ['study-guides'], params: uuidParam } }, async (request, reply) => {
    const guide = await requestGuide(db, userId(request), request.params.id);
    // Con IA conectada la generación sigue en segundo plano; la pantalla consulta el estado. Sin IA queda en cola.
    if (generator.configured) void processQueue(db, generator, policy, { limit: 1 }).catch(() => {});
    return reply.code(202).send({ guide, queued: !generator.configured || guide.status === 'requested' });
  });
}
