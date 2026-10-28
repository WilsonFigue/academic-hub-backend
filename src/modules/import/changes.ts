// Registro de novedades entre importaciones (entity_changes).
// Reglas:
// - La primera importación de una cuenta es línea base: no genera novedades personales.
// - Los cambios del catálogo (columnas, anuncios) solo se registran si la materia ya existía antes de esta ejecución.
// - Los cambios de nota solo se registran si la inscripción ya existía.
// - Nunca se registran eliminaciones: una ausencia puede deberse a una lectura incompleta.
import type { Queryable } from '../../database/connection.js';
import type { ColumnState, GradeState, UpsertResult } from './persist.js';

export type ChangeKind =
  | 'term_new' | 'course_new' | 'activity_new' | 'due_changed' | 'activity_renamed' | 'points_changed'
  | 'grade_new' | 'grade_changed' | 'submission_changed' | 'announcement_new';

interface ChangeInput {
  runId: string;
  entityType: 'academic_term' | 'course_enrollment' | 'gradebook_column' | 'student_grade' | 'course_announcement';
  entityId: string;
  scope: 'shared' | 'personal';
  accountId: string | null;
  courseId: string | null;
  changeType: 'created' | 'updated';
  kind: ChangeKind;
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function recordChange(client: Queryable, change: ChangeInput): Promise<void> {
  await client.query(
    `INSERT INTO entity_changes (sync_run_id, entity_type, entity_id, scope, external_account_id, course_id, change_type, changed_fields, before, after, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sync')`,
    [change.runId, change.entityType, change.entityId, change.scope, change.scope === 'personal' ? change.accountId : null, change.courseId,
     change.changeType, change.changedFields, change.before ? JSON.stringify(change.before) : null,
     JSON.stringify({ ...(change.after ?? {}), kind: change.kind })],
  );
}

const sameInstant = (left: string | null | undefined, right: string | null | undefined) =>
  (left ? new Date(left).getTime() : null) === (right ? new Date(right).getTime() : null);
const sameNumber = (left: unknown, right: unknown) =>
  (left === null || left === undefined ? null : Number(left)) === (right === null || right === undefined ? null : Number(right));

/** Cambios de negocio de una columna (compartidos). */
export function columnChanges(result: UpsertResult<ColumnState>): Array<{ kind: ChangeKind; changeType: 'created' | 'updated'; fields: string[] }> {
  if (result.after.is_calculated) return [];
  if (result.inserted) return [{ kind: 'activity_new', changeType: 'created', fields: [] }];
  const before = result.before;
  if (!before || !result.changed) return [];
  const out: Array<{ kind: ChangeKind; changeType: 'updated'; fields: string[] }> = [];
  if (!sameInstant(before.due_at, result.after.due_at)) out.push({ kind: 'due_changed', changeType: 'updated', fields: ['due_at'] });
  if (before.name !== result.after.name) out.push({ kind: 'activity_renamed', changeType: 'updated', fields: ['name'] });
  if (!sameNumber(before.points_possible, result.after.points_possible)) out.push({ kind: 'points_changed', changeType: 'updated', fields: ['points_possible'] });
  return out;
}

/** Cambios de negocio de una nota propia (personales). */
export function gradeChanges(result: UpsertResult<GradeState>): Array<{ kind: ChangeKind; fields: string[] }> {
  const before = result.before;
  if (result.inserted || !before || !result.changed) return [];
  const out: Array<{ kind: ChangeKind; fields: string[] }> = [];
  const hadScore = before.score !== null && before.score !== undefined;
  const hasScore = result.after.score !== null && result.after.score !== undefined;
  if (!hadScore && hasScore) out.push({ kind: 'grade_new', fields: ['score'] });
  else if (hadScore && hasScore && !sameNumber(before.score, result.after.score)) out.push({ kind: 'grade_changed', fields: ['score'] });
  // Pasar a GRADED junto con una nota nueva ya se informa como "calificación nueva": no se duplica.
  const gradedWithScore = out.length > 0 && result.after.submission_status === 'GRADED';
  if (!gradedWithScore && (before.submission_status !== result.after.submission_status || before.is_submitted !== result.after.is_submitted)) {
    out.push({ kind: 'submission_changed', fields: ['submission_status'] });
  }
  return out;
}
