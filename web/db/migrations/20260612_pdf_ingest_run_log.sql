-- PDF 직접 수집 작업 공용 실행 로그 (job_key 로 작업 구분)
create table if not exists dp.pdf_ingest_run_log (
  run_log_id bigint generated always as identity primary key,
  job_key text not null,
  trigger_type text not null default 'manual',
  status text not null default 'running',
  report_month date,
  source_file text,
  post_url text,
  inserted_count int,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  elapsed_ms int,
  error_message text,
  created_at timestamptz not null default now(),
  constraint pdf_ingest_run_log_trigger_type_check check (trigger_type in ('manual', 'schedule')),
  constraint pdf_ingest_run_log_status_check check (status in ('running', 'success', 'error'))
);

create index if not exists pdf_ingest_run_log_job_started_idx
  on dp.pdf_ingest_run_log(job_key, started_at desc);
