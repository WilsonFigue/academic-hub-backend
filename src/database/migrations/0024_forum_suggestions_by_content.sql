-- 0024 · La sugerencia de un foro se guarda por el foro mismo (contenido), no por la columna de calificaciones:
-- también hay foros sin nota que no tienen actividad, y se abren desde la pestaña de contenido.

ALTER TABLE forum_suggestions ADD COLUMN content_item_id uuid;
UPDATE forum_suggestions fs SET content_item_id = gc.content_item_id FROM gradebook_columns gc WHERE gc.id = fs.gradebook_column_id;
DELETE FROM forum_suggestions WHERE content_item_id IS NULL;
ALTER TABLE forum_suggestions ALTER COLUMN content_item_id SET NOT NULL;
ALTER TABLE forum_suggestions ALTER COLUMN gradebook_column_id DROP NOT NULL;
ALTER TABLE forum_suggestions DROP CONSTRAINT forum_suggestions_enrollment_id_gradebook_column_id_key;
ALTER TABLE forum_suggestions ADD CONSTRAINT forum_suggestions_enrollment_content_key UNIQUE (enrollment_id, content_item_id);
ALTER TABLE forum_suggestions ADD CONSTRAINT forum_suggestions_content_fk FOREIGN KEY (content_item_id, course_id) REFERENCES course_content_items (id, course_id) ON DELETE CASCADE;
