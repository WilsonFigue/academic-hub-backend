-- 0031 · PDF de las guías de estudio dentro de la base de datos.
-- Antes el PDF se armaba con Chromium al pedirlo y se guardaba en disco (.state/guides). Ahora se arma al generar la guía (o la primera
-- vez que se pide) y se guarda aquí, así la API puede servirlo sin Chromium ni disco permanente.
-- input_hash identifica el contenido y el diseño con que se armó; si cambia (otra fecha de entrega, otro diseño) se rehace cuando haya Chromium.
-- Reversión: DROP TABLE study_guide_pdfs.

CREATE TABLE study_guide_pdfs (
  guide_id   uuid PRIMARY KEY REFERENCES study_guides (id) ON DELETE CASCADE,
  input_hash text NOT NULL CHECK (char_length(input_hash) BETWEEN 6 AND 64),
  content    bytea NOT NULL CHECK (octet_length(content) <= 52428800),     -- 50 MB
  created_at timestamptz NOT NULL DEFAULT now()
);
