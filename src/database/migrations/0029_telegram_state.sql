-- 0029 · Estado del bot de Telegram para el modo «consulta cuando me llamen» (sin proceso encendido).
-- last_update_id: último mensaje del bot ya atendido, para no repetir al consultar de nuevo. Una sola fila.
-- Reversión: DROP TABLE telegram_state.

CREATE TABLE telegram_state (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_update_id bigint NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
