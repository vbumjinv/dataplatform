CREATE TABLE IF NOT EXISTS dp.api_stat_list_krx
(
  p_api_id varchar(50),
  api_id varchar(100) PRIMARY KEY NOT NULL,
  api_name varchar(500) NOT NULL,
  api_path varchar(20) NOT NULL,
  category_name varchar(100) NOT NULL,
  cycle varchar(10) DEFAULT 'D' NOT NULL,
  srch_yn char(1) DEFAULT 'Y' NOT NULL,
  category_sort int,
  api_sort int,
  created_at timestamp DEFAULT now() NOT NULL
);

INSERT INTO dp.api_stat_list_krx
  (p_api_id, api_id, api_name, api_path, category_name, cycle, srch_yn, category_sort, api_sort)
VALUES
  ('IDX', 'krx_dd_trd', 'KRX 시리즈 일별시세정보', 'idx', '지수', 'D', 'Y', 1, 1),
  ('IDX', 'kospi_dd_trd', 'KOSPI 시리즈 일별시세정보', 'idx', '지수', 'D', 'Y', 1, 2),
  ('IDX', 'kosdaq_dd_trd', 'KOSDAQ 시리즈 일별시세정보', 'idx', '지수', 'D', 'Y', 1, 3),
  ('IDX', 'bon_dd_trd', '채권지수 시세정보', 'idx', '지수', 'D', 'Y', 1, 4),
  ('IDX', 'drvprod_dd_trd', '파생상품지수 시세정보', 'idx', '지수', 'D', 'Y', 1, 5),

  ('STK', 'stk_bydd_trd', '유가증권 일별매매정보', 'sto', '주식', 'D', 'Y', 2, 1),
  ('STK', 'ksq_bydd_trd', '코스닥 일별매매정보', 'sto', '주식', 'D', 'Y', 2, 2),
  ('STK', 'knx_bydd_trd', '코넥스 일별매매정보', 'sto', '주식', 'D', 'Y', 2, 3),
  ('STK', 'sw_bydd_trd', '신주인수권증권 일별매매정보', 'sto', '주식', 'D', 'Y', 2, 4),
  ('STK', 'sr_bydd_trd', '신주인수권증서 일별매매정보', 'sto', '주식', 'D', 'Y', 2, 5),
  ('STK', 'stk_isu_base_info', '유가증권 종목기본정보', 'sto', '주식', 'D', 'Y', 2, 6),
  ('STK', 'ksq_isu_base_info', '코스닥 종목기본정보', 'sto', '주식', 'D', 'Y', 2, 7),
  ('STK', 'knx_isu_base_info', '코넥스 종목기본정보', 'sto', '주식', 'D', 'Y', 2, 8),

  ('ETP', 'etf_bydd_trd', 'ETF 일별매매정보', 'etp', '증권상품', 'D', 'Y', 3, 1),
  ('ETP', 'etn_bydd_trd', 'ETN 일별매매정보', 'etp', '증권상품', 'D', 'Y', 3, 2),
  ('ETP', 'elw_bydd_trd', 'ELW 일별매매정보', 'etp', '증권상품', 'D', 'Y', 3, 3),

  ('BND', 'kts_bydd_trd', '국채전문유통시장 일별매매정보', 'bon', '채권', 'D', 'Y', 4, 1),
  ('BND', 'bnd_bydd_trd', '일반채권시장 일별매매정보', 'bon', '채권', 'D', 'Y', 4, 2),
  ('BND', 'smb_bydd_trd', '소액채권시장 일별매매정보', 'bon', '채권', 'D', 'Y', 4, 3),

  ('DRV', 'fut_bydd_trd', '선물 일별매매정보 (주식선물外)', 'drv', '파생상품', 'D', 'Y', 5, 1),
  ('DRV', 'eqsfu_stk_bydd_trd', '주식선물(유가) 일별매매정보', 'drv', '파생상품', 'D', 'Y', 5, 2),
  ('DRV', 'eqkfu_ksq_bydd_trd', '주식선물(코스닥) 일별매매정보', 'drv', '파생상품', 'D', 'Y', 5, 3),
  ('DRV', 'opt_bydd_trd', '옵션 일별매매정보 (주식옵션外)', 'drv', '파생상품', 'D', 'Y', 5, 4),
  ('DRV', 'eqsop_bydd_trd', '주식옵션(유가) 일별매매정보', 'drv', '파생상품', 'D', 'Y', 5, 5),
  ('DRV', 'eqkop_bydd_trd', '주식옵션(코스닥) 일별매매정보', 'drv', '파생상품', 'D', 'Y', 5, 6),

  ('CMD', 'oil_bydd_trd', '석유시장 일별매매정보', 'gen', '일반상품', 'D', 'Y', 6, 1),
  ('CMD', 'gold_bydd_trd', '금시장 일별매매정보', 'gen', '일반상품', 'D', 'Y', 6, 2),
  ('CMD', 'ets_bydd_trd', '배출권 시장 일별매매정보', 'gen', '일반상품', 'D', 'Y', 6, 3),

  ('ESG', 'sri_bond_info', '사회책임투자채권 정보', 'esg', 'ESG', 'D', 'Y', 7, 1),
  ('ESG', 'esg_index_info', 'ESG 지수', 'esg', 'ESG', 'D', 'Y', 7, 2),
  ('ESG', 'esg_etp_info', 'ESG 증권상품', 'esg', 'ESG', 'D', 'Y', 7, 3)
ON CONFLICT (api_id) DO UPDATE
SET
  p_api_id = EXCLUDED.p_api_id,
  api_name = EXCLUDED.api_name,
  api_path = EXCLUDED.api_path,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  api_sort = EXCLUDED.api_sort;
