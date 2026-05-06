-- ai_forecast_chat 테이블/시퀀스 접근 권한 (app 접속 계정: dp_reader)

GRANT USAGE ON SCHEMA dp TO dp_reader;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE dp.ai_forecast_chat_session
  TO dp_reader;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE dp.ai_forecast_chat_message
  TO dp_reader;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE dp.ai_forecast_chat_summary
  TO dp_reader;

GRANT USAGE, SELECT
  ON SEQUENCE dp.ai_forecast_chat_message_message_id_seq
  TO dp_reader;

GRANT EXECUTE
  ON FUNCTION dp.ai_forecast_chat_session_touch_updated_at()
  TO dp_reader;
