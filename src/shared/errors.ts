/** Error con código estable y mensaje seguro para el cliente. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (message = 'Recurso no encontrado.') => new HttpError(404, 'not_found', message);
export const unauthorized = (message = 'Se requiere iniciar sesión.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
