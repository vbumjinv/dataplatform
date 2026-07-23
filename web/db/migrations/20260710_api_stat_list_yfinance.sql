-- yfinance 수집 대상(티커) 큐레이션 목록.
-- API 생성 마법사에서 KRX/OECD 처럼 목록에서 티커를 선택하게 한다.
-- (신규 설치/재실행 모두 안전하도록 idempotent 작성)
--
-- 한글(category_name 등)이 깨져 저장되지 않도록 클라이언트 인코딩을 UTF8로 고정한다.
-- (psql 등에서 client_encoding 이 다르면 '지수' 가 'ì§€ìˆ˜' 처럼 이중 인코딩됨)
SET client_encoding TO 'UTF8';

CREATE TABLE IF NOT EXISTS dp.api_stat_list_yfinance
(
  ticker varchar(50) PRIMARY KEY NOT NULL,   -- 예: '^GSPC', 'DX-Y.NYB'
  item_name varchar(500) NOT NULL,           -- 표시명. 예: 'S&P 500'
  category_name varchar(100) NOT NULL,       -- 분류. 예: '지수', '환율', '원자재'
  cycle char(1) DEFAULT 'D' NOT NULL,        -- 주기(일별 고정)
  srch_yn char(1) DEFAULT 'Y' NOT NULL,      -- 목록 노출 여부
  category_sort int,
  item_sort int,
  created_at timestamp DEFAULT now() NOT NULL
);

INSERT INTO dp.api_stat_list_yfinance
  (ticker, item_name, category_name, cycle, srch_yn, category_sort, item_sort)
VALUES
  -- 지수
  ('^GSPC',     'S&P 500',            '지수', 'D', 'Y', 1, 1),
  ('^IXIC',     'NASDAQ 종합',        '지수', 'D', 'Y', 1, 2),
  ('^DJI',      '다우존스 산업평균',  '지수', 'D', 'Y', 1, 3),
  ('^RUT',      'Russell 2000',       '지수', 'D', 'Y', 1, 4),
  ('^KS11',     'KOSPI',              '지수', 'D', 'Y', 1, 5),
  ('^KQ11',     'KOSDAQ',             '지수', 'D', 'Y', 1, 6),
  ('^N225',     'Nikkei 225',         '지수', 'D', 'Y', 1, 7),
  ('^HSI',      'Hang Seng',          '지수', 'D', 'Y', 1, 8),
  ('^VIX',      'VIX 변동성지수',     '지수', 'D', 'Y', 1, 9),
  ('^W5000',    'Wilshire 5000',      '지수', 'D', 'Y', 1, 10),
  -- 환율
  ('DX-Y.NYB',  '미국 달러 인덱스',   '환율', 'D', 'Y', 2, 1),
  ('KRW=X',     'USD/KRW',            '환율', 'D', 'Y', 2, 2),
  ('EURUSD=X',  'EUR/USD',            '환율', 'D', 'Y', 2, 3),
  ('JPY=X',     'USD/JPY',            '환율', 'D', 'Y', 2, 4),
  ('CNY=X',     'USD/CNY',            '환율', 'D', 'Y', 2, 5),
  -- 원자재
  ('GC=F',      '금 선물',            '원자재', 'D', 'Y', 3, 1),
  ('SI=F',      '은 선물',            '원자재', 'D', 'Y', 3, 2),
  ('CL=F',      'WTI 원유 선물',      '원자재', 'D', 'Y', 3, 3),
  ('BZ=F',      '브렌트유 선물',      '원자재', 'D', 'Y', 3, 4),
  ('NG=F',      '천연가스 선물',      '원자재', 'D', 'Y', 3, 5),
  -- 금리/채권
  ('^TNX',      '미국 10년 국채금리', '금리', 'D', 'Y', 4, 1),
  ('^TYX',      '미국 30년 국채금리', '금리', 'D', 'Y', 4, 2),
  -- 암호화폐
  ('BTC-USD',   '비트코인 (USD)',     '암호화폐', 'D', 'Y', 5, 1),
  ('ETH-USD',   '이더리움 (USD)',     '암호화폐', 'D', 'Y', 5, 2)
ON CONFLICT (ticker) DO UPDATE
SET
  item_name = EXCLUDED.item_name,
  category_name = EXCLUDED.category_name,
  cycle = EXCLUDED.cycle,
  srch_yn = EXCLUDED.srch_yn,
  category_sort = EXCLUDED.category_sort,
  item_sort = EXCLUDED.item_sort;
