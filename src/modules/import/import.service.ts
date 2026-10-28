// Onboarding de desarrollo: sesión Blackboard verificada → extracción de solo lectura → PostgreSQL.
import type { Database, Queryable } from '../../database/connection.js';
import { DatabaseError } from '../../database/connection.js';
import { generateTemporaryPassword } from '../../shared/crypto.js';
import { hashPassword } from '../auth/password.js';
import { isObject, str, type BlackboardGateway, type Json, type ReadResult } from '../blackboard/gateway.js';
import { columnChanges, gradeChanges, recordChange } from './changes.js';
import { attemptIds, toDate } from './normalize.js';
import {
  newCounters, upsertAnnouncement, upsertAttempt, upsertCalendarItem, upsertColumn, upsertContent, upsertCourse, upsertEnrollment,
  upsertException, upsertGrade, upsertSchema, upsertTerm, upsertTodo, type Counters,
} from './persist.js';

export const ADAPTER_VERSION = 'bb-gateway/0.1.0+blackboard-mcp@0.1.2';
const DAY_MS = 86_400_000;

export const UTEC = {
  code: 'UTEC',
  name: 'Universidad Tecnológica de El Salvador',
  lmsBaseUrl: 'https://utecvirtual.blackboard.com',
  timezone: 'America/El_Salvador',
} as const;

/** Subconjunto de campos para el registro de cambios. */
function pick(source: object, fields: string[]): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
}

export class ImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportSummary {
  user: { id: string; username: string | null; email: string; displayName: string | null };
  created: boolean;
  temporaryPassword: string | null;
  academicData: Record<string, number>;
  rows: Record<string, Counters>;
  sync: { id: string; status: 'succeeded' | 'partial' | 'failed'; incompleteSteps: Array<{ resource: string; errorCode: string | null }>; baseline: boolean; changesRecorded: number };
}

type Step = { resource: string; courseExternalId: string | null; read: ReadResult<unknown>; items: number; startedAt: number };

async function ensureInstitution(db: Database): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO institutions (code, name, lms_provider, lms_base_url, timezone, auth_mode)
     VALUES ($1, $2, 'blackboard_learn_ultra', $3, $4, 'user_session')
     ON CONFLICT (code) DO UPDATE SET name = excluded.name
     RETURNING id`,
    [UTEC.code, UTEC.name, UTEC.lmsBaseUrl, UTEC.timezone],
  );
  return rows[0]!.id;
}

function slug(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

/** Username propio de Academic Hub (independiente del de UTEC): nombre.apellido, con sufijo si está ocupado. */
async function availableUsername(client: Queryable, given: string | undefined, family: string | undefined): Promise<string> {
  const base = (slug(`${given?.split(/\s+/)[0] ?? ''}.${family?.split(/\s+/)[0] ?? ''}`) || 'estudiante').slice(0, 30).replace(/\.+$/, '');
  const candidate = base.length >= 3 ? base : `${base}.ah`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = attempt === 0 ? candidate : `${candidate}${attempt + 1}`;
    const taken = await client.query('SELECT 1 FROM users WHERE username = $1', [name]);
    if (!taken.rowCount) return name;
  }
  return `${candidate}.${Date.now().toString(36)}`;
}

/** Busca la cuenta vinculada a la identidad Blackboard; si no existe, crea usuario + cuenta en una transacción. */
async function linkIdentity(db: Database, institutionId: string, profile: Json, locale: string | null) {
  const lmsUserId = String(profile.id);
  const given = str(profile.givenName);
  const family = str(profile.familyName);
  const preferred = str(profile.preferredDisplayName);
  // Algunos tenants devuelven la plantilla ("GIVEN_NAME") en lugar del nombre real.
  const displayName = (preferred && !/^[A-Z][A-Z_]*$/.test(preferred) ? preferred : [given, family].filter(Boolean).join(' ')) || null;
  const email = str(profile.emailAddress);
  const accountFields = [
    str(profile.uuid) ?? null, str(profile.foundationsId) ?? null, str(profile.userName) ?? null, given ?? null, family ?? null,
    preferred ?? null, email ?? null, locale, str(profile.systemRoleIdentifier) ?? str(profile.systemRole) ?? null,
  ];

  return db.transaction(async (client) => {
    const existing = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM external_accounts WHERE institution_id = $1 AND lms_user_id = $2 AND link_status <> 'revoked' FOR UPDATE`,
      [institutionId, lmsUserId],
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE external_accounts SET lms_uuid = $2, lms_foundations_id = $3, lms_username = $4, given_name = $5, family_name = $6,
                preferred_display_name = $7, institutional_email = $8, locale = COALESCE($9, locale), system_role = $10,
                link_status = 'active', last_verified_at = now()
          WHERE id = $1`,
        [existing.rows[0].id, ...accountFields],
      );
      const user = await client.query<{ id: string; username: string | null; email: string; display_name: string | null }>(
        'SELECT id, username, email, display_name FROM users WHERE id = $1', [existing.rows[0].user_id]);
      return { accountId: existing.rows[0].id, user: user.rows[0]!, created: false, temporaryPassword: null };
    }

    if (!email) throw new ImportError('missing_email', 'Blackboard no devolvió un correo institucional; no se puede crear la cuenta automáticamente.');
    // No se vincula por coincidencia de correo: si el correo ya pertenece a otra cuenta, es un conflicto administrativo.
    const emailTaken = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
    if (emailTaken.rowCount) {
      throw new ImportError('identity_conflict', 'Ya existe una cuenta Academic Hub con ese correo sin vínculo a esta identidad Blackboard. Resuélvelo manualmente.');
    }
    const temporaryPassword = generateTemporaryPassword();
    const username = await availableUsername(client, given, family);
    const user = await client.query<{ id: string; username: string | null; email: string; display_name: string | null }>(
      `INSERT INTO users (email, username, password_hash, display_name, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, true, now()) RETURNING id, username, email, display_name`,
      [email, username, await hashPassword(temporaryPassword), displayName],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO external_accounts (user_id, institution_id, lms_user_id, lms_uuid, lms_foundations_id, lms_username, given_name, family_name,
                                      preferred_display_name, institutional_email, locale, system_role, link_status, linked_at, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', now(), now()) RETURNING id`,
      [user.rows[0]!.id, institutionId, lmsUserId, ...accountFields],
    );
    await client.query(`INSERT INTO audit_events (user_id, event, metadata) VALUES ($1, 'import.account_created', $2)`,
      [user.rows[0]!.id, JSON.stringify({ institution: UTEC.code })]);
    return { accountId: account.rows[0]!.id, user: user.rows[0]!, created: true, temporaryPassword };
  });
}

