-- 데이터 수집 > 뉴스 설정. 검색어·건수·수치화·스케줄을 한 행에 저장한다.
create table if not exists dp.news_collect_setting (
  setting_id integer primary key,
  queries text[] not null,
  display_per_query integer not null default 10,
  market_code text not null default 'KOSPI',
  provider text not null default 'auto',
  model text not null default '',
  schedule_enabled boolean not null default false,
  schedule_cron_expr text not null default '0 7 * * *',
  updated_at timestamptz not null default now(),
  constraint news_collect_setting_provider_check
    check (provider in ('auto', 'openai', 'ollama')),
  constraint news_collect_setting_display_check
    check (display_per_query between 1 and 100)
);

insert into dp.news_collect_setting (setting_id, queries)
values (
  1,
  array['코스피', '한국은행 기준금리', '원달러 환율', '반도체 수출', '유가', '미국 금리']
)
on conflict (setting_id) do nothing;

grant select, insert, update
  on table dp.news_collect_setting
  to dp_reader;
