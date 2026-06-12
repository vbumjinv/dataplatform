CREATE TABLE IF NOT EXISTS public.app_db_connection_setting (
  id int PRIMARY KEY DEFAULT 1,
  db_type text NOT NULL DEFAULT 'postgres',
  url text NOT NULL,
  database_name text NOT NULL,
  user_name text NOT NULL,
  password text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_db_connection_setting_singleton_check CHECK (id = 1),
  CONSTRAINT app_db_connection_setting_type_check CHECK (db_type IN ('postgres'))
);

CREATE OR REPLACE FUNCTION public.app_db_connection_setting_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_db_connection_setting_touch_updated_at_trigger
  ON public.app_db_connection_setting;

CREATE TRIGGER app_db_connection_setting_touch_updated_at_trigger
  BEFORE UPDATE ON public.app_db_connection_setting
  FOR EACH ROW
  EXECUTE PROCEDURE public.app_db_connection_setting_touch_updated_at();
