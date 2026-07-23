grant select, insert, update, delete
  on table dp.api_pipeline
  to dp_reader;

grant select, insert, update, delete
  on table dp.api_pipeline_map
  to dp_reader;

grant select, insert, update
  on table dp.api_pipeline_run_log
  to dp_reader;

grant usage, select on sequence dp.api_pipeline_pipeline_id_seq to dp_reader;
grant usage, select on sequence dp.api_pipeline_map_id_seq to dp_reader;
grant usage, select on sequence dp.api_pipeline_run_log_run_log_id_seq to dp_reader;
