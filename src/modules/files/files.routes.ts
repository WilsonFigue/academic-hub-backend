// Archivos de las materias: ver/descargar (con copia local), vista previa de texto y marcas de "revisado".
// Todo parte de la cadena usuario → inscripción activa → contenido visible para esa inscripción; un archivo ajeno responde 404.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../database/connection.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { isPreviewable, previewFile, type Preview } from './extract.js';
import { convertToPdf, officeAvailable, officeFormat } from './office.js';
import { sendReviewMark } from './reviews.js';
import type { BlackboardSessions } from './sessions.js';

const MAX_BYTES = 150 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 60 * 1024 * 1024;
const SEND_TIMEOUT_MS = 60_000;
const FILES_DIR = join(process.cwd(), '.state', 'files');
// Solo se muestran dentro de la página tipos que el navegador no ejecuta; todo lo demás se descarga.
const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|video\/mp4|audio\/(mpeg|mp4|wav)|text\/plain)$/;

interface Item {
  enrollmentId: string; accountId: string; courseExternalId: string; id: string; externalId: string; courseId: string;
  title: string; handler: string; externalUrl: string | null; bodyHtml: string | null; bodyText: string | null;
  file: { fileName: string; mimeType: string; fileSize: number; permanentUrl?: string; viewerUrl?: string } | null;
  completion: unknown;
  review: { state: string; markedAt: string; sentAt: string | null; alreadyCompleted: boolean } | null;
}

const params = {
  type: 'object', required: ['courseId', 'contentId'], additionalProperties: false,
  properties: { courseId: { type: 'string', format: 'uuid' }, contentId: { type: 'string', format: 'uuid' } },
} as const;

