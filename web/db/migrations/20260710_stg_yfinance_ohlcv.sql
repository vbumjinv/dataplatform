-- yfinance 적재 대상(랜딩) 테이블: 여러 티커의 일별 OHLCV 를 한 테이블에 누적한다.
-- load-runner 는 API 헤더(DATE/OPEN/HIGH/LOW/CLOSE/ADJ_CLOSE/VOLUME/TICKER)와
-- 테이블 컬럼명을 대소문자·구분자 무시(fuzzy)로 매칭해 삽입한다.
--   - 헤더에 없는 컬럼(loaded_at)은 삽입 대상에서 제외되어 default 가 적용된다.
--   - 증분 모드는 "행 전체가 동일"할 때만 건너뛰는 방식이라, unique 제약 대신
--     조회/조인용 인덱스만 둔다. (개정치가 와도 충돌 없이 새 행으로 들어옴)
CREATE TABLE IF NOT EXISTS dp.stg_yfinance_ohlcv
(
  ticker     text        NOT NULL,
  date       date        NOT NULL,
  open       numeric,
  high       numeric,
  low        numeric,
  close      numeric,
  adj_close  numeric,
  volume     numeric,
  loaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_stg_yfinance_ohlcv_ticker_date
  ON dp.stg_yfinance_ohlcv (ticker, date);

-- 앱(매핑/시각화)이 읽을 수 있도록 읽기 권한 부여.
GRANT SELECT ON TABLE dp.stg_yfinance_ohlcv TO dp_reader;

-- 적재(INSERT)는 데이터 수집이 사용하는 "DB 설정" 계정으로 수행된다.
-- 그 계정이 dp_reader 가 아니라면 아래처럼 쓰기 권한도 부여해야 한다(계정명은 실제 값으로 교체):
--   GRANT INSERT, SELECT ON TABLE dp.stg_yfinance_ohlcv TO <적재_쓰기_계정>;
