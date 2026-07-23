-- 채워넣은(fill-forward) 행 표시: 이동평균 등에서 실제 관측치만 골라쓰기 위함
alter table dp.viz_map_data
  add column if not exists is_filled boolean not null default false;