async function resolveItem(db: Database, userId: string, courseId: string, contentId: string): Promise<Item> {
  const { rows } = await db.query<{
    enrollment_id: string; account_id: string; course_external_id: string; id: string; external_id: string; course_id: string; title: string; handler: string;
    external_url: string | null; body_html: string | null; body_text: string | null; detail: { file?: Item['file'] } | null;
    completion: unknown; review: Item['review'];
  }>(
    `SELECT ce.id AS enrollment_id, ea.id AS account_id, c.external_id AS course_external_id, ci.id, ci.external_id, ci.course_id, ci.title, ci.handler,
            ci.external_url, ci.body_html_sanitized AS body_html, ci.body_text, ci.content_detail AS detail, v.completion,
            CASE WHEN m.enrollment_id IS NOT NULL THEN jsonb_build_object('state', m.state, 'markedAt', m.marked_at, 'sentAt', m.sent_at, 'alreadyCompleted', m.already_completed) END AS review
       FROM course_enrollments ce
       JOIN external_accounts ea ON ea.id = ce.external_account_id AND ea.user_id = $1 AND ea.link_status <> 'revoked'
       JOIN enrollment_content_visibility v ON v.enrollment_id = ce.id AND v.missing_since IS NULL
       JOIN course_content_items ci ON ci.id = v.content_item_id AND ci.removed_at_source IS NULL
       JOIN courses c ON c.id = ci.course_id
       LEFT JOIN content_review_marks m ON m.enrollment_id = ce.id AND m.content_item_id = ci.id
      WHERE ce.status = 'active' AND ce.course_id = $2 AND ci.id = $3`,
    [userId, courseId, contentId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  const file = row.detail?.file && typeof row.detail.file.fileName === 'string' ? row.detail.file : null;
  return { enrollmentId: row.enrollment_id, accountId: row.account_id, courseExternalId: row.course_external_id, id: row.id, externalId: row.external_id,
    courseId: row.course_id, title: row.title, handler: row.handler, externalUrl: row.external_url, bodyHtml: row.body_html, bodyText: row.body_text, file,
    completion: row.completion, review: row.review };
}

/** URL que entrega los bytes: se quita el render en línea (que lleva a un visor HTML) y se fuerza la descarga. */
function rawFileUrl(file: NonNullable<Item['file']>): string {
  const base = file.permanentUrl ?? file.viewerUrl;
  if (!base) throw new HttpError(422, 'file_without_url', 'Este elemento no tiene un archivo descargable.');
  const [path = '', search = ''] = base.split('?');
  const query = new URLSearchParams(search);
  query.delete('render'); query.delete('isInlineRender'); query.set('xythos-download', 'true');
  return `${path}?${query.toString()}`;
}

export function filesRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: BlackboardSessions | null }, done: () => void): void {
  const auth = requireAuth();
  const userId = (request: FastifyRequest) => currentSession(request).user_id;
  mkdirSync(FILES_DIR, { recursive: true });
  const inFlight = new Map<string, Promise<void>>();

  /** ¿Se puede mostrar tal cual? PDF siempre (visor del navegador); Word, PowerPoint y Excel si este equipo tiene Office para convertirlos. */
  function canRender(item: Item): 'pdf' | 'office' | null {
    if (!item.file) return null;
    if (item.file.mimeType === 'application/pdf') return 'pdf';
    const format = officeFormat(item.file.mimeType, item.file.fileName);
    return format && officeAvailable(format.kind) ? 'office' : null;
  }
  const converting = new Map<string, Promise<string>>();
  const sending = new Map<string, Promise<boolean>>();

  /** Copia local del archivo: si no existe, se descarga una vez con la sesión del estudiante. */
  async function ensureFile(item: Item): Promise<string> {
    const target = join(FILES_DIR, item.id);
    if (existsSync(target) && statSync(target).size > 0) return target;
    if (!item.file) throw new HttpError(422, 'not_a_file', 'Este elemento no es un archivo.');
    if (item.file.fileSize > MAX_BYTES) throw new HttpError(413, 'file_too_large', 'El archivo es demasiado grande para verlo aquí; ábrelo en Blackboard.');
    if (!sessions) throw new HttpError(503, 'files_unavailable', 'Abrir archivos por primera vez requiere las credenciales recordadas y la clave de cifrado configurada.');
    let job = inFlight.get(item.id);
    if (!job) {
      job = (async () => {
        const session = await sessions.acquire(item.accountId);
        const response = await session.download(rawFileUrl(item.file!));
        if (response.status < 200 || response.status >= 300 || !response.body) {
          if (response.status === 401 || response.status === 403) sessions.drop(item.accountId);
          throw new HttpError(502, 'file_not_available', 'Blackboard no entregó el archivo.');
        }
        if (response.contentType === 'text/html' && !item.file!.mimeType.startsWith('text/')) {
          sessions.drop(item.accountId);
          throw new HttpError(502, 'file_not_available', 'Blackboard devolvió una página en lugar del archivo (la sesión pudo caducar).');
        }
        if (response.contentLength && response.contentLength > MAX_BYTES) throw new HttpError(413, 'file_too_large', 'El archivo es demasiado grande para verlo aquí.');
        const part = `${target}.part`;
        let size = 0;
        const limit = new Transform({ transform(chunk: Buffer, _enc, cb) { size += chunk.length; cb(size > MAX_BYTES ? new Error('file_too_large') : null, chunk); } });
        try {
          await pipeline(Readable.fromWeb(response.body as never), limit, createWriteStream(part, { mode: 0o600 }));
          renameSync(part, target);
        } catch (error) {
          try { unlinkSync(part); } catch { /* ya no existe */ }
          throw error instanceof HttpError ? error : new HttpError(502, 'file_not_available', 'No fue posible descargar el archivo.');
        }
      })().finally(() => inFlight.delete(item.id));
      inFlight.set(item.id, job);
    }
    await job;
    return target;
  }

  function serve(request: FastifyRequest, reply: FastifyReply, path: string, mimeType: string, fileName: string, download: boolean) {
    const size = statSync(path).size;
    const inline = !download && INLINE.test(mimeType);
    reply.header('Content-Type', mimeType).header('Accept-Ranges', 'bytes').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=300')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(createReadStream(path, { start, end }));
    }
    return reply.header('Content-Length', size).send(createReadStream(path));
  }

  // El documento tal cual: los PDF, tal como están; Word, PowerPoint y Excel convertidos a PDF por el Office de este equipo (y guardados).
  app.get<{ Params: { courseId: string; contentId: string } }>('/courses/:courseId/content/:contentId/render', { preHandler: auth, schema: { tags: ['courses'], params } }, async (request, reply) => {
    const item = await resolveItem(db, userId(request), request.params.courseId, request.params.contentId);
    if (!item.file) throw notFound();
    const original = await ensureFile(item);
    if (item.file.mimeType === 'application/pdf') return serve(request, reply, original, 'application/pdf', item.file.fileName, false);
    const format = officeFormat(item.file.mimeType, item.file.fileName);
    if (!format) throw new HttpError(422, 'render_unavailable', 'Este tipo de archivo no se puede mostrar tal cual.');
    const target = join(FILES_DIR, `${item.id}.pdf`);
    if (!existsSync(target)) {
      let job = converting.get(item.id);
      if (!job) {
        job = convertToPdf(original, format, target).then((result) => {
          if (result !== 'ok') throw new HttpError(422, 'render_unavailable', result === 'unavailable' ? 'Este equipo no tiene Office para mostrar el documento tal cual.' : result === 'shared_instance_legacy' ? 'Este formato antiguo no se convierte mientras tengas Office abierto.' : 'No fue posible convertir el documento.');
          return target;
        }).finally(() => converting.delete(item.id));
        converting.set(item.id, job);
      }
      await job;
    }
    return serve(request, reply, target, 'application/pdf', `${item.file.fileName.replace(/\.[^.]+$/, '')}.pdf`, false);
  });

  app.get<{ Params: { courseId: string; contentId: string }; Querystring: { download?: string } }>('/courses/:courseId/content/:contentId/file', {
    preHandler: auth, schema: { tags: ['courses'], params, querystring: { type: 'object', additionalProperties: false, properties: { download: { type: 'string', enum: ['1'] } } } },
  }, async (request, reply) => {
    const item = await resolveItem(db, userId(request), request.params.courseId, request.params.contentId);
    if (!item.file) throw notFound();
    const path = await ensureFile(item);
    return serve(request, reply, path, item.file.mimeType, item.file.fileName, request.query.download === '1');
  });

  /** Texto y estructura del archivo para leerlo dentro de la app (Word, PowerPoint, Excel, PDF) o el cuerpo de un documento de Blackboard. */
  app.get<{ Params: { courseId: string; contentId: string } }>('/courses/:courseId/content/:contentId/preview', { preHandler: auth, schema: { tags: ['courses'], params } }, async (request) => {
    const item = await resolveItem(db, userId(request), request.params.courseId, request.params.contentId);
    const meta = {
      title: item.title, handler: item.handler, fileName: item.file?.fileName ?? null, mimeType: item.file?.mimeType ?? null, size: item.file?.fileSize ?? null,
      completion: item.completion, review: item.review,
      render: canRender(item),
    };
    if (!item.file) {
      if (item.bodyHtml) return { ...meta, preview: { kind: 'document', html: item.bodyHtml, text: item.bodyText ?? '' } };
      if (item.externalUrl) return { ...meta, preview: { kind: 'link', url: item.externalUrl } };
      return { ...meta, preview: { kind: 'none', reason: 'empty' } };
    }
    if (!isPreviewable(item.file.mimeType, item.file.fileName)) return { ...meta, preview: { kind: 'none', reason: 'unsupported' } };
    if (item.file.fileSize > MAX_PREVIEW_BYTES) return { ...meta, preview: { kind: 'none', reason: 'too_large' } };
    const cache = join(FILES_DIR, `${item.id}.preview.json`);
    if (existsSync(cache)) return { ...meta, preview: JSON.parse(readFileSync(cache, 'utf8')) as Preview };
    const path = await ensureFile(item);
    let preview: Preview | { kind: 'none'; reason: string } | null;
    try {
      preview = await previewFile(readFileSync(path), item.file.mimeType, item.file.fileName);
    } catch {
      return { ...meta, preview: { kind: 'none', reason: 'unreadable' } };
    }
    if (!preview) return { ...meta, preview: { kind: 'none', reason: 'unsupported' } };
    writeFileSync(cache, JSON.stringify(preview), { mode: 0o600 });
    return { ...meta, preview };
  });

  // Marca (o quita, mientras esté pendiente) el contenido como revisado. Se envía a Blackboard en la siguiente actualización.
  app.put<{ Params: { courseId: string; contentId: string }; Body: { reviewed: boolean } }>('/courses/:courseId/content/:contentId/reviewed', {
    preHandler: auth,
    schema: { tags: ['courses'], params, body: { type: 'object', additionalProperties: false, required: ['reviewed'], properties: { reviewed: { type: 'boolean' } } } },
  }, async (request) => {
    const item = await resolveItem(db, userId(request), request.params.courseId, request.params.contentId);
    if (request.body.reviewed) {
      const { rows } = await db.query<{ state: string; marked_at: string; sent_at: string | null; already_completed: boolean }>(
        `INSERT INTO content_review_marks (enrollment_id, content_item_id, course_id) VALUES ($1, $2, $3)
         ON CONFLICT (enrollment_id, content_item_id) DO UPDATE SET
           state = CASE WHEN content_review_marks.state = 'failed' THEN 'pending' ELSE content_review_marks.state END,
           attempts = CASE WHEN content_review_marks.state = 'failed' THEN 0 ELSE content_review_marks.attempts END,
           marked_at = CASE WHEN content_review_marks.state = 'failed' THEN now() ELSE content_review_marks.marked_at END
         RETURNING state, marked_at, sent_at, already_completed`,
        [item.enrollmentId, item.id, item.courseId],
      );
      let row = rows[0]!;
      let sendFailed = false;
      // Envío inmediato a UTEC: con las credenciales recordadas se obtiene la sesión en el momento. Si no se puede, queda pendiente y la próxima actualización lo reintenta.
      if (row.state === 'pending' && sessions) {
        const key = `${item.enrollmentId}:${item.id}`;
        let job = sending.get(key);
        if (!job) {
          job = (async () => {
            const attempts = (await db.query<{ attempts: number }>('SELECT attempts FROM content_review_marks WHERE enrollment_id = $1 AND content_item_id = $2', [item.enrollmentId, item.id])).rows[0]?.attempts ?? 0;
            const session = await sessions.acquire(item.accountId);
            const outcome = await sendReviewMark(db, { enrollmentId: item.enrollmentId, contentItemId: item.id, courseExternalId: item.courseExternalId, contentExternalId: item.externalId, completion: item.completion, attempts },
              async (course, content, reviewed) => { const result = await session.markReviewed(course, content, reviewed); if (result.status === 401 || result.status === 403) sessions.drop(item.accountId); return result; }, false);
            return outcome === 'sent' || outcome === 'already_completed';
          })().catch(() => false).finally(() => sending.delete(key));
          sending.set(key, job);
        }
        sendFailed = !(await Promise.race([job, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SEND_TIMEOUT_MS))]));
        row = (await db.query<typeof row>('SELECT state, marked_at, sent_at, already_completed FROM content_review_marks WHERE enrollment_id = $1 AND content_item_id = $2', [item.enrollmentId, item.id])).rows[0] ?? row;
      }
      return { review: { state: row.state, markedAt: row.marked_at, sentAt: row.sent_at, alreadyCompleted: row.already_completed, sendFailed } };
    }
    const removed = await db.query(`DELETE FROM content_review_marks WHERE enrollment_id = $1 AND content_item_id = $2 AND state IN ('pending', 'failed')`, [item.enrollmentId, item.id]);
    if (!removed.rowCount) {
      const sent = await db.query(`SELECT 1 FROM content_review_marks WHERE enrollment_id = $1 AND content_item_id = $2 AND state = 'sent'`, [item.enrollmentId, item.id]);
      if (sent.rowCount) throw new HttpError(409, 'review_already_sent', 'Ya se envió a UTEC. Para quitarla, desmárcalo en Blackboard.');
    }
    return { review: null };
  });

  done();
}
