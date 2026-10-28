-- 0004 · Ejecuciones de sincronización (antes del catálogo, que referencia la última ejecución que observó cada registro).

CREATE TABLE sync_runs (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  external_account_id  uuid NOT NULL REFERENCES external_accounts (id) ON DELETE CASCADE,
  trigger              text NOT NULL CHECK (trigger IN ('manual', 'link', 'dev_import', 'scheduled')),
  status               text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'needs_reauth', 'cancelled')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  adapter_version      text NOT NULL,
  stats                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
  error_code           text CHECK (error_code ~ '^[a-z][a-z0-9_]{2,63}$'),   -- código sanitizado, nunca mensajes crudos
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
-- Impide dos ejecuciones simultáneas para la misma cuenta.
CREATE UNIQUE INDEX sync_runs_one_running_key ON sync_runs (external_account_id) WHERE status = 'running';
CREATE INDEX sync_runs_account_idx ON sync_runs (external_account_id, started_at DESC);

-- Un paso por recurso (y por materia cuando aplica). "complete" decide si una ausencia es significativa.
CREATE TABLE sync_run_steps (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  sync_run_id         uuid NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  resource            text NOT NULL CHECK (resource IN (
                        'profile', 'memberships', 'terms', 'courses', 'content', 'gradebook_columns', 'grading_schemas',
                        'grades', 'attempts', 'due_date_exceptions', 'calendar', 'todo', 'announcements')),
  course_external_id  text,             -- referencia de origen; el curso puede no existir aún en el catálogo
  status              text NOT NULL CHECK (status IN ('succeeded', 'failed', 'incomplete', 'skipped')),
  complete            boolean NOT NULL DEFAULT false,
  truncated           boolean NOT NULL DEFAULT false,
  pages               integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
  items               integer NOT NULL DEFAULT 0 CHECK (items >= 0),
  http_status_counts  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(http_status_counts) = 'object'),
  error_code          text CHECK (error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  started_at          timestamptz NOT NULL DEFAULT now(),
  duration_ms         integer CHECK (duration_ms >= 0),
  -- Un paso truncado o fallido nunca cuenta como completo.
  CHECK (NOT complete OR (status = 'succeeded' AND NOT truncated))
);
CREATE INDEX sync_run_steps_run_idx ON sync_run_steps (sync_run_id);
