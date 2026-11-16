-- 코스피 예측 화면의 수동·스케줄 수행 로그. 예측 결과 테이블과는 별개다.
SET client_encoding TO 'UTF8';

CREATE TABLE IF NOT EXISTS dp.kospi_forecast_run_log (
  id bigserial PRIMARY KEY,
  time_point varchar(8) NOT NULL,
  trigger_type varchar(16) NOT NULL,
  target_dd date,
  llm boolean NOT NULL DEFAULT false,
  status varchar(16) NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  output text NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_kospi_forecast_run_log_started
  ON dp.kospi_forecast_run_log (started_at DESC, id DESC);

GRANT SELECT, INSERT ON TABLE dp.kospi_forecast_run_log TO dp_reader;
GRANT USAGE, SELECT ON SEQUENCE dp.kospi_forecast_run_log_id_seq TO dp_reader;
