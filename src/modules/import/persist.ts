// Persistencia idempotente de la importación. Cada función recibe un cliente dentro de una transacción.
// Regla: los upserts solo escriben cuando cambia content_hash; last_seen_* se actualiza siempre.
import type { Queryable } from '../../database/connection.js';
import { isObject, str, type Json } from '../blackboard/gateway.js';
import { businessHash, htmlToText, sanitizeHtml, text, toBool, toDate, toNumber } from './normalize.js';

export interface Counters {
  inserted: number;
  updated: number;
  unchanged: number;
}

export const newCounters = (): Counters => ({ inserted: 0, updated: 0, unchanged: 0 });

/** Resultado de un upsert: permite al importador decidir si hubo un cambio de negocio que registrar. */
export interface UpsertResult<T> {
  id: string;
  inserted: boolean;
  changed: boolean;
  before: T | null;
  after: T;
}

/** Interpreta el resultado de un upsert con "RETURNING (xmax = 0) AS inserted, changed". */
function tally(counters: Counters, row: { inserted: boolean; changed: boolean } | undefined): void {
  if (!row) return;
  if (row.inserted) counters.inserted += 1;
  else if (row.changed) counters.updated += 1;
  else counters.unchanged += 1;
}

export async function upsertTerm(client: Queryable, institutionId: string, term: Json, runId: string, counters: Counters): Promise<{ id: string; inserted: boolean } | null> {
  const externalId = str(term.id);
  if (!externalId) return null;
  const fields = {
    name: str(term.name) ?? externalId, description: text(term.description), start: toDate(term.startDate), end: toDate(term.endDate),
    available: toBool(term.isAvailable), duration: str(term.durationType) ?? null, days: toNumber(term.daysOfUse),
  };
  const hash = businessHash(fields);
  const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean }>(
    `INSERT INTO academic_terms (institution_id, external_id, name, description, start_at, end_at, is_available, duration_type, days_of_use, content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (institution_id, external_id) DO UPDATE SET
       name = CASE WHEN academic_terms.content_hash IS DISTINCT FROM excluded.content_hash THEN excluded.name ELSE academic_terms.name END,
       description = CASE WHEN academic_terms.content_hash IS DISTINCT FROM excluded.content_hash THEN excluded.description ELSE academic_terms.description END,
       start_at = CASE WHEN academic_terms.content_hash IS DISTINCT FROM excluded.content_hash THEN excluded.start_at ELSE academic_terms.start_at END,
       end_at = CASE WHEN academic_terms.content_hash IS DISTINCT FROM excluded.content_hash THEN excluded.end_at ELSE academic_terms.end_at END,
       is_available = excluded.is_available, duration_type = excluded.duration_type, days_of_use = excluded.days_of_use,
       content_hash = excluded.content_hash, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING id, (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
    [institutionId, externalId, fields.name, fields.description, fields.start, fields.end, fields.available, fields.duration, fields.days, hash, runId],
  );
  tally(counters, rows[0]);
  return rows[0] ? { id: rows[0].id, inserted: rows[0].inserted } : null;
}

export async function upsertCourse(client: Queryable, institutionId: string, termId: string | null, course: Json, lmsUrl: string, runId: string, counters: Counters): Promise<{ id: string; inserted: boolean }> {
  const fields = {
    term: str(course.termId) ?? null, uuid: str(course.uuid) ?? null, foundations: str(course.foundationsId) ?? null,
    code: str(course.courseId) ?? null, displayId: str(course.displayId) ?? null, batch: str(course.batchUid) ?? null,
    name: str(course.name) ?? str(course.displayName) ?? String(course.id), displayName: str(course.displayName) ?? null,
    description: text(course.description), start: toDate(course.startDate), end: toDate(course.endDate),
    available: toBool(course.isAvailable), closed: toBool(course.isClosed), org: course.isOrganization === true,
    ultra: str(course.ultraStatus) ?? null, url: lmsUrl,
  };
  const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean }>(
    `INSERT INTO courses (institution_id, term_id, term_external_id, external_id, external_uuid, foundations_id, course_code, display_id, batch_uid,
                          name, display_name, description, start_at, end_at, is_available, is_closed, is_organization, ultra_status, lms_url,
                          content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (institution_id, external_id) DO UPDATE SET
       term_id = excluded.term_id, term_external_id = excluded.term_external_id,
       external_uuid = COALESCE(excluded.external_uuid, courses.external_uuid), foundations_id = excluded.foundations_id,
       course_code = excluded.course_code, display_id = excluded.display_id, batch_uid = COALESCE(excluded.batch_uid, courses.batch_uid),
       name = excluded.name, display_name = excluded.display_name, description = excluded.description,
       start_at = excluded.start_at, end_at = excluded.end_at, is_available = excluded.is_available, is_closed = excluded.is_closed,
       is_organization = excluded.is_organization, ultra_status = excluded.ultra_status, lms_url = excluded.lms_url,
       content_hash = excluded.content_hash, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING id, (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
    [institutionId, termId, fields.term, String(course.id), fields.uuid, fields.foundations, fields.code, fields.displayId, fields.batch,
     fields.name, fields.displayName, fields.description, fields.start, fields.end, fields.available, fields.closed, fields.org, fields.ultra, fields.url,
     businessHash(fields), runId],
  );
  tally(counters, rows[0]);
  return { id: rows[0]!.id, inserted: rows[0]!.inserted };
}

export async function upsertEnrollment(client: Queryable, accountId: string, institutionId: string, courseId: string, membership: Json, runId: string, counters: Counters): Promise<{ id: string; inserted: boolean }> {
  const role = isObject(membership.courseRole) ? membership.courseRole : {};
  const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean }>(
    `INSERT INTO course_enrollments (external_account_id, institution_id, course_id, external_id, foundations_id, role, role_bucket, is_available,
                                     user_has_hidden, enrolled_at, last_access_at, due_date_exception_type, time_limit_exception_type, status, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active', $14)
     ON CONFLICT (external_account_id, course_id) DO UPDATE SET
       external_id = excluded.external_id, foundations_id = excluded.foundations_id, role = excluded.role, role_bucket = excluded.role_bucket,
       is_available = excluded.is_available, user_has_hidden = excluded.user_has_hidden, enrolled_at = excluded.enrolled_at,
       last_access_at = excluded.last_access_at, due_date_exception_type = excluded.due_date_exception_type,
       time_limit_exception_type = excluded.time_limit_exception_type, status = 'active', missing_since = NULL,
       last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING id, (xmax = 0) AS inserted, false AS changed`,
    [accountId, institutionId, courseId, String(membership.id), str(membership.foundationsId) ?? null, str(membership.role) ?? str(role.identifier) ?? null,
     str(role.roleBucket) ?? null, toBool(membership.isAvailable), toBool(membership.userHasHidden), toDate(membership.enrollmentDate),
     toDate(membership.lastAccessDate), str(membership.dueDateExceptionType) ?? null, str(membership.timeLimitExceptionType) ?? null, runId],
  );
  tally(counters, rows[0]);
  return { id: rows[0]!.id, inserted: rows[0]!.inserted };
}

