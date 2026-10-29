-- 0014 · Credenciales de Blackboard recordadas (opcional, con consentimiento) para la actualización diaria automática.
-- El usuario y la contraseña se guardan JUNTOS y CIFRADOS (AES-256-GCM, la clave vive en CREDENTIALS_KEY del entorno, nunca en la base).
-- Una fila solo existe si el titular pidió recordarlas; se borra con `npm run credentials -- forget <usuario>`.
-- Reversión: DROP TABLE account_credentials.

CREATE TABLE account_credentials (
  external_account_id  uuid PRIMARY KEY REFERENCES external_accounts (id) ON DELETE CASCADE,
  ciphertext           bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 29 AND 2048),   -- nonce(12) ‖ etiqueta(16) ‖ datos
  key_version          smallint NOT NULL DEFAULT 1,
  consented_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at         timestamptz,
  last_ok_at           timestamptz,
  last_error_code      text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  last_error_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER account_credentials_updated_at BEFORE UPDATE ON account_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
