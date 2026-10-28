-- 0003 · Instituciones y cuentas universitarias vinculadas.
-- No existe almacenamiento de contraseñas UTEC, cookies ni secretos TOTP (decisión pendiente, ver I.2 del review).

CREATE TABLE institutions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name          text NOT NULL,
  lms_provider  text NOT NULL CHECK (lms_provider IN ('blackboard_learn_ultra')),
  lms_base_url  text NOT NULL CHECK (lms_base_url ~ '^https://[^/]+$'),
  timezone      text NOT NULL,
  -- Mecanismo previsto: sesión iniciada por el usuario hoy; OAuth 3LO si la institución lo aprueba.
  auth_mode     text NOT NULL CHECK (auth_mode IN ('user_session', 'oauth_3lo')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER institutions_updated_at BEFORE UPDATE ON institutions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Perfil institucional mínimo (sin nacimiento, género, dirección ni teléfono).
CREATE TABLE external_accounts (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  institution_id            uuid NOT NULL REFERENCES institutions (id),
  lms_user_id               text,          -- users/me.id (formato _123_1)
  lms_uuid                  text,
  lms_foundations_id        text,
  lms_username              text,          -- no equivale al código de estudiante
  given_name                text,
  family_name               text,
  preferred_display_name    text,
  institutional_email       text,
  locale                    text,
  system_role               text,
  link_status               text NOT NULL DEFAULT 'pending'
                            CHECK (link_status IN ('pending', 'active', 'needs_reauth', 'revoked', 'error')),
  linked_at                 timestamptz,
  last_verified_at          timestamptz,
  last_successful_sync_at   timestamptz,
  preferred_current_term_id uuid,          -- FK añadida en 0005 (academic_terms aún no existe)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Una cuenta activa exige identidad verificada.
  CHECK (link_status NOT IN ('active', 'needs_reauth') OR (lms_user_id IS NOT NULL AND linked_at IS NOT NULL))
);
-- Una cuenta universitaria por usuario e institución (v1).
CREATE UNIQUE INDEX external_accounts_user_institution_key ON external_accounts (user_id, institution_id) WHERE link_status <> 'revoked';
-- Una identidad Blackboard no puede vincularse activamente a dos usuarios.
CREATE UNIQUE INDEX external_accounts_identity_key ON external_accounts (institution_id, lms_user_id)
  WHERE lms_user_id IS NOT NULL AND link_status <> 'revoked';
CREATE INDEX external_accounts_user_idx ON external_accounts (user_id);
-- Destino de FKs compuestas que fijan la institución de cada inscripción.
CREATE UNIQUE INDEX external_accounts_id_institution_key ON external_accounts (id, institution_id);
CREATE TRIGGER external_accounts_updated_at BEFORE UPDATE ON external_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
