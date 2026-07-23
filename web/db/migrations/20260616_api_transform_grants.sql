grant select, insert, update, delete
  on table dp.api_transform
  to dp_reader;

grant select, insert, update
  on table dp.api_transform_run_log
  to dp_reader;

grant usage, select on sequence dp.api_transform_transform_id_seq to dp_reader;
grant usage, select on sequence dp.api_transform_run_log_run_log_id_seq to dp_reader;
