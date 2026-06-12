-- 그래프 목록/설정을 데이터 매핑과 분리하기 위한 전용 테이블
-- 실행 대상: PostgreSQL

create table if not exists dp.viz_chart_cfg (
  chart_id bigserial primary key,
  chart_name text not null,
  chart_type text not null default 'line',
  series_ids text[] not null default '{}',
  series_axis_map jsonb not null default '{}'::jsonb,
  reference_lines jsonb not null default '[]'::jsonb,
  is_public boolean not null default true,
  is_active boolean not null default true,
  created_by text null,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index if not exists idx_viz_chart_cfg_active_updated
  on dp.viz_chart_cfg (is_active, updated_at desc);