function lmsUrlFor(course: Json): string {
  const external = str(course.externalAccessUrl);
  if (external && external.startsWith(`${UTEC.lmsBaseUrl}/`)) return external;
  return `${UTEC.lmsBaseUrl}/ultra/courses/${encodeURIComponent(String(course.id))}/outline`;
}

export async function importStudent(
  db: Database,
  gateway: BlackboardGateway,
  onPhase: (phase: 'extracting' | 'persisting') => void,
): Promise<ImportSummary> {
  // 1. Identidad verificada con la sesión real (antes de crear nada).
  const { user: profile, locale, result: profileRead } = await gateway.profile();
  if (profileRead.status !== 'succeeded' || !str(profile.id)) throw new ImportError('profile_unavailable', 'No fue posible verificar la identidad en Blackboard.');

  const institutionId = await ensureInstitution(db);
  const identity = await linkIdentity(db, institutionId, profile, locale);

  // Línea base: sin una importación previa terminada, nada de lo encontrado es "novedad".
  const previous = await db.query<{ has_previous: boolean; term_ids: string[] | null }>(
    `SELECT EXISTS (SELECT 1 FROM sync_runs WHERE external_account_id = $1 AND status IN ('succeeded', 'partial')) AS has_previous,
            (SELECT array_agg(DISTINCT c.term_id) FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
              WHERE ce.external_account_id = $1 AND c.term_id IS NOT NULL) AS term_ids`,
    [identity.accountId],
  );
  const baseline = !previous.rows[0]?.has_previous;
  const knownTermIds = new Set(previous.rows[0]?.term_ids ?? []);
  let changesRecorded = 0;

  let runId: string;
  try {
    const run = await db.query<{ id: string }>(
      `INSERT INTO sync_runs (external_account_id, trigger, adapter_version) VALUES ($1, 'dev_import', $2) RETURNING id`,
      [identity.accountId, ADAPTER_VERSION],
    );
    runId = run.rows[0]!.id;
  } catch (error) {
    if (error instanceof DatabaseError && error.code === '23505') throw new ImportError('import_in_progress', 'Ya hay una importación en curso para esta cuenta.');
    throw error;
  }

  const steps: Step[] = [];
  const rows: Record<string, Counters> = {};
  const counter = (name: string) => (rows[name] ??= newCounters());
  const academicData: Record<string, number> = { terms: 0, courses: 0, contentItems: 0, gradebookColumns: 0, activities: 0, calculatedColumns: 0, grades: 0, attempts: 0, calendarItems: 0, announcements: 0, dueDateExceptions: 0, todoItems: 0 };
  const record = (resource: string, courseExternalId: string | null, read: ReadResult<unknown>, startedAt: number, items = read.rows.length) =>
    steps.push({ resource, courseExternalId, read, items, startedAt });
  record('profile', null, profileRead, Date.now(), 1);

  try {
    onPhase('extracting');
    let started = Date.now();
    const memberships = await gateway.memberships();
    record('memberships', null, memberships, started);
    if (memberships.status === 'failed') throw new ImportError('memberships_unavailable', 'No fue posible leer las inscripciones.');

    const enrollments = memberships.rows.filter((m) => isObject(m.course) && str(m.course.id) && m.course.isOrganization !== true);
    const termWindow = enrollments
      .map((m) => (isObject((m.course as Json).term) ? (m.course as Json).term as Json : {}))
      .flatMap((term) => [toDate(term.startDate), toDate(term.endDate)])
      .filter((date): date is Date => date !== null);
    const calendarFrom = termWindow.length ? new Date(Math.min(...termWindow.map(Number))) : new Date(Date.now() - 120 * DAY_MS);
    const calendarTo = termWindow.length ? new Date(Math.max(...termWindow.map(Number))) : new Date(Date.now() + 120 * DAY_MS);

    started = Date.now();
    const todo = await gateway.todo(new Date(Date.now() - 28 * DAY_MS), new Date(Date.now() + 56 * DAY_MS));
    record('todo', null, todo, started);
    const todoByColumn = new Map<string, { bucket: string; due: Date | null }>();
    for (const item of todo.rows) {
      const columnId = isObject(item.column) ? str(item.column.id) : undefined;
      if (columnId) todoByColumn.set(columnId, { bucket: item._bucket, due: toDate(item.dueDate) });
    }

    const seenTerms = new Set<string>();
    for (const membership of enrollments) {
      const course = membership.course as Json;
      const courseExternalId = String(course.id);

      // ── extracción (sin transacciones abiertas) ──
      started = Date.now();
      const content = await gateway.contentTree(courseExternalId);
      record('content', courseExternalId, content, started);
      started = Date.now();
      const schemas = await gateway.gradingSchemas(courseExternalId);
      record('grading_schemas', courseExternalId, schemas, started);
      started = Date.now();
      const columns = await gateway.gradebookColumns(courseExternalId);
      record('gradebook_columns', courseExternalId, columns, started);
      started = Date.now();
      const grades = await gateway.grades(courseExternalId, String(profile.id));
      record('grades', courseExternalId, grades, started);

      started = Date.now();
      const attempts = new Map<string, Json[]>();
      let attemptPages = 0;
      const attemptStatuses: Record<string, number> = {};
      for (const grade of grades.rows) {
        const columnId = str(grade.columnId);
        if (!columnId) continue;
        for (const attemptId of attemptIds(grade)) {
          const read = await gateway.attempt(courseExternalId, attemptId);
          attemptPages += read.pages;
          for (const [status, n] of Object.entries(read.httpStatusCounts)) attemptStatuses[status] = (attemptStatuses[status] ?? 0) + n;
          const attempt = read.rows[0];
          // Solo intentos propios: el userId del intento debe ser el de la identidad verificada.
          if (attempt && attempt.userId === profile.id) attempts.set(columnId, [...(attempts.get(columnId) ?? []), attempt]);
        }
      }
      const attemptsRead: ReadResult<unknown> = {
        rows: [...attempts.values()].flat(), status: Object.keys(attemptStatuses).some((s) => s !== '200') ? 'incomplete' : 'succeeded',
        complete: !Object.keys(attemptStatuses).some((s) => s !== '200'), truncated: false, pages: attemptPages, httpStatusCounts: attemptStatuses,
        errorCode: Object.keys(attemptStatuses).some((s) => s !== '200') ? 'attempt_read_failed' : null,
      };
      record('attempts', courseExternalId, attemptsRead, started);

      started = Date.now();
      const exceptions = str(membership.id) ? await gateway.dueDateExceptions(courseExternalId, String(membership.id)) : null;
      if (exceptions) record('due_date_exceptions', courseExternalId, exceptions, started);
      started = Date.now();
      const calendar = await gateway.courseCalendar(courseExternalId, calendarFrom, calendarTo);
      record('calendar', courseExternalId, calendar, started);
      started = Date.now();
      const announcements = await gateway.announcements(courseExternalId);
      record('announcements', courseExternalId, announcements, started);

      // ── persistencia de la materia en una transacción ──
      onPhase('persisting');
      await db.transaction(async (client) => {
        const term = isObject(course.term) ? course.term : null;
        const termResult = term ? await upsertTerm(client, institutionId, term, runId, counter('academic_terms')) : null;
        const termId = termResult?.id ?? null;
        if (termId && !seenTerms.has(termId)) { seenTerms.add(termId); academicData.terms! += 1; }
        const courseResult = await upsertCourse(client, institutionId, termId, course, lmsUrlFor(course), runId, counter('courses'));
        const courseId = courseResult.id;
        const enrollmentResult = await upsertEnrollment(client, identity.accountId, institutionId, courseId, membership, runId, counter('course_enrollments'));
        const enrollmentId = enrollmentResult.id;
        academicData.courses! += 1;

        // ── novedades (nunca en la línea base) ──
        const courseExisted = !courseResult.inserted;
        const enrollmentExisted = !enrollmentResult.inserted;
        const note = async (change: Parameters<typeof recordChange>[1]) => { await recordChange(client, change); changesRecorded += 1; };
        if (!baseline && termId && !knownTermIds.has(termId)) {
          knownTermIds.add(termId);
          await note({ runId, entityType: 'academic_term', entityId: termId, scope: 'personal', accountId: identity.accountId, courseId: null,
            changeType: 'created', kind: 'term_new', changedFields: [], before: null, after: { name: str(term?.name) ?? null } });
        }
        if (!baseline && !enrollmentExisted) {
          await note({ runId, entityType: 'course_enrollment', entityId: enrollmentId, scope: 'personal', accountId: identity.accountId, courseId,
            changeType: 'created', kind: 'course_new', changedFields: [], before: null, after: { name: str(course.name) ?? null } });
        }

        const contentIds = content.status === 'failed'
          ? new Map<string, string>()
          : await upsertContent(client, courseId, enrollmentId, content.rows, runId, counter('course_content_items'));
        academicData.contentItems! += contentIds.size;
        for (const schema of schemas.rows) await upsertSchema(client, courseId, schema, runId, counter('grading_schemas'));

        const columnIds = new Map<string, string>();
        for (const column of columns.rows) {
          const result = await upsertColumn(client, courseId, column, contentIds, runId, counter('gradebook_columns'));
          columnIds.set(String(column.id), result.id);
          // Cambios del catálogo: solo si la materia ya existía (si no, es su línea base).
          if (courseExisted) {
            for (const change of columnChanges(result)) {
              await note({ runId, entityType: 'gradebook_column', entityId: result.id, scope: 'shared', accountId: null, courseId,
                changeType: change.changeType, kind: change.kind, changedFields: change.fields,
                before: result.before && change.changeType === 'updated' ? pick(result.before, change.fields) : null,
                after: { ...pick(result.after, change.fields), name: result.after.name, due_at: result.after.due_at } });
            }
          }
        }
        academicData.gradebookColumns! += columnIds.size;
        academicData.calculatedColumns! += columns.rows.filter((column) => isObject(column.calculatedFormula)).length;

        const gradesByColumn = new Map(grades.rows.map((grade) => [str(grade.columnId) ?? '', grade]));
        // Una fila por columna visible (con o sin nota): solo si la lectura de notas no falló.
        if (grades.status !== 'failed') {
          for (const column of columns.rows) {
            const external = String(column.id);
            const grade = gradesByColumn.get(external) ?? null;
            const own = attempts.get(external) ?? [];
            const isSubmitted = own.length > 0 ? own.some((attempt) => attempt.status !== 'IN_PROGRESS')
              : grade && attemptIds(grade).length === 0 && column.isAttemptBased === true ? false : null;
            const todoItem = todoByColumn.get(external);
            const columnDue = toDate(column.dueDate);
            const effectiveDue = todoItem?.due && (!columnDue || todoItem.due.getTime() !== columnDue.getTime()) ? { at: todoItem.due, source: 'todo' as const } : null;
            const gradeResult = await upsertGrade(client, enrollmentId, courseId, columnIds.get(external)!, { grade, isSubmitted, effectiveDue }, runId, counter('student_grades'));
            const gradeId = gradeResult.id;
            if (!baseline && enrollmentExisted) {
              for (const change of gradeChanges(gradeResult)) {
                await note({ runId, entityType: 'student_grade', entityId: gradeId, scope: 'personal', accountId: identity.accountId, courseId,
                  changeType: 'updated', kind: change.kind, changedFields: change.fields,
                  before: pick(gradeResult.before ?? {}, ['score', 'status', 'submission_status']),
                  after: { ...pick(gradeResult.after, ['score', 'status', 'submission_status']), name: str(column.columnName) ?? null } });
              }
            }
            if (grade?.id) academicData.grades! += 1;
            if (!isObject(column.calculatedFormula)) academicData.activities! += 1;
            for (const attempt of own) { await upsertAttempt(client, gradeId, courseId, attempt, runId, counter('grade_attempts')); academicData.attempts! += 1; }
            if (todoItem) { await upsertTodo(client, enrollmentId, courseId, columnIds.get(external)!, todoItem.bucket, todoItem.due, runId); academicData.todoItems! += 1; }
          }
        }
        for (const exception of exceptions?.rows ?? []) {
          await upsertException(client, enrollmentId, courseId, exception, columnIds, runId, counter('due_date_exceptions'));
          academicData.dueDateExceptions! += 1;
        }
        for (const item of calendar.rows) { await upsertCalendarItem(client, institutionId, courseId, item, columnIds, runId, counter('calendar_items')); academicData.calendarItems! += 1; }
        for (const item of announcements.rows) {
          const result = await upsertAnnouncement(client, courseId, enrollmentId, item, runId, counter('course_announcements'));
          academicData.announcements! += 1;
          if (courseExisted && result.inserted) {
            await note({ runId, entityType: 'course_announcement', entityId: result.id, scope: 'shared', accountId: null, courseId,
              changeType: 'created', kind: 'announcement_new', changedFields: [], before: null, after: { title: str(item.title) ?? null } });
          }
        }
      });
      onPhase('extracting');
    }
  } catch (error) {
    await finishRun(db, runId, steps, 'failed', error instanceof ImportError ? error.code : 'import_failed', { ...academicData, changesRecorded, baseline: baseline ? 1 : 0 }, rows);
    throw error;
  }

  const incompleteSteps = steps.filter((step) => !step.read.complete).map((step) => ({ resource: step.resource, errorCode: step.read.errorCode }));
  const status = incompleteSteps.length === 0 ? 'succeeded' : 'partial';
  await finishRun(db, runId, steps, status, null, { ...academicData, changesRecorded, baseline: baseline ? 1 : 0 }, rows);
  return {
    user: { id: identity.user.id, username: identity.user.username, email: identity.user.email, displayName: identity.user.display_name },
    created: identity.created,
    temporaryPassword: identity.temporaryPassword,
    academicData,
    rows,
    sync: { id: runId, status, incompleteSteps, baseline, changesRecorded },
  };
}

