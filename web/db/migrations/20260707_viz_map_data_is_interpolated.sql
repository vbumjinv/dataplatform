-- 선형보간(interpolate)으로 생성된 행 표시: 추정값임을 구분하기 위함
alter table dp.viz_map_data
  add column if not exists is_interpolated boolean not null default false;
