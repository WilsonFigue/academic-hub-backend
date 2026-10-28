// Rutas internas de desarrollo para el onboarding desde Blackboard UTEC.
// Solo se registran con NODE_ENV=development y DEV_OPERATOR_TOKEN; solo aceptan loopback y no aceptan navegadores (Origin).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../../database/connection.js';
import { safeEqual, sha256 } from '../../shared/crypto.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { createBlackboardGateway, SessionExpiredError } from '../blackboard/gateway.js';
import { LoginError, loginInteractively } from '../blackboard/session-login.js';
import { ImportError, UTEC, importStudent, type ImportSummary } from './import.service.js';

type Phase = 'starting' | 'authenticating' | 'awaiting_mfa' | 'extracting' | 'persisting' | 'completed' | 'failed';

interface Operation {
  id: string;
  phase: Phase;
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  summary: Omit<ImportSummary, 'temporaryPassword'> | null;
  /** Solo en memoria; se entrega una vez y se borra. */
  temporaryPassword: string | null;
  temporaryPasswordDelivered: boolean;
}

const OPERATION_TTL_MS = 30 * 60_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface DevImportOptions {
  db: Database;
  operatorToken: string;
}

export async function devImportRoutes(app: FastifyInstance, { db, operatorToken }: DevImportOptions): Promise<void> {
  const operations = new Map<string, Operation>();
  const tokenHash = sha256(operatorToken);
  let running: string | null = null;

  const sweep = () => {
    for (const [id, operation] of operations) if (Date.now() - operation.updatedAt > OPERATION_TTL_MS && id !== running) operations.delete(id);
  };

  function authorizeOperator(request: FastifyRequest): void {
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw notFound();
    // Un navegador siempre envía Origin en POST: se rechaza para impedir CSRF hacia localhost.
    if (request.headers.origin !== undefined) throw new HttpError(403, 'browser_not_allowed', 'Este endpoint no acepta solicitudes desde navegadores.');
    const header = request.headers['x-dev-operator-token'];
    if (typeof header !== 'string' || !safeEqual(sha256(header), tokenHash)) throw new HttpError(401, 'operator_unauthorized', 'Token de operador inválido.');
  }

  const view = (operation: Operation) => {
    const response: Record<string, unknown> = {
      operationId: operation.id, status: operation.phase, updatedAt: new Date(operation.updatedAt).toISOString(),
    };
    if (operation.errorCode) response.error = { code: operation.errorCode, message: operation.errorMessage };
    if (operation.summary) {
      response.success = true;
      response.user = operation.summary.user;
      response.accountCreated = operation.summary.created;
      response.academicData = operation.summary.academicData;
      response.rows = operation.summary.rows;
      response.sync = operation.summary.sync;
      if (operation.temporaryPassword) {
        // Entrega única: después de esta respuesta la contraseña deja de existir en memoria.
        response.initialAccess = { temporaryPassword: operation.temporaryPassword, mustChangePassword: true, deliveredOnce: true };
        operation.temporaryPassword = null;
        operation.temporaryPasswordDelivered = true;
      } else if (operation.temporaryPasswordDelivered) {
        response.initialAccess = { temporaryPassword: null, mustChangePassword: true, note: 'La contraseña temporal ya fue entregada.' };
      } else if (!operation.summary.created) {
        response.initialAccess = { temporaryPassword: null, note: 'Cuenta existente reutilizada; su contraseña no se modificó.' };
      }
    }
    return response;
  };

  app.post<{ Body: { username: string; password: string } }>('/internal/dev/utec/create-user', {
    logLevel: 'warn',
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    schema: {
      hide: true,
      body: {
        type: 'object', additionalProperties: false, required: ['username', 'password'],
        properties: { username: { type: 'string', minLength: 1, maxLength: 120 }, password: { type: 'string', minLength: 1, maxLength: 256 } },
      },
    },
  }, async (request, reply) => {
    authorizeOperator(request);
    sweep();
    if (running) throw new HttpError(409, 'import_in_progress', 'Ya hay una importación en curso.');

    const operation: Operation = {
      id: randomUUID(), phase: 'starting', createdAt: Date.now(), updatedAt: Date.now(), errorCode: null, errorMessage: null,
      summary: null, temporaryPassword: null, temporaryPasswordDelivered: false,
    };
    operations.set(operation.id, operation);
    running = operation.id;
    const setPhase = (phase: Phase) => { operation.phase = phase; operation.updatedAt = Date.now(); };

    // Las credenciales viven solo en este cierre y se descartan al terminar el login.
    let credentials: { username: string; password: string } | null = { username: request.body.username, password: request.body.password };
    void (async () => {
      let captured: Awaited<ReturnType<typeof loginInteractively>> | null = null;
      try {
        captured = await loginInteractively(UTEC.lmsBaseUrl, credentials!, setPhase);
        credentials = null;
        const summary = await importStudent(db, createBlackboardGateway(captured.transport), setPhase);
        const { temporaryPassword, ...rest } = summary;
        operation.summary = rest;
        operation.temporaryPassword = temporaryPassword;
        setPhase('completed');
      } catch (error) {
        operation.errorCode = error instanceof ImportError || error instanceof LoginError ? error.code
          : error instanceof SessionExpiredError ? 'blackboard_session_expired' : 'import_failed';
        operation.errorMessage = error instanceof ImportError || error instanceof LoginError ? error.message
          : error instanceof SessionExpiredError ? error.message : 'La importación falló. Revisa el registro de sincronización.';
        if (!(error instanceof ImportError || error instanceof LoginError || error instanceof SessionExpiredError)) {
          app.log.error({ err: { name: (error as Error)?.name } }, 'dev import failed');
        }
        setPhase('failed');
      } finally {
        credentials = null;
        captured?.dispose();
        running = null;
      }
    })();

    return reply.code(202).send({ operationId: operation.id, status: operation.phase, poll: `/internal/dev/utec/imports/${operation.id}` });
  });

  app.get<{ Params: { operationId: string } }>('/internal/dev/utec/imports/:operationId', {
    logLevel: 'warn',
    schema: {
      hide: true,
      params: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request) => {
    authorizeOperator(request);
    sweep();
    const operation = operations.get(request.params.operationId);
    if (!operation) throw notFound('Operación no encontrada o expirada.');
    return view(operation);
  });
}
