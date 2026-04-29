-- 1) 시리즈 메타 적재
insert into dp.viz_series (
  series_id, source_org, source_table, source_key, series_name, unit_name, freq, is_active
)
select distinct
  'bok_513y001_' || item_code1 as series_id,
  'bok' as source_org,
  'bok_513y001' as source_table,
  item_code1 as source_key,
  coalesce(item_name1, item_code1) as series_name,
  unit_name,
  'M' as freq,
  true as is_active
from dp.bok_513y001
on conflict (series_id) do update
set
  series_name = excluded.series_name,
  unit_name = excluded.unit_name,
  is_active = true;


insert into dp.viz_series (
  series_id, source_org, source_table, source_key, series_name, unit_name, freq, is_active
)
select distinct
  'bok_802y001_' || item_code1 as series_id,
  'bok' as source_org,
  'bok_802y001' as source_table,
  item_code1 as source_key,
  coalesce(item_name1, item_code1) as series_name,
  unit_name,
  'D' as freq,
  true as is_active
from dp.bok_802y001
on conflict (series_id) do update
set
  series_name = excluded.series_name,
  unit_name = excluded.unit_name,
  is_active = true;


insert into dp.viz_series (
  series_id, source_org, source_table, source_key, series_name, unit_name, freq, is_active
)
select distinct
  'kosis_dt_1j22003_' || itm_id as series_id,
  'kosis' as source_org,
  'kosis_dt_1j22003' as source_table,
  itm_id as source_key,
  tbl_nm as series_name,
  unit_nm,
  'M' as freq,
  true as is_active
from dp.kosis_dt_1j22003
on conflict (series_id) do update
set
  series_name = excluded.series_name,
  unit_name = excluded.unit_name,
  is_active = true;

insert into dp.viz_series (
  series_id, source_org, source_table, source_key, series_name, unit_name, freq, is_active
)
select distinct
  'kosis_dt_1j22007_' || itm_id as series_id,
  'kosis' as source_org,
  'kosis_dt_1j22007' as source_table,
  itm_id as source_key,
  tbl_nm as series_name,
  unit_nm,
  'M' as freq,
  true as is_active
from dp.kosis_dt_1j22007
on conflict (series_id) do update
set
  series_name = excluded.series_name,
  unit_name = excluded.unit_name,
  is_active = true;


insert into dp.viz_series (
  series_id, source_org, source_table, source_key, series_name, unit_name, freq, is_active
)
select distinct
  'kosis_dt_1j22009_' || itm_id as series_id,
  'kosis' as source_org,
  'kosis_dt_1j22009' as source_table,
  itm_id as source_key,
  tbl_nm as series_name,
  unit_nm,
  'M' as freq,
  true as is_active
from dp.kosis_dt_1j22009
on conflict (series_id) do update
set
  series_name = excluded.series_name,
  unit_name = excluded.unit_name,
  is_active = true;



with base as (
  select
    year,
    to_date(replace(year, '.', '') || '01', 'YYYYMMDD') as obs_date,
    nullif(replace(balpayments::text, ',', ''), '')::numeric as balpayments,
    nullif(replace(expcnt::text, ',', ''), '')::numeric as expcnt,
    nullif(replace(expdlr::text, ',', ''), '')::numeric as expdlr,
    nullif(replace(impcnt::text, ',', ''), '')::numeric as impcnt,
    nullif(replace(impdlr::text, ',', ''), '')::numeric as impdlr
  from dp.datagokr_newtrade
  where year ~ '^[0-9]{4}\.[0-9]{2}$'   -- 총계 같은 값 제외
),
unpvt as (
  select
    v.metric_key,
    v.metric_name,
    v.unit_name
  from base b
  cross join lateral (
    values
      ('balpayments', '한국_무역수지', 'USD'),
      ('expcnt',      '한국_수출건수', '건'),
      ('expdlr',      '한국_수출금액', 'USD'),
      ('impcnt',      '한국_수입건수', '건'),
      ('impdlr',      '한국_수입금액', 'USD')
  ) as v(metric_key, metric_name, unit_name)
  group by v.metric_key, v.metric_name, v.unit_name
)
insert into dp.viz_series (
  series_id, source_org, source_table, source_key, series_name, unit_name, freq, is_active
)
select
  'datagokr_newtrade_' || metric_key as series_id,
  'datagokr' as source_org,
  'datagokr_newtrade' as source_table,
  metric_key as source_key,
  metric_name as series_name,
  unit_name,
  'M' as freq,
  true as is_active
