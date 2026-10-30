-- 0023 · Sugerencias de respuesta para foros (las pide el estudiante con un botón; nunca son automáticas).
-- Se guarda solo la sugerencia del estudiante: el texto de las participaciones de compañeros NO se guarda en ningún lado.
-- «replies» lleva, por cada respuesta sugerida, el nombre de pila del compañero (para saludarlo) y el texto propuesto.

CREATE TABLE forum_suggestions (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  enrollment_id       uuid NOT NULL,
  course_id           uuid NOT NULL,
  gradebook_column_id uuid NOT NULL,
  post_text           text NOT NULL,
  replies             jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(replies) = 'array'),
  prompt_source       text NOT NULL CHECK (prompt_source IN ('teacher_post', 'pasted', 'title_only')),
  model               text,
  input_tokens        integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd            numeric(10, 5) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, gradebook_column_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE
);
CREATE TRIGGER forum_suggestions_updated_at BEFORE UPDATE ON forum_suggestions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
