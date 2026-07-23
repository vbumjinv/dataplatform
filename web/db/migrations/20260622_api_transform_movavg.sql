-- 데이터 가공: 이동평균(movavg) 유형 추가
-- 주기(일·월·년)와 무관하게 최근 N개 관측치의 평균을 산출한다.
alter table dp.api_transform drop constraint if exists api_transform_type_check;
alter table dp.api_transform
  add constraint api_transform_type_check
  check (transform_type in ('sql', 'resample', 'rate', 'combine', 'interpolate', 'movavg'));
