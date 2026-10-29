// Rutas internas de desarrollo para el onboarding desde Blackboard UTEC.
// Solo se registran con NODE_ENV=development y DEV_OPERATOR_TOKEN; solo aceptan loopback y no aceptan navegadores (Origin).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../database/connection.js';
import { safeEqual, sha256 } from '../../shared/crypto.js';
import { HttpError, notFound } from '../../shared/errors.js';
import { createBlackboardGateway, SessionExpiredError } from '../blackboard/gateway.js';
import { LoginError, loginInteractively } from '../blackboard/session-login.js';
import { loadCredentials, markCredentialUse, saveCredentials } from '../credentials/vault.js';
import { applyCalendar, importCalendar } from '../calendar/calendar.service.js';
import { dispatchReviewMarks } from '../files/reviews.js';
import { ImportError, UTEC, importStudent, type ImportMode, type ImportSummary } from './import.service.js';

// Tres operaciones con la misma sesión interactiva (usuario + contraseña + MFA manual, solo en memoria):
//  - create-user: primera importación; crea la cuenta si no existe.
//  - refresh/full: actualización completa de una cuenta existente (contenido, materias cerradas e historial).
//  - refresh/daily: actualización ligera de lo que cambia a diario (actividades, notas, calendario, anuncios, pendientes).
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
  /** Se guardaron (cifradas) las credenciales de esta cuenta para la actualización automática. */
  remembered: boolean;
  /** Resultado por cuenta de una actualización con credenciales recordadas. */
  stored: Array<{ username: string; ok: boolean; errorCode: string | null; changesRecorded: number }> | null;
}

const OPERATION_TTL_MS = 30 * 60_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface DevImportOptions {
  db: Database;
  operatorToken: string;
  /** Nota mínima (en %) para marcar una materia cerrada como aprobada; sin valor el resultado queda 'unknown'. */
  passingGradePct?: number | null;
  /** Clave de cifrado de las credenciales recordadas; sin ella no se puede recordar ni programar. */
  credentialsKey?: Buffer | null;
  /** Abre Chromium visible en la actualización con credenciales recordadas (por defecto, sin ventana). */
  scheduledLoginVisible?: boolean;
}

