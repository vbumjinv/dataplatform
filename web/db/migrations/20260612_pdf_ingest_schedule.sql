-- PDF 직접 수집 작업 공용 스케줄 설정 (작업별 1행, job_key 로 구분)
create table if not exists dp.pdf_ingest_schedule (
  job_key text primary key,
  schedule_enabled boolean not null default false,
  schedule_cron_expr text not null default '0 9 1 * *',
  updated_at timestamptz not null default now()
);

-- 산업부 수출입동향(20대 품목) 적재 작업
insert into dp.pdf_ingest_schedule (job_key)
values ('itemtrade')
on conflict (job_key) do nothing;
