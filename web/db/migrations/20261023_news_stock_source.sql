-- 네이버페이 증권 뉴스의 조회 기간과 스케줄을 한 행에 저장한다.
create table if not exists dp.news_stock_source (
  source_key text primary key,
  start_expr text not null,
  end_expr text not null,
  schedule_enabled boolean not null default false,
  schedule_type text not null default 'cron',
  schedule_interval_minutes integer,
  schedule_cron_expr text not null default '',
  db_setting_id integer,
  updated_at timestamptz not null default now(),
  constraint news_stock_source_type_check check (schedule_type in ('interval', 'cron'))
);

insert into dp.news_stock_source (source_key, start_expr, end_expr)
values ('naver-pay', '__TODAY_MINUS_1D__', '__TODAY_MINUS_1D__')
on conflict (source_key) do nothing;

grant select, insert, update
  on table dp.news_stock_source
  to dp_reader;
