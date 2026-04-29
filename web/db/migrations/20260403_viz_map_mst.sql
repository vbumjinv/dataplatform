create table if not exists dp.viz_map_mst (
  map_id bigserial primary key,
  source_org varchar(50) not null,
  api_name varchar(200) not null,
  source_table varchar(200) not null,
  series_name varchar(200) not null,
  series_key varchar(200),
  date_column varchar(200) not null,
  date_format varchar(50),
  value_column varchar(200) not null,
  where_clause text,
  unit_name varchar(100),
  freq varchar(20),
  is_active boolean not null default true,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index if not exists ix_viz_map_mst_active
  on dp.viz_map_mst (is_active);

create index if not exists ix_viz_map_mst_org_table
  on dp.viz_map_mst (source_org, source_table);

create index if not exists ix_viz_map_mst_series_name
  on dp.viz_map_mst (series_name);

create index if not exists ix_viz_map_mst_updated_at
  on dp.viz_map_mst (updated_at desc);

create unique index if not exists ux_viz_map_mst_unique_mapping
  on dp.viz_map_mst (source_org, source_table, series_name, date_column, value_column, coalesce(series_key, ''));
