// BlackboardGateway: acceso de SOLO LECTURA a Blackboard Learn Ultra.
// Hoy autentica con una sesión de navegador capturada en memoria (blackboard-mcp HttpClient);
// la interfaz no depende de ese mecanismo, para poder cambiarlo por OAuth 3LO.
// Rutas: las verificadas en docs/BLACKBOARD_ENDPOINT_DISCOVERY.md y CLAUDE_BLACKBOARD_ARCHITECTURE_REVIEW.md.

export type Json = Record<string, unknown>;

export type StepOutcome = 'succeeded' | 'failed' | 'incomplete';

/** Resultado de una lectura con su completitud: una lista vacía por error nunca equivale a "no hay datos". */
export interface ReadResult<T> {
  rows: T[];
  status: StepOutcome;
  complete: boolean;
  truncated: boolean;
  pages: number;
  httpStatusCounts: Record<string, number>;
  errorCode: string | null;
}

/** Transporte mínimo: GET de una ruta del mismo host, sin escrituras. */
export interface BlackboardTransport {
  get(path: string, query?: Record<string, string | number | boolean>): Promise<{ status: number; body: unknown }>;
}

export class SessionExpiredError extends Error {
  constructor() {
    super('La sesión de Blackboard expiró.');
    this.name = 'SessionExpiredError';
  }
}

export function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const DAY_MS = 86_400_000;
// Ventana máxima aceptada por todo/studentItems es 16 días; se usa 14 por margen.
const TODO_WINDOW_MS = 14 * DAY_MS;

export interface GatewayLimits {
  maxPages: number;
  maxContentNodes: number;
  maxContentDepth: number;
}

export const DEFAULT_LIMITS: GatewayLimits = { maxPages: 60, maxContentNodes: 5_000, maxContentDepth: 15 };

function emptyResult<T>(): ReadResult<T> {
  return { rows: [], status: 'succeeded', complete: true, truncated: false, pages: 0, httpStatusCounts: {}, errorCode: null };
}

function count(result: ReadResult<unknown>, status: number): void {
  result.httpStatusCounts[String(status)] = (result.httpStatusCounts[String(status)] ?? 0) + 1;
}

function fail<T>(result: ReadResult<T>, status: number): ReadResult<T> {
  result.status = result.rows.length > 0 ? 'incomplete' : 'failed';
  result.complete = false;
  result.errorCode = status === 0 ? 'network_error' : `http_${status}`;
  return result;
}

