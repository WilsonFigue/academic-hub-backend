-- 0008 · Ciclos evaluativos (configuración personal por inscripción).
-- Blackboard no los expone: 0 grading periods y categorías de sistema (review A.6).
-- Las sugerencias derivadas de fórmulas quedan sin confirmar hasta que el estudiante las acepta.

CREATE TABLE evaluation_cycles (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  enrollment_id   uuid NOT NULL REFERENCES course_enrollments (id) ON DELETE CASCADE,
  number          smallint NOT NULL CHECK (number BETWEEN 1 AND 10),   -- UTEC usa 5; el modelo admite más
  label           text CHECK (length(label) BETWEEN 1 AND 80),
  weight_percent  numeric(5, 2) CHECK (weight_percent IS NULL OR weight_percent BETWEEN 0 AND 100),
  is_active       boolean NOT NULL DEFAULT false,
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'formula_suggestion', 'ai_suggestion')),
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, number),
  UNIQUE (id, enrollment_id),
  -- Un ciclo manual se considera confirmado; una sugerencia no puede estar activa sin confirmar.
  CHECK (source <> 'manual' OR confirmed_at IS NOT NULL),
  CHECK (NOT is_active OR confirmed_at IS NOT NULL)
);
-- Un único ciclo activo por inscripción.
CREATE UNIQUE INDEX evaluation_cycles_one_active_key ON evaluation_cycles (enrollment_id) WHERE is_active;
CREATE TRIGGER evaluation_cycles_updated_at BEFORE UPDATE ON evaluation_cycles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE evaluation_cycle_items (
  cycle_id             uuid NOT NULL,
  enrollment_id        uuid NOT NULL,
  course_id            uuid NOT NULL,
  gradebook_column_id  uuid NOT NULL,
  weight_within_cycle  numeric(5, 2) CHECK (weight_within_cycle IS NULL OR weight_within_cycle BETWEEN 0 AND 100),
  source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'formula_suggestion', 'ai_suggestion')),
  confirmed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, gradebook_column_id),
  -- Una columna pertenece como mucho a un ciclo dentro de la misma inscripción.
  UNIQUE (enrollment_id, gradebook_column_id),
  FOREIGN KEY (cycle_id, enrollment_id) REFERENCES evaluation_cycles (id, enrollment_id) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (gradebook_column_id, course_id) REFERENCES gradebook_columns (id, course_id) ON DELETE CASCADE,
  CHECK (source <> 'manual' OR confirmed_at IS NOT NULL)
);
