-- OECD 큐레이션 수집대상 목록에 GDP 계열 지표 추가 (dp.api_stat_list_oecd 시드 확장)
-- 출처: OECD Economic Outlook (연간). flow_ref = OECD.ECO.MAD,DSD_EO@DF_EO
-- data_key 차원 순서: {REF_AREA}.{MEASURE}..A  (3번째 차원은 비워두면 됨, 마지막은 FREQ=A)
-- MEASURE 코드:
--   GDPV   = 국내총생산, 실질(연쇄물량)      → 실질 GDP
--   GDP    = 국내총생산, 명목(경상가격)      → 명목 GDP
--   GDPVTR = 잠재산출, 실질(연쇄물량)        → 실질 잠재GDP
--   GDPTR  = 잠재산출, 명목(경상가격)        → 명목 잠재GDP
-- 아래 flow_ref/data_key 는 sdmx.oecd.org 라이브 API 로 실제 조회가 검증된 값이다.
-- (OECD 잠재GDP 명목(GDPTR)은 KOR/USA/JPN/DEU/FRA/GBR 만 제공, OECD 집계는 실질만 제공)
INSERT INTO dp.api_stat_list_oecd
  (id, category_name, indicator_name, flow_ref, data_key, ref_area, cycle, srch_yn, category_sort, item_sort)
VALUES
  -- 국내총생산 (GDP) : OECD.ECO.MAD,DSD_EO@DF_EO / {AREA}.GDPV..A (실질) / {AREA}.GDP..A (명목)
  ('gdpv_kor',  'GDP(실질·명목)', '대한민국 실질 GDP(연)', 'OECD.ECO.MAD,DSD_EO@DF_EO', 'KOR.GDPV..A',  'KOR',  'A', 'Y', 6, 1),
  ('gdp_kor',   'GDP(실질·명목)', '대한민국 명목 GDP(연)', 'OECD.ECO.MAD,DSD_EO@DF_EO', 'KOR.GDP..A',   'KOR',  'A', 'Y', 6, 2),
  ('gdpv_usa',  'GDP(실질·명목)', '미국 실질 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'USA.GDPV..A',  'USA',  'A', 'Y', 6, 3),
  ('gdp_usa',   'GDP(실질·명목)', '미국 명목 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'USA.GDP..A',   'USA',  'A', 'Y', 6, 4),
  ('gdpv_jpn',  'GDP(실질·명목)', '일본 실질 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'JPN.GDPV..A',  'JPN',  'A', 'Y', 6, 5),
  ('gdp_jpn',   'GDP(실질·명목)', '일본 명목 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'JPN.GDP..A',   'JPN',  'A', 'Y', 6, 6),
  ('gdpv_deu',  'GDP(실질·명목)', '독일 실질 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'DEU.GDPV..A',  'DEU',  'A', 'Y', 6, 7),
  ('gdp_deu',   'GDP(실질·명목)', '독일 명목 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'DEU.GDP..A',   'DEU',  'A', 'Y', 6, 8),
  ('gdpv_fra',  'GDP(실질·명목)', '프랑스 실질 GDP(연)',   'OECD.ECO.MAD,DSD_EO@DF_EO', 'FRA.GDPV..A',  'FRA',  'A', 'Y', 6, 9),
  ('gdp_fra',   'GDP(실질·명목)', '프랑스 명목 GDP(연)',   'OECD.ECO.MAD,DSD_EO@DF_EO', 'FRA.GDP..A',   'FRA',  'A', 'Y', 6, 10),
  ('gdpv_gbr',  'GDP(실질·명목)', '영국 실질 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'GBR.GDPV..A',  'GBR',  'A', 'Y', 6, 11),
  ('gdp_gbr',   'GDP(실질·명목)', '영국 명목 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'GBR.GDP..A',   'GBR',  'A', 'Y', 6, 12),
  ('gdpv_chn',  'GDP(실질·명목)', '중국 실질 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'CHN.GDPV..A',  'CHN',  'A', 'Y', 6, 13),
  ('gdp_chn',   'GDP(실질·명목)', '중국 명목 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'CHN.GDP..A',   'CHN',  'A', 'Y', 6, 14),
  ('gdpv_oecd', 'GDP(실질·명목)', 'OECD 실질 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'OECD.GDPV..A', 'OECD', 'A', 'Y', 6, 15),
  ('gdp_oecd',  'GDP(실질·명목)', 'OECD 명목 GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'OECD.GDP..A',  'OECD', 'A', 'Y', 6, 16),

  -- 잠재GDP (Potential GDP) : OECD.ECO.MAD,DSD_EO@DF_EO / {AREA}.GDPVTR..A (실질) / {AREA}.GDPTR..A (명목)
  ('gdpvtr_kor',  '잠재GDP(실질·명목)', '대한민국 실질 잠재GDP(연)', 'OECD.ECO.MAD,DSD_EO@DF_EO', 'KOR.GDPVTR..A',  'KOR',  'A', 'Y', 7, 1),
  ('gdptr_kor',   '잠재GDP(실질·명목)', '대한민국 명목 잠재GDP(연)', 'OECD.ECO.MAD,DSD_EO@DF_EO', 'KOR.GDPTR..A',   'KOR',  'A', 'Y', 7, 2),
  ('gdpvtr_usa',  '잠재GDP(실질·명목)', '미국 실질 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'USA.GDPVTR..A',  'USA',  'A', 'Y', 7, 3),
  ('gdptr_usa',   '잠재GDP(실질·명목)', '미국 명목 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'USA.GDPTR..A',   'USA',  'A', 'Y', 7, 4),
  ('gdpvtr_jpn',  '잠재GDP(실질·명목)', '일본 실질 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'JPN.GDPVTR..A',  'JPN',  'A', 'Y', 7, 5),
  ('gdptr_jpn',   '잠재GDP(실질·명목)', '일본 명목 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'JPN.GDPTR..A',   'JPN',  'A', 'Y', 7, 6),
  ('gdpvtr_deu',  '잠재GDP(실질·명목)', '독일 실질 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'DEU.GDPVTR..A',  'DEU',  'A', 'Y', 7, 7),
  ('gdptr_deu',   '잠재GDP(실질·명목)', '독일 명목 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'DEU.GDPTR..A',   'DEU',  'A', 'Y', 7, 8),
  ('gdpvtr_fra',  '잠재GDP(실질·명목)', '프랑스 실질 잠재GDP(연)',   'OECD.ECO.MAD,DSD_EO@DF_EO', 'FRA.GDPVTR..A',  'FRA',  'A', 'Y', 7, 9),
  ('gdptr_fra',   '잠재GDP(실질·명목)', '프랑스 명목 잠재GDP(연)',   'OECD.ECO.MAD,DSD_EO@DF_EO', 'FRA.GDPTR..A',   'FRA',  'A', 'Y', 7, 10),
  ('gdpvtr_gbr',  '잠재GDP(실질·명목)', '영국 실질 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'GBR.GDPVTR..A',  'GBR',  'A', 'Y', 7, 11),
  ('gdptr_gbr',   '잠재GDP(실질·명목)', '영국 명목 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'GBR.GDPTR..A',   'GBR',  'A', 'Y', 7, 12),
  ('gdpvtr_oecd', '잠재GDP(실질·명목)', 'OECD 실질 잠재GDP(연)',     'OECD.ECO.MAD,DSD_EO@DF_EO', 'OECD.GDPVTR..A', 'OECD', 'A', 'Y', 7, 13)
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
