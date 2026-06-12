ALTER TABLE public.app_db_connection_setting
  DROP CONSTRAINT IF EXISTS app_db_connection_setting_singleton_check;

ALTER TABLE public.app_db_connection_setting
  ADD COLUMN IF NOT EXISTS setting_name text NOT NULL DEFAULT '기본 연결',
  ADD COLUMN IF NOT EXISTS host text,
  ADD COLUMN IF NOT EXISTS port int,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE public.app_db_connection_setting
SET is_active = true
WHERE id = 1;

CREATE UNIQUE INDEX IF NOT EXISTS app_db_connection_setting_active_unique
  ON public.app_db_connection_setting (is_active)
  WHERE is_active = true;
