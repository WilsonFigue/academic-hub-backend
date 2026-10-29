-- 0019 · Guías de estudio con IA por actividad.
-- La guía vive como texto estructurado (content); el PDF se genera al vuelo a partir de él, así que no se guardan archivos.
-- Reglas: nada se genera si el estudiante no lo pidió (manual) o no activó la materia (rutina). Una sola guía por actividad.

CREATE TABLE study_guide_settings (
  enrollment_id uuid PRIMARY KEY REFERENCES course_enrollments (id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT false,      -- apagado por defecto: ningún texto sale hacia la IA sin que el estudiante lo active
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study_guides (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  enrollment_id       uuid NOT NULL,
  course_id           uuid NOT NULL,
  gradebook_column_id uuid NOT NULL,
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'generating', 'ready', 'failed')),
  trigger             text NOT NULL CHECK (trigger IN ('manual', 'routine')),
  content             jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
  model               text,
  input_tokens        integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd            numeric(10, 5) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  error_code          text,
  attempts            smallint NOT NULL DEFAULT 0,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Una sola guía por actividad y estudiante: ni la rutina ni el botón pueden duplicarla.
  UNIQUE (enrollment_id, gradebook_column_id),
  UNIQUE (id, enrollment_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE,
  CHECK (status <> 'ready' OR content IS NOT NULL)
);
CREATE INDEX study_guides_queue_idx ON study_guides (requested_at) WHERE status IN ('requested', 'generating');
CREATE INDEX study_guides_spend_idx ON study_guides (finished_at) WHERE cost_usd IS NOT NULL;
CREATE TRIGGER study_guides_updated_at BEFORE UPDATE ON study_guides FOR EACH ROW EXECUTE FUNCTION set_updated_at();
