GRANT SELECT, INSERT
  ON TABLE public.user_access_log
  TO dp_reader;

GRANT USAGE, SELECT
  ON SEQUENCE public.user_access_log_access_log_id_seq
  TO dp_reader;
