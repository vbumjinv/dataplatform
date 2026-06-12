GRANT SELECT, INSERT, UPDATE
  ON TABLE public.app_db_connection_setting
  TO dp_reader;

GRANT EXECUTE
  ON FUNCTION public.app_db_connection_setting_touch_updated_at()
  TO dp_reader;
