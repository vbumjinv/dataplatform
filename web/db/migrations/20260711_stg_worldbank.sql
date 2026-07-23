-- World Bank 적재(랜딩) 테이블: 여러 국가·지표의 연간 값을 누적한다.
-- load-runner 의 worldbank 분기가 응답을 평탄화해 아래 컬럼으로 삽입한다.
--   API 헤더: DATE / VALUE / COUNTRY / COUNTRY_ISO3 / INDICATOR / INDICATOR_NAME
--   - date 는 연도 문자열("2022")이라 varchar 로 저장하고, 매핑에서 date_format='YYYY' 로 변환한다.
--     (KRX '20240101', KOSIS '202401' 처럼 원시 API 값을 텍스트로 저장하는 방식과 동일)
--   - 미국/세계를 나누려면 매핑 where_clause 에 country_iso3='USA' 또는 'WLD' 를 준다.
CREATE TABLE IF NOT EXISTS dp.stg_worldbank
(
  country         text,
  country_iso3    text,
  indicator       text,          -- 예: 'NY.GDP.MKTP.CD'
  indicator_name  text,          -- 예: 'GDP (current US$)'
  date            varchar(8),    -- 연도 문자열. 예: '2022'
  value           numeric,
  loaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_stg_worldbank_key
  ON dp.stg_worldbank (indicator, country_iso3, date);

GRANT SELECT ON TABLE dp.stg_worldbank TO dp_reader;

-- 적재(INSERT)는 데이터 수집이 사용하는 "DB 설정" 계정으로 수행된다.
-- 그 계정이 dp_reader 가 아니라면 쓰기 권한도 부여해야 한다(계정명은 실제 값으로 교체):
--   GRANT INSERT, SELECT ON TABLE dp.stg_worldbank TO <적재_쓰기_계정>;
