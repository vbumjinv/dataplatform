begin;

-- viz_map_mst / viz_map_data 기반으로 시각화를 단순화한다.
-- 기존 viz_chart / viz_series 계열 테이블은 제거 대상이다.

drop table if exists dp.viz_chart_ref_line cascade;
drop table if exists dp.viz_chart_series cascade;
drop table if exists dp.viz_chart cascade;

drop table if exists dp.viz_analysis_series cascade;
drop table if exists dp.viz_analysis_topic cascade;
drop table if exists dp.viz_analysis cascade;

drop table if exists dp.viz_series cascade;
drop table if exists dp.viz_series_mst cascade;

commit;
