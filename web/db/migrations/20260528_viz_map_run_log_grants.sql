grant select, insert, update
  on table dp.viz_map_run_log
  to dp_reader;

grant usage, select
  on sequence dp.viz_map_run_log_run_log_id_seq
  to dp_reader;
