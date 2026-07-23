-- 데이터 가공 실행 로그
create table if not exists dp.api_transform_run_log (
  run_log_id bigint generated always as identity primary key,
  transform_id bigint references dp.api_transform(transform_id) on delete cascade,
  trigger_type text not null default 'manual',
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  elapsed_ms int,
  affected_count int,
  error_message text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_transform_run_log_trigger_type_check'
      and conrelid = 'dp.api_transform_run_log'::regclass
  ) then
    alter table dp.api_transform_run_log
      add constraint api_transform_run_log_trigger_type_check
      check (trigger_type in ('manual', 'schedule'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_transform_run_log_status_check'
      and conrelid = 'dp.api_transform_run_log'::regclass
  ) then
    alter table dp.api_transform_run_log
      add constraint api_transform_run_log_status_check
      check (status in ('running', 'success', 'error'));
  end if;
end$$;

create index if not exists ix_api_transform_run_log_transform_started
  on dp.api_transform_run_log(transform_id, started_at desc);