type ContentNode = Json & { _root: 'outline' | 'interactive'; _depth: number };

/** Inserta el árbol en dos pasadas (nodos y luego padres) y registra la visibilidad de esta inscripción. */
export async function upsertContent(client: Queryable, courseId: string, enrollmentId: string, nodes: ContentNode[], runId: string, counters: Counters): Promise<Map<string, string>> {
  const idByExternal = new Map<string, string>();
  for (const node of nodes) {
    const handler = str(node.contentHandler) ?? 'unknown';
    const detail = isObject(node.contentDetail) && isObject(node.contentDetail[handler]) ? node.contentDetail[handler] as Json : null;
    const generic = isObject(node.genericReadOnlyData) ? node.genericReadOnlyData : {};
    const bodyHtml = text(node.body);
    const url = detail && typeof detail.url === 'string' && /^https?:\/\//.test(detail.url) ? detail.url : null;
    const fields = {
      parent: str(node.parentId) ?? null, root: node._root, handler, title: str(node.title) ?? '(sin título)',
      description: str(node.description) ?? null, body: sanitizeHtml(bodyHtml), position: toNumber(node.position), depth: node._depth,
      detail, url, hasGrade: toBool(generic.hasGradeColumn), due: toDate(generic.dueDate), modified: toDate(node.modifiedDate),
    };
    const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean }>(
      `INSERT INTO course_content_items (course_id, external_id, parent_external_id, root_kind, handler, title, description, body_text, body_html_sanitized,
                                         position, depth, content_detail, external_url, has_grade_column, due_at, source_modified_at, content_hash, last_seen_sync_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (course_id, external_id) DO UPDATE SET
         parent_external_id = excluded.parent_external_id, root_kind = excluded.root_kind, handler = excluded.handler, title = excluded.title,
         description = excluded.description, body_text = excluded.body_text, body_html_sanitized = excluded.body_html_sanitized,
         position = excluded.position, depth = excluded.depth, content_detail = excluded.content_detail, external_url = excluded.external_url,
         has_grade_column = excluded.has_grade_column, due_at = excluded.due_at, source_modified_at = excluded.source_modified_at,
         content_hash = excluded.content_hash, missing_since = NULL, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
       RETURNING id, (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
      [courseId, String(node.id), fields.parent, fields.root, handler, fields.title, fields.description, htmlToText(bodyHtml), fields.body,
       fields.position, fields.depth, detail ? JSON.stringify(detail) : null, url, fields.hasGrade, fields.due, fields.modified, businessHash(fields), runId],
    );
    tally(counters, rows[0]);
    idByExternal.set(String(node.id), rows[0]!.id);
  }
  // Padres: solo cuando el padre también es un nodo conocido del mismo curso.
  await client.query(
    `UPDATE course_content_items child SET parent_id = parent.id
       FROM course_content_items parent
      WHERE child.course_id = $1 AND parent.course_id = $1 AND parent.external_id = child.parent_external_id
        AND child.parent_id IS DISTINCT FROM parent.id`,
    [courseId],
  );
  for (const node of nodes) {
    const completion = isObject(node.stateCompletion) ? node.stateCompletion : null;
    await client.query(
      `INSERT INTO enrollment_content_visibility (enrollment_id, content_item_id, course_id, visibility, has_release_rules, completion, last_seen_sync_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, content_item_id) DO UPDATE SET
         visibility = excluded.visibility, has_release_rules = excluded.has_release_rules, completion = excluded.completion,
         missing_since = NULL, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id`,
      [enrollmentId, idByExternal.get(String(node.id)), courseId, str(node.visibility) ?? null, Boolean(node.adaptiveReleaseRules),
       completion ? JSON.stringify(completion) : null, runId],
    );
  }
  return idByExternal;
}

export async function upsertSchema(client: Queryable, courseId: string, schema: Json, runId: string, counters: Counters): Promise<void> {
  const title = isObject(schema.localizableTitle) ? schema.localizableTitle : {};
  const fields = { title: str(schema.title) ?? null, key: str(title.languageKey) ?? null, scale: str(schema.scaleType) ?? null,
    numeric: toBool(schema.isNumeric), symbols: Array.isArray(schema.symbols) ? schema.symbols : null };
  const { rows } = await client.query<{ inserted: boolean; changed: boolean }>(
    `INSERT INTO grading_schemas (course_id, external_id, title, title_key, scale_type, is_numeric, symbols, content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (course_id, external_id) DO UPDATE SET
       title = excluded.title, title_key = excluded.title_key, scale_type = excluded.scale_type, is_numeric = excluded.is_numeric,
       symbols = excluded.symbols, content_hash = excluded.content_hash, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
    [courseId, String(schema.id), fields.title, fields.key, fields.scale, fields.numeric, fields.symbols ? JSON.stringify(fields.symbols) : null, businessHash(fields), runId],
  );
  tally(counters, rows[0]);
}

export type ColumnState = { name: string; due_at: string | null; points_possible: string | number | null; is_calculated: boolean };

export async function upsertColumn(client: Queryable, courseId: string, column: Json, contentIds: Map<string, string>, runId: string, counters: Counters): Promise<UpsertResult<ColumnState>> {
  const category = isObject(column.gradebookCategory) ? column.gradebookCategory : {};
  const categoryTitle = isObject(category.localizableTitle) ? category.localizableTitle : {};
  const formula = isObject(column.calculatedFormula) ? column.calculatedFormula : null;
  const contentExternal = str(column.contentId) ?? null;
  const fields = {
    contentExternal, schema: str(column.gradingSchemaId) ?? null, name: str(column.columnName) ?? str(column.effectiveColumnName) ?? String(column.id),
    effective: str(column.effectiveColumnName) ?? null, possible: toNumber(column.possible), due: toDate(column.dueDate),
    enforce: toBool(column.enforceDueDate), categoryId: str(column.gradebookCategoryId) ?? null, categoryKey: str(categoryTitle.languageKey) ?? null,
    categoryTitle: str(category.title) ?? null, handle: str(column.scoreProviderHandle) ?? null, calculated: formula !== null, formula,
    attemptBased: toBool(column.isAttemptBased), attempts: toNumber(column.multipleAttempts), formative: toBool(column.isFormative),
    scorable: toBool(column.scorable), position: toNumber(column.position), visible: toBool(column.visible), released: toBool(column.gradesReleased),
    deleted: column.deleted === true,
  };
  const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean; before: ColumnState | null; after: ColumnState }>(
    `INSERT INTO gradebook_columns (course_id, external_id, content_item_id, content_external_id, grading_schema_id, grading_schema_external_id,
                                    name, effective_name, points_possible, due_at, enforce_due_date, category_external_id, category_key, category_title,
                                    score_provider_handle, is_calculated, calculated_formula, is_attempt_based, multiple_attempts, is_formative,
                                    is_scorable, position, is_visible, grades_released, is_deleted_at_source, content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM grading_schemas WHERE course_id = $1 AND external_id = $5), $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
     ON CONFLICT (course_id, external_id) DO UPDATE SET
       content_item_id = excluded.content_item_id, content_external_id = excluded.content_external_id,
       grading_schema_id = excluded.grading_schema_id, grading_schema_external_id = excluded.grading_schema_external_id,
       name = excluded.name, effective_name = excluded.effective_name, points_possible = excluded.points_possible, due_at = excluded.due_at,
       enforce_due_date = excluded.enforce_due_date, category_external_id = excluded.category_external_id, category_key = excluded.category_key,
       category_title = excluded.category_title, score_provider_handle = excluded.score_provider_handle, is_calculated = excluded.is_calculated,
       calculated_formula = excluded.calculated_formula, is_attempt_based = excluded.is_attempt_based, multiple_attempts = excluded.multiple_attempts,
       is_formative = excluded.is_formative, is_scorable = excluded.is_scorable, position = excluded.position, is_visible = excluded.is_visible,
       grades_released = excluded.grades_released, is_deleted_at_source = excluded.is_deleted_at_source, content_hash = excluded.content_hash,
       missing_since = NULL, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING id, (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed,
       CASE WHEN old.id IS NULL THEN NULL ELSE json_build_object('name', old.name, 'due_at', old.due_at, 'points_possible', old.points_possible, 'is_calculated', old.is_calculated) END AS before,
       json_build_object('name', new.name, 'due_at', new.due_at, 'points_possible', new.points_possible, 'is_calculated', new.is_calculated) AS after`,
    [courseId, String(column.id), contentExternal ? contentIds.get(contentExternal) ?? null : null, contentExternal, fields.schema,
     fields.name, fields.effective, fields.possible, fields.due, fields.enforce, fields.categoryId, fields.categoryKey, fields.categoryTitle,
     fields.handle, fields.calculated, formula ? JSON.stringify(formula) : null, fields.attemptBased, fields.attempts, fields.formative,
     fields.scorable, fields.position, fields.visible, fields.released, fields.deleted, businessHash(fields), runId],
  );
  tally(counters, rows[0]);
  return rows[0]!;
}

