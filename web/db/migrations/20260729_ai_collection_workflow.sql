CREATE TABLE IF NOT EXISTS dp.ai_collection_workflow (
  workflow_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES dp.ai_forecast_chat_session(session_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  db_setting_id bigint,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ai_collection_workflow_status_check
    CHECK (status IN ('active', 'completed', 'cancelled', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_collection_workflow_active_session_idx
  ON dp.ai_collection_workflow(session_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ai_collection_workflow_user_updated_idx
  ON dp.ai_collection_workflow(user_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE
  ON TABLE dp.ai_collection_workflow
  TO dp_reader;
