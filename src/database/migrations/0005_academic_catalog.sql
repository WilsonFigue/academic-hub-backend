-- 0005 · Catálogo académico compartido (por institución y por curso).
-- "Compartido" no significa visible para todos: la API solo lo sirve a través de las tablas por inscripción (0006).
-- Convenciones de procedencia: first_seen_at, last_seen_at, last_seen_sync_run_id, source;
-- borrado lógico: missing_since (ausente en un paso completo) y removed_at_source (confirmado).

CREATE TABLE academic_terms (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  institution_id         uuid NOT NULL REFERENCES institutions (id),
  external_id            text NOT NULL,          -- term.id
  name                   text NOT NULL,
  description            text,
  start_at               timestamptz,
  end_at                 timestamptz,
  is_available           boolean,
  duration_type          text,
  days_of_use            integer,
  source                 text NOT NULL DEFAULT 'internal_v1' CHECK (source IN ('internal_v1', 'public_v1')),
  content_hash           bytea,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, external_id),
  UNIQUE (id, institution_id),
  CHECK (end_at IS NULL OR start_at IS NULL OR end_at >= start_at)
);
CREATE TRIGGER academic_terms_updated_at BEFORE UPDATE ON academic_terms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE external_accounts
  ADD CONSTRAINT external_accounts_preferred_term_fk
  FOREIGN KEY (preferred_current_term_id, institution_id) REFERENCES academic_terms (id, institution_id);

