-- 데이터 가공: Python 코드 직접 작성 타입(python) 추가
-- (df 입력 → 사용자 코드 실행 → result 출력. 실행은 python-forecast-api /transform 가 담당)
alter table dp.api_transform drop constraint if exists api_transform_type_check;
alter table dp.api_transform
  add constraint api_transform_type_check
  check (transform_type in ('sql', 'resample', 'rate', 'combine', 'interpolate', 'movavg', 'python'));
