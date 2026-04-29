-- 3개 API 수집 테이블 신규 생성 (dp.api_source, dp.api_param_group, dp.api_param)
-- 기존 테이블이 있다면 DROP 후 실행

CREATE SCHEMA IF NOT EXISTS dp;

-- 1. dp.api_source
DROP TABLE IF EXISTS dp.api_param CASCADE;
DROP TABLE IF EXISTS dp.api_param_group CASCADE;
DROP TABLE IF EXISTS dp.api_source CASCADE;

CREATE TABLE dp.api_source (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'custom',
  base_url text NOT NULL,
  api_key text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  api_key_param_key text,
  api_key_location text NOT NULL DEFAULT 'query',
  api_key_order int NOT NULL DEFAULT 0,
  api_key_encode_mode text NOT NULL DEFAULT 'encode',
  is_template boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX api_source_name_unique ON dp.api_source(name);

-- 2. dp.api_param_group
CREATE TABLE dp.api_param_group (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES dp.api_source(id) ON DELETE CASCADE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_template boolean NOT NULL DEFAULT false,
  schedule_enabled boolean NOT NULL DEFAULT false,
  schedule_type text NOT NULL DEFAULT 'interval',
  schedule_interval_minutes int,
  schedule_cron_expr text,
  target_schema text,
  target_table text,
  target_truncate boolean NOT NULL DEFAULT false,
  target_merge_sql text,
  CONSTRAINT api_param_group_schedule_type_check CHECK (schedule_type IN ('interval', 'cron'))
);

CREATE INDEX api_param_group_source_id_idx ON dp.api_param_group(source_id);
CREATE INDEX api_param_group_schedule_enabled_idx
  ON dp.api_param_group(schedule_enabled) WHERE schedule_enabled = true;

-- 3. dp.api_param (source_id 없음, group_id로 조인)
CREATE TABLE dp.api_param (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id bigint NOT NULL REFERENCES dp.api_param_group(id) ON DELETE CASCADE,
  param_key text NOT NULL,
  param_value text NOT NULL,
  param_location text NOT NULL,
  param_order int NOT NULL DEFAULT 0,
  encode_mode text NOT NULL DEFAULT 'encode',
  param_role text,
  CONSTRAINT api_param_location_check CHECK (param_location IN ('path', 'query'))
);

CREATE INDEX api_param_group_id_idx ON dp.api_param(group_id);
CREATE UNIQUE INDEX api_param_group_key_unique ON dp.api_param(group_id, param_key);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION dp.api_source_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER api_source_updated_at_trigger
  BEFORE UPDATE ON dp.api_source
  FOR EACH ROW
  EXECUTE PROCEDURE dp.api_source_updated_at();
