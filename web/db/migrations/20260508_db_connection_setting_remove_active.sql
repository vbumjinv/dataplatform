DROP INDEX IF EXISTS public.app_db_connection_setting_active_unique;

ALTER TABLE public.app_db_connection_setting
  DROP COLUMN IF EXISTS is_active;