export interface GradeInput {
  grade: Json | null;
  isSubmitted: boolean | null;
  effectiveDue: { at: Date; source: 'todo' | 'exception' } | null;
}

export type GradeState = { status: string | null; submission_status: string | null; score: string | number | null; is_submitted: boolean | null; effective_due_at: string | null };

export async function upsertGrade(client: Queryable, enrollmentId: string, courseId: string, columnId: string, input: GradeInput, runId: string, counters: Counters): Promise<UpsertResult<GradeState>> {
  const grade = input.grade ?? {};
  const submission = isObject(grade.submissionStatus) ? grade.submissionStatus : {};
  const feedback = text(grade.instructorFeedback);
  const fields = {
    gradeId: str(grade.id) ?? null, status: str(grade.status) ?? null, submission: str(submission.status) ?? null,
    score: toNumber(grade.effectiveScore), possible: toNumber(grade.pointsPossible), display: isObject(grade.displayGrade) ? grade.displayGrade : null,
    manual: str(grade.manualGrade) ?? null, exempt: toBool(grade.isExempt), hasFeedback: toBool(grade.hasAttemptOrGradeFeedback) ?? (feedback ? true : null),
    feedback: htmlToText(feedback), version: toNumber(grade.version), viewed: toBool(grade.hasBeenViewedByStudent),
    modified: toDate(grade.lastOverrideDate), submitted: input.isSubmitted,
    due: input.effectiveDue?.at ?? null, dueSource: input.effectiveDue?.source ?? null,
  };
  const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean; before: GradeState | null; after: GradeState }>(
    `INSERT INTO student_grades (enrollment_id, course_id, gradebook_column_id, external_grade_id, is_visible_to_student, status, submission_status, score,
                                 points_possible, display_grade, manual_grade, is_exempt, has_feedback, feedback_text, source_version, viewed_by_student,
                                 source_modified_at, is_submitted, effective_due_at, effective_due_source, content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (enrollment_id, gradebook_column_id) DO UPDATE SET
       external_grade_id = excluded.external_grade_id, is_visible_to_student = true, status = excluded.status, submission_status = excluded.submission_status,
       score = excluded.score, points_possible = excluded.points_possible, display_grade = excluded.display_grade, manual_grade = excluded.manual_grade,
       is_exempt = excluded.is_exempt, has_feedback = excluded.has_feedback, feedback_text = excluded.feedback_text, source_version = excluded.source_version,
       viewed_by_student = excluded.viewed_by_student, source_modified_at = excluded.source_modified_at, is_submitted = excluded.is_submitted,
       effective_due_at = excluded.effective_due_at, effective_due_source = excluded.effective_due_source, content_hash = excluded.content_hash,
       missing_since = NULL, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING id, (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed,
       CASE WHEN old.id IS NULL THEN NULL ELSE json_build_object('status', old.status, 'submission_status', old.submission_status, 'score', old.score, 'is_submitted', old.is_submitted, 'effective_due_at', old.effective_due_at) END AS before,
       json_build_object('status', new.status, 'submission_status', new.submission_status, 'score', new.score, 'is_submitted', new.is_submitted, 'effective_due_at', new.effective_due_at) AS after`,
    [enrollmentId, courseId, columnId, fields.gradeId, fields.status, fields.submission, fields.score, fields.possible,
     fields.display ? JSON.stringify(fields.display) : null, fields.manual, fields.exempt, fields.hasFeedback, fields.feedback, fields.version,
     fields.viewed, fields.modified, fields.submitted, fields.due, fields.dueSource, businessHash(fields), runId],
  );
  tally(counters, rows[0]);
  return rows[0]!;
}

