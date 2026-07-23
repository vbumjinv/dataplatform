-- World Bank 수집 대상(지표×국가) 큐레이션 목록.
-- API 생성 마법사에서 KRX/OECD/yfinance 처럼 목록에서 항목을 선택하게 한다.
-- World Bank API: https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?format=json&date=Y:Y
--   - country: 'USA'(미국), 'WLD'(세계) 등 (ISO3 또는 WB 코드)
--   - indicator: 'NY.GDP.MKTP.CD' = GDP (current US$), 연간
-- (신규 설치/재실행 모두 안전하도록 idempotent 작성)
CREATE TABLE IF NOT EXISTS dp.api_stat_list_worldbank
(
  id              varchar(80) PRIMARY KEY NOT NULL,  -- 예: 'usa_gdp', 'wld_gdp'
  item_name       varchar(500) NOT NULL,             -- 표시명. 예: '미국 GDP'
  country_code    varchar(20)  NOT NULL,             -- 예: 'USA', 'WLD'
  country_name    varchar(200) NOT NULL,             -- 예: '미국', '세계'
  indicator_code  varchar(60)  NOT NULL,             -- 예: 'NY.GDP.MKTP.CD'
  indicator_name  varchar(500) NOT NULL,             -- 예: 'GDP (current US$)'
  category_name   varchar(100) NOT NULL,             -- 분류. 예: 'GDP'
  cycle           char(1) DEFAULT 'A' NOT NULL,      -- 주기(연간 고정)
  srch_yn         char(1) DEFAULT 'Y' NOT NULL,
  category_sort   int,
  item_sort       int,
  created_at      timestamp DEFAULT now() NOT NULL
);

INSERT INTO dp.api_stat_list_worldbank
  (id, item_name, country_code, country_name, indicator_code, indicator_name, category_name, cycle, srch_yn, category_sort, item_sort)
VALUES
  ('usa_gdp', '미국 GDP', 'USA', '미국', 'NY.GDP.MKTP.CD', 'GDP (current US$)', 'GDP', 'A', 'Y', 1, 1),
  ('wld_gdp', '세계 GDP', 'WLD', '세계', 'NY.GDP.MKTP.CD', 'GDP (current US$)', 'GDP', 'A', 'Y', 1, 2)
ON CONFLICT (id) DO UPDATE
SET
  item_name = EXCLUDED.item_name,
  country_code = EXCLUDED.country_code,
  country_name = EXCLUDED.country_name,
  indicator_code = EXCLUDED.indicator_code,
  indicator_name = EXCLUDED.indicator_name,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