export function createBlackboardGateway(transport: BlackboardTransport, limits: GatewayLimits = DEFAULT_LIMITS) {
  async function get(path: string, query?: Record<string, string | number | boolean>) {
    const response = await transport.get(path, query);
    if (response.status === 401) throw new SessionExpiredError();
    return response;
  }

  /** Paginación por paging.nextPage, ignorando enlaces que no avanzan el offset (bug de calendario en 0.1.2). */
  async function paginate(path: string, query: Record<string, string | number | boolean> = {}, pageSize = 100): Promise<ReadResult<Json>> {
    const result = emptyResult<Json>();
    let next: string | undefined = path;
    let currentQuery: Record<string, string | number | boolean> | undefined = { ...query, limit: pageSize, offset: 0 };
    let offset = 0;
    while (next) {
      if (result.pages >= limits.maxPages) {
        result.truncated = true;
        result.complete = false;
        result.status = 'incomplete';
        result.errorCode = 'page_limit';
        break;
      }
      const response = await get(next, currentQuery);
      count(result, response.status);
      if (response.status !== 200 || !isObject(response.body)) return fail(result, response.status);
      result.pages += 1;
      const rows = Array.isArray(response.body.results) ? response.body.results.filter(isObject) : [];
      result.rows.push(...rows);
      currentQuery = undefined;
      const paging = isObject(response.body.paging) ? response.body.paging : {};
      const link = str(paging.nextPage);
      if (!link || rows.length === 0) break;
      const params = new URL(link, 'https://placeholder.invalid').searchParams;
      // Un nextPage que pierde la ventana de fechas o no avanza no es una página siguiente.
      if (query.since !== undefined && !params.has('since')) break;
      const linkOffset = Number(params.get('offset'));
      if (Number.isFinite(linkOffset) && linkOffset <= offset) break;
      if (Number.isFinite(linkOffset)) offset = linkOffset;
      next = link;
    }
    return result;
  }

  async function single(path: string, query?: Record<string, string | number | boolean>): Promise<ReadResult<Json>> {
    const result = emptyResult<Json>();
    const response = await get(path, query);
    count(result, response.status);
    if (response.status !== 200 || !isObject(response.body)) return fail(result, response.status);
    result.pages = 1;
    result.rows.push(response.body);
    return result;
  }

  const course = (courseId: string) => `/learn/api/v1/courses/${encodeURIComponent(courseId)}`;

  return {
    /** Identidad propia (interna) + locale (pública v1, ausente en la interna). */
    async profile(): Promise<{ user: Json; locale: string | null; result: ReadResult<Json> }> {
      const result = await single('/learn/api/v1/users/me', { expand: 'systemRoles,insRoles' });
      const user = result.rows[0];
      if (!user || !str(user.id)) return { user: {}, locale: null, result: fail(result, result.httpStatusCounts['200'] ? 200 : 0) };
      const publicUser = await get(`/learn/api/public/v1/users/${encodeURIComponent(String(user.id))}`, { fields: 'locale' }).catch(() => null);
      const locale = publicUser && isObject(publicUser.body) && isObject(publicUser.body.locale) ? str(publicUser.body.locale.id) ?? null : null;
      return { user, locale, result };
    },

    /** Inscripciones propias con curso y período expandidos (una sola consulta, como la UI de Ultra). */
    async memberships(): Promise<ReadResult<Json>> {
      const result = await single('/learn/api/v1/users/me/memberships', {
        expand: 'course.effectiveAvailability,course.permissions,courseRole', includeCount: true, limit: 10_000,
      });
      const page = result.rows[0];
      if (!page) return result;
      const rows = Array.isArray(page.results) ? page.results.filter(isObject) : [];
      const total = isObject(page.paging) && typeof page.paging.count === 'number' ? page.paging.count : rows.length;
      return { ...result, rows, truncated: total > rows.length, complete: result.complete && total <= rows.length };
    },

    /** Árbol completo (ROOT + INTERACTIVE) recorriendo contenedores; truncamiento explícito. */
    async contentTree(courseId: string): Promise<ReadResult<Json & { _root: 'outline' | 'interactive'; _depth: number }>> {
      const result = emptyResult<Json & { _root: 'outline' | 'interactive'; _depth: number }>();
      const seen = new Set<string>();
      const merge = (part: ReadResult<Json>) => {
        result.pages += part.pages;
        for (const [status, n] of Object.entries(part.httpStatusCounts)) result.httpStatusCounts[status] = (result.httpStatusCounts[status] ?? 0) + n;
        if (!part.complete) { result.complete = false; result.status = 'incomplete'; result.errorCode ??= part.errorCode; }
        if (part.truncated) result.truncated = true;
      };
      const visit = async (nodes: Json[], depth: number, root: 'outline' | 'interactive'): Promise<void> => {
        for (const node of nodes) {
          const id = str(node.id);
          if (!id || seen.has(id)) continue;   // los enlaces entre cursos pueden crear ciclos
          if (result.rows.length >= limits.maxContentNodes) {
            result.truncated = true; result.complete = false; result.status = 'incomplete'; result.errorCode = 'node_limit';
            return;
          }
          seen.add(id);
          result.rows.push({ ...node, _root: root, _depth: depth });
          if (isContainer(node)) {
            if (depth >= limits.maxContentDepth) {
              result.truncated = true; result.complete = false; result.status = 'incomplete'; result.errorCode = 'depth_limit';
              continue;
            }
            const children = await paginate(`${course(courseId)}/contents/${encodeURIComponent(id)}/children`, { '@view': 'Summary', expand: 'gradebookCategory' });
            merge(children);
            await visit(children.rows, depth + 1, root);
          }
        }
      };
      const roots = await paginate(`${course(courseId)}/contents/ROOT/children`, {
        '@view': 'Summary', expand: 'assignedGroups,selfEnrollmentGroups.group,gradebookCategory', includeInActivityTracking: true,
      });
      merge(roots);
      if (roots.status === 'failed') return { ...result, status: 'failed', complete: false };
      await visit(roots.rows, 0, 'outline');
      // INTERACTIVE puede no existir (404) en tenants con la función deshabilitada: no invalida el árbol principal.
      const interactive = await paginate(`${course(courseId)}/contents/INTERACTIVE/children`, { '@view': 'Summary' });
      if (interactive.status === 'failed' && interactive.httpStatusCounts['404']) {
        result.pages += interactive.pages;
      } else {
        merge(interactive);
        await visit(interactive.rows, 0, 'interactive');
      }
      return result;
    },

    gradebookColumns: (courseId: string) => paginate(`${course(courseId)}/gradebook/columns`, {
      isExcludedFromCourseUserActivity: true, expand: 'associatedRubrics,collectExternalSubmissions', includeInvisible: false,
    }),
    gradingSchemas: (courseId: string) => paginate(`${course(courseId)}/gradebook/schemas`),
    grades: (courseId: string, userId: string) => paginate(`${course(courseId)}/gradebook/grades`, {
      userId, expand: 'lastAttempt,attemptsLeft,submissionStatus,hasAttemptOrGradeFeedback,column', sort: 'column.position(asc)',
    }),
    attempt: (courseId: string, attemptId: string) => single(`${course(courseId)}/gradebook/attempts/${encodeURIComponent(attemptId)}`),
    dueDateExceptions: (courseId: string, membershipId: string) =>
      paginate(`${course(courseId)}/gradebook/memberships/${encodeURIComponent(membershipId)}/exceptions`),
    courseCalendar: (courseId: string, since: Date, until: Date) =>
      paginate(`${course(courseId)}/calendars/calendarItems`, { since: since.toISOString(), until: until.toISOString() }),
    announcements: (courseId: string) => paginate(`${course(courseId)}/announcements`, { sort: 'startDateRestriction(desc)' }),

    /**
     * Lo que Blackboard ya sabe que el estudiante no ha visto en la materia (solo contadores). Cada lectura es independiente:
     * si una falla (404/403/500), ese dato queda en null y las demás siguen. Nunca devuelve el contenido de mensajes ni foros.
     */
    async signals(courseId: string): Promise<Record<'unreadGrades' | 'announcementsUnread' | 'announcementsPosted' | 'conversationsTotal' | 'conversationsUnread' | 'forumUnread' | 'contentWithNews', number | null>> {
      const read = async (path: string) => {
        const response = await get(`${course(courseId)}${path}`).catch(() => ({ status: 0, body: null as unknown }));
        return response.status === 200 ? response.body : null;
      };
      const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);
      const [grades, announcements, forums, conversations, indicators] = await Promise.all([
        read('/gradebook/unreadGradesCount'), read('/announcements/counts'), read('/discussionboards/count'), read('/conversations'), read('/contents/indicators'),
      ]);
      const rows = isObject(conversations) && Array.isArray(conversations.results) ? conversations.results.filter(isObject) : null;
      const news = isObject(indicators) && Array.isArray(indicators.results) ? indicators.results.filter((row) => isObject(row) && row.newData === true).length : null;
      return {
        unreadGrades: isObject(grades) ? count(grades.count) : null,
        announcementsUnread: isObject(announcements) ? count(announcements.unreadCount) : null,
        announcementsPosted: isObject(announcements) ? count(announcements.postedCount) : null,
        conversationsTotal: rows ? rows.length : null,
        conversationsUnread: rows ? rows.reduce((sum, row) => sum + (count(row.unreadCount) ?? 0), 0) : null,
        forumUnread: isObject(forums) ? count(forums.unreadCount) : null,
        contentWithNews: news,
      };
    },

    /** Pendientes en ventanas de 14 días; un ítem en el borde de dos ventanas se conserva una vez (clave: column.id). */
    async todo(from: Date, to: Date): Promise<ReadResult<Json & { _bucket: 'overdue' | 'due_today' | 'upcoming' }>> {
      const result = emptyResult<Json & { _bucket: 'overdue' | 'due_today' | 'upcoming' }>();
      const seen = new Set<string>();
      for (let start = from.getTime(); start < to.getTime(); start += TODO_WINDOW_MS) {
        const window = await single('/learn/api/v1/calendars/todo/studentItems', {
          since: new Date(start).toISOString(), until: new Date(Math.min(start + TODO_WINDOW_MS, to.getTime())).toISOString(),
        });
        result.pages += window.pages;
        for (const [status, n] of Object.entries(window.httpStatusCounts)) result.httpStatusCounts[status] = (result.httpStatusCounts[status] ?? 0) + n;
        const body = window.rows[0];
        if (!body) { result.complete = false; result.status = 'incomplete'; result.errorCode = window.errorCode; continue; }
        for (const [bucket, field] of [['overdue', 'overdueItems'], ['due_today', 'dueTodayItems'], ['upcoming', 'futureDueItems']] as const) {
          for (const row of Array.isArray(body[field]) ? (body[field] as unknown[]).filter(isObject) : []) {
            const key = `${isObject(row.column) ? str(row.column.id) : str(row.title)}|${str(row.dueDate)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.rows.push({ ...row, _bucket: bucket });
          }
        }
      }
      if (result.pages === 0) result.status = 'failed';
      return result;
    },
  };
}

/** Contenedores del árbol: carpetas y lecciones (hasChildren puede faltar en algunos tenants). */
export function isContainer(node: Json): boolean {
  if (node.hasChildren === true) return true;
  if (node.hasChildren === false) return false;
  const handler = str(node.contentHandler);
  const detail = handler && isObject(node.contentDetail) ? node.contentDetail[handler] : undefined;
  if (isObject(detail) && (detail.isFolder === true || detail.isLesson === true)) return true;
  return handler === 'resource/x-bb-folder' || handler === 'resource/x-bb-lesson';
}

export type BlackboardGateway = ReturnType<typeof createBlackboardGateway>;
