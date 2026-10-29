-- 0012 · Preferencias de interfaz por usuario (p. ej. orden de las columnas del tablero de actividades).
-- Solo guarda ajustes de presentación del propio usuario; no contiene datos académicos ni credenciales.
-- Reversión: DROP TABLE user_preferences.

CREATE TABLE user_preferences (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  value      jsonb NOT NULL CHECK (pg_column_size(value) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
