import type { Database } from '../../database/connection.js';

// Todas las consultas parten del usuario autenticado: users → external_accounts → course_enrollments.
// Un recurso que no pertenece a esa cadena simplemente no aparece (la API responde 404).

const OWN_ENROLLMENTS = `
  SELECT ce.id AS enrollment_id, ce.course_id, ea.id AS external_account_id
    FROM course_enrollments ce
    JOIN external_accounts ea ON ea.id = ce.external_account_id
   WHERE ea.user_id = $1 AND ea.link_status <> 'revoked' AND ce.status = 'active'`;

// Vencimiento efectivo: personal (excepción/pendiente) o el de la columna.
const EFFECTIVE_DUE = 'COALESCE(sg.effective_due_at, gc.due_at)';
const IS_ACTIVITY = 'NOT gc.is_calculated AND NOT gc.is_deleted_at_source AND gc.removed_at_source IS NULL AND sg.is_visible_to_student';

export function createAcademicRepository(db: Database) {
  return {
    async institutions() {
      const { rows } = await db.query(
        `SELECT id, code, name, lms_provider AS "lmsProvider", lms_base_url AS "lmsBaseUrl", timezone, auth_mode AS "authMode", status
           FROM institutions WHERE status = 'active' ORDER BY name`,
      );
      return rows;
    },

    async universityAccounts(userId: string, accountId?: string) {
      const { rows } = await db.query(
        `SELECT ea.id, i.code AS "institutionCode", i.name AS "institutionName", ea.lms_username AS "lmsUsername",
                ea.given_name AS "givenName", ea.family_name AS "familyName", ea.preferred_display_name AS "preferredDisplayName",
                ea.institutional_email AS "institutionalEmail", ea.locale, ea.link_status AS "linkStatus",
                ea.linked_at AS "linkedAt", ea.last_verified_at AS "lastVerifiedAt", ea.last_successful_sync_at AS "lastSuccessfulSyncAt",
                (SELECT count(*)::int FROM course_enrollments ce WHERE ce.external_account_id = ea.id AND ce.status = 'active') AS "activeEnrollments"
           FROM external_accounts ea JOIN institutions i ON i.id = ea.institution_id
          WHERE ea.user_id = $1 AND ($2::uuid IS NULL OR ea.id = $2)
          ORDER BY ea.created_at`,
        [userId, accountId ?? null],
      );
      return rows;
    },

    async terms(userId: string) {
      const { rows } = await db.query(
        `SELECT term_id AS id, name, start_at AS "startAt", end_at AS "endAt", is_available AS "isAvailable",
                bool_or(is_current_by_date) AS "isCurrentByDate", bool_or(is_preferred_current) AS "isPreferredCurrent",
                sum(course_count)::int AS "courseCount"
           FROM student_terms WHERE user_id = $1
          GROUP BY term_id, name, start_at, end_at, is_available
          ORDER BY start_at DESC NULLS LAST, name`,
        [userId],
      );
      return rows as Array<{ id: string; isCurrentByDate: boolean; isPreferredCurrent: boolean; [key: string]: unknown }>;
    },

    async courses(userId: string, filter: { termId?: string; courseId?: string } = {}) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT c.id, c.name, c.display_name AS "displayName", c.course_code AS "courseCode", c.display_id AS "displayId",
                c.description, c.start_at AS "startAt", c.end_at AS "endAt", c.is_available AS "isAvailable", c.is_closed AS "isClosed",
                c.lms_url AS "lmsUrl", c.last_seen_at AS "lastSeenAt", c.instructor_name AS "instructorName",
                CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'name', t.name, 'startAt', t.start_at, 'endAt', t.end_at) END AS term,
                json_build_object('id', ce.id, 'role', ce.role, 'isAvailable', ce.is_available, 'enrolledAt', ce.enrolled_at,
                                  'lastAccessAt', ce.last_access_at, 'userHasHidden', ce.user_has_hidden) AS enrollment,
                (SELECT count(*)::int FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
                  WHERE sg.enrollment_id = ce.id AND ${IS_ACTIVITY}) AS "activityCount",
                (SELECT min(${EFFECTIVE_DUE}) FROM student_grades sg JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
                  WHERE sg.enrollment_id = ce.id AND ${IS_ACTIVITY} AND ${EFFECTIVE_DUE} >= now()) AS "nextDueAt",
                (SELECT json_build_object('unreadGrades', cs.unread_grades, 'announcementsUnread', cs.announcements_unread, 'announcementsPosted', cs.announcements_posted,
                          'conversationsTotal', cs.conversations_total, 'conversationsUnread', cs.conversations_unread, 'forumUnread', cs.forum_unread,
                          'contentWithNews', cs.content_with_news, 'capturedAt', cs.captured_at)
                   FROM course_signals cs WHERE cs.enrollment_id = ce.id) AS signals
           FROM own
           JOIN course_enrollments ce ON ce.id = own.enrollment_id
           JOIN courses c ON c.id = own.course_id
           LEFT JOIN academic_terms t ON t.id = c.term_id
          WHERE ($2::uuid IS NULL OR c.term_id = $2) AND ($3::uuid IS NULL OR c.id = $3)
          ORDER BY t.start_at DESC NULLS LAST, c.name`,
        [userId, filter.termId ?? null, filter.courseId ?? null],
      );
      return rows;
    },

    /** Árbol visible para la inscripción del usuario (nunca lo observado por otra cuenta). */
    /** Archivos que comparten carpeta con el contenido de una actividad (sus guías), solo los visibles para esa inscripción. */
    async activityGuides(userId: string, activityId: string) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT f.id, f.course_id AS "courseId", f.title, f.content_detail->'file'->>'fileName' AS "fileName",
                f.content_detail->'file'->>'mimeType' AS "mimeType", (f.content_detail->'file'->>'fileSize')::bigint AS size
           FROM own
           JOIN student_grades sg ON sg.enrollment_id = own.enrollment_id AND sg.id = $2
           JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
           JOIN course_content_items task ON task.id = gc.content_item_id
           JOIN course_content_items f ON f.course_id = task.course_id AND f.parent_external_id IS NOT DISTINCT FROM task.parent_external_id
                AND f.handler = 'resource/x-bb-file' AND f.id <> task.id AND f.removed_at_source IS NULL
           JOIN enrollment_content_visibility v ON v.enrollment_id = own.enrollment_id AND v.content_item_id = f.id AND v.missing_since IS NULL
          WHERE task.parent_external_id IS NOT NULL AND f.content_detail->'file' IS NOT NULL
          ORDER BY f.position NULLS LAST, f.title`,
        [userId, activityId],
      );
      return rows;
    },

    async courseContent(userId: string, courseId: string) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS} AND ce.course_id = $2)
         SELECT ci.id, ci.parent_id AS "parentId", ci.root_kind AS "rootKind", ci.handler, ci.title, ci.description,
                ci.body_text AS "bodyText", ci.position, ci.depth, ci.external_url AS "externalUrl",
                ci.has_grade_column AS "hasGradeColumn", ci.due_at AS "dueAt", ci.source_modified_at AS "modifiedAt",
                v.visibility, v.completion,
                CASE WHEN ci.content_detail->'file' IS NOT NULL THEN jsonb_build_object('name', ci.content_detail->'file'->>'fileName',
                  'mimeType', ci.content_detail->'file'->>'mimeType', 'size', (ci.content_detail->'file'->>'fileSize')::bigint) END AS file,
                CASE WHEN m.enrollment_id IS NOT NULL THEN jsonb_build_object('state', m.state, 'markedAt', m.marked_at, 'sentAt', m.sent_at, 'alreadyCompleted', m.already_completed) END AS review
           FROM own
           JOIN enrollment_content_visibility v ON v.enrollment_id = own.enrollment_id AND v.missing_since IS NULL
           JOIN course_content_items ci ON ci.id = v.content_item_id AND ci.removed_at_source IS NULL
           LEFT JOIN content_review_marks m ON m.enrollment_id = own.enrollment_id AND m.content_item_id = ci.id
          ORDER BY ci.depth, ci.position NULLS LAST, ci.title`,
        [userId, courseId],
      );
      return rows;
    },

    async activities(userId: string, filter: {
      courseId?: string; from?: Date; to?: Date; status?: 'pending' | 'submitted' | 'graded'; activityId?: string; includeCalculated?: boolean; termId?: string;
    } = {}) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT sg.id, gc.name, gc.effective_name AS "effectiveName", c.id AS "courseId", c.name AS "courseName",
                gc.points_possible AS "pointsPossible", ${EFFECTIVE_DUE} AS "dueAt",
                CASE WHEN sg.effective_due_at IS NULL THEN CASE WHEN gc.due_at IS NULL THEN NULL ELSE 'column' END ELSE sg.effective_due_source END AS "dueSource",
                gc.category_key AS "categoryKey", gc.category_title AS "categoryTitle", gc.score_provider_handle AS "kind",
                gc.is_calculated AS "isCalculated", gc.position, gc.grades_released AS "gradesReleased",
                sg.status, sg.submission_status AS "submissionStatus", sg.is_submitted AS "isSubmitted",
                sg.score, sg.display_grade AS "displayGrade", sg.is_exempt AS "isExempt", sg.has_feedback AS "hasFeedback",
                (sg.submission_status = 'PAST_DUE_AUTO_ZERO') AS "isAutoZero",
                CASE WHEN ci.id IS NOT NULL AND v.content_item_id IS NOT NULL
                     THEN json_build_object('id', ci.id, 'title', ci.title, 'handler', ci.handler,
                       -- Solo texto que aporte algo distinto del título (en UTEC el resumen suele repetirlo).
                       'description', NULLIF(NULLIF(btrim(COALESCE(ci.body_text, ci.description)), ''), btrim(ci.title)),
                       'externalUrl', ci.external_url) END AS content,
                sg.feedback_text AS "feedbackText",
                c.lms_url AS "lmsUrl", c.term_id AS "termId", t.name AS "termName",
                (SELECT count(*)::int FROM grade_attempts a WHERE a.student_grade_id = sg.id) AS "attemptCount",
                (SELECT max(a.submitted_at) FROM grade_attempts a WHERE a.student_grade_id = sg.id AND a.status <> 'IN_PROGRESS') AS "submittedAt",
                (SELECT max(a.last_graded_at) FROM grade_attempts a WHERE a.student_grade_id = sg.id) AS "gradedAt",
                sg.last_seen_at AS "lastSeenAt"
           FROM own
           JOIN student_grades sg ON sg.enrollment_id = own.enrollment_id
           JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
           JOIN courses c ON c.id = own.course_id
           LEFT JOIN academic_terms t ON t.id = c.term_id
           LEFT JOIN course_content_items ci ON ci.id = gc.content_item_id
           LEFT JOIN enrollment_content_visibility v ON v.enrollment_id = own.enrollment_id AND v.content_item_id = ci.id
          WHERE NOT gc.is_deleted_at_source AND gc.removed_at_source IS NULL AND sg.is_visible_to_student
            AND ($9::boolean OR NOT gc.is_calculated)
            AND ($10::uuid IS NULL OR c.term_id = $10)
            AND ($2::uuid IS NULL OR c.id = $2)
            AND ($3::timestamptz IS NULL OR ${EFFECTIVE_DUE} >= $3)
            AND ($4::timestamptz IS NULL OR ${EFFECTIVE_DUE} <= $4)
            AND ($5::uuid IS NULL OR sg.id = $5)
            AND ($6::text IS NULL
                 OR ($6 = 'graded' AND sg.status = 'GRADED')
                 OR ($6 = 'submitted' AND sg.is_submitted IS TRUE)
                 OR ($6 = 'pending' AND sg.is_submitted IS NOT TRUE AND sg.status IS DISTINCT FROM 'GRADED'
                     AND sg.submission_status IS DISTINCT FROM 'PAST_DUE_AUTO_ZERO' AND (${EFFECTIVE_DUE} IS NULL OR ${EFFECTIVE_DUE} >= $7)))
          ORDER BY ${EFFECTIVE_DUE} NULLS LAST, c.name, gc.position NULLS LAST
          LIMIT $8`,
        [userId, filter.courseId ?? null, filter.from ?? null, filter.to ?? null, filter.activityId ?? null,
         filter.status ?? null, new Date(), 1000, filter.includeCalculated ?? false, filter.termId ?? null],
      );
      return rows;
    },

    async attempts(userId: string, studentGradeId: string) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT a.id, a.status, a.attempted_at AS "attemptedAt", a.submitted_at AS "submittedAt",
                a.first_graded_at AS "firstGradedAt", a.last_graded_at AS "lastGradedAt", a.score,
                a.display_grade AS "displayGrade", a.is_exempt AS "isExempt", (a.receipt_id IS NOT NULL) AS "hasReceipt",
                (a.status <> 'IN_PROGRESS') AS "isFinal"
           FROM own JOIN student_grades sg ON sg.enrollment_id = own.enrollment_id
           JOIN grade_attempts a ON a.student_grade_id = sg.id
          WHERE sg.id = $2
          ORDER BY a.attempted_at DESC NULLS LAST`,
        [userId, studentGradeId],
      );
      return rows;
    },

    /** Vencimientos de columnas + eventos independientes; los GradableItem enlazados no se duplican. */
    async calendar(userId: string, from: Date, to: Date) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT 'activity' AS type, sg.id, gc.name AS title, c.id AS "courseId", c.name AS "courseName",
                ${EFFECTIVE_DUE} AS "startAt", NULL::timestamptz AS "endAt", sg.status, sg.is_submitted AS "isSubmitted",
                sg.submission_status AS "submissionStatus", (sg.submission_status = 'PAST_DUE_AUTO_ZERO') AS "isAutoZero",
                gc.score_provider_handle AS kind, gc.category_key AS "categoryKey", sg.score, gc.points_possible AS "pointsPossible"
           FROM own JOIN student_grades sg ON sg.enrollment_id = own.enrollment_id
           JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
           JOIN courses c ON c.id = own.course_id
          WHERE ${IS_ACTIVITY} AND ${EFFECTIVE_DUE} BETWEEN $2 AND $3
         UNION ALL
         SELECT 'event', ci.id, ci.title, ci.course_id, c.name, ci.start_at, ci.end_at, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL
           FROM calendar_items ci
           LEFT JOIN courses c ON c.id = ci.course_id
          WHERE NOT (ci.is_gradable_projection AND ci.gradebook_column_id IS NOT NULL)
            AND ci.missing_since IS NULL
            AND ci.start_at BETWEEN $2 AND $3
            AND (   (ci.scope = 'course' AND ci.course_id IN (SELECT course_id FROM own))
                 OR (ci.scope = 'personal' AND ci.external_account_id IN (SELECT external_account_id FROM own))
                 OR (ci.scope = 'institution' AND ci.institution_id IN (
                       SELECT institution_id FROM external_accounts WHERE user_id = $1 AND link_status <> 'revoked')))
          ORDER BY "startAt"`,
        [userId, from, to],
      );
      return rows;
    },

    async syncRuns(userId: string, runId?: string) {
      const { rows } = await db.query(
        `SELECT r.id, r.external_account_id AS "universityAccountId", r.trigger, r.status, r.started_at AS "startedAt",
                r.finished_at AS "finishedAt", r.adapter_version AS "adapterVersion", r.stats, r.error_code AS "errorCode"
           FROM sync_runs r JOIN external_accounts ea ON ea.id = r.external_account_id
          WHERE ea.user_id = $1 AND ($2::uuid IS NULL OR r.id = $2)
          ORDER BY r.started_at DESC LIMIT 50`,
        [userId, runId ?? null],
      );
      return rows;
    },

    /**
     * Novedades del usuario: cambios personales de sus cuentas + cambios compartidos de materias en las que
     * está inscrito, detectados después de su inscripción. Paginación por cursor (detected_at, id).
     */
    async changes(userId: string, options: { before?: { at: Date; id: string }; limit: number; courseId?: string }) {
      const { rows } = await db.query(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT ec.id, ec.change_type AS "changeType", ec.after->>'kind' AS kind, ec.entity_type AS "entityType",
                ec.changed_fields AS "changedFields", ec.before - 'kind' AS before, ec.after - 'kind' AS after, ec.detected_at AS "detectedAt",
                c.id AS "courseId", c.name AS "courseName",
                -- Enlace al recurso propio: la actividad personal de esa columna o la materia.
                COALESCE(
                  CASE WHEN ec.entity_type = 'student_grade' THEN ec.entity_id END,
                  CASE WHEN ec.entity_type = 'gradebook_column'
                       THEN (SELECT sg.id FROM student_grades sg WHERE sg.gradebook_column_id = ec.entity_id AND sg.enrollment_id = own.enrollment_id) END
                ) AS "activityId",
                CASE WHEN ec.entity_type = 'academic_term' THEN ec.entity_id END AS "termId"
           FROM entity_changes ec
           LEFT JOIN own ON own.course_id = ec.course_id
           LEFT JOIN course_enrollments ce ON ce.id = own.enrollment_id
           LEFT JOIN courses c ON c.id = ec.course_id
          WHERE (
                  (ec.scope = 'personal' AND ec.external_account_id IN (SELECT id FROM external_accounts WHERE user_id = $1 AND link_status <> 'revoked')
                   AND (ec.course_id IS NULL OR own.enrollment_id IS NOT NULL))
               OR (ec.scope = 'shared' AND own.enrollment_id IS NOT NULL AND ec.detected_at >= ce.first_seen_at)
                )
            AND ($2::timestamptz IS NULL OR (ec.detected_at, ec.id) < ($2, $3::uuid))
            AND ($5::uuid IS NULL OR ec.course_id = $5)
          ORDER BY ec.detected_at DESC, ec.id DESC
          LIMIT $4`,
        [userId, options.before?.at ?? null, options.before?.id ?? null, options.limit, options.courseId ?? null],
      );
      return rows;
    },

    /** Inscripción propia activa en una materia (null si no es del usuario). */
    async ownEnrollment(userId: string, courseId: string): Promise<string | null> {
      const { rows } = await db.query<{ enrollment_id: string }>(`${OWN_ENROLLMENTS} AND ce.course_id = $2`, [userId, courseId]);
      return rows[0]?.enrollment_id ?? null;
    },

    async evaluationCycles(enrollmentId: string) {
      const cycles = await db.query(
        `SELECT ec.id, ec.number, ec.label, ec.weight_percent AS "weightPercent", ec.is_active AS "isActive", ec.source, ec.confirmed_at AS "confirmedAt",
                ie.exam_start::text AS "examStart", ie.exam_end::text AS "examEnd", ie.deferred_start::text AS "deferredStart", ie.deferred_end::text AS "deferredEnd",
                ie.grades_correction_deadline::text AS "gradesCorrectionDeadline"
           FROM evaluation_cycles ec
           JOIN course_enrollments ce ON ce.id = ec.enrollment_id
           JOIN courses c ON c.id = ce.course_id
           LEFT JOIN academic_terms t ON t.id = c.term_id
           LEFT JOIN institution_terms it ON it.term_name = t.name AND it.institution_id = t.institution_id
           LEFT JOIN institution_evaluations ie ON ie.term_id = it.id AND ie.number = ec.number
          WHERE ec.enrollment_id = $1 ORDER BY ec.number`,
        [enrollmentId],
      );
      const items = await db.query(
        `SELECT i.cycle_id AS "cycleId", sg.id AS "activityId", i.weight_within_cycle AS "weightWithinCycle", i.source, i.confirmed_at AS "confirmedAt"
           FROM evaluation_cycle_items i
           JOIN student_grades sg ON sg.enrollment_id = i.enrollment_id AND sg.gradebook_column_id = i.gradebook_column_id
          WHERE i.enrollment_id = $1`,
        [enrollmentId],
      );
      return { cycles: cycles.rows, items: items.rows };
    },

    /**
     * Avance de las materias del estudiante en las evaluaciones del ciclo institucional.
     * Los puntos son una ESTIMACIÓN con las notas de Blackboard (la nota oficial de cada evaluación la publica el docente en el portal).
     */
    async evaluationOverview(userId: string) {
      const terms = await db.query<{ id: string; name: string; weight: string; passing: string; start: string | null; end: string | null; today: string }>(
        `WITH own AS (${OWN_ENROLLMENTS})
         SELECT DISTINCT it.id, it.term_name AS name, it.evaluation_weight_percent AS weight, it.passing_grade AS passing,
                it.classes_start::text AS start, it.classes_end::text AS end, (now() AT TIME ZONE 'America/El_Salvador')::date::text AS today
           FROM own JOIN courses c ON c.id = own.course_id JOIN academic_terms t ON t.id = c.term_id
           JOIN institution_terms it ON it.term_name = t.name AND it.institution_id = t.institution_id
          ORDER BY start DESC NULLS LAST`, [userId]);
      const result = [];
      for (const term of terms.rows) {
        const evaluations = await db.query<{ number: number; examStart: string; examEnd: string; deferredStart: string | null; deferredEnd: string | null }>(
          `SELECT number, exam_start::text AS "examStart", exam_end::text AS "examEnd", deferred_start::text AS "deferredStart", deferred_end::text AS "deferredEnd"
             FROM institution_evaluations WHERE term_id = $1 ORDER BY number`, [term.id]);
        const current = (evaluations.rows.find((e) => term.today <= e.examEnd) ?? evaluations.rows[evaluations.rows.length - 1])?.number ?? null;
        const stats = await db.query<{ courseId: string; name: string; number: number; total: number; graded: number; earned: string | null; possible: string | null }>(
          `WITH own AS (${OWN_ENROLLMENTS})
           SELECT c.id AS "courseId", c.name, ec.number,
                  count(*) FILTER (WHERE ${IS_ACTIVITY})::int AS total,
                  count(*) FILTER (WHERE ${IS_ACTIVITY} AND sg.score IS NOT NULL)::int AS graded,
                  sum(sg.score) FILTER (WHERE ${IS_ACTIVITY} AND sg.score IS NOT NULL) AS earned,
                  sum(COALESCE(sg.points_possible, gc.points_possible)) FILTER (WHERE ${IS_ACTIVITY} AND sg.score IS NOT NULL) AS possible
             FROM own
             JOIN courses c ON c.id = own.course_id
             JOIN academic_terms t ON t.id = c.term_id
             JOIN institution_terms it ON it.term_name = t.name AND it.institution_id = t.institution_id AND it.id = $2
             JOIN evaluation_cycles ec ON ec.enrollment_id = own.enrollment_id
             LEFT JOIN evaluation_cycle_items i ON i.cycle_id = ec.id
             LEFT JOIN student_grades sg ON sg.enrollment_id = i.enrollment_id AND sg.gradebook_column_id = i.gradebook_column_id
             LEFT JOIN gradebook_columns gc ON gc.id = sg.gradebook_column_id
            GROUP BY c.id, c.name, ec.number ORDER BY c.name, ec.number`, [userId, term.id]);
        const weight = Number(term.weight); const passing = Number(term.passing);
        const pointsPerEvaluation = (weight / 100) * 10;
        const courses = new Map<string, { courseId: string; name: string; evaluations: Array<Record<string, unknown>> }>();
        for (const row of stats.rows) {
          const entry = courses.get(row.courseId) ?? courses.set(row.courseId, { courseId: row.courseId, name: row.name, evaluations: [] }).get(row.courseId)!;
          const possible = row.possible === null ? 0 : Number(row.possible);
          const percent = possible > 0 ? Number(row.earned) / possible : null;
          entry.evaluations.push({ number: row.number, total: row.total, graded: row.graded, percent, points: percent === null ? null : percent * pointsPerEvaluation });
        }
        const summaries = [...courses.values()].map((course) => {
          const scored = course.evaluations.filter((e) => e.points !== null);
          const earned = scored.reduce((sum, e) => sum + (e.points as number), 0);
          const available = (evaluations.rows.length - scored.length) * pointsPerEvaluation;
          return { ...course, pointsEarned: earned, pointsAvailable: available, missingToPass: Math.max(0, passing - earned), reachable: earned + available >= passing };
        });
        result.push({
          term: { name: term.name, passingGrade: passing, evaluationWeightPercent: weight, classesStart: term.start, classesEnd: term.end, today: term.today, currentEvaluation: current },
          evaluations: evaluations.rows.map((e) => ({ ...e, status: e.number === current ? 'current' : term.today > e.examEnd ? 'closed' : 'upcoming' })),
          courses: summaries,
        });
      }
      return result;
    },

    /**
     * Reemplaza la configuración completa de ciclos de una inscripción (PUT idempotente).
     * Las actividades llegan como IDs personales (student_grades.id) y se validan contra la inscripción.
     */
    async saveEvaluationCycles(enrollmentId: string, courseId: string, input: {
      activeNumber: number | null;
      cycles: Array<{ number: number; label: string | null; weightPercent: number | null; items: Array<{ activityId: string; weightWithinCycle: number | null }> }>;
    }): Promise<{ invalidActivityIds: string[] }> {
      return db.transaction(async (client) => {
        const activityIds = input.cycles.flatMap((cycle) => cycle.items.map((item) => item.activityId));
        const valid = await client.query<{ id: string; gradebook_column_id: string }>(
          `SELECT sg.id, sg.gradebook_column_id FROM student_grades sg WHERE sg.enrollment_id = $1 AND sg.id = ANY($2::uuid[])`,
          [enrollmentId, activityIds],
        );
        const columnByActivity = new Map(valid.rows.map((row) => [row.id, row.gradebook_column_id]));
        const invalidActivityIds = activityIds.filter((id) => !columnByActivity.has(id));
        if (invalidActivityIds.length > 0) return { invalidActivityIds };

        await client.query('DELETE FROM evaluation_cycles WHERE enrollment_id = $1', [enrollmentId]);
        for (const cycle of input.cycles) {
          const created = await client.query<{ id: string }>(
            `INSERT INTO evaluation_cycles (enrollment_id, number, label, weight_percent, is_active, source, confirmed_at)
             VALUES ($1, $2, $3, $4, $5, 'manual', now()) RETURNING id`,
            [enrollmentId, cycle.number, cycle.label, cycle.weightPercent, cycle.number === input.activeNumber],
          );
          for (const item of cycle.items) {
            await client.query(
              `INSERT INTO evaluation_cycle_items (cycle_id, enrollment_id, course_id, gradebook_column_id, weight_within_cycle, source, confirmed_at)
               VALUES ($1, $2, $3, $4, $5, 'manual', now())`,
              [created.rows[0]!.id, enrollmentId, courseId, columnByActivity.get(item.activityId), item.weightWithinCycle],
            );
          }
        }
        return { invalidActivityIds: [] };
      });
    },

    async syncRunSteps(runId: string) {
      const { rows } = await db.query(
        `SELECT resource, course_external_id IS NOT NULL AS "perCourse", status, complete, truncated, pages, items,
                http_status_counts AS "httpStatusCounts", error_code AS "errorCode", duration_ms AS "durationMs"
           FROM sync_run_steps WHERE sync_run_id = $1 ORDER BY started_at`,
        [runId],
      );
      return rows;
    },
  };
}

export type AcademicRepository = ReturnType<typeof createAcademicRepository>;
