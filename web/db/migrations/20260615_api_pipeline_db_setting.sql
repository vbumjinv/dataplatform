-- 파이프라인 스케줄 실행 시 UI에서 선택한 DB 연결과 동일한 계정을 사용하기 위해 저장
alter table dp.api_pipeline
  add column if not exists db_setting_id bigint;