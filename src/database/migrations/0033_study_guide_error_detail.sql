-- 0033 · Motivo legible de una guía fallida (p. ej. por qué no había material). Lo escribe el backend en español y la web lo muestra tal cual.
-- Reversión: ALTER TABLE study_guides DROP COLUMN error_detail.

ALTER TABLE study_guides ADD COLUMN error_detail text;
