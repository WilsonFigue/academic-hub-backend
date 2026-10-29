-- 0016 · Calendario académico de la institución (igual para todos los estudiantes del ciclo).
-- Fuente: instructivo académico anual de UTEC. Las 5 evaluaciones valen 20 % cada una; la nota mínima es 6.0.
-- La pertenencia de cada actividad a una evaluación sigue siendo personal (evaluation_cycles, por inscripción).

CREATE TABLE institution_terms (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  institution_id            uuid NOT NULL REFERENCES institutions (id),
  term_name                 text NOT NULL,            -- igual que academic_terms.name, p. ej. 'Ciclo 02-2026'
  classes_start             date,
  classes_end               date,
  withdrawal_deadline       date,
  evaluation_count          smallint NOT NULL DEFAULT 5 CHECK (evaluation_count BETWEEN 1 AND 10),
  evaluation_weight_percent numeric(5, 2) NOT NULL DEFAULT 20 CHECK (evaluation_weight_percent BETWEEN 0 AND 100),
  passing_grade             numeric(4, 2) NOT NULL DEFAULT 6.0 CHECK (passing_grade BETWEEN 0 AND 10),
  source                    text NOT NULL,            -- p. ej. 'Instructivo académico 2026'
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, term_name),
  UNIQUE (id, institution_id)
);
CREATE TRIGGER institution_terms_updated_at BEFORE UPDATE ON institution_terms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE institution_evaluations (
  term_id                    uuid NOT NULL REFERENCES institution_terms (id) ON DELETE CASCADE,
  number                     smallint NOT NULL CHECK (number BETWEEN 1 AND 10),
  exam_start                 date NOT NULL,
  exam_end                   date NOT NULL,
  deferred_request_deadline  date,
  deferred_start             date,
  deferred_end               date,
  grades_correction_deadline date,
  PRIMARY KEY (term_id, number),
  CHECK (exam_end >= exam_start),
  CHECK (deferred_end IS NULL OR deferred_start IS NULL OR deferred_end >= deferred_start)
);
