-- 0013 · Historial de materias: estado de cierre y resultado por inscripción, y nuevos orígenes de sincronización.
-- La tabla solo guarda lo observado en Blackboard (cierre, calificación general) y, de forma opcional, un resultado
-- derivado de un umbral configurado por el operador; sin ese umbral el resultado queda como 'unknown' (nunca se inventa).
-- Reversión: DROP TABLE enrollment_outcomes; restaurar el CHECK de sync_runs.trigger anterior.

ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_trigger_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_trigger_check
  CHECK (trigger IN ('manual', 'link', 'dev_import', 'dev_refresh_full', 'dev_refresh_daily', 'scheduled'));

CREATE TABLE enrollment_outcomes (
  enrollment_id            uuid PRIMARY KEY REFERENCES course_enrollments (id) ON DELETE CASCADE,
  state                    text NOT NULL CHECK (state IN ('in_progress', 'closed')),
  closed_reason            text CHECK (closed_reason IN ('course_closed', 'term_ended', 'course_ended')),
  closed_at                timestamptz,                       -- fecha observada de cierre (fin del período o de la materia)
  final_column_external_id text,                              -- columna marcada por Blackboard como calificación general
  final_column_name        text,
  final_score              numeric(12, 4),
  final_points_possible    numeric(12, 4),
  final_display            jsonb CHECK (final_display IS NULL OR jsonb_typeof(final_display) = 'object'),
  outcome                  text NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('passed', 'failed', 'unknown')),
  outcome_basis            text CHECK (outcome_basis IN ('configured_threshold')),
  outcome_threshold_pct    numeric(5, 2),
  evaluated_at             timestamptz NOT NULL DEFAULT now(),
  sync_run_id              uuid REFERENCES sync_runs (id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'unknown') = (outcome_basis IS NULL)),
  CHECK (state = 'closed' OR outcome = 'unknown')
);
CREATE TRIGGER enrollment_outcomes_updated_at BEFORE UPDATE ON enrollment_outcomes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
