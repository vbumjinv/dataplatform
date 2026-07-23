alter table dp.viz_map_mst
  add column if not exists duplicate_date_policy text not null default 'none';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'viz_map_mst_duplicate_date_policy_check'
      and conrelid = 'dp.viz_map_mst'::regclass
  ) then
    alter table dp.viz_map_mst
      add constraint viz_map_mst_duplicate_date_policy_check
      check (duplicate_date_policy in ('none', 'sum'));
  end if;
end$$;