CREATE TABLE courses (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  institution_id         uuid NOT NULL REFERENCES institutions (id),
  term_id                uuid,
  term_external_id       text,                   -- course.termId tal como llegó
  external_id            text NOT NULL,          -- course.id
  external_uuid          text,
  foundations_id         text,
  course_code            text,                   -- course.courseId
  display_id             text,
  batch_uid              text,
  name                   text NOT NULL,
  display_name           text,
  description            text,
  start_at               timestamptz,
  end_at                 timestamptz,
  is_available           boolean,
  is_closed              boolean,
  is_organization        boolean NOT NULL DEFAULT false,
  ultra_status           text,
  lms_url                text CHECK (lms_url IS NULL OR lms_url ~ '^https://'),
  source                 text NOT NULL DEFAULT 'internal_v1' CHECK (source IN ('internal_v1', 'public_v3')),
  content_hash           bytea,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, external_id),
  UNIQUE (id, institution_id),
  -- El período debe ser de la misma institución que la materia.
  FOREIGN KEY (term_id, institution_id) REFERENCES academic_terms (id, institution_id),
  CHECK (term_id IS NULL OR term_external_id IS NOT NULL)
);
CREATE INDEX courses_term_idx ON courses (term_id);
CREATE TRIGGER courses_updated_at BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Árbol de contenido. El padre debe pertenecer al mismo curso (FK compuesta).
CREATE TABLE course_content_items (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  course_id              uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  external_id            text NOT NULL,          -- content.id
  parent_id              uuid,
  parent_external_id     text,                   -- content.parentId; se conserva aunque el padre no sea visible
  root_kind              text NOT NULL DEFAULT 'outline' CHECK (root_kind IN ('outline', 'interactive')),
  handler                text NOT NULL,          -- contentHandler, p. ej. resource/x-bb-folder
  title                  text NOT NULL,
  description            text,
  body_text              text,
  body_html_sanitized    text,
  position               integer,
  depth                  integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  content_detail         jsonb CHECK (content_detail IS NULL OR jsonb_typeof(content_detail) = 'object'),
  external_url           text CHECK (external_url IS NULL OR external_url ~ '^https?://'),
  has_grade_column       boolean,
  due_at                 timestamptz,            -- genericReadOnlyData.dueDate
  is_available           boolean,
  source_modified_at     timestamptz,            -- modifiedDate (epoch ms en la API interna)
  source                 text NOT NULL DEFAULT 'internal_v1' CHECK (source IN ('internal_v1', 'public_v1')),
  content_hash           bytea,
  missing_since          timestamptz,
  removed_at_source      timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, external_id),
  UNIQUE (id, course_id),
  FOREIGN KEY (parent_id, course_id) REFERENCES course_content_items (id, course_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX course_content_items_tree_idx ON course_content_items (course_id, parent_id, position);
CREATE TRIGGER course_content_items_updated_at BEFORE UPDATE ON course_content_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE grading_schemas (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  course_id              uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  external_id            text NOT NULL,
  title                  text,
  title_key              text,                   -- localizableTitle.languageKey
  scale_type             text,
  is_numeric             boolean,
  symbols                jsonb CHECK (symbols IS NULL OR jsonb_typeof(symbols) = 'array'),
  content_hash           bytea,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, external_id),
  UNIQUE (id, course_id)
);
CREATE TRIGGER grading_schemas_updated_at BEFORE UPDATE ON grading_schemas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Columna del libro de calificaciones = actividad evaluable canónica.
CREATE TABLE gradebook_columns (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  course_id              uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  external_id            text NOT NULL,          -- column.id
  content_item_id        uuid,
  content_external_id    text,                   -- column.contentId tal como llegó
  grading_schema_id      uuid,
  grading_schema_external_id text,
  name                   text NOT NULL,          -- columnName
  effective_name         text,
  points_possible        numeric(12, 4) CHECK (points_possible IS NULL OR points_possible >= 0),
  due_at                 timestamptz,
  enforce_due_date       boolean,
  category_external_id   text,
  category_key           text,                   -- gradebookCategory.localizableTitle.languageKey (p. ej. Test.name)
  category_title         text,
  score_provider_handle  text,                   -- tipo de evaluación (resource/x-bb-assessment, ...)
  is_calculated          boolean NOT NULL DEFAULT false,
  calculated_formula     jsonb CHECK (calculated_formula IS NULL OR jsonb_typeof(calculated_formula) = 'object'),
  is_attempt_based       boolean,
  multiple_attempts      integer,
  is_formative           boolean,
  is_scorable            boolean,
  position               integer,
  is_visible             boolean,
  grades_released        boolean,
  is_deleted_at_source   boolean NOT NULL DEFAULT false,
  source                 text NOT NULL DEFAULT 'internal_v1' CHECK (source IN ('internal_v1', 'public_v2')),
  content_hash           bytea,
  missing_since          timestamptz,
  removed_at_source      timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, external_id),
  UNIQUE (id, course_id),
  FOREIGN KEY (content_item_id, course_id) REFERENCES course_content_items (id, course_id),
  FOREIGN KEY (grading_schema_id, course_id) REFERENCES grading_schemas (id, course_id),
  CHECK (content_item_id IS NULL OR content_external_id IS NOT NULL),
  CHECK (calculated_formula IS NULL OR is_calculated)
);
CREATE INDEX gradebook_columns_due_idx ON gradebook_columns (course_id, due_at) WHERE NOT is_deleted_at_source;
CREATE INDEX gradebook_columns_content_idx ON gradebook_columns (content_item_id) WHERE content_item_id IS NOT NULL;
CREATE TRIGGER gradebook_columns_updated_at BEFORE UPDATE ON gradebook_columns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE course_announcements (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  course_id              uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  external_id            text NOT NULL,
  title                  text NOT NULL,
  body_text              text,
  body_html_sanitized    text,
  source_created_at      timestamptz,
  source_modified_at     timestamptz,
  visible_from           timestamptz,            -- startDateRestriction
  visible_until          timestamptz,            -- endDateRestriction
  is_draft               boolean,
  creator_external_id    text,                   -- solo el ID; sin datos personales del docente
  source                 text NOT NULL DEFAULT 'internal_v1' CHECK (source IN ('internal_v1', 'public_v1')),
  content_hash           bytea,
  missing_since          timestamptz,
  removed_at_source      timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, external_id),
  UNIQUE (id, course_id)
);
CREATE TRIGGER course_announcements_updated_at BEFORE UPDATE ON course_announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