export async function upsertAttempt(client: Queryable, studentGradeId: string, courseId: string, attempt: Json, runId: string, counters: Counters): Promise<void> {
  const receipt = isObject(attempt.attemptReceipt) ? attempt.attemptReceipt : {};
  const display = isObject(attempt.displayGrade) ? attempt.displayGrade : null;
  const fields = {
    status: str(attempt.status) ?? 'UNKNOWN', attempted: toDate(attempt.attemptDate), submitted: toDate(receipt.submissionDate),
    receipt: str(receipt.receiptId) ?? null, first: toDate(attempt.attemptFirstGradedDate), last: toDate(attempt.attemptLastGradedDate),
    score: display ? toNumber(display.score) : null, display, exempt: toBool(attempt.exempt), override: str(attempt.overrideStatus) ?? null,
  };
  const { rows } = await client.query<{ inserted: boolean; changed: boolean }>(
    `INSERT INTO grade_attempts (student_grade_id, course_id, external_id, status, attempted_at, submitted_at, receipt_id, first_graded_at, last_graded_at,
                                 score, display_grade, is_exempt, override_status, content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (course_id, external_id) DO UPDATE SET
       status = excluded.status, attempted_at = excluded.attempted_at, submitted_at = excluded.submitted_at, receipt_id = excluded.receipt_id,
       first_graded_at = excluded.first_graded_at, last_graded_at = excluded.last_graded_at, score = excluded.score,
       display_grade = excluded.display_grade, is_exempt = excluded.is_exempt, override_status = excluded.override_status,
       content_hash = excluded.content_hash, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
    [studentGradeId, courseId, String(attempt.id), fields.status, fields.attempted, fields.submitted, fields.receipt, fields.first, fields.last,
     fields.score, display ? JSON.stringify(display) : null, fields.exempt, fields.override, businessHash(fields), runId],
  );
  tally(counters, rows[0]);
}

export async function upsertException(client: Queryable, enrollmentId: string, courseId: string, raw: Json, columnIds: Map<string, string>, runId: string, counters: Counters): Promise<void> {
  const columnExternal = str(raw.columnId) ?? (isObject(raw.column) ? str(raw.column.id) : undefined);
  const sourceKey = str(raw.id) ?? businessHash(raw).toString('hex');
  const { rows } = await client.query<{ inserted: boolean; changed: boolean }>(
    `INSERT INTO due_date_exceptions (enrollment_id, course_id, gradebook_column_id, source_key, due_at, raw, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (enrollment_id, source_key) DO UPDATE SET
       gradebook_column_id = excluded.gradebook_column_id, due_at = excluded.due_at, raw = excluded.raw,
       last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING (xmax = 0) AS inserted, false AS changed`,
    [enrollmentId, courseId, columnExternal ? columnIds.get(columnExternal) ?? null : null, sourceKey, toDate(raw.dueDate), JSON.stringify(raw), runId],
  );
  tally(counters, rows[0]);
}

export async function upsertCalendarItem(client: Queryable, institutionId: string, courseId: string, item: Json, columnIds: Map<string, string>, runId: string, counters: Counters): Promise<void> {
  const sourceType = str(item.itemSourceType) ?? 'unknown';
  const sourceId = str(item.itemSourceId) ?? str(item.id);
  if (!sourceId) return;
  const columnId = sourceType.endsWith('GradableItem') ? columnIds.get(sourceId) ?? null : null;
  const fields = { title: str(item.title) ?? '(sin título)', start: toDate(item.startDate), end: toDate(item.endDate), location: str(item.location) ?? null, calendar: str(item.calendarId) ?? null };
  const { rows } = await client.query<{ inserted: boolean; changed: boolean }>(
    `INSERT INTO calendar_items (institution_id, scope, course_id, source_type, source_external_id, calendar_external_id, gradebook_column_id, title,
                                 start_at, end_at, location, content_hash, last_seen_sync_run_id)
     VALUES ($1, 'course', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (institution_id, course_id, external_account_id, source_type, source_external_id) DO UPDATE SET
       calendar_external_id = excluded.calendar_external_id, gradebook_column_id = excluded.gradebook_column_id, title = excluded.title,
       start_at = excluded.start_at, end_at = excluded.end_at, location = excluded.location, content_hash = excluded.content_hash,
       missing_since = NULL, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
    [institutionId, courseId, sourceType, sourceId, fields.calendar, columnId, fields.title, fields.start, fields.end, fields.location, businessHash(fields), runId],
  );
  tally(counters, rows[0]);
}

export async function upsertAnnouncement(client: Queryable, courseId: string, enrollmentId: string, item: Json, runId: string, counters: Counters): Promise<{ id: string; inserted: boolean }> {
  const bodyHtml = text(item.body);
  const read = isObject(item.readStatus) ? item.readStatus : {};
  const fields = {
    title: str(item.title) ?? '(sin título)', body: sanitizeHtml(bodyHtml), created: toDate(item.createdDate), modified: toDate(item.modifiedDate),
    from: toDate(item.startDateRestriction), until: toDate(item.endDateRestriction), draft: toBool(item.isDraft), creator: str(item.creatorUserId) ?? null,
  };
  const { rows } = await client.query<{ id: string; inserted: boolean; changed: boolean }>(
    `INSERT INTO course_announcements (course_id, external_id, title, body_text, body_html_sanitized, source_created_at, source_modified_at,
                                       visible_from, visible_until, is_draft, creator_external_id, content_hash, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (course_id, external_id) DO UPDATE SET
       title = excluded.title, body_text = excluded.body_text, body_html_sanitized = excluded.body_html_sanitized,
       source_created_at = excluded.source_created_at, source_modified_at = excluded.source_modified_at, visible_from = excluded.visible_from,
       visible_until = excluded.visible_until, is_draft = excluded.is_draft, creator_external_id = excluded.creator_external_id,
       content_hash = excluded.content_hash, missing_since = NULL, last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id
     RETURNING id, (xmax = 0) AS inserted, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed`,
    [courseId, String(item.id), fields.title, htmlToText(bodyHtml), fields.body, fields.created, fields.modified, fields.from, fields.until,
     fields.draft, fields.creator, businessHash(fields), runId],
  );
  tally(counters, rows[0]);
  await client.query(
    `INSERT INTO enrollment_announcements (enrollment_id, announcement_id, course_id, is_read, first_read_at, last_seen_sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (enrollment_id, announcement_id) DO UPDATE SET
       is_read = excluded.is_read, first_read_at = excluded.first_read_at, missing_since = NULL,
       last_seen_at = now(), last_seen_sync_run_id = excluded.last_seen_sync_run_id`,
    [enrollmentId, rows[0]!.id, courseId, toBool(read.isRead), toDate(read.firstReadDate), runId],
  );
  return { id: rows[0]!.id, inserted: rows[0]!.inserted };
}

export async function upsertTodo(client: Queryable, enrollmentId: string, courseId: string, columnId: string, bucket: string, dueAt: Date | null, runId: string): Promise<void> {
  await client.query(
    `INSERT INTO todo_observations (enrollment_id, gradebook_column_id, course_id, bucket, due_at, sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (enrollment_id, gradebook_column_id) DO UPDATE SET
       bucket = excluded.bucket, due_at = excluded.due_at, observed_at = now(), sync_run_id = excluded.sync_run_id`,
    [enrollmentId, columnId, courseId, bucket, dueAt, runId],
  );
}

export interface OutcomeInput {
  state: 'in_progress' | 'closed';
  closedReason: 'course_closed' | 'term_ended' | 'course_ended' | null;
  closedAt: Date | null;
  finalColumnExternalId: string | null;
  finalColumnName: string | null;
  finalScore: number | null;
  finalPointsPossible: number | null;
  finalDisplay: Json | null;
  outcome: 'passed' | 'failed' | 'unknown';
  thresholdPct: number | null;
}

/** Guarda el estado de cierre y la calificación general observados; el resultado solo existe con un umbral configurado. */
export async function upsertOutcome(client: Queryable, enrollmentId: string, runId: string, input: OutcomeInput): Promise<void> {
  const decided = input.outcome !== 'unknown';
  await client.query(
    `INSERT INTO enrollment_outcomes (enrollment_id, state, closed_reason, closed_at, final_column_external_id, final_column_name, final_score,
                                      final_points_possible, final_display, outcome, outcome_basis, outcome_threshold_pct, sync_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (enrollment_id) DO UPDATE SET
       state = excluded.state, closed_reason = excluded.closed_reason, closed_at = excluded.closed_at,
       final_column_external_id = excluded.final_column_external_id, final_column_name = excluded.final_column_name,
       final_score = excluded.final_score, final_points_possible = excluded.final_points_possible, final_display = excluded.final_display,
       outcome = excluded.outcome, outcome_basis = excluded.outcome_basis, outcome_threshold_pct = excluded.outcome_threshold_pct,
       evaluated_at = now(), sync_run_id = excluded.sync_run_id`,
    [enrollmentId, input.state, input.closedReason, input.closedAt, input.finalColumnExternalId, input.finalColumnName, input.finalScore,
     input.finalPointsPossible, input.finalDisplay ? JSON.stringify(input.finalDisplay) : null, input.outcome,
     decided ? 'configured_threshold' : null, decided ? input.thresholdPct : null, runId],
  );
}
