-- OECD 큐레이션 수집대상 목록에 GDP 갭률(Output Gap) 추가 (dp.api_stat_list_oecd 시드 확장)
-- 출처: OECD Economic Outlook (연간). flow_ref = OECD.ECO.MAD,DSD_EO@DF_EO
-- data_key 차원 순서: {REF_AREA}.{MEASURE}..A  (3번째 차원은 비워둠, 마지막은 FREQ=A)
-- MEASURE 코드:
--   GAP = Output gap as a percentage of potential GDP (잠재GDP 대비 산출갭 %)
-- 아래 flow_ref/data_key 는 sdmx.oecd.org 라이브 API 로 실제 조회가 검증된 값이다.
--   확인: /OECD.ECO.MAD,DSD_EO@DF_EO/KOR.GAP..A?format=jsondata → KOR 연간 산출갭(%) 반환
INSERT INTO dp.api_stat_list_oecd
  (id, category_name, indicator_name, flow_ref, data_key, ref_area, cycle, srch_yn, category_sort, item_sort)
VALUES
  ('gap_kor', 'GDP 갭률(Output Gap)', '대한민국 GDP 갭률(연)', 'OECD.ECO.MAD,DSD_EO@DF_EO', 'KOR.GAP..A', 'KOR', 'A', 'Y', 8, 1)
ON CONFLICT (id) DO UPDATE
SET
  category_name = EXCLUDED.category_name,
  indicator_name = EXCLUDED.indicator_name,
  flow_ref = EXCLUDED.flow_ref,
  data_key = EXCLUDED.data_key,
  ref_area = EXCLUDED.ref_area,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
