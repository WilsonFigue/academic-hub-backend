// Copia local de los archivos de Blackboard: si no existe, se descarga una vez con la sesión del estudiante.
// La usan el visor de archivos y el armado del material de las guías de estudio.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../../shared/errors.js';
import type { BlackboardSessions } from './sessions.js';

export const MAX_BYTES = 150 * 1024 * 1024;
export const FILES_DIR = join(process.cwd(), '.state', 'files');

export interface StoredFileRef {
  id: string;
  accountId: string;
  file: { fileName: string; mimeType: string; fileSize: number; permanentUrl?: string; viewerUrl?: string } | null;
}

/** URL que entrega los bytes: se quita el render en línea (que lleva a un visor HTML) y se fuerza la descarga. */
export function rawFileUrl(file: NonNullable<StoredFileRef['file']>): string {
  const base = file.permanentUrl ?? file.viewerUrl;
  if (!base) throw new HttpError(422, 'file_without_url', 'Este elemento no tiene un archivo descargable.');
  const [path = '', search = ''] = base.split('?');
  const query = new URLSearchParams(search);
  query.delete('render'); query.delete('isInlineRender'); query.set('xythos-download', 'true');
  return `${path}?${query.toString()}`;
}

export function createFileStore(sessions: BlackboardSessions | null) {
  mkdirSync(FILES_DIR, { recursive: true });
  const inFlight = new Map<string, Promise<void>>();

  /** Ruta de la copia local del archivo; la descarga si hace falta. */
  async function ensure(item: StoredFileRef): Promise<string> {
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

  return { ensure };
}
