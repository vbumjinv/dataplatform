ALTER TABLE dp.api_stat_list_krx
  ADD COLUMN IF NOT EXISTS api_path varchar(20);

UPDATE dp.api_stat_list_krx
SET api_path = CASE category_name
  WHEN '지수' THEN 'idx'
  WHEN '주식' THEN 'sto'
  WHEN '증권상품' THEN 'etp'
  WHEN '채권' THEN 'bon'
  WHEN '파생상품' THEN 'drv'
  WHEN '일반상품' THEN 'gen'
  WHEN 'ESG' THEN 'esg'
  ELSE 'gen'
END
WHERE coalesce(api_path, '') = '';

ALTER TABLE dp.api_stat_list_krx
  ALTER COLUMN api_path SET DEFAULT 'gen';

UPDATE dp.api_stat_list_krx
SET api_path = 'gen'
WHERE api_path IS NULL;

ALTER TABLE dp.api_stat_list_krx
  ALTER COLUMN api_path SET NOT NULL;
