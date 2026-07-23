-- 데이터 가공: 두 시리즈 연산(combine) 유형 추가
alter table dp.api_transform drop constraint if exists api_transform_type_check;
alter table dp.api_transform
  add constraint api_transform_type_check
  check (transform_type in ('sql', 'resample', 'rate', 'combine'));
