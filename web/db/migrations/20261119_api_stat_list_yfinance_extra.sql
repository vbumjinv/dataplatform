-- yfinance API 등록 목록에 변동성 지수와 ETF, 반도체 종목을 추가한다.
SET client_encoding TO 'UTF8';

INSERT INTO dp.api_stat_list_yfinance
  (ticker, item_name, category_name, cycle, srch_yn, category_sort, item_sort)
VALUES
  ('^VVIX', 'VIX 변동성',              '지수',   'D', 'Y', 1,  12),
  ('^VXN',  '나스닥 변동성',           '지수',   'D', 'Y', 1,  13),
  ('AMAT',  '어플라이드머티리얼즈',    '반도체', 'D', 'Y', 11, 1),
  ('HYG',   '하이일드 회사채 ETF',     'ETF',    'D', 'Y', 12, 1),
  ('XLU',   '유틸리티 ETF',            'ETF',    'D', 'Y', 12, 2),
  ('KORU',  '미국 상장 한국 3배 ETF',  'ETF',    'D', 'Y', 12, 3)
ON CONFLICT (ticker) DO UPDATE
SET
  item_name = EXCLUDED.item_name,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
