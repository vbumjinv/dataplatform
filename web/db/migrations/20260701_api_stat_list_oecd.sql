-- OECD 큐레이션 수집대상 목록 (다른 기관의 api_stat_list_* 와 동일 역할)
-- OECD 는 데이터플로우(flow_ref) + 다차원 필터키(data_key) 조합으로 시계열이 특정되므로,
-- 자주 쓰는 지표를 (지표 × 지역) 조합으로 미리 큐레이션해 둔다. 지표는 이후 계속 추가 가능.
-- flow_ref/data_key 는 sdmx.oecd.org 라이브 API 로 실제 조회가 검증된 값이다.
CREATE TABLE IF NOT EXISTS dp.api_stat_list_oecd
(
  id varchar(80) PRIMARY KEY NOT NULL,
  category_name varchar(100) NOT NULL,
  indicator_name varchar(300) NOT NULL,
  flow_ref varchar(200) NOT NULL,
  data_key varchar(300) NOT NULL,
  ref_area varchar(40) NOT NULL,
  cycle varchar(10) DEFAULT 'M' NOT NULL,
  srch_yn char(1) DEFAULT 'Y' NOT NULL,
  category_sort int,
  item_sort int,
  created_at timestamp DEFAULT now() NOT NULL
);

INSERT INTO dp.api_stat_list_oecd
  (id, category_name, indicator_name, flow_ref, data_key, ref_area, cycle, srch_yn, category_sort, item_sort)
