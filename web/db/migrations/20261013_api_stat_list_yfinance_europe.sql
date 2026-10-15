-- yfinance API 리스트에 유럽 지수를 별도 분류로 추가한다.
SET client_encoding TO 'UTF8';

INSERT INTO dp.api_stat_list_yfinance
  (ticker, item_name, category_name, cycle, srch_yn, category_sort, item_sort)
VALUES
  ('^STOXX', 'STOXX Europe 600', '유럽 지수', 'D', 'Y', 6, 1),
  ('^GDAXI', 'DAX',               '유럽 지수', 'D', 'Y', 6, 2)
ON CONFLICT (ticker) DO UPDATE
SET
  item_name = EXCLUDED.item_name,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
