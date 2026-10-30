-- 0028 · Avisos por Telegram.
-- telegram_links: el chat de Telegram de cada usuario (un bot solo puede escribir a quien le dio «Iniciar»; el número de teléfono no sirve).
-- telegram_link_codes: códigos de un solo uso y corta vida para conectar el chat con la cuenta (enlace t.me/bot?start=CODIGO).
-- notifications.telegram_sent_at: cuándo se mandó ese aviso por Telegram (NULL = pendiente de mandar).
-- Reversión: DROP TABLE telegram_link_codes, telegram_links; ALTER TABLE notifications DROP COLUMN telegram_sent_at.

CREATE TABLE telegram_links (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  chat_id     bigint NOT NULL UNIQUE,
  tg_username text,
  enabled     boolean NOT NULL DEFAULT true,
  linked_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_link_codes (
  code       text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9]{16,64}$'),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX telegram_link_codes_user_idx ON telegram_link_codes (user_id);

ALTER TABLE notifications ADD COLUMN telegram_sent_at timestamptz;
-- Lo que ya existe no se manda por Telegram: solo lo que llegue desde ahora.
UPDATE notifications SET telegram_sent_at = now();
CREATE INDEX notifications_telegram_idx ON notifications (user_id, created_at) WHERE telegram_sent_at IS NULL AND dismissed_at IS NULL;
