-- 0007 · Calendario.
-- Los GradableItem enlazados a una columna son la fecha de esa columna, no actividades nuevas:
-- se guardan con gradebook_column_id para verificación cruzada y la API no los muestra como eventos propios.

CREATE TABLE calendar_items (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  institution_id         uuid NOT NULL REFERENCES institutions (id),
  scope                  text NOT NULL CHECK (scope IN ('course', 'institution', 'personal')),
  course_id              uuid,
  external_account_id    uuid,
  source_type            text NOT NULL,          -- itemSourceType (p. ej. blackboard.platform.gradebook2.GradableItem)
  source_external_id     text NOT NULL,          -- itemSourceId o id público
  calendar_external_id   text,
  gradebook_column_id    uuid,
  is_gradable_projection boolean GENERATED ALWAYS AS (source_type LIKE '%GradableItem') STORED,
  title                  text NOT NULL,
  start_at               timestamptz,
  end_at                 timestamptz,
  location               text,
  content_hash           bytea,
  missing_since          timestamptz,
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_run_id  uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, institution_id) REFERENCES courses (id, institution_id) ON DELETE CASCADE,
  FOREIGN KEY (external_account_id, institution_id) REFERENCES external_accounts (id, institution_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE SET NULL (gradebook_column_id),
  -- El ámbito determina qué referencias existen.
  CHECK (
    (scope = 'course'      AND course_id IS NOT NULL AND external_account_id IS NULL) OR
    (scope = 'personal'    AND external_account_id IS NOT NULL) OR
    (scope = 'institution' AND course_id IS NULL AND external_account_id IS NULL)
  ),
  CHECK (end_at IS NULL OR start_at IS NULL OR end_at >= start_at)
);
-- Unicidad por institución + ámbito + tipo de origen + ID real (nunca por título).
CREATE UNIQUE INDEX calendar_items_source_key
  ON calendar_items (institution_id, course_id, external_account_id, source_type, source_external_id) NULLS NOT DISTINCT;
-- Una columna tiene como mucho una proyección de calendario por ámbito.
CREATE UNIQUE INDEX calendar_items_column_key ON calendar_items (gradebook_column_id) WHERE gradebook_column_id IS NOT NULL;
CREATE INDEX calendar_items_course_start_idx ON calendar_items (course_id, start_at);
CREATE INDEX calendar_items_account_start_idx ON calendar_items (external_account_id, start_at) WHERE external_account_id IS NOT NULL;
CREATE TRIGGER calendar_items_updated_at BEFORE UPDATE ON calendar_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
