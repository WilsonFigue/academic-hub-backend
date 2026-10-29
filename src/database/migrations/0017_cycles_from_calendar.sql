-- 0017 · Ciclos y actividades asignados desde el calendario institucional.
-- 'institution_calendar' marca lo que repartió el calendario oficial; 'manual' sigue siendo lo que el estudiante guardó a mano y nunca se sobrescribe.

ALTER TABLE evaluation_cycles DROP CONSTRAINT IF EXISTS evaluation_cycles_source_check;
ALTER TABLE evaluation_cycles ADD CONSTRAINT evaluation_cycles_source_check
  CHECK (source IN ('manual', 'formula_suggestion', 'ai_suggestion', 'institution_calendar'));

ALTER TABLE evaluation_cycle_items DROP CONSTRAINT IF EXISTS evaluation_cycle_items_source_check;
ALTER TABLE evaluation_cycle_items ADD CONSTRAINT evaluation_cycle_items_source_check
  CHECK (source IN ('manual', 'formula_suggestion', 'ai_suggestion', 'institution_calendar'));
