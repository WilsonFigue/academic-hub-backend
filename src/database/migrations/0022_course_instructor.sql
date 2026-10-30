-- 0022 · Docente de cada materia (nombre completo, escrito por el estudiante).
-- Blackboard solo lo expone en la lista de participantes del curso, que no se consulta a propósito (datos de terceros).
-- Es un solo nombre por materia, compartido por quienes la cursan; la importación nunca lo toca. Se usa en las portadas de las tareas.

ALTER TABLE courses
  ADD COLUMN instructor_name   text CHECK (instructor_name IS NULL OR char_length(btrim(instructor_name)) BETWEEN 3 AND 200),
  ADD COLUMN instructor_set_at timestamptz;