async function finishRun(db: Database, runId: string, steps: Step[], status: string, errorCode: string | null,
  academicData: Record<string, number>, rows: Record<string, Counters>): Promise<void> {
  await db.transaction(async (client) => {
    for (const step of steps) {
      const stepStatus = step.read.status === 'succeeded' && !step.read.complete ? 'incomplete' : step.read.status;
      await client.query(
        `INSERT INTO sync_run_steps (sync_run_id, resource, course_external_id, status, complete, truncated, pages, items, http_status_counts, error_code, started_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0), $12)`,
        [runId, step.resource, step.courseExternalId, stepStatus, step.read.complete && stepStatus === 'succeeded', step.read.truncated,
         step.read.pages, step.items, JSON.stringify(step.read.httpStatusCounts), step.read.errorCode, step.startedAt, Date.now() - step.startedAt],
      );
    }
    await client.query(
      `UPDATE sync_runs SET status = $2, finished_at = now(), error_code = $3, stats = $4 WHERE id = $1`,
      [runId, status, errorCode, JSON.stringify({ academicData, rows })],
    );
    if (status !== 'failed') {
      await client.query(`UPDATE external_accounts SET last_successful_sync_at = now() WHERE id = (SELECT external_account_id FROM sync_runs WHERE id = $1)`, [runId]);
    }
  });
}
