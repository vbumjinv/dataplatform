-- yfinance API 리스트에 국내 업종 종목·ETF를 분류별로 추가한다.
-- F&F(383220)는 Yahoo 주식 티커가 383220.KS 이다.
SET client_encoding TO 'UTF8';

INSERT INTO dp.api_stat_list_yfinance
  (ticker, item_name, category_name, cycle, srch_yn, category_sort, item_sort)
VALUES
  ('091180.KS', 'KODEX 자동차', '자동차', 'D', 'Y', 7, 1),
  ('051900.KS', 'LG생활건강',   '화장품', 'D', 'Y', 8, 1),
  ('090430.KS', '아모레퍼시픽', '화장품', 'D', 'Y', 8, 2),
  ('035420.KS', 'NAVER',        '인터넷', 'D', 'Y', 9, 1),
  ('035720.KS', '카카오',       '인터넷', 'D', 'Y', 9, 2),
  ('383220.KS', 'F&F',          '패션',   'D', 'Y', 10, 1),
  ('020000.KS', '한섬',         '패션',   'D', 'Y', 10, 2)
ON CONFLICT (ticker) DO UPDATE
SET
  item_name = EXCLUDED.item_name,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
