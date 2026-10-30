-- 0020 · Tareas resueltas con IA por actividad (agente con herramientas).
-- Misma lógica que las guías: apagado por defecto por materia, una sola corrida por actividad, tope de gasto propio.
-- Los archivos que produce el agente (PDF, Word, Excel) viven en disco (.state/homework); aquí queda su lista y el registro del trabajo.

CREATE TABLE homework_settings (
  enrollment_id uuid PRIMARY KEY REFERENCES course_enrollments (id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,      -- apagado por defecto: nada sale hacia la IA sin que el estudiante lo active
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE homework_runs (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  enrollment_id       uuid NOT NULL,
  course_id           uuid NOT NULL,
  gradebook_column_id uuid NOT NULL,
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'generating', 'ready', 'failed', 'skipped')),
  trigger             text NOT NULL CHECK (trigger IN ('manual', 'routine')),
  deliverables        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(deliverables) = 'array'),   -- [{ name, kind, bytes }]
  summary             text,
  report              jsonb CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),            -- supuestos, pendientes, herramientas usadas, turnos
  model               text,
  input_tokens        integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd            numeric(10, 5) CHECK (cost_usd IS NULL OR cost_usd >= 0),                   -- también se guarda en los intentos que fallan
  error_code          text,
  attempts            smallint NOT NULL DEFAULT 0,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, gradebook_column_id),
  UNIQUE (id, enrollment_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE,
  CHECK (status <> 'ready' OR jsonb_array_length(deliverables) > 0)
);
CREATE INDEX homework_runs_queue_idx ON homework_runs (requested_at) WHERE status IN ('requested', 'generating');
CREATE INDEX homework_runs_spend_idx ON homework_runs (finished_at) WHERE cost_usd IS NOT NULL;
CREATE TRIGGER homework_runs_updated_at BEFORE UPDATE ON homework_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