from unpvt
on conflict (series_id) do update
set
  series_name = excluded.series_name,
  unit_name = excluded.unit_name,
  is_active = true;


-- 2) 시계열 포인트 적재
insert into dp.viz_series_point (series_id, obs_date, obs_value)
select
  'bok_513y001_' || item_code1 as series_id,
  to_date(time || '01', 'YYYYMMDD') as obs_date,
  data_value as obs_value
from dp.bok_513y001
where data_value is not null
on conflict (series_id, obs_date) do update
set obs_value = excluded.obs_value;


insert into dp.viz_series_point (series_id, obs_date, obs_value)
select
  'bok_802y001_' || item_code1 as series_id,
  to_date(time, 'YYYYMMDD') as obs_date,
  data_value as obs_value
from dp.bok_802y001
where data_value is not null
on conflict (series_id, obs_date) do update
set obs_value = excluded.obs_value;


insert into dp.viz_series_point (series_id, obs_date, obs_value)
select
  'kosis_dt_1j22003_' || itm_id as series_id,
  to_date(prd_de || '01', 'YYYYMMDD') as obs_date,
  dt as obs_value
from dp.kosis_dt_1j22003
where dt is not null
on conflict (series_id, obs_date) do update
set obs_value = excluded.obs_value;

insert into dp.viz_series_point (series_id, obs_date, obs_value)
select
  'kosis_dt_1j22007_' || itm_id as series_id,
  to_date(prd_de || '01', 'YYYYMMDD') as obs_date,
  dt as obs_value
from dp.kosis_dt_1j22007
where dt is not null
on conflict (series_id, obs_date) do update
set obs_value = excluded.obs_value;

insert into dp.viz_series_point (series_id, obs_date, obs_value)
select
  'kosis_dt_1j22009_' || itm_id as series_id,
  to_date(prd_de || '01', 'YYYYMMDD') as obs_date,
  dt as obs_value
from dp.kosis_dt_1j22009
where dt is not null
on conflict (series_id, obs_date) do update
set obs_value = excluded.obs_value;



with base as (
  select
    year,
    to_date(replace(year, '.', '') || '01', 'YYYYMMDD') as obs_date,
    nullif(replace(balpayments::text, ',', ''), '')::numeric as balpayments,
    nullif(replace(expcnt::text, ',', ''), '')::numeric as expcnt,
    nullif(replace(expdlr::text, ',', ''), '')::numeric as expdlr,
    nullif(replace(impcnt::text, ',', ''), '')::numeric as impcnt,
    nullif(replace(impdlr::text, ',', ''), '')::numeric as impdlr
  from dp.datagokr_newtrade
  where year ~ '^[0-9]{4}\.[0-9]{2}$'
),
unpvt as (
  select
    'datagokr_newtrade_' || v.metric_key as series_id,
    b.obs_date,
    v.obs_value
  from base b
  cross join lateral (
    values
      ('balpayments', b.balpayments),
      ('expcnt',      b.expcnt),
      ('expdlr',      b.expdlr),
      ('impcnt',      b.impcnt),
      ('impdlr',      b.impdlr)
  ) as v(metric_key, obs_value)
)
insert into dp.viz_series_point (series_id, obs_date, obs_value)
select
  series_id,
  obs_date,
  obs_value
from unpvt
where obs_value is not null
on conflict (series_id, obs_date) do update
set obs_value = excluded.obs_value;
