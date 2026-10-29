import type { FastifyInstance } from 'fastify';
import type { Database } from '../../database/connection.js';
import { badRequest, notFound } from '../../shared/errors.js';
import type { AuthRepository } from '../auth/auth.repository.js';
import { currentSession, requireAuth } from '../auth/auth.guard.js';
import { toPublicUser } from '../auth/auth.service.js';
import type { AcademicRepository } from './academic.repository.js';

interface Deps {
  db: Database;
  repo: AcademicRepository;
  authRepo: AuthRepository;
}

const uuidParam = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const DAY = 86_400_000;

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function academicRoutes(app: FastifyInstance, { db, repo, authRepo }: Deps): Promise<void> {
  const auth = requireAuth();
  const userId = (request: Parameters<typeof currentSession>[0]) => currentSession(request).user_id;

  app.get('/me', { preHandler: auth, schema: { tags: ['users'] } }, async (request) => {
    const user = await authRepo.findUserById(userId(request));
    if (!user) throw notFound();
    return { user: toPublicUser(user), universityAccounts: await repo.universityAccounts(user.id) };
  });

  app.patch<{ Body: { displayName: string } }>('/me', {
    preHandler: auth,
    schema: {
      tags: ['users'],
      body: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 120 } } },
    },
  }, async (request) => {
    await db.query('UPDATE users SET display_name = $2 WHERE id = $1', [userId(request), request.body.displayName.trim()]);
    const user = await authRepo.findUserById(userId(request));
    return { user: user ? toPublicUser(user) : null };
  });

  // Preferencias de interfaz del propio usuario. Solo claves conocidas y con forma validada.
  const COLUMN_KEYS = ['pending', 'overdue', 'submitted', 'graded', 'nodate'] as const;
  const PREFERENCE_KEYS = ['activities_board'] as const;
  type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
  const keyParam = { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string', enum: [...PREFERENCE_KEYS] } } } as const;
  const uniqueColumns = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((v): v is string => (COLUMN_KEYS as readonly string[]).includes(v)))] : []);
  function sanitizePreference(key: PreferenceKey, value: Record<string, unknown>) {
    // activities_board: orden completo de columnas, minimizadas (a un lado) y cerradas (ocultas).
    const order = uniqueColumns(value.order);
    for (const column of COLUMN_KEYS) if (!order.includes(column)) order.push(column);
    return { order, minimized: uniqueColumns(value.minimized), hidden: uniqueColumns(value.hidden) };
  }

  app.get<{ Params: { key: PreferenceKey } }>('/me/preferences/:key', { preHandler: auth, schema: { tags: ['users'], params: keyParam } }, async (request) => {
    const { rows } = await db.query<{ value: Record<string, unknown> }>('SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2', [userId(request), request.params.key]);
    return { key: request.params.key, value: rows[0] ? sanitizePreference(request.params.key, rows[0].value) : null };
  });

  app.put<{ Params: { key: PreferenceKey }; Body: { value: Record<string, unknown> } }>('/me/preferences/:key', {
    preHandler: auth,
    schema: {
      tags: ['users'], params: keyParam,
      body: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'object', additionalProperties: true } } },
    },
  }, async (request) => {
    const value = sanitizePreference(request.params.key, request.body.value);
    await db.query(
      `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [userId(request), request.params.key, JSON.stringify(value)],
    );
    return { key: request.params.key, value };
  });

  app.get('/institutions', { preHandler: auth, schema: { tags: ['institutions'] } }, async () => ({ institutions: await repo.institutions() }));

  app.get('/me/university-accounts', { preHandler: auth, schema: { tags: ['university-accounts'] } }, async (request) => ({
    universityAccounts: await repo.universityAccounts(userId(request)),
  }));

  app.get<{ Params: { id: string } }>('/me/university-accounts/:id', { preHandler: auth, schema: { tags: ['university-accounts'], params: uuidParam } }, async (request) => {
    const [account] = await repo.universityAccounts(userId(request), request.params.id);
    if (!account) throw notFound();
    return { universityAccount: account };
  });

  app.get('/terms', { preHandler: auth, schema: { tags: ['terms'] } }, async (request) => ({ terms: await repo.terms(userId(request)) }));

  // Puede haber varios candidatos: se devuelven todos; la preferencia personal tiene prioridad.
  app.get('/terms/current', { preHandler: auth, schema: { tags: ['terms'] } }, async (request) => {
    const terms = await repo.terms(userId(request));
    const preferred = terms.filter((term) => term.isPreferredCurrent);
    const current = preferred.length > 0 ? preferred : terms.filter((term) => term.isCurrentByDate);
    return { terms: current, ambiguous: preferred.length === 0 && current.length > 1 };
  });

  app.get<{ Params: { id: string } }>('/terms/:id/courses', { preHandler: auth, schema: { tags: ['terms'], params: uuidParam } }, async (request) => {
    const terms = await repo.terms(userId(request));
    if (!terms.some((term) => term.id === request.params.id)) throw notFound();
    return { courses: await repo.courses(userId(request), { termId: request.params.id }) };
  });

  app.get<{ Querystring: { termId?: string } }>('/courses', {
    preHandler: auth,
    schema: { tags: ['courses'], querystring: { type: 'object', additionalProperties: false, properties: { termId: { type: 'string', format: 'uuid' } } } },
  }, async (request) => ({ courses: await repo.courses(userId(request), { termId: request.query.termId }) }));

  app.get<{ Params: { id: string } }>('/courses/:id', { preHandler: auth, schema: { tags: ['courses'], params: uuidParam } }, async (request) => {
    const [course] = await repo.courses(userId(request), { courseId: request.params.id });
    if (!course) throw notFound();
    return { course };
  });

  app.get<{ Params: { id: string } }>('/courses/:id/content', { preHandler: auth, schema: { tags: ['courses'], params: uuidParam } }, async (request) => {
    const [course] = await repo.courses(userId(request), { courseId: request.params.id });
    if (!course) throw notFound();
    const items = await repo.courseContent(userId(request), request.params.id);
    const visible = new Set(items.map((item) => item.id as string));
    // Un padre no visible para esta inscripción no se revela: el hijo pasa a la raíz.
    return { items: items.map((item) => ({ ...item, parentId: visible.has(item.parentId as string) ? item.parentId : null })) };
  });

  app.get<{ Params: { id: string } }>('/courses/:id/grades', { preHandler: auth, schema: { tags: ['courses'], params: uuidParam } }, async (request) => {
    const [course] = await repo.courses(userId(request), { courseId: request.params.id });
    if (!course) throw notFound();
    return { grades: await repo.activities(userId(request), { courseId: request.params.id, includeCalculated: true }) };
  });

  // Libro de calificaciones propio de todas las materias (incluye columnas calculadas, marcadas como tales).
  app.get<{ Querystring: { courseId?: string; termId?: string } }>('/grades', {
    preHandler: auth,
    schema: {
      tags: ['grades'],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { courseId: { type: 'string', format: 'uuid' }, termId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request) => ({
    grades: await repo.activities(userId(request), { courseId: request.query.courseId, termId: request.query.termId, includeCalculated: true }),
  }));

  app.get<{ Querystring: { before?: string; limit?: number; courseId?: string } }>('/changes', {
    preHandler: auth,
    schema: {
      tags: ['changes'],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          before: { type: 'string', maxLength: 120 },
          limit: { type: 'string', pattern: '^[0-9]{1,3}$' },
          courseId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 30), 1), 100);
    // Cursor opaco "fechaISO|uuid" (el último elemento de la página anterior).
    let before: { at: Date; id: string } | undefined;
    if (request.query.before) {
      const [at, id] = String(request.query.before).split('|');
      const date = at ? new Date(at) : null;
      if (date && !Number.isNaN(date.getTime()) && id && /^[0-9a-f-]{36}$/i.test(id)) before = { at: date, id };
    }
    const changes = await repo.changes(userId(request), { before, limit, courseId: request.query.courseId });
    const last = changes[changes.length - 1] as { detectedAt: Date; id: string } | undefined;
    return { changes, nextCursor: changes.length === limit && last ? `${new Date(last.detectedAt).toISOString()}|${last.id}` : null };
  });

  app.get<{ Params: { id: string } }>('/courses/:id/evaluation-cycles', { preHandler: auth, schema: { tags: ['evaluation-cycles'], params: uuidParam } }, async (request) => {
    const enrollmentId = await repo.ownEnrollment(userId(request), request.params.id);
    if (!enrollmentId) throw notFound();
    return repo.evaluationCycles(enrollmentId);
  });

  app.put<{ Params: { id: string }; Body: {
    activeNumber: number | null;
    cycles: Array<{ number: number; label: string | null; weightPercent: number | null; items: Array<{ activityId: string; weightWithinCycle: number | null }> }>;
  } }>('/courses/:id/evaluation-cycles', {
    preHandler: auth,
    schema: {
      tags: ['evaluation-cycles'],
      params: uuidParam,
      body: {
        type: 'object', additionalProperties: false, required: ['activeNumber', 'cycles'],
        properties: {
          activeNumber: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          cycles: {
            type: 'array', maxItems: 10,
            items: {
              type: 'object', additionalProperties: false, required: ['number', 'label', 'weightPercent', 'items'],
              properties: {
                number: { type: 'integer', minimum: 1, maximum: 10 },
                label: { type: ['string', 'null'], minLength: 1, maxLength: 80 },
                weightPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
                items: {
                  type: 'array', maxItems: 200,
                  items: {
                    type: 'object', additionalProperties: false, required: ['activityId', 'weightWithinCycle'],
                    properties: {
                      activityId: { type: 'string', format: 'uuid' },
                      weightWithinCycle: { type: ['number', 'null'], minimum: 0, maximum: 100 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const enrollmentId = await repo.ownEnrollment(userId(request), request.params.id);
    if (!enrollmentId) throw notFound();
    const { cycles, activeNumber } = request.body;
    const numbers = cycles.map((cycle) => cycle.number);
    if (new Set(numbers).size !== numbers.length) throw badRequest('duplicate_cycle', 'Cada número de ciclo puede aparecer una sola vez.');
    if (activeNumber !== null && !numbers.includes(activeNumber)) throw badRequest('invalid_active_cycle', 'El ciclo activo debe existir en la configuración.');
    const activityIds = cycles.flatMap((cycle) => cycle.items.map((item) => item.activityId));
    if (new Set(activityIds).size !== activityIds.length) throw badRequest('activity_in_multiple_cycles', 'Una actividad solo puede pertenecer a un ciclo.');
    const totalWeight = cycles.reduce((sum, cycle) => sum + (cycle.weightPercent ?? 0), 0);
    if (totalWeight > 100.001) throw badRequest('weights_exceed_100', 'La suma de los pesos de los ciclos no puede superar 100 %.');
    const { invalidActivityIds } = await repo.saveEvaluationCycles(enrollmentId, request.params.id, { activeNumber, cycles });
    // Una actividad ajena o de otra materia se trata como inexistente.
    if (invalidActivityIds.length > 0) throw badRequest('invalid_activity', 'Alguna actividad no pertenece a esta materia.');
    return repo.evaluationCycles(enrollmentId);
  });

  app.get<{ Querystring: { courseId?: string; termId?: string; from?: string; to?: string; status?: 'pending' | 'submitted' | 'graded' } }>('/activities', {
    preHandler: auth,
    schema: {
      tags: ['activities'],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          courseId: { type: 'string', format: 'uuid' },
          termId: { type: 'string', format: 'uuid' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['pending', 'submitted', 'graded'] },
        },
      },
    },
  }, async (request) => ({
    activities: await repo.activities(userId(request), {
      courseId: request.query.courseId, termId: request.query.termId, from: parseDate(request.query.from), to: parseDate(request.query.to), status: request.query.status,
    }),
  }));

  app.get<{ Params: { id: string } }>('/activities/:id', { preHandler: auth, schema: { tags: ['activities'], params: uuidParam } }, async (request) => {
    const [activity] = await repo.activities(userId(request), { activityId: request.params.id, includeCalculated: true });
    if (!activity) throw notFound();
    return { activity, attempts: await repo.attempts(userId(request), request.params.id) };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/calendar', {
    preHandler: auth,
    schema: {
      tags: ['calendar'],
      querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } } },
    },
  }, async (request) => {
    const from = parseDate(request.query.from) ?? new Date(Date.now() - 7 * DAY);
    const to = parseDate(request.query.to) ?? new Date(from.getTime() + 60 * DAY);
    return { from: from.toISOString(), to: to.toISOString(), items: await repo.calendar(userId(request), from, to) };
  });

  app.get('/dashboard', { preHandler: auth, schema: { tags: ['dashboard'] } }, async (request) => {
    const id = userId(request);
    const now = new Date();
    const [accounts, terms, courses, activities, syncRuns, recentChanges, weekAhead] = await Promise.all([
      repo.universityAccounts(id), repo.terms(id), repo.courses(id), repo.activities(id), repo.syncRuns(id),
      repo.changes(id, { limit: 5 }), repo.calendar(id, now, new Date(now.getTime() + 7 * DAY)),
    ]);
    const soon = new Date(now.getTime() + 7 * DAY);
    const pending = activities.filter((a) => a.isSubmitted !== true && a.status !== 'GRADED' && !a.isAutoZero && (a.dueAt === null || (a.dueAt as Date) >= now));
    const graded = activities.filter((a) => a.status === 'GRADED' && a.score !== null);
    return {
      universityAccounts: accounts,
      terms: { all: terms, current: terms.filter((term) => term.isPreferredCurrent || term.isCurrentByDate) },
      summary: {
        courses: courses.length,
        activities: activities.length,
        pending: pending.length,
        dueSoon: pending.filter((a) => a.dueAt !== null && (a.dueAt as Date) <= soon).length,
        graded: graded.length,
      },
      courses,
      upcoming: pending.filter((a) => a.dueAt !== null).slice(0, 8),
      recentGrades: graded.sort((a, b) => +new Date(b.lastSeenAt as string) - +new Date(a.lastSeenAt as string)).slice(0, 8),
      lastSync: syncRuns[0] ?? null,
      recentChanges,
      weekAhead,
    };
  });

  app.get('/sync-runs', { preHandler: auth, schema: { tags: ['sync'] } }, async (request) => ({ syncRuns: await repo.syncRuns(userId(request)) }));

  app.get<{ Params: { id: string } }>('/sync-runs/:id', { preHandler: auth, schema: { tags: ['sync'], params: uuidParam } }, async (request) => {
    const [run] = await repo.syncRuns(userId(request), request.params.id);
    if (!run) throw notFound();
    return { syncRun: run, steps: await repo.syncRunSteps(request.params.id) };
  });
}
