-- 매핑: 빈 날짜 채우기(직전 값 forward-fill) 옵션. 기본값 켜짐(true)
-- 일별(freq='D') 매핑에서 주말/공휴일 등 빠진 달력 날짜를 직전 관측값으로 채운다.
alter table dp.viz_map_mst
  add column if not exists fill_forward boolean not null default true;
