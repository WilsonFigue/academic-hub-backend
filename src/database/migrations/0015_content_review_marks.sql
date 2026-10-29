-- 0015 · "Marcar como revisado": cola de marcas hechas por el estudiante, enviadas a Blackboard en la siguiente actualización.
-- Cada fila nace de un clic explícito del estudiante (nunca automática). Blackboard registrará la marca con la hora del ENVÍO, no la del clic.
-- Estados: pending (aún no enviada), sent (aceptada por Blackboard, o ya estaba completada allí), failed (3 intentos rechazados).
-- Reversión: DROP TABLE content_review_marks.

CREATE TABLE content_review_marks (
  enrollment_id      uuid NOT NULL,
  content_item_id    uuid NOT NULL,
  course_id          uuid NOT NULL,
  state              text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed')),
  marked_at          timestamptz NOT NULL DEFAULT now(),   -- cuándo lo marcó el estudiante en Academic Hub
  sent_at            timestamptz,
  attempts           smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code    text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  already_completed  boolean NOT NULL DEFAULT false,       -- Blackboard ya lo mostraba completado: no se envió nada
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, content_item_id),
  FOREIGN KEY (enrollment_id, course_id) REFERENCES course_enrollments (id, course_id) ON DELETE CASCADE,
  FOREIGN KEY (content_item_id, course_id) REFERENCES course_content_items (id, course_id) ON DELETE CASCADE,
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX content_review_marks_pending_idx ON content_review_marks (enrollment_id) WHERE state = 'pending';
CREATE TRIGGER content_review_marks_updated_at BEFORE UPDATE ON content_review_marks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
