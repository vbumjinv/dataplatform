-- 네이버페이 증권 뉴스 하루 수집분. 기사 키는 언론사ID_기사ID.
create table if not exists dp.news_stock_article (
  article_key text primary key,
  office_id text not null,
  article_id text not null,
  category text not null,
  published_at timestamptz not null,
  modified_at timestamptz,
  title text not null,
  summary text not null default '',
  publisher text not null default '',
  reporter text not null default '',
  url text not null,
  body text not null default '',
  body_chars integer not null default 0,
  content_hash text not null default '',
  crawl_date date not null,
  list_fetched_at timestamptz not null default now(),
  body_fetched_at timestamptz,
  body_status text not null default 'pending',
  body_error text not null default '',
  constraint news_stock_article_status_check
    check (body_status in ('pending', 'ok', 'low_quality', 'failed'))
);

create index if not exists news_stock_article_crawl_date_idx
  on dp.news_stock_article (crawl_date, published_at desc);

grant select, insert, update
  on table dp.news_stock_article
  to dp_reader;
