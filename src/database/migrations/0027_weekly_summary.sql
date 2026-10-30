-- 0027 · El resumen semanal también se registra en email_summaries (una vez por persona y por semana).
-- Reversión: restaurar el CHECK con solo 'summary' (borrando antes las filas 'weekly').

ALTER TABLE email_summaries DROP CONSTRAINT email_summaries_kind_check;
ALTER TABLE email_summaries ADD CONSTRAINT email_summaries_kind_check CHECK (kind IN ('summary', 'weekly'));
