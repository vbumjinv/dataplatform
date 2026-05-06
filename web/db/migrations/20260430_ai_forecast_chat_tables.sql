CREATE SCHEMA IF NOT EXISTS dp;

CREATE TABLE IF NOT EXISTS dp.ai_forecast_chat_session (
  session_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS ai_forecast_chat_session_user_idx
  ON dp.ai_forecast_chat_session(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dp.ai_forecast_chat_message (
  message_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES dp.ai_forecast_chat_session(session_id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_forecast_chat_message_role_check
    CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS ai_forecast_chat_message_session_idx
  ON dp.ai_forecast_chat_message(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS dp.ai_forecast_chat_summary (
  session_id uuid PRIMARY KEY REFERENCES dp.ai_forecast_chat_session(session_id) ON DELETE CASCADE,
  summary_text text NOT NULL,
  summarized_through_message_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION dp.ai_forecast_chat_session_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_forecast_chat_session_touch_updated_at_trigger
  ON dp.ai_forecast_chat_session;

CREATE TRIGGER ai_forecast_chat_session_touch_updated_at_trigger
  BEFORE UPDATE ON dp.ai_forecast_chat_session
  FOR EACH ROW
  EXECUTE PROCEDURE dp.ai_forecast_chat_session_touch_updated_at();
