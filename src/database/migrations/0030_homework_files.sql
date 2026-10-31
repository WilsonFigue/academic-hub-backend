-- 0030 · Archivos de las tareas dentro de la base de datos.
-- Antes vivían solo en el disco del servidor (.state/homework): si el servidor cambiaba o el disco se borraba, la tarea seguía
-- «lista» en la base pero sus archivos ya no existían. Ahora cada archivo se guarda aquí y el disco queda como zona de trabajo.
-- Reversión: DROP TABLE homework_files.

CREATE TABLE homework_files (
  run_id     uuid NOT NULL REFERENCES homework_runs (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  kind       text NOT NULL CHECK (kind IN ('pdf', 'docx', 'xlsx', 'ggb')),
  content    bytea NOT NULL CHECK (octet_length(content) <= 52428800),     -- 50 MB por archivo
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, name)
);
