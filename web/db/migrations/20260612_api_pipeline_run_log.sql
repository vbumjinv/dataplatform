-- 파이프라인 실행 로그 (스텝별 결과는 step_results jsonb)
create table if not exists dp.api_pipeline_run_log (
  run_log_id bigint generated always as identity primary key,
  pipeline_id bigint references dp.api_pipeline(pipeline_id) on delete cascade,
  trigger_type text not null default 'manual',
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  elapsed_ms int,
  step_results jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_pipeline_run_log_trigger_type_check'
      and conrelid = 'dp.api_pipeline_run_log'::regclass
  ) then
    alter table dp.api_pipeline_run_log
      add constraint api_pipeline_run_log_trigger_type_check
      check (trigger_type in ('manual', 'schedule'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'api_pipeline_run_log_status_check'
      and conrelid = 'dp.api_pipeline_run_log'::regclass
  ) then
    alter table dp.api_pipeline_run_log
      add constraint api_pipeline_run_log_status_check
      check (status in ('running', 'success', 'error'));
  end if;
end$$;

create index if not exists ix_api_pipeline_run_log_pipeline_started
  on dp.api_pipeline_run_log(pipeline_id, started_at desc);
