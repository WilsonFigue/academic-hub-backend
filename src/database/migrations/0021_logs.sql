-- 0021 · Dos bitácoras: peticiones a la API (con errores y fallas) y uso de IA (tokens y costos).
-- Son registros: no llevan llaves foráneas, así que sobreviven aunque se borren materias, actividades o usuarios.
-- Nunca guardan cuerpos de peticiones, cookies, tokens ni contraseñas.

CREATE TABLE api_request_log (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  request_id    text,
  method        text NOT NULL,
  route         text,                      -- patrón de la ruta (p. ej. /api/v1/activities/:id); null si no existe
  path          text NOT NULL,             -- ruta pedida, sin query string
  status        smallint NOT NULL,
  duration_ms   integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  user_id       uuid,
  ip_hash       bytea,
  user_agent    text,
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'client_error', 'server_error')),
  error_code    text,
  error_message text,
  error_detail  jsonb
);
CREATE INDEX api_request_log_created_idx ON api_request_log (created_at DESC);
CREATE INDEX api_request_log_errors_idx ON api_request_log (created_at DESC) WHERE outcome <> 'ok';
CREATE INDEX api_request_log_route_idx ON api_request_log (route, created_at DESC);

CREATE TABLE ai_usage_log (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  event               text NOT NULL CHECK (event IN ('call', 'run_finished', 'run_skipped', 'cap_reached', 'monthly_report')),
  feature             text NOT NULL CHECK (feature IN ('homework', 'study_guide', 'report')),
  run_id              uuid,                -- id de homework_runs o de study_guides
  user_id             uuid,
  enrollment_id       uuid,
  course_id           uuid,
  gradebook_column_id uuid,
  model               text,
  turn                smallint,
  input_tokens        integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens       integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_tokens       integer CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  cost_usd            numeric(10, 5) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  duration_ms         integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status              text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  error_code          text,
  tools               text[],
  period              date,                -- primer día del mes (hora de El Salvador) al que pertenece el registro
  message             text,
  detail              jsonb
);
CREATE INDEX ai_usage_log_period_idx ON ai_usage_log (period, feature, event);
CREATE INDEX ai_usage_log_created_idx ON ai_usage_log (created_at DESC);
CREATE INDEX ai_usage_log_run_idx ON ai_usage_log (run_id, created_at);
-- Un solo reporte mensual por mes.
CREATE UNIQUE INDEX ai_usage_log_monthly_report_uidx ON ai_usage_log (period) WHERE event = 'monthly_report';
