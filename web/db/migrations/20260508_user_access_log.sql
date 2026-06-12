CREATE TABLE IF NOT EXISTS public.user_access_log (
  access_log_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id int,
  email text,
  action text NOT NULL DEFAULT 'login',
  status text NOT NULL,
  ip_address text,
  user_agent text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_access_log_status_check CHECK (status IN ('success', 'failed')),
  CONSTRAINT user_access_log_action_check CHECK (action IN ('login', 'logout', 'session_denied'))
);

CREATE INDEX IF NOT EXISTS user_access_log_created_idx
  ON public.user_access_log(created_at DESC);

CREATE INDEX IF NOT EXISTS user_access_log_user_created_idx
  ON public.user_access_log(user_id, created_at DESC);
