create table if not exists dp.viz_map_run_log (
  run_log_id bigint generated always as identity primary key,
  map_id bigint not null references dp.viz_map_mst(map_id) on delete cascade,
  series_name text,
  trigger_type text not null default 'manual',
  run_mode text not null default 'generate',
  status text not null default 'running',
  affected_count bigint not null default 0,
  start_date date,
  end_date date,
  error_message text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'viz_map_run_log_trigger_type_check'
      and conrelid = 'dp.viz_map_run_log'::regclass
  ) then
    alter table dp.viz_map_run_log
      add constraint viz_map_run_log_trigger_type_check
      check (trigger_type in ('manual', 'schedule'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'viz_map_run_log_run_mode_check'
      and conrelid = 'dp.viz_map_run_log'::regclass
  ) then
    alter table dp.viz_map_run_log
      add constraint viz_map_run_log_run_mode_check
      check (run_mode in ('generate', 'regenerate'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'viz_map_run_log_status_check'
      and conrelid = 'dp.viz_map_run_log'::regclass
  ) then
    alter table dp.viz_map_run_log
      add constraint viz_map_run_log_status_check
      check (status in ('running', 'success', 'error'));
  end if;
end$$;

create index if not exists ix_viz_map_run_log_started_at
  on dp.viz_map_run_log (started_at desc);

create index if not exists ix_viz_map_run_log_map_started
  on dp.viz_map_run_log (map_id, started_at desc);
