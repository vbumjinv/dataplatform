-- OpenDART 공시검색 결과. 접수번호(rcept_no)가 공시 한 건의 키다.
create table if not exists dp.dart_source (
  source_key text primary key,
  start_expr text not null,
  end_expr text not null,
  schedule_enabled boolean not null default false,
  schedule_type text not null default 'cron',
  schedule_interval_minutes integer,
  schedule_cron_expr text not null default '',
  db_setting_id integer,
  api_key text not null default '',
  updated_at timestamptz not null default now(),
  constraint dart_source_type_check check (schedule_type in ('interval', 'cron'))
);

insert into dp.dart_source (source_key, start_expr, end_expr)
values ('disclosure', '__TODAY__', '__TODAY__')
on conflict (source_key) do nothing;

create table if not exists dp.dart_disclosure (
  rcept_no text primary key,
  rcept_dt date not null,
  corp_code text not null default '',
  corp_name text not null default '',
  stock_code text not null default '',
  corp_cls text not null default '',
  report_nm text not null default '',
  flr_nm text not null default '',
  rm text not null default '',
  fetched_at timestamptz not null default now()
);

create index if not exists dart_disclosure_rcept_dt_idx
  on dp.dart_disclosure (rcept_dt desc, corp_name);

alter table dp.dart_source add column if not exists api_key text not null default '';

grant select, insert, update on table dp.dart_source to dp_reader;
grant select, insert, update on table dp.dart_disclosure to dp_reader;
