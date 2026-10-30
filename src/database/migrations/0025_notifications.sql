-- 0025 · Notificaciones del estudiante (bandeja de la campana).
-- Cada fila es un aviso para UN usuario: guía lista, tarea lista, actividad nueva, fecha por vencer, nota nueva, anuncio...
-- dedupe_key evita avisar dos veces lo mismo (p. ej. "vence mañana" de la misma actividad y la misma fecha).
-- expires_at oculta los avisos que ya no sirven (un recordatorio de entrega deja de ser útil al pasar la fecha o al entregar).
-- Reversión: DROP TABLE notifications.

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN (
                  'guide_ready', 'homework_ready', 'activity_new', 'due_changed', 'due_tomorrow', 'due_today', 'due_soon',
                  'grade_new', 'grade_changed', 'announcement_new')),
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'urgent')),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body          text CHECK (body IS NULL OR char_length(body) <= 500),
  course_id     uuid REFERENCES courses (id) ON DELETE CASCADE,
  activity_id   uuid REFERENCES student_grades (id) ON DELETE CASCADE,
  link          text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&%.-]*$'),
  dedupe_key    text NOT NULL CHECK (char_length(dedupe_key) <= 300),
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  dismissed_at  timestamptz,
  expires_at    timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_inbox_idx ON notifications (user_id, created_at DESC, id DESC) WHERE dismissed_at IS NULL;
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX notifications_activity_idx ON notifications (activity_id) WHERE activity_id IS NOT NULL;