VALUES
  -- 경기선행지수 (CLI, 진폭조정) : OECD.SDD.STES,DSD_STES@DF_CLI / {AREA}.M.LI...AA...H
  ('cli_g20',  '경기선행지수(CLI)', 'G20 경기선행지수(CLI, 월)',      'OECD.SDD.STES,DSD_STES@DF_CLI', 'G20.M.LI...AA...H',  'G20',  'M', 'Y', 1, 1),
  ('cli_oecd', '경기선행지수(CLI)', 'OECD 경기선행지수(CLI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'OECD.M.LI...AA...H', 'OECD', 'M', 'Y', 1, 2),
  ('cli_usa',  '경기선행지수(CLI)', '미국 경기선행지수(CLI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'USA.M.LI...AA...H',  'USA',  'M', 'Y', 1, 3),
  ('cli_ea',   '경기선행지수(CLI)', '유로존 경기선행지수(CLI, 월)',   'OECD.SDD.STES,DSD_STES@DF_CLI', 'EA.M.LI...AA...H',   'EA',   'M', 'Y', 1, 4),
  ('cli_jpn',  '경기선행지수(CLI)', '일본 경기선행지수(CLI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'JPN.M.LI...AA...H',  'JPN',  'M', 'Y', 1, 5),
  ('cli_deu',  '경기선행지수(CLI)', '독일 경기선행지수(CLI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'DEU.M.LI...AA...H',  'DEU',  'M', 'Y', 1, 6),
  ('cli_gbr',  '경기선행지수(CLI)', '영국 경기선행지수(CLI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'GBR.M.LI...AA...H',  'GBR',  'M', 'Y', 1, 7),
  ('cli_fra',  '경기선행지수(CLI)', '프랑스 경기선행지수(CLI, 월)',   'OECD.SDD.STES,DSD_STES@DF_CLI', 'FRA.M.LI...AA...H',  'FRA',  'M', 'Y', 1, 8),
  ('cli_chn',  '경기선행지수(CLI)', '중국 경기선행지수(CLI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'CHN.M.LI...AA...H',  'CHN',  'M', 'Y', 1, 9),
  ('cli_kor',  '경기선행지수(CLI)', '대한민국 경기선행지수(CLI, 월)', 'OECD.SDD.STES,DSD_STES@DF_CLI', 'KOR.M.LI...AA...H',  'KOR',  'M', 'Y', 1, 10),

  -- 기업신뢰지수 (BCI) : OECD.SDD.STES,DSD_STES@DF_CLI / {AREA}.M.BCICP...AA...H
  ('bci_g20',  '기업신뢰지수(BCI)', 'G20 기업신뢰지수(BCI, 월)',      'OECD.SDD.STES,DSD_STES@DF_CLI', 'G20.M.BCICP...AA...H',  'G20',  'M', 'Y', 2, 1),
  ('bci_oecd', '기업신뢰지수(BCI)', 'OECD 기업신뢰지수(BCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'OECD.M.BCICP...AA...H', 'OECD', 'M', 'Y', 2, 2),
  ('bci_usa',  '기업신뢰지수(BCI)', '미국 기업신뢰지수(BCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'USA.M.BCICP...AA...H',  'USA',  'M', 'Y', 2, 3),
  ('bci_ea',   '기업신뢰지수(BCI)', '유로존 기업신뢰지수(BCI, 월)',   'OECD.SDD.STES,DSD_STES@DF_CLI', 'EA.M.BCICP...AA...H',   'EA',   'M', 'Y', 2, 4),
  ('bci_jpn',  '기업신뢰지수(BCI)', '일본 기업신뢰지수(BCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'JPN.M.BCICP...AA...H',  'JPN',  'M', 'Y', 2, 5),
  ('bci_deu',  '기업신뢰지수(BCI)', '독일 기업신뢰지수(BCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'DEU.M.BCICP...AA...H',  'DEU',  'M', 'Y', 2, 6),
  ('bci_kor',  '기업신뢰지수(BCI)', '대한민국 기업신뢰지수(BCI, 월)', 'OECD.SDD.STES,DSD_STES@DF_CLI', 'KOR.M.BCICP...AA...H',  'KOR',  'M', 'Y', 2, 7),

  -- 소비자신뢰지수 (CCI) : OECD.SDD.STES,DSD_STES@DF_CLI / {AREA}.M.CCICP...AA...H
  ('cci_g20',  '소비자신뢰지수(CCI)', 'G20 소비자신뢰지수(CCI, 월)',      'OECD.SDD.STES,DSD_STES@DF_CLI', 'G20.M.CCICP...AA...H',  'G20',  'M', 'Y', 3, 1),
  ('cci_oecd', '소비자신뢰지수(CCI)', 'OECD 소비자신뢰지수(CCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'OECD.M.CCICP...AA...H', 'OECD', 'M', 'Y', 3, 2),
  ('cci_usa',  '소비자신뢰지수(CCI)', '미국 소비자신뢰지수(CCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'USA.M.CCICP...AA...H',  'USA',  'M', 'Y', 3, 3),
  ('cci_ea',   '소비자신뢰지수(CCI)', '유로존 소비자신뢰지수(CCI, 월)',   'OECD.SDD.STES,DSD_STES@DF_CLI', 'EA.M.CCICP...AA...H',   'EA',   'M', 'Y', 3, 4),
  ('cci_jpn',  '소비자신뢰지수(CCI)', '일본 소비자신뢰지수(CCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'JPN.M.CCICP...AA...H',  'JPN',  'M', 'Y', 3, 5),
  ('cci_deu',  '소비자신뢰지수(CCI)', '독일 소비자신뢰지수(CCI, 월)',     'OECD.SDD.STES,DSD_STES@DF_CLI', 'DEU.M.CCICP...AA...H',  'DEU',  'M', 'Y', 3, 6),
  ('cci_kor',  '소비자신뢰지수(CCI)', '대한민국 소비자신뢰지수(CCI, 월)', 'OECD.SDD.STES,DSD_STES@DF_CLI', 'KOR.M.CCICP...AA...H',  'KOR',  'M', 'Y', 3, 7),

  -- 소비자물가 전년동월비 (CPI, YoY) : OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL / {AREA}.M.N.CPI.PA._T.N.GY
  ('cpi_oecd', '소비자물가(전년동월비)', 'OECD 소비자물가 전년비(월)',     'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'OECD.M.N.CPI.PA._T.N.GY', 'OECD', 'M', 'Y', 4, 1),
  ('cpi_usa',  '소비자물가(전년동월비)', '미국 소비자물가 전년비(월)',     'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'USA.M.N.CPI.PA._T.N.GY',  'USA',  'M', 'Y', 4, 2),
  ('cpi_ea',   '소비자물가(전년동월비)', '유로존 소비자물가 전년비(월)',   'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'EA.M.N.CPI.PA._T.N.GY',   'EA',   'M', 'Y', 4, 3),
  ('cpi_jpn',  '소비자물가(전년동월비)', '일본 소비자물가 전년비(월)',     'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'JPN.M.N.CPI.PA._T.N.GY',  'JPN',  'M', 'Y', 4, 4),
  ('cpi_deu',  '소비자물가(전년동월비)', '독일 소비자물가 전년비(월)',     'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'DEU.M.N.CPI.PA._T.N.GY',  'DEU',  'M', 'Y', 4, 5),
  ('cpi_gbr',  '소비자물가(전년동월비)', '영국 소비자물가 전년비(월)',     'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'GBR.M.N.CPI.PA._T.N.GY',  'GBR',  'M', 'Y', 4, 6),
  ('cpi_fra',  '소비자물가(전년동월비)', '프랑스 소비자물가 전년비(월)',   'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'FRA.M.N.CPI.PA._T.N.GY',  'FRA',  'M', 'Y', 4, 7),
  ('cpi_kor',  '소비자물가(전년동월비)', '대한민국 소비자물가 전년비(월)', 'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL', 'KOR.M.N.CPI.PA._T.N.GY',  'KOR',  'M', 'Y', 4, 8),

  -- 실업률 (조화 실업률, 15세 이상) : OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M / {AREA}..._Z.Y._T.Y_GE15..M
  ('une_oecd', '실업률', 'OECD 실업률(월)',     'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'OECD..._Z.Y._T.Y_GE15..M', 'OECD', 'M', 'Y', 5, 1),
  ('une_usa',  '실업률', '미국 실업률(월)',     'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'USA..._Z.Y._T.Y_GE15..M',  'USA',  'M', 'Y', 5, 2),
  ('une_ea',   '실업률', '유로존 실업률(월)',   'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'EA..._Z.Y._T.Y_GE15..M',   'EA',   'M', 'Y', 5, 3),
  ('une_jpn',  '실업률', '일본 실업률(월)',     'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'JPN..._Z.Y._T.Y_GE15..M',  'JPN',  'M', 'Y', 5, 4),
  ('une_deu',  '실업률', '독일 실업률(월)',     'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'DEU..._Z.Y._T.Y_GE15..M',  'DEU',  'M', 'Y', 5, 5),
  ('une_gbr',  '실업률', '영국 실업률(월)',     'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'GBR..._Z.Y._T.Y_GE15..M',  'GBR',  'M', 'Y', 5, 6),
  ('une_fra',  '실업률', '프랑스 실업률(월)',   'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'FRA..._Z.Y._T.Y_GE15..M',  'FRA',  'M', 'Y', 5, 7),
  ('une_kor',  '실업률', '대한민국 실업률(월)', 'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M', 'KOR..._Z.Y._T.Y_GE15..M',  'KOR',  'M', 'Y', 5, 8)
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
