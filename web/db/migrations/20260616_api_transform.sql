-- 데이터 가공: 기존 매핑 시리즈를 변환(SQL/리샘플/증감률)해 새 파생 시리즈로 저장
-- (신규 설치/재실행 모두 안전하도록 idempotent 작성)
create table if not exists dp.api_transform (
  transform_id bigint generated always as identity primary key,
  name text not null,
  transform_type text not null default 'sql',
  -- 입력 시리즈 (viz_map_data) : 삭제되면 가공도 함께 삭제
  source_map_id bigint references dp.viz_map_mst(map_id) on delete cascade,
  -- 출력 파생 시리즈 (viz_map_mst 행) : 출력행 삭제 시 NULL
  output_map_id bigint references dp.viz_map_mst(map_id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  output_name text,
  output_unit text,
  output_freq text,
  db_setting_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_transform_type_check'
      and conrelid = 'dp.api_transform'::regclass
  ) then
    alter table dp.api_transform
      add constraint api_transform_type_check
      check (transform_type in ('sql', 'resample', 'rate'));
  end if;
end$$;

create index if not exists ix_api_transform_source_map
  on dp.api_transform(source_map_id);
create index if not exists ix_api_transform_output_map
  on dp.api_transform(output_map_id);
