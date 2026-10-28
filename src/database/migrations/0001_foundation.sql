-- 0001 · Fundamentos: función de auditoría compartida.
-- Todas las PK internas usan uuidv7() (nativa en PostgreSQL 18).

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
