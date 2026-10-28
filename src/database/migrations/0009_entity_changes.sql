-- 0009 · Registro de cambios de negocio (no copias completas del JSON de origen).
-- before/after contienen solo los campos de negocio modificados; nunca contraseñas, cookies ni tokens.

CREATE TABLE entity_changes (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  sync_run_id          uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  entity_type          text NOT NULL CHECK (entity_type IN (
                         'academic_term', 'course', 'course_enrollment', 'course_content_item', 'gradebook_column',
                         'student_grade', 'grade_attempt', 'calendar_item', 'course_announcement', 'due_date_exception')),
  entity_id            uuid NOT NULL,
  -- shared: cambio del catálogo (se notifica uniendo con inscripciones activas); personal: de una cuenta.
  scope                text NOT NULL CHECK (scope IN ('shared', 'personal')),
  external_account_id  uuid REFERENCES external_accounts (id) ON DELETE CASCADE,
  change_type          text NOT NULL CHECK (change_type IN ('created', 'updated', 'missing', 'reappeared', 'removed')),
  changed_fields       text[] NOT NULL DEFAULT '{}',
  before               jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  after                jsonb CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),
  source               text NOT NULL DEFAULT 'sync' CHECK (source IN ('sync', 'user', 'system')),
  detected_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'personal') = (external_account_id IS NOT NULL)),
  CHECK (change_type <> 'updated' OR cardinality(changed_fields) > 0)
);
CREATE INDEX entity_changes_account_idx ON entity_changes (external_account_id, detected_at DESC) WHERE external_account_id IS NOT NULL;
CREATE INDEX entity_changes_entity_idx ON entity_changes (entity_type, entity_id, detected_at DESC);
CREATE INDEX entity_changes_run_idx ON entity_changes (sync_run_id);
