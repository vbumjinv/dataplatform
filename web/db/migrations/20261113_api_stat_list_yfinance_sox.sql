-- yfinance API 등록 목록에 필라델피아 반도체 지수(^SOX)를 추가한다.
SET client_encoding TO 'UTF8';

INSERT INTO dp.api_stat_list_yfinance
  (ticker, item_name, category_name, cycle, srch_yn, category_sort, item_sort)
VALUES
  ('^SOX', '필라델피아 반도체 지수', '지수', 'D', 'Y', 1, 11)
ON CONFLICT (ticker) DO UPDATE
SET
  item_name = EXCLUDED.item_name,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
