-- 뉴스 수집이 서버 재시작 뒤에도 같은 기간을 이어 가도록 마지막 실행을 남긴다.
create table if not exists dp.news_stock_collect_job (
  id integer primary key,
  start_date date not null,
  end_date date not null,
  db_setting_id integer,
  status text not null,
  message text not null default '',
  updated_at timestamptz not null default now(),
  constraint news_stock_collect_job_status_check
    check (status in ('running', 'done', 'error'))
);

grant select, insert, update
  on table dp.news_stock_collect_job
  to dp_reader;
