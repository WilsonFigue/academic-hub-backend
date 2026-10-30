-- 0026 · Correo de resumen (consolidado) y correo personal de contacto.
-- contact_email: dónde recibe los resúmenes; si es NULL se usa el correo institucional de su cuenta.
-- email_summaries: un registro por envío; la llave (usuario, tipo, periodo) impide mandar dos veces el mismo resumen.
-- Reversión: DROP TABLE email_summaries; ALTER TABLE users DROP COLUMN contact_email.

ALTER TABLE users ADD COLUMN contact_email text
  CHECK (contact_email IS NULL OR (contact_email = btrim(contact_email) AND position('@' IN contact_email) > 1 AND length(contact_email) <= 320));

CREATE TABLE email_summaries (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('summary')),
  period_key   text NOT NULL CHECK (char_length(period_key) <= 40),     -- p. ej. el día 2026-10-30
  to_email     text NOT NULL,
  subject      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('sent', 'failed')),
  error_code   text,
  provider_ref text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, period_key)
);
