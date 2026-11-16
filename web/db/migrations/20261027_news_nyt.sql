-- 뉴욕타임스 Article Search 수집 설정과 기사 목록.
create table if not exists dp.news_nyt_source (
  source_key text primary key,
  start_expr text not null,
  end_expr text not null,
  schedule_enabled boolean not null default false,
  schedule_type text not null default 'cron',
  schedule_interval_minutes integer,
  schedule_cron_expr text not null default '',
  db_setting_id integer,
  api_key text not null default '',
  keywords text not null default '',
  updated_at timestamptz not null default now(),
  constraint news_nyt_source_type_check check (schedule_type in ('interval', 'cron'))
);

insert into dp.news_nyt_source (source_key, start_expr, end_expr)
values ('nyt', '__TODAY__', '__TODAY__')
on conflict (source_key) do nothing;

create table if not exists dp.news_nyt_article (
  article_id text primary key,
  web_url text not null default '',
  headline text not null default '',
  abstract text not null default '',
  section_name text not null default '',
  published_at timestamptz,
  pub_date date,
  fetched_at timestamptz not null default now()
);

create index if not exists news_nyt_article_pub_date_idx
  on dp.news_nyt_article (pub_date desc, published_at desc);

alter table dp.news_nyt_source add column if not exists keywords text not null default '';

grant select, insert, update on table dp.news_nyt_source to dp_reader;
grant select, insert, update on table dp.news_nyt_article to dp_reader;
