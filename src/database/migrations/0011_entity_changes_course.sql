-- 0011 · Novedades: cada cambio conoce su materia para filtrarlo por inscripción.
-- Un cambio compartido (columna, anuncio) se muestra solo a estudiantes inscritos en esa materia
-- y detectado después de que su inscripción existiera. Reversión: DROP INDEX + ALTER TABLE ... DROP COLUMN.

ALTER TABLE entity_changes ADD COLUMN course_id uuid REFERENCES courses (id) ON DELETE CASCADE;
CREATE INDEX entity_changes_course_idx ON entity_changes (course_id, detected_at DESC) WHERE course_id IS NOT NULL;
