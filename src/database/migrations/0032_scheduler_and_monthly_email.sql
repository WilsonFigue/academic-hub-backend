-- 0032 · Programador de rutinas y correo mensual.
-- scheduled_job_runs: una fila por rutina y horario ("slot") ejecutado. La llave (rutina, horario) impide ejecutar dos veces el mismo horario,
-- aunque el servidor se reinicie, y deja el historial de lo que corrió (estado, detalle y error).
-- email_summaries: ahora también guarda el cierre mensual de gasto de IA (kind 'monthly').
-- Reversión: DROP TABLE scheduled_job_runs; restaurar el CHECK de email_summaries sin 'monthly' (borrando antes esas filas).

CREATE TABLE scheduled_job_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  job_name    text NOT NULL CHECK (job_name ~ '^[a-z][a-z0-9_-]{1,40}$'),
  slot_key    text NOT NULL CHECK (char_length(slot_key) <= 40),          -- p. ej. 2026-10-31@13:00 (hora de El Salvador)
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  detail      jsonb,
  error_code  text,
  UNIQUE (job_name, slot_key)
);
CREATE INDEX scheduled_job_runs_recent_idx ON scheduled_job_runs (started_at DESC);

ALTER TABLE email_summaries DROP CONSTRAINT email_summaries_kind_check;
ALTER TABLE email_summaries ADD CONSTRAINT email_summaries_kind_check CHECK (kind IN ('summary', 'weekly', 'monthly'));