export async function devImportRoutes(app: FastifyInstance, { db, operatorToken, passingGradePct = null, credentialsKey = null, scheduledLoginVisible = false }: DevImportOptions): Promise<void> {
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
    if (operation.stored) response.stored = operation.stored;
    if (operation.summary) {
      response.success = true;
      response.credentialsRemembered = operation.remembered;
      response.user = operation.summary.user;
      response.accountCreated = operation.summary.created;
      response.mode = operation.summary.mode;
      response.academicData = operation.summary.academicData;
      if (operation.summary.history) response.history = operation.summary.history;
      if (operation.summary.skippedClosed) response.skippedClosed = operation.summary.skippedClosed;
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

  const bodySchema = {
    type: 'object', additionalProperties: false, required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 120 }, password: { type: 'string', minLength: 1, maxLength: 256 },
      // El titular pide recordar usuario y contraseña (cifrados) para la actualización diaria automática.
      remember: { type: 'boolean' },
    },
  } as const;

  /** Arranca una operación en segundo plano y responde 202; las credenciales viven solo en este cierre. */
  function launch(request: FastifyRequest<{ Body: { username: string; password: string; remember?: boolean } }>, reply: FastifyReply, mode: ImportMode) {
    authorizeOperator(request);
    sweep();
    if (running) throw new HttpError(409, 'import_in_progress', 'Ya hay una importación en curso.');
    const remember = request.body.remember === true;
    if (remember && !credentialsKey) throw new HttpError(400, 'credentials_key_missing', 'Falta CREDENTIALS_KEY en .env: sin ella no se pueden recordar las credenciales.');

    const operation: Operation = {
      id: randomUUID(), phase: 'starting', createdAt: Date.now(), updatedAt: Date.now(), errorCode: null, errorMessage: null,
      summary: null, temporaryPassword: null, temporaryPasswordDelivered: false, remembered: false, stored: null,
    };
    operations.set(operation.id, operation);
    running = operation.id;
    const setPhase = (phase: Phase) => { operation.phase = phase; operation.updatedAt = Date.now(); };

    // Las credenciales viven solo en este cierre y se descartan al terminar el login.
    let credentials: { username: string; password: string } | null = { username: request.body.username, password: request.body.password };
    // Copia que solo existe si el titular pidió recordarlas; se descarta al terminar.
    let toRemember: { username: string; password: string } | null = remember ? { ...credentials } : null;
    void (async () => {
      let captured: Awaited<ReturnType<typeof loginInteractively>> | null = null;
      try {
        captured = await loginInteractively(UTEC.lmsBaseUrl, credentials!, setPhase);
        credentials = null;
        const session = captured;
        const summary = await importStudent(db, createBlackboardGateway(captured.transport), setPhase, {
          mode, passingGradePct, onIdentity: async (accountId) => { await dispatchReviewMarks(db, accountId, (course, content, reviewed) => session.markReviewed(course, content, reviewed)); },
        });
        await applyCalendar(db, { userId: summary.user.id }).catch(() => {});
        const { temporaryPassword, ...rest } = summary;
        if (toRemember && credentialsKey) {
          const account = await db.query<{ id: string }>(`SELECT id FROM external_accounts WHERE user_id = $1 AND link_status <> 'revoked' ORDER BY created_at LIMIT 1`, [summary.user.id]);
          if (account.rows[0]) { await saveCredentials(db, credentialsKey, account.rows[0].id, toRemember); operation.remembered = true; }
        }
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
        toRemember = null;
        captured?.dispose();
        running = null;
      }
    })();

    return reply.code(202).send({ operationId: operation.id, status: operation.phase, poll: `/internal/dev/utec/imports/${operation.id}` });
  }

  /** Actualización diaria con las credenciales recordadas: inicio de sesión sin ventana y sin intentar saltar ningún MFA. */
  async function runStored(accounts: Array<{ accountId: string; username: string }>, onPhase: (phase: Phase) => void = () => {}) {
    const results: NonNullable<Operation['stored']> = [];
    for (const account of accounts) {
      let captured: Awaited<ReturnType<typeof loginInteractively>> | null = null;
      let errorCode: string | null = null;
      let changes = 0;
      try {
        const credentials = credentialsKey ? await loadCredentials(db, credentialsKey, account.accountId) : null;
        if (!credentials) throw new ImportError('credentials_unreadable', 'No se pueden descifrar las credenciales recordadas.');
        onPhase('authenticating');
        captured = await loginInteractively(UTEC.lmsBaseUrl, credentials, () => {}, { headless: !scheduledLoginVisible, timeoutMs: 120_000, failOnMfa: true });
        onPhase('extracting');
        const session = captured;
        const summary = await importStudent(db, createBlackboardGateway(captured.transport), onPhase, {
          mode: 'daily', trigger: 'scheduled', passingGradePct,
          onIdentity: async (accountId) => { await dispatchReviewMarks(db, accountId, (course, content, reviewed) => session.markReviewed(course, content, reviewed)); },
        });
        changes = summary.sync.changesRecorded;
        await applyCalendar(db, { userId: summary.user.id }).catch(() => {});
      } catch (error) {
        errorCode = error instanceof ImportError || error instanceof LoginError ? error.code : error instanceof SessionExpiredError ? 'blackboard_session_expired' : 'import_failed';
        if (!(error instanceof ImportError || error instanceof LoginError || error instanceof SessionExpiredError)) app.log.error({ err: { name: (error as Error)?.name } }, 'scheduled refresh failed');
      } finally {
        captured?.dispose();
      }
      await markCredentialUse(db, account.accountId, errorCode).catch(() => {});
      results.push({ username: account.username, ok: errorCode === null, errorCode, changesRecorded: changes });
    }
    return results;
  }

  // Actualización diaria de todas las cuentas con credenciales recordadas (inicio de sesión sin ventana). Pensada para que un
  // programador externo la dispare; esta API no programa nada por sí sola.
  app.post('/internal/dev/utec/refresh/stored', {
    logLevel: 'warn', config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { hide: true },
  }, async (request, reply) => {
    authorizeOperator(request);
    sweep();
    if (running) throw new HttpError(409, 'import_in_progress', 'Ya hay una importación en curso.');
    if (!credentialsKey) throw new HttpError(400, 'credentials_key_missing', 'Falta CREDENTIALS_KEY en .env.');
    const stored = await db.query<{ account_id: string; username: string }>(
      `SELECT ea.id AS account_id, u.username FROM account_credentials ac JOIN external_accounts ea ON ea.id = ac.external_account_id AND ea.link_status = 'active'
         JOIN users u ON u.id = ea.user_id ORDER BY u.created_at`);
    if (stored.rows.length === 0) throw new HttpError(404, 'no_stored_credentials', 'No hay credenciales recordadas. Usa la actualización con "recordar".');
    const operation: Operation = {
      id: randomUUID(), phase: 'starting', createdAt: Date.now(), updatedAt: Date.now(), errorCode: null, errorMessage: null,
      summary: null, temporaryPassword: null, temporaryPasswordDelivered: false, remembered: false, stored: [],
    };
    operations.set(operation.id, operation);
    running = operation.id;
    const setPhase = (phase: Phase) => { operation.phase = phase; operation.updatedAt = Date.now(); };
    void (async () => {
      try {
        operation.stored = await runStored(stored.rows.map((row) => ({ accountId: row.account_id, username: row.username })), setPhase);
        setPhase('completed');
      } catch {
        operation.errorCode = 'import_failed';
        operation.errorMessage = 'La actualización con credenciales recordadas falló.';
        setPhase('failed');
      } finally {
        running = null;
      }
    })();
    return reply.code(202).send({ operationId: operation.id, status: operation.phase, poll: `/internal/dev/utec/imports/${operation.id}` });
  });

  // Calendario académico: una vez al año. Sin "confirm" solo devuelve lo que entendió del instructivo (vista previa).
  app.post<{ Body: { year: number; confirm?: boolean } }>('/internal/dev/utec/calendar/import', {
    logLevel: 'warn', config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { hide: true, body: { type: 'object', additionalProperties: false, required: ['year'], properties: { year: { type: 'integer', minimum: 2020, maximum: 2100 }, confirm: { type: 'boolean' } } } },
  }, async (request) => {
    authorizeOperator(request);
    try {
      return await importCalendar(db, request.body.year, { confirm: request.body.confirm === true });
    } catch (error) {
      throw new HttpError(422, 'calendar_import_failed', (error as Error).message);
    }
  });

  // Reparte las actividades de cada inscripción en sus evaluaciones según el calendario (sin tocar lo que el estudiante guardó a mano).
  app.post('/internal/dev/utec/calendar/apply', { logLevel: 'warn', schema: { hide: true } }, async (request) => {
    authorizeOperator(request);
    return applyCalendar(db);
  });

  const routes: Array<[string, ImportMode, string]> = [
    ['/internal/dev/utec/create-user', 'onboarding', '5'],
    ['/internal/dev/utec/refresh/full', 'full', '10'],
    ['/internal/dev/utec/refresh/daily', 'daily', '30'],
  ];
  for (const [path, mode, max] of routes) {
    app.post<{ Body: { username: string; password: string } }>(path, {
      logLevel: 'warn',
      config: { rateLimit: { max: Number(max), timeWindow: '10 minutes' } },
      schema: { hide: true, body: bodySchema },
    }, async (request, reply) => launch(request, reply, mode));
  }

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
