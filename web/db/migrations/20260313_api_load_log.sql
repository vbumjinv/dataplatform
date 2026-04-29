CREATE TABLE IF NOT EXISTS dp.api_load_log (
  load_log_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES dp.api_source(id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES dp.api_param_group(id) ON DELETE CASCADE,
  trigger_type text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms int,
  inserted_count int,
  request_url text,
  target_table text,
  merge_configured boolean NOT NULL DEFAULT false,
  error_message text,
  error_stage text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_load_log_trigger_type_check CHECK (trigger_type IN ('manual', 'schedule')),
  CONSTRAINT api_load_log_status_check CHECK (status IN ('running', 'success', 'error')),
  CONSTRAINT api_load_log_error_stage_check CHECK (
    error_stage IS NULL OR error_stage IN ('setup', 'api_fetch', 'table_load', 'merge_sql', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS api_load_log_group_started_idx
  ON dp.api_load_log(group_id, started_at DESC);

CREATE INDEX IF NOT EXISTS api_load_log_status_started_idx
  ON dp.api_load_log(status, started_at DESC);
