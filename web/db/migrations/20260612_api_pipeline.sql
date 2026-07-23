-- 독립 파이프라인: 수집 1개 + 그 수집에 연결된 매핑 N개를 묶어 단일 스케줄로 실행
-- (신규 설치 + 이전 버전(step 모델) DB 모두에서 안전하게 동작하도록 idempotent 작성)
create table if not exists dp.api_pipeline (
  pipeline_id bigint generated always as identity primary key,
  name text not null,
  description text,
  group_id bigint references dp.api_param_group(id) on delete set null,
  schedule_enabled boolean not null default false,
  schedule_type text not null default 'interval',
  schedule_interval_minutes int,
  schedule_cron_expr text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 이전 버전(step 모델)에서 업그레이드: 컬럼 정리
alter table dp.api_pipeline add column if not exists group_id bigint references dp.api_param_group(id) on delete set null;
alter table dp.api_pipeline drop column if exists stop_on_error;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_pipeline_schedule_type_check'
      and conrelid = 'dp.api_pipeline'::regclass
  ) then
    alter table dp.api_pipeline
      add constraint api_pipeline_schedule_type_check
      check (schedule_type in ('interval', 'cron'));
  end if;
end$$;

create index if not exists ix_api_pipeline_schedule_enabled
  on dp.api_pipeline(schedule_enabled)
  where schedule_enabled = true;

-- 이전 버전의 스텝 테이블 제거 (수집 1:N 매핑 모델로 대체)
drop table if exists dp.api_pipeline_step;

-- 파이프라인에 포함된 매핑들 (수집 1 : 매핑 N)
create table if not exists dp.api_pipeline_map (
  id bigint generated always as identity primary key,
  pipeline_id bigint not null references dp.api_pipeline(pipeline_id) on delete cascade,
  map_id bigint not null references dp.viz_map_mst(map_id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  constraint api_pipeline_map_uq unique (pipeline_id, map_id)
);

create index if not exists ix_api_pipeline_map_pipeline
  on dp.api_pipeline_map(pipeline_id, sort_order);
