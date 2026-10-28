-- 0002 · Identidad propia de Academic Hub y autenticación.
-- La contraseña de Academic Hub es independiente de la contraseña UTEC.

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  email                 text NOT NULL CHECK (email = btrim(email) AND position('@' IN email) > 1 AND length(email) <= 320),
  -- Usuario propio de Academic Hub (opcional); nunca el username de UTEC.
  username              text CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  password_hash         text NOT NULL,                      -- Argon2id (formato PHC)
  must_change_password  boolean NOT NULL DEFAULT false,
  display_name          text CHECK (length(display_name) BETWEEN 1 AND 120),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at     timestamptz,
  password_changed_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_username_key ON users (username) WHERE username IS NOT NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sesiones opacas: en la base solo se guarda el SHA-256 del token.
CREATE TABLE auth_sessions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  csrf_token_hash  bytea NOT NULL CHECK (length(csrf_token_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text CHECK (revoked_reason IN ('logout', 'logout_all', 'password_changed', 'expired', 'admin')),
  user_agent       text CHECK (length(user_agent) <= 512),
  ip_hash          bytea,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

-- Tokens de un solo uso (verificación de correo, recuperación, contraseña inicial).
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verification', 'password_reset', 'initial_password')),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

-- Auditoría de seguridad. Nunca contiene contraseñas, tokens ni sesiones.
CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  event        text NOT NULL CHECK (event ~ '^[a-z][a-z0-9_.]{2,63}$'),
  outcome      text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  ip_hash      bytea,
  user_agent   text CHECK (length(user_agent) <= 512),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, occurred_at DESC);
CREATE INDEX audit_events_event_idx ON audit_events (event, occurred_at DESC);
