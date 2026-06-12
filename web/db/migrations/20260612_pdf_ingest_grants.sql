grant select, insert, update
  on table dp.pdf_ingest_schedule
  to dp_reader;

grant select, insert, update
  on table dp.pdf_ingest_run_log
  to dp_reader;

grant usage, select
  on sequence dp.pdf_ingest_run_log_run_log_id_seq
  to dp_reader;

grant select, insert, update, delete
  on table dp.pdf_itemtrade
  to dp_reader;
