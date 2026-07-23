grant select, insert, update, delete
  on table dp.api_pipeline_transform
  to dp_reader;

grant usage, select on sequence dp.api_pipeline_transform_id_seq to dp_reader;
