-- OECD G20 경기선행지수(CLI, 월) 적재 대상 테이블
-- 수집설정 > OECD > "G20 경기선행지수(CLI, 월)" 등록 후, 매핑 단계에서 이 _LRD 테이블을 선택한다.
-- 컬럼명은 SDMX-JSON 파서가 내보내는 헤더(REF_AREA, TIME_PERIOD, OBS_VALUE 등)와 매칭된다
-- (적재 시 대소문자/특수문자 무시하고 이름으로 매칭됨).
create table if not exists dp.oecd_cli_g20_lrd (
  ref_area        varchar(20),   -- 지역 코드 (G20)
  freq            varchar(10),   -- 주기 (M)
  measure         varchar(20),   -- 지표 (LI = CLI)
  unit_measure    varchar(20),   -- 단위 (IX = 지수)
  activity        varchar(20),
  adjustment      varchar(20),   -- 조정 (AA = 진폭조정)
  transformation  varchar(20),
  time_horiz      varchar(20),
  methodology     varchar(20),   -- 산출방법 (H = OECD 조화)
  time_period     varchar(10),   -- 기간 (예: 2015-01)
  obs_value       numeric,       -- 관측값 (CLI 지수)
  obs_status      varchar(10),   -- 관측 상태 (A = 정상)
  unit_mult       integer,       -- 단위 배수
  decimals        integer,       -- 소수 자릿수
  base_per        varchar(40),   -- 기준시점
  loaded_at       timestamptz not null default now()
);

GRANT SELECT ON TABLE dp.oecd_cli_g20_lrd TO dp_reader;
