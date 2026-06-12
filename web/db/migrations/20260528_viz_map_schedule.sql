alter table dp.viz_map_mst
  add column if not exists schedule_enabled boolean not null default false,
  add column if not exists schedule_type text not null default 'interval',
  add column if not exists schedule_interval_minutes int,
  add column if not exists schedule_cron_expr text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'viz_map_mst_schedule_type_check'
      and conrelid = 'dp.viz_map_mst'::regclass
  ) then
    alter table dp.viz_map_mst
      add constraint viz_map_mst_schedule_type_check
      check (schedule_type in ('interval', 'cron'));
  end if;
end$$;

create index if not exists ix_viz_map_mst_schedule_enabled
  on dp.viz_map_mst (schedule_enabled)
  where schedule_enabled = true;
