-- 0006 · Datos personales por inscripción.
-- Cada tabla repite course_id y usa FKs compuestas: la base impide que una nota, una visibilidad
-- o un intento apunten a un recurso de una materia distinta a la de la inscripción.

CREATE TABLE course_enrollments (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  external_account_id        uuid NOT NULL,
  institution_id             uuid NOT NULL,
  course_id                  uuid NOT NULL,
  external_id                text NOT NULL,      -- membership.id
  foundations_id             text,
  role                       text,
  role_bucket                text,               -- courseRole.roleBucket
  is_available               boolean,
  user_has_hidden            boolean,
  enrolled_at                timestamptz,
  last_access_at             timestamptz,
  due_date_exception_type    text,
  time_limit_exception_type  text,
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'not_seen', 'removed_at_source')),
  missing_since              timestamptz,
  first_seen_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id      uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- La cuenta y la materia deben ser de la misma institución.
  FOREIGN KEY (external_account_id, institution_id) REFERENCES external_accounts (id, institution_id) ON DELETE CASCADE,
  FOREIGN KEY (course_id, institution_id) REFERENCES courses (id, institution_id) ON DELETE CASCADE,
  UNIQUE (external_account_id, course_id),
  UNIQUE (course_id, external_id),
  UNIQUE (id, course_id)
);
CREATE INDEX course_enrollments_account_idx ON course_enrollments (external_account_id) WHERE status = 'active';
CREATE TRIGGER course_enrollments_updated_at BEFORE UPDATE ON course_enrollments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fuente de autorización del árbol de contenido: qué observó esta inscripción y con qué visibilidad.
CREATE TABLE enrollment_content_visibility (
  enrollment_id          uuid NOT NULL,
  content_item_id        uuid NOT NULL,
  course_id              uuid NOT NULL,
  visibility             text,                   -- VISIBLE / PARTIALLY_VISIBLE / ...
  has_release_rules      boolean NOT NULL DEFAULT false,
  completion             jsonb CHECK (completion IS NULL OR jsonb_typeof(completion) = 'object'),  -- stateCompletion
  missing_since          timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  PRIMARY KEY (enrollment_id, content_item_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (content_item_id, course_id) REFERENCES course_content_items (id, course_id) ON DELETE CASCADE
);

-- Una fila por columna visible para la inscripción, con o sin nota (listGrades omite columnas sin registro).
-- La identidad es (inscripción, columna); external_grade_id es solo informativo porque puede ser null.
CREATE TABLE student_grades (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  enrollment_id          uuid NOT NULL,
  course_id              uuid NOT NULL,
  gradebook_column_id    uuid NOT NULL,
  external_grade_id      text,
  is_visible_to_student  boolean NOT NULL DEFAULT true,
  status                 text,                   -- GRADED / NEEDS_GRADING / ... (no implica entrega)
  submission_status      text,                   -- PAST_DUE_AUTO_ZERO es un cero automático, no una nota del docente
  score                  numeric(12, 4),
  points_possible        numeric(12, 4),
  display_grade          jsonb CHECK (display_grade IS NULL OR jsonb_typeof(display_grade) = 'object'),
  manual_grade           text,
  is_exempt              boolean,
  has_feedback           boolean,
  feedback_text          text,
  source_version         bigint,                 -- version (interna) o changeIndex (pública v2)
  viewed_by_student      boolean,
  source_modified_at     timestamptz,            -- lastOverrideDate u otra marca de cambio de origen
  -- Derivado de los intentos (todo estado distinto de IN_PROGRESS), nunca de status.
  is_submitted           boolean,
  effective_due_at       timestamptz,
  effective_due_source   text CHECK (effective_due_source IN ('column', 'exception', 'todo')),
  content_hash           bytea,
  missing_since          timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, gradebook_column_id),
  UNIQUE (id, course_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE,
  CHECK ((effective_due_at IS NULL) = (effective_due_source IS NULL))
);
CREATE INDEX student_grades_enrollment_due_idx ON student_grades (enrollment_id, effective_due_at);
CREATE TRIGGER student_grades_updated_at BEFORE UPDATE ON student_grades FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Solo intentos propios.
CREATE TABLE grade_attempts (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  student_grade_id       uuid NOT NULL,
  course_id              uuid NOT NULL,
  external_id            text NOT NULL,          -- attempt.id
  status                 text NOT NULL,          -- IN_PROGRESS = borrador, no entrega
  attempted_at           timestamptz,            -- attemptDate
  submitted_at           timestamptz,            -- attemptReceipt.submissionDate (entrega real)
  receipt_id             text,
  first_graded_at        timestamptz,
  last_graded_at         timestamptz,
  score                  numeric(12, 4),
  display_grade          jsonb CHECK (display_grade IS NULL OR jsonb_typeof(display_grade) = 'object'),
  is_exempt              boolean,
  override_status        text,
  content_hash           bytea,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, external_id),
  FOREIGN KEY (student_grade_id, course_id) REFERENCES student_grades (id, course_id) ON DELETE CASCADE
);
CREATE INDEX grade_attempts_grade_idx ON grade_attempts (student_grade_id);
CREATE TRIGGER grade_attempts_updated_at BEFORE UPDATE ON grade_attempts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Excepciones de vencimiento: el endpoint responde 200, pero la forma de cada registro no se ha visto
-- con una excepción real. Estructura mínima + raw hasta tener evidencia (ver review B.2.5 y K.5).
CREATE TABLE due_date_exceptions (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  enrollment_id          uuid NOT NULL,
  course_id              uuid NOT NULL,
  gradebook_column_id    uuid,
  source_key             text NOT NULL,          -- identificador o huella del registro de origen
  due_at                 timestamptz,
  raw                    jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  UNIQUE (enrollment_id, source_key),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE
);

-- Visibilidad y lectura personal de anuncios.
CREATE TABLE enrollment_announcements (
  enrollment_id          uuid NOT NULL,
  announcement_id        uuid NOT NULL,
  course_id              uuid NOT NULL,
  is_read                boolean,
  first_read_at          timestamptz,
  missing_since          timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  PRIMARY KEY (enrollment_id, announcement_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (announcement_id, course_id) REFERENCES course_announcements (id, course_id) ON DELETE CASCADE
);

-- Última observación del widget de pendientes (vencimiento personal candidato, sin id propio en origen).
CREATE TABLE todo_observations (
  enrollment_id          uuid NOT NULL,
  gradebook_column_id    uuid NOT NULL,
  course_id              uuid NOT NULL,
  bucket                 text NOT NULL CHECK (bucket IN ('overdue', 'due_today', 'upcoming')),
  due_at                 timestamptz,
  observed_at            timestamptz NOT NULL DEFAULT now(),
  sync_run_id            uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  PRIMARY KEY (enrollment_id, gradebook_column_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE
);
