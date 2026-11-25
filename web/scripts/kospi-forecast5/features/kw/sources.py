"""[실사용 모듈] (service_5 복사본, 원본: experiments/5/kw/sources.py) 주별 변수 원천 등록부 — 등록 원천과 PostgreSQL 조회 함수.

등록부 필드:
  source_id   변수 이름 접두어(노트북·설계서 이름을 그대로 쓴다: US_SP500, EU_DAX, MACRO_OIL ...)
  group       ablation 묶음(KOSPI·KR_SECTOR·KRX_INDEX·US·EU·ASIA·KR_ADR·VOL·FX·RATE·SPREAD·COMMOD·FLOW·MACRO_M·CAL·EVENT·INTERACTION·PLACEBO)
  origin      db_daily | db_monthly | db_derived | external | computed
  fetch       daily_kp(일별 kp 모듈 그대로) | db_table(DB 등록부 테이블, 실행마다 읽음) | db_sql(읽기 전용 SQL) | yf | fdr | composite | computed
  ref         db key / SQL / 티커
  kind        price | price_level | rate | difference | sector | flow | tv | helper(다른 원천 계산용) | monthly | calendar·event·interaction·placebo
  rule        값 확정 시각 규칙(kw/align.py) | lag_days 확정 뒤 반영 지연(일) | lag_status 확인/가정
  tform       monthly 원천의 변환(diff | pct | level | mean_diff | mean_level) | agg 월 집계(last | mean)
  N/Dd/Dm/S/P 출처: 노트북 / 설계서 일별 / 설계서 월별 / 일별 서비스 변수 / 이번에 새로 제안
  status      use(이번 탐색에 넣음) | hold(받을 수 없거나 범위 밖 — 기록만)
외부(external) 원천은 탐색 전용이다. 통과하면 DB 적재 요청 목록에 오른다(사용자 결정 2026-11-10).
"""
from __future__ import annotations
import json
import numpy as np
import pandas as pd
from . import config as WC

# ------------------------------------------------------------------ 원천 목록
_COLS = ["source_id", "group", "origin", "fetch", "ref", "kind", "rule", "lag_days", "lag_status", "tform", "agg",
         "N", "Dd", "Dm", "S", "P", "status", "desc"]


def _s(sid, group, origin, fetch, ref, kind, rule="", lag=0, lag_status="", tform="", agg="last",
       N=0, Dd=0, Dm=0, S=0, P=0, status="use", desc=""):
    return dict(zip(_COLS, [sid, group, origin, fetch, ref, kind, rule, lag, lag_status, tform, agg,
                            N, Dd, Dm, S, P, status, desc]))


def _krx(nm, table="krx_kospi_dd_trd"):
    return f"select bas_dd as date, clsprc_idx as close from dp.{table} where idx_nm = '{nm}'"


def _bok(table, item1, item2=None):
    w = f"item_code1 = '{item1}'" + (f" and item_code2 = '{item2}'" if item2 else "")
    return f"select time as date, data_value as close from dp.{table} where {w}"


def _fred(table):
    return f"select date, value as close from dp.{table}"


SOURCES = [
    # ---- 코스피 (일별 kp 모듈: K6·TECH·TA, 주별 긴 기간 변수는 kw/features 가 더함)
    _s("KOSPI", "KOSPI", "db_daily", "daily_kp", "kospi", "price", "krx_close", 0, "확인", N=1, Dd=1, Dm=1, S=1,
       desc="KOSPI OHLCV (K_*, TECH_*, TA_*)"),
    _s("KOSPI_TV", "FLOW", "db_daily", "db_sql", "select bas_dd as date, acc_trdval as close from dp.krx_kospi_dd_trd where idx_nm = '코스피'",
       "tv", "krx_close", 0, "확인", P=1, desc="KOSPI 거래대금(원) — 거래대금 비율·회전율"),
    _s("KOSPI_MCAP", "FLOW", "db_daily", "db_sql", "select bas_dd as date, mktcap as close from dp.krx_kospi_dd_trd where idx_nm = '코스피'",
       "helper", "krx_close", 0, "확인", P=1, desc="KOSPI 시가총액(원) — 회전율 계산용(변수 없음)"),
    # ---- 미국
    _s("US_SP500", "US", "db_daily", "daily_kp", "us_sp500", "price", "us_close", 0, "가정", N=1, Dd=1, Dm=1, S=1),
    _s("US_SOX", "US", "db_daily", "daily_kp", "us_sox", "price", "us_close", 0, "가정", N=1, Dd=1, S=1),
    _s("US_NASDAQ", "US", "db_daily", "db_table", "us_nasdaq", "price", "us_close", 0, "가정", N=1),
    _s("US_W5000", "US", "db_daily", "db_table", "us_w5000", "price", "us_close", 0, "가정", P=1),
    _s("US_DOW", "US", "external", "yf", "^DJI", "price", "us_close", 0, "가정", N=1, desc="DB fred_djia 는 2016~ 라 탐색은 외부"),
    _s("US_RUSSELL2000", "US", "external", "yf", "^RUT", "price", "us_close", 0, "가정", N=1),
    _s("US_NVDA", "US", "external", "yf", "NVDA", "price", "us_close", 0, "가정", P=1, desc="반도체 사이클"),
    _s("US_TSM", "US", "external", "yf", "TSM", "price", "us_close", 0, "가정", P=1, desc="TSMC ADR"),
    _s("US_MU", "US", "external", "yf", "MU", "price", "us_close", 0, "가정", P=1, desc="마이크론"),
    # ---- 유럽
    _s("EU_STOXX600", "EU", "db_daily", "daily_kp", "eu_stoxx600", "price", "eu_close", 0, "가정", N=1, Dd=1, S=1),
    _s("EU_DAX", "EU", "db_daily", "daily_kp", "eu_dax", "price", "eu_close", 0, "가정", N=1, Dd=1, S=1),
    _s("EU_FTSE100", "EU", "external", "yf", "^FTSE", "price", "eu_close", 0, "가정", N=1),
    # ---- 아시아 (DB 없음, 사용자 요청)
    _s("ASIA_NIKKEI", "ASIA", "external", "yf", "^N225", "price", "tokyo_close", 0, "가정", P=1),
    _s("ASIA_SHANGHAI", "ASIA", "external", "yf", "000001.SS", "price", "shanghai_close", 0, "가정", P=1),
    _s("ASIA_HSI", "ASIA", "external", "yf", "^HSI", "price", "hk_close", 0, "가정", P=1),
    _s("ASIA_TAIEX", "ASIA", "external", "yf", "^TWII", "price", "taipei_close", 0, "가정", P=1),
    _s("ASIA_CSI300", "ASIA", "external", "yf", "000300.SS", "price", "shanghai_close", 0, "", P=1, status="hold",
       desc="yfinance 에서 받을 수 없음(2026-11-10 확인)"),
    _s("EM_EEM", "ASIA", "external", "yf", "EEM", "price", "us_close", 0, "가정", P=1, desc="신흥국 ETF"),
    _s("EM_FXI", "ASIA", "external", "yf", "FXI", "price", "us_close", 0, "가정", P=1, desc="중국 대형주 ETF"),
    _s("EM_KWEB", "ASIA", "external", "yf", "KWEB", "price", "us_close", 0, "가정", P=1, desc="중국 인터넷 ETF(2013-08~)"),
    # ---- 한국 해외 상장
    _s("KR_EWY", "KR_ADR", "external", "yf", "EWY", "price", "us_close", 0, "가정", P=1, desc="미국 상장 한국 ETF(코스피 야간 대용)"),
    # ---- 변동성
    _s("US_VIX", "VOL", "db_daily", "daily_kp", "us_vix", "price_level", "us_close", 0, "가정", N=1, Dm=1),
    _s("US_VIX3M", "VOL", "external", "yf", "^VIX3M", "price_level", "us_close", 0, "가정", P=1),
    _s("US_VIX9D", "VOL", "external", "yf", "^VIX9D", "price_level", "us_close", 0, "가정", P=1, desc="2011~"),
    _s("US_MOVE", "VOL", "external", "yf", "^MOVE", "price_level", "us_close", 0, "가정", P=1, desc="채권 변동성"),
    _s("US_SKEW", "VOL", "external", "yf", "^SKEW", "price_level", "us_close", 0, "가정", P=1),
    _s("KR_VKOSPI", "VOL", "external", "pykrx", "V-KOSPI200", "price_level", "krx_close", 0, "", P=1, status="hold",
       desc="pykrx 는 KRX 로그인(KRX_ID·KRX_PW) 필요 — 받을 수 없음"),
    # ---- 환율
    _s("KR_USDKRW", "FX", "db_daily", "daily_kp", "kr_usdkrw", "price", "kst_eod", 1, "가정", Dm=1, S=0, desc="ECOS 매매기준율"),
    _s("MACRO_USDKRW", "FX", "external", "yf", "KRW=X", "price", "utc_eod", 0, "가정", N=1, desc="노트북 원천(야간 반영)"),
    _s("MACRO_DXY", "FX", "db_daily", "daily_kp", "macro_dxy", "price", "us_close", 0, "가정", Dd=1, S=1, desc="FRED 광의 달러지수"),
    _s("MACRO_DXYNYB", "FX", "db_daily", "db_sql", "select date, close from dp.yfinance_dxy_nyb", "price", "us_close", 0, "가정", N=1,
       desc="노트북 DX-Y.NYB(DB 에 있음)"),
    _s("FX_USDJPY", "FX", "external", "yf", "JPY=X", "price", "utc_eod", 0, "가정", P=1),
    _s("FX_USDCNY", "FX", "external", "yf", "CNY=X", "price", "utc_eod", 0, "가정", P=1),
    # ---- 금리
    _s("KR_BASERATE", "RATE", "db_daily", "daily_kp", "kr_base_rate", "rate", "kst_eod", 1, "가정", Dm=1, S=0),
    _s("KR_BOND10Y", "RATE", "db_daily", "daily_kp", "kr_bond10y", "rate", "kst_eod", 1, "가정", Dm=1),
    _s("KR_GOV3Y", "RATE", "db_daily", "db_table", "kr_gov3y", "rate", "kst_eod", 1, "가정", Dm=1),
    _s("KR_CORPAA3Y", "RATE", "db_daily", "db_table", "kr_corp_aa3y", "rate", "kst_eod", 1, "가정", Dm=1),
    _s("MACRO_US5Y", "RATE", "external", "yf", "^FVX", "rate", "us_close", 0, "가정", N=1),
    _s("MACRO_US10Y", "RATE", "external", "yf", "^TNX", "rate", "us_close", 0, "가정", N=1),
    _s("MACRO_US30Y", "RATE", "external", "yf", "^TYX", "rate", "us_close", 0, "가정", N=1),
    _s("MACRO_US3M", "RATE", "external", "yf", "^IRX", "rate", "us_close", 0, "가정", P=1),
    _s("US_DGS10", "RATE", "db_daily", "db_sql", _fred("fred_dgs10"), "rate", "us_close", 1, "가정", P=1, desc="FRED 10년(DB)"),
    _s("US_DFF", "RATE", "db_daily", "db_sql", _fred("fred_dff"), "rate", "us_close", 1, "가정", P=1, desc="연방기금 실효금리(DB)"),
    _s("US_DGS2", "RATE", "external", "fdr", "FRED:DGS2", "rate", "us_close", 1, "가정", P=1),
    _s("US_REAL10Y", "RATE", "external", "fdr", "FRED:DFII10", "rate", "us_close", 1, "가정", P=1, desc="10년 실질금리"),
    _s("US_BEI10Y", "RATE", "external", "fdr", "FRED:T10YIE", "rate", "us_close", 1, "가정", P=1, desc="10년 기대인플레"),
    _s("US_NFCI", "RATE", "external", "fdr", "FRED:NFCI", "rate", "weekly_fri", 5, "가정", P=1, status="hold",
       desc="시카고 연준 금융여건(주간) — 과거 값이 매주 개정되어 최신 개정치에는 그때 몰랐던 정보가 섞임(2026-11-10 제외)"),
    _s("US_HYOAS", "SPREAD", "external", "fdr", "FRED:BAMLH0A0HYM2", "rate", "us_close", 1, "", P=1, status="hold",
       desc="FRED 무료 제공이 최근 3년뿐(2023-11~) — 기간 부족"),
    # ---- 스프레드(계산)
    _s("KR_GBS", "SPREAD", "db_derived", "composite", "KR_BOND10Y-KR_GOV3Y", "rate", "kst_eod", 1, "가정", Dm=1, status="hold",
       desc="국고10-3년 — 사용자 표·운영 DB 정의(KR_TERMSPR)와 달라 제외(2026-11-12)"),
    _s("KR_CBS", "SPREAD", "db_derived", "composite", "KR_CORPAA3Y-KR_BOND10Y", "rate", "kst_eod", 1, "가정", Dm=1, status="hold",
       desc="회사채AA-3년 - 국고10 — 사용자 표·운영 DB 정의(KR_CREDSPR)와 달라 제외(2026-11-12)"),
    _s("KR_TERMSPR", "SPREAD", "db_derived", "composite", "KR_BOND10Y-KR_BASERATE", "rate", "kst_eod", 1, "가정",
       desc="GBS = 국고10 - 기준금리(사용자 표·DB 계산값 187 과 같은 식). DB 계산값이 2026-10-08 에 끊겨 구성 원천으로 계산"),
    _s("KR_CREDSPR", "SPREAD", "db_derived", "composite", "KR_CORPAA3Y-KR_GOV3Y", "rate", "kst_eod", 1, "가정",
       desc="CBS = 회사채 AA- 3년 - 국고 3년(사용자 표·DB 계산값 189 와 같은 식). DB 계산값이 2026-10-14 에 끊겨 구성 원천으로 계산"),
    _s("US_T10Y2Y", "SPREAD", "db_daily", "db_sql", _fred("fred_t10y2y"), "rate", "us_close", 1, "가정", P=1, desc="미국 10-2년(DB, 2026-07 까지)"),
    _s("US_T10Y3M", "SPREAD", "db_derived", "composite", "MACRO_US10Y-MACRO_US3M", "rate", "us_close", 0, "가정", P=1),
    # ---- 원자재
    _s("MACRO_OIL", "COMMOD", "db_daily", "daily_kp", "macro_oil", "difference", "us_close", 0, "가정", Dd=1, Dm=1, S=1, desc="WTI 현물(DB)"),
    _s("MACRO_OILFUT", "COMMOD", "external", "yf", "CL=F", "difference", "us_close", 0, "가정", N=1, desc="노트북 CL=F(차분형)"),
    _s("MACRO_GOLD", "COMMOD", "db_daily", "daily_kp", "macro_gold", "price", "us_close", 0, "가정", N=1, Dd=1, Dm=1, S=1),
    _s("MACRO_COPPER", "COMMOD", "external", "yf", "HG=F", "price", "us_close", 0, "가정", P=1),
    _s("MACRO_NATGAS", "COMMOD", "external", "yf", "NG=F", "price", "us_close", 0, "가정", P=1),
    _s("MACRO_CUAU", "COMMOD", "db_derived", "composite", "MACRO_COPPER/MACRO_GOLD", "price", "us_close", 0, "가정", P=1, desc="구리/금 비율"),
    _s("RISK_BTC", "COMMOD", "external", "yf", "BTC-USD", "price", "utc_eod", 0, "가정", P=1, desc="2014-09~"),
    # ---- 국내 업종: 일별 서비스 대용(4) + 노트북 업종(8, 두 종목 동일가중) + 대형주
    *[_s(f"SECTOR_{k}", "KR_SECTOR", "db_daily", "daily_kp", k, "price", "krx_close", 0, "확인", N=1, Dd=1, S=1)
      for k in ("AUTO", "LIVING", "INTERNET", "FASHION")],
    _s("SECTOR_AUTOSTK", "KR_SECTOR", "external", "yf", "005380.KS,000270.KS", "price", "krx_close", 0, "확인", N=1, desc="노트북 AUTO(현대차·기아)"),
    _s("SECTOR_SEMICON", "KR_SECTOR", "external", "yf", "005930.KS,000660.KS", "price", "krx_close", 0, "확인", N=1),
    _s("SECTOR_FINANCIAL", "KR_SECTOR", "external", "yf", "105560.KS,055550.KS", "price", "krx_close", 0, "확인", N=1),
    _s("SECTOR_CHEMSTEEL", "KR_SECTOR", "external", "yf", "051910.KS,005490.KS", "price", "krx_close", 0, "확인", N=1),
    _s("SECTOR_PHARMA", "KR_SECTOR", "external", "yf", "207940.KS,068270.KS", "price", "krx_close", 0, "확인", N=1, desc="삼성바이오 2016-11 상장"),
    _s("STK_SAMSUNG", "KR_SECTOR", "external", "yf", "005930.KS", "price", "krx_close", 0, "확인", P=1),
    _s("STK_HYNIX", "KR_SECTOR", "external", "yf", "000660.KS", "price", "krx_close", 0, "확인", P=1),
    # ---- KRX 지수(DB 에 있음, 지금까지 안 씀)
    *[_s(f"KRX_{sid}", "KRX_INDEX", "db_daily", "db_sql", _krx(nm, tb), "sector", "krx_close", 0, "확인", P=1, desc=nm)
      for sid, nm, tb in [
          ("K200", "코스피 200", "krx_kospi_dd_trd"), ("K50", "코스피 50", "krx_kospi_dd_trd"),
          ("LARGE", "코스피 대형주", "krx_kospi_dd_trd"), ("MID", "코스피 중형주", "krx_kospi_dd_trd"),
          ("SMALL", "코스피 소형주", "krx_kospi_dd_trd"), ("EXK200", "코스피200제외 코스피지수", "krx_kospi_dd_trd"),
          ("K200_IT", "코스피 200 정보기술", "krx_kospi_dd_trd"), ("K200_FIN", "코스피 200 금융", "krx_kospi_dd_trd"),
          ("K200_HEAVY", "코스피 200 중공업", "krx_kospi_dd_trd"), ("K200_CONS", "코스피 200 경기소비재", "krx_kospi_dd_trd"),
          ("K200_STAPLE", "코스피 200 생활소비재", "krx_kospi_dd_trd"), ("K200_ENERGY", "코스피 200 에너지/화학", "krx_kospi_dd_trd"),
          ("K200_STEEL", "코스피 200 철강/소재", "krx_kospi_dd_trd"), ("K200_CONST", "코스피 200 건설", "krx_kospi_dd_trd"),
          ("K200_HEALTH", "코스피 200 헬스케어", "krx_kospi_dd_trd"), ("K200_INDUS", "코스피 200 산업재", "krx_kospi_dd_trd"),
          ("K200_COMM", "코스피 200 커뮤니케이션서비스", "krx_kospi_dd_trd"),
          ("ELEC", "전기전자", "krx_kospi_dd_trd"), ("TRANSEQ", "운송장비·부품", "krx_kospi_dd_trd"),
          ("CHEM", "화학", "krx_kospi_dd_trd"), ("METAL", "금속", "krx_kospi_dd_trd"), ("FIN", "금융", "krx_kospi_dd_trd"),
          ("SEC", "증권", "krx_kospi_dd_trd"), ("INSUR", "보험", "krx_kospi_dd_trd"), ("CONST", "건설", "krx_kospi_dd_trd"),
          ("PHARM", "제약", "krx_kospi_dd_trd"), ("RETAIL", "유통", "krx_kospi_dd_trd"), ("TELE", "통신", "krx_kospi_dd_trd"),
          ("UTIL", "전기·가스", "krx_kospi_dd_trd"), ("MACH", "기계·장비", "krx_kospi_dd_trd"),
          ("FOOD", "음식료·담배", "krx_kospi_dd_trd"), ("TRANSP", "운송·창고", "krx_kospi_dd_trd"),
          ("SERV", "일반서비스", "krx_kospi_dd_trd"), ("TEXT", "섬유·의류", "krx_kospi_dd_trd"),
          ("KOSDAQ", "코스닥", "krx_kosdaq_dd_trd"), ("KQ150", "코스닥 150", "krx_kosdaq_dd_trd"),
          ("KQ_LARGE", "코스닥 대형주", "krx_kosdaq_dd_trd"), ("KQ_SMALL", "코스닥 소형주", "krx_kosdaq_dd_trd"),
          ("KQ150_IT", "코스닥 150 정보기술", "krx_kosdaq_dd_trd"), ("KQ150_HEALTH", "코스닥 150 헬스케어", "krx_kosdaq_dd_trd")]],
    # ---- 수급(ECOS 802Y001, DB)
    _s("FLOW_FRGN_KOSPI", "FLOW", "db_daily", "db_sql", _bok("bok_802y001", "0030000"), "flow", "kst_eod", 1, "가정", P=1,
       desc="외국인 순매수(유가증권, 억원) — 설계서에서 '스크리닝 대상 아님'으로 빠졌던 항목"),
    _s("FLOW_FRGN_KOSDAQ", "FLOW", "db_daily", "db_sql", _bok("bok_802y001", "0113000"), "flow", "kst_eod", 1, "가정", P=1),
    _s("FLOW_TV_KOSPI", "FLOW", "db_daily", "db_sql", _bok("bok_802y001", "0088000"), "helper", "kst_eod", 1, "가정", P=1,
       desc="거래대금(유가증권, 억원) — 외국인 순매수 정규화용"),
    _s("FLOW_TV_KOSDAQ", "FLOW", "db_daily", "db_sql", _bok("bok_802y001", "0091000"), "helper", "kst_eod", 1, "가정", P=1),
    _s("FLOW_INST", "FLOW", "external", "pykrx", "기관·개인 순매수", "flow", "krx_close", 0, "", P=1, status="hold",
       desc="pykrx 는 KRX 로그인 필요 — 받을 수 없음"),
    _s("FLOW_SHORT", "FLOW", "external", "pykrx", "공매도", "flow", "krx_close", 0, "", P=1, status="hold", desc="KRX 로그인 필요"),
    _s("FLOW_CREDIT", "FLOW", "external", "", "신용융자 잔고·고객예탁금", "flow", "", 0, "", P=1, status="hold", desc="라이브러리로 받을 수 없음"),
    _s("VAL_PER_PBR", "FLOW", "external", "pykrx", "KOSPI PER·PBR·배당", "price_level", "krx_close", 0, "", P=1, status="hold",
       desc="KRX 로그인 필요"),
    _s("KR_NSI", "MACRO_M", "db_daily", "db_sql", _bok("bok_523y001", "A001"), "rate", "kst_eod", 1, "가정", P=1,
       desc="한국은행 뉴스심리지수(일별, 실험적 통계)"),
    # ---- 월별 거시(설계서 3.4 원천 18개 + 제안). lag_days = 기준 달 말일 뒤 발표까지 일수(가정).
    _s("BR", "MACRO_M", "db_daily", "db_table", "kr_base_rate", "monthly", "monthly", 1, "가정", "diff", "last", Dm=1, desc="기준금리 월말 차분", status="hold"),
    _s("MR", "MACRO_M", "db_daily", "db_table", "kr_bond10y", "monthly", "monthly", 1, "가정", "diff", "mean", Dm=1, desc="국고10 월평균 차분", status="hold"),
    _s("MB", "MACRO_M", "db_monthly", "db_table", "kr_base_money", "monthly", "monthly", 45, "가정", "pct", "last", Dm=1, desc="본원통화 증가율"),
    _s("BI", "MACRO_M", "db_monthly", "db_table", "kr_deposit_rate", "monthly", "monthly", 30, "가정", "diff", "last", Dm=1),
    _s("CPI", "MACRO_M", "db_monthly", "db_table", "kr_cpi", "monthly", "monthly", 5, "가정", "diff", "last", Dm=1, desc="지수 수준 차분(논문 기준)"),
    _s("IP", "MACRO_M", "db_monthly", "db_table", "kr_ip", "monthly", "monthly", 32, "가정", "diff", "last", Dm=1),
    _s("UR", "MACRO_M", "db_monthly", "db_table", "kr_unemp", "monthly", "monthly", 18, "가정", "diff", "last", Dm=1),
    _s("ER", "MACRO_M", "db_daily", "db_table", "kr_usdkrw", "monthly", "monthly", 1, "가정", "diff", "mean", Dm=1, desc="원/달러 월평균 차분", status="hold"),
    _s("GBS", "MACRO_M", "db_derived", "composite", "KR_BOND10Y-KR_GOV3Y", "monthly", "monthly", 1, "가정", "level", "mean", Dm=1, status="hold"),
    _s("CBS", "MACRO_M", "db_derived", "composite", "KR_CORPAA3Y-KR_BOND10Y", "monthly", "monthly", 1, "가정", "level", "mean", Dm=1, status="hold"),
    _s("VIX", "MACRO_M", "db_daily", "db_table", "us_vix", "monthly", "monthly", 1, "가정", "level", "last", Dm=1, status="hold"),
    _s("SP", "MACRO_M", "db_daily", "db_table", "us_sp500", "monthly", "monthly", 1, "가정", "pct", "last", Dm=1, status="hold"),
    _s("GR", "MACRO_M", "db_daily", "db_table", "macro_gold", "monthly", "monthly", 1, "가정", "pct", "last", Dm=1, status="hold"),
    _s("OIL", "MACRO_M", "db_daily", "db_table", "macro_oil", "monthly", "monthly", 1, "가정", "level", "last", Dm=1, status="hold"),
    _s("SS", "MACRO_M", "db_monthly", "db_table", "kr_esi", "monthly", "monthly", 1, "가정", "diff", "last", Dm=1, desc="ESI 순환변동치(조사 달 말 발표)"),
    _s("SF", "MACRO_M", "db_monthly", "db_table", "kr_bsi", "monthly", "monthly", 1, "가정", "diff", "last", Dm=1),
    _s("SC", "MACRO_M", "db_monthly", "db_table", "kr_ccsi", "monthly", "monthly", 1, "가정", "diff", "last", Dm=1),
    _s("KSP", "MACRO_M", "db_daily", "db_table", "kospi", "monthly", "monthly", 1, "확인", "pct", "last", Dm=1, desc="KSP_GROSS_RET_L1~L3 — 주별은 일별 코스피 변수로 대신(2026-11-12)", status="hold"),
    _s("SN", "MACRO_M", "", "", "뉴스심리 월 집계", "monthly", "", 0, "", Dm=1, status="hold", desc="설계서에서도 제외(BOK API 월 집계 없음) — 일별 KR_NSI 로 대신"),
    # 제안 월별
    _s("M_CLI", "MACRO_M", "db_monthly", "db_sql", _bok("bok_901y067", "I16E"), "monthly", "monthly", 32, "가정", "diff", "last", P=1, desc="선행지수 순환변동치"),
    _s("M_CCI", "MACRO_M", "db_monthly", "db_sql", _bok("bok_901y067", "I16D"), "monthly", "monthly", 32, "가정", "diff", "last", P=1, desc="동행지수 순환변동치"),
    _s("M_OECDKR", "MACRO_M", "db_monthly", "db_sql", "select time_period as date, obs_value as close from dp.oecd_cli_kor",
       "monthly", "monthly", 45, "가정", "diff", "last", P=1, status="hold", desc="OECD 한국 CLI — 개정치만 있어 시점 누수 위험(2026-11-10 제외)"),
    _s("M_OECDG20", "MACRO_M", "db_monthly", "db_sql", "select time_period as date, obs_value as close from dp.oecd_cli_g20",
       "monthly", "monthly", 45, "가정", "diff", "last", P=1, status="hold", desc="OECD G20 CLI — 개정치만 있어 시점 누수 위험(2026-11-10 제외)"),
    _s("M_EXPORT", "MACRO_M", "db_monthly", "db_sql", "select year as date, expdlr as close from dp.datagokr_newtrade",
       "monthly", "monthly", 2, "가정", "yoy", "last", P=1, desc="수출액(관세청, 다음 달 1일 발표) 전년 대비"),
    _s("M_CA", "MACRO_M", "db_monthly", "db_sql", _bok("bok_301y013", "000000"), "monthly", "monthly", 38, "가정", "level", "last", P=1, desc="경상수지"),
    _s("M_M2", "MACRO_M", "db_monthly", "db_sql", _bok("bok_161y005", "BBHS00"), "monthly", "monthly", 45, "가정", "pct", "last", P=1, desc="M2 평잔 계절조정"),
    _s("M_BSIF", "MACRO_M", "db_monthly", "db_sql", _bok("bok_512y014", "99988", "BA"), "monthly", "monthly", 1, "가정", "diff", "last", P=1, desc="업황전망 BSI"),
    _s("M_HOUSE", "MACRO_M", "db_monthly", "db_sql", _bok("bok_901y062", "P63A"), "monthly", "monthly", 3, "가정", "pct", "last", P=1, desc="KB 주택매매가격"),
    _s("M_USCPI", "MACRO_M", "db_monthly", "db_sql", _fred("fred_cpiaucsl"), "monthly", "monthly", 15, "가정", "yoy", "last", P=1),
    _s("M_USM2", "MACRO_M", "db_monthly", "db_sql", _fred("fred_m2sl"), "monthly", "monthly", 28, "가정", "yoy", "last", P=1),
    # ==== 2026-11-12 추가(영업일 +5일 탐색): DB 전수 점검(db_inventory.csv) 포함분 + 라이브러리 73개 + 뉴스 ====
    # ---- 한국은행 일별: 주요 통화 환율 13(페그·소수 통화 제외), 시장금리 21(이미 쓰는 3개 제외), 증시 거래량·시총
    *[_s(f"KR_FX_{c}", "FX", "db_daily", "db_sql", _bok("bok_731y001", code), "price", "kst_eod", 1, "가정", P=1, desc=f"원/{c}(ECOS 매매기준율)")
      for c, code in [("JPY", "0000002"), ("EUR", "0000003"), ("GBP", "0000012"), ("CAD", "0000013"), ("CHF", "0000014"), ("HKD", "0000015"),
                      ("AUD", "0000017"), ("SGD", "0000024"), ("NZD", "0000026"), ("TWD", "0000031"), ("INR", "0000037"), ("BRL", "0000041"),
                      ("CNY", "0000053")]],
    *[_s(f"KR_RATE_{c}", "RATE", "db_daily", "db_sql", _bok("bok_817y002", code), "rate", "kst_eod", 1, "가정", P=1, desc=nm)
      for c, code, nm in [("CALL", "010101000", "콜금리 1일"), ("CALLB", "010102000", "콜금리 1일 중개"), ("KORIBOR3M", "010150000", "KORIBOR 3개월"),
                          ("KORIBOR6M", "010151000", "KORIBOR 6개월"), ("KORIBOR12M", "010152000", "KORIBOR 12개월"), ("GOV1Y", "010190000", "국고채 1년"),
                          ("GOV5Y", "010200001", "국고채 5년"), ("GOV20Y", "010220000", "국고채 20년"), ("GOV30Y", "010230000", "국고채 30년"),
                          ("GOV50Y", "010240000", "국고채 50년"), ("KDB1Y", "010260000", "산금채 1년"), ("CORPAA3YM", "010310000", "회사채 AA- 민평"),
                          ("CORPBBB3Y", "010320000", "회사채 BBB- 3년"), ("MSB91D", "010400000", "통안증권 91일"), ("MSB1Y", "010400001", "통안증권 1년"),
                          ("MSB2Y", "010400002", "통안증권 2년"), ("MMF7D", "010501000", "MMF 7일"), ("CD91D", "010502000", "CD 91일"),
                          ("CP91D", "010503000", "CP 91일"), ("HOUSING5Y", "010503500", "국민주택채권 5년"), ("CMA", "010504000", "CMA")]],
    *[_s(f"MKT_{c}", "FLOW", "db_daily", "db_sql", _bok("bok_802y001", code), "price", "kst_eod", 1, "가정", P=1, desc=nm)
      for c, code, nm in [("VOL_KOSPI", "0087000", "거래량(유가증권)"), ("VOL_KOSDAQ", "0090000", "거래량(코스닥)"), ("MCAP_KOSPI", "0183000", "시가총액(유가증권)")]],
    _s("US_FEDTGT", "RATE", "db_daily", "db_sql", _fred("fred_dfedtaru"), "rate", "us_close", 1, "가정", P=1, desc="연준 목표금리 상단(FRED)"),
    # ---- KRX 지수(나머지 39개, 외국주포함·비중상한 사본 제외)
    *[_s(f"KRX_X{i:02d}", "KRX_INDEX", "db_daily", "db_sql", _krx(nm, tb), "sector", "krx_close", 0, "확인", P=1, desc=nm)
      for i, (tb, nm) in enumerate([("krx_kosdaq_dd_trd", n) for n in (
          "건설", "금속", "금융", "유통", "제약", "제조", "화학", "비금속", "기타제조", "전기전자", "일반서비스", "운송장비·부품", "코스닥 중형주",
          "코스닥 벤처기업부", "코스닥 우량기업부", "코스닥 중견기업부", "코스닥 기술성장기업부", "음식료·담배", "기계·장비", "섬유·의류", "오락·문화",
          "운송·창고", "종이·목재", "의료·정밀기기", "출판·매체복제", "코스닥 150 소재", "코스닥 150 산업재", "코스닥 150 자유소비재",
          "코스닥 150 필수소비재", "코스닥 150 커뮤니케이션서비스")] + [("krx_kospi_dd_trd", n) for n in (
          "제조", "비금속", "종이·목재", "의료·정밀기기", "코스피 100", "코스피 200 중소형주", "코스피 200 경기방어소비재지수",
          "코스피 200 초대형제외 지수", "코스피 200 TOP 10")])],
    # ---- 월별 대표 항목(세부 분류 제외, 사용자 결정 2026-11-12). 최근 발표 달 변화 L1 하나.
    *[_s(sid, "MACRO_M", "db_monthly", "db_sql", sql, "monthly", "monthly", lag, "가정", tf, "last", P=1, desc=d)
      for sid, sql, lag, tf, d in [
          ("M_DEP_SAV", _bok("bok_121y002", "BEABAA2"), 30, "diff", "저축성수신 금리"),
          ("M_DEP_TIME", _bok("bok_121y002", "BEABAA211"), 30, "diff", "정기예금 금리"),
          ("M_GOODS_BAL", _bok("bok_301y013", "100000"), 38, "level", "상품수지"),
          ("M_SERV_BAL", _bok("bok_301y013", "200000"), 38, "level", "서비스수지"),
          ("M_CA_SA", _bok("bok_301y017", "SA000"), 38, "level", "경상수지(계절조정)"),
          ("M_GOODS_SA", _bok("bok_301y017", "SA100"), 38, "level", "상품수지(계절조정)"),
          ("M_CSI_SENT", _bok("bok_511y002", "FME", "99988"), 1, "diff", "소비자심리지수"),
          ("M_CSI_ECON", _bok("bok_511y002", "FMBB", "99988"), 1, "diff", "향후경기전망 CSI"),
          ("M_CSI_PRICE", _bok("bok_511y002", "FMFA", "99988"), 1, "diff", "물가수준전망 CSI"),
          ("M_CSI_HOUSE", _bok("bok_511y002", "FMFB", "99988"), 1, "diff", "주택가격전망 CSI"),
          ("M_CSI_RATE", _bok("bok_511y002", "FMBG", "99988"), 1, "diff", "금리수준전망 CSI"),
          ("M_BSI_CSI", _bok("bok_512y013", "99988", "AX"), 1, "diff", "기업심리지수 실적"),
          ("M_BSI_SALES", _bok("bok_512y013", "99988", "AB"), 1, "diff", "매출실적 BSI"),
          ("M_BSI_FUND", _bok("bok_512y013", "99988", "AO"), 1, "diff", "자금사정실적 BSI"),
          ("M_EMPLOY", _bok("bok_901y027", "I61BA", "I28B"), 18, "pct", "취업자(계절조정)"),
          ("M_IP_MINING", _bok("bok_901y033", "AB00", "2"), 32, "pct", "광공업생산(계절조정)"),
          ("M_IP_SERV", _bok("bok_901y033", "AC00", "2"), 32, "pct", "서비스업생산(계절조정)"),
          ("M_IP_CONST", _bok("bok_901y033", "AD00", "2"), 32, "pct", "건설업생산(계절조정)"),
          ("M_HOUSE_APT", _bok("bok_901y062", "P63AC"), 3, "pct", "아파트 매매가격"),
          ("M_HOUSE_SEOUL", _bok("bok_901y062", "P63AD"), 3, "pct", "서울 주택 매매가격"),
          ("M_CLI_LV", _bok("bok_901y067", "I16A"), 32, "pct", "선행종합지수"),
          ("M_LAG_LV", _bok("bok_901y067", "I16C"), 32, "pct", "후행종합지수"),
          ("M_CLI_YOY", "select prd_de as date, dt as close from dp.kosis_dt_1c8015 where c1 = 'A05' and itm_id = 'T1'", 32, "diff", "선행지수 전년동월비"),
          ("M_CPI_CORE1", "select prd_de as date, dt as close from dp.kosis_dt_1j22007 where c1 = 'QB' and itm_id = 'T'", 5, "yoy", "근원물가(농산물·석유류 제외)"),
          ("M_CPI_CORE2", "select prd_de as date, dt as close from dp.kosis_dt_1j22009 where c1 = 'DB' and itm_id = 'T'", 5, "yoy", "근원물가(식료품·에너지 제외)")]],
    # ---- 라이브러리(탐색 전용, 통과하면 DB 적재 요청). 선물·통화는 뉴욕 17:00 확정으로 본다.
    *[_s(sid, g, "external", "yf", t, k, rule, 0, "가정", P=1, desc=d) for sid, g, t, k, rule, d in [
        ("FUT_SP500", "US", "ES=F", "price", "fx_close", "S&P500 선물"), ("FUT_NASDAQ", "US", "NQ=F", "price", "fx_close", "나스닥100 선물"),
        ("FUT_DOW", "US", "YM=F", "price", "fx_close", "다우 선물"),
        ("FUT_SILVER", "COMMOD", "SI=F", "price", "fx_close", "은"), ("FUT_PLATINUM", "COMMOD", "PL=F", "price", "fx_close", "백금"),
        ("FUT_BRENT", "COMMOD", "BZ=F", "price", "fx_close", "브렌트유"), ("FUT_HEATOIL", "COMMOD", "HO=F", "price", "fx_close", "난방유"),
        ("FUT_GASOLINE", "COMMOD", "RB=F", "price", "fx_close", "휘발유"), ("FUT_CORN", "COMMOD", "ZC=F", "price", "fx_close", "옥수수"),
        ("FUT_WHEAT", "COMMOD", "ZW=F", "price", "fx_close", "밀"), ("FUT_SOY", "COMMOD", "ZS=F", "price", "fx_close", "대두"),
        ("FUT_UST10", "RATE", "ZN=F", "price", "fx_close", "미 국채 10년 선물"), ("FUT_UST30", "RATE", "ZB=F", "price", "fx_close", "미 국채 30년 선물"),
        ("FUT_UST2", "RATE", "ZT=F", "price", "fx_close", "미 국채 2년 선물"), ("FUT_UST5", "RATE", "ZF=F", "price", "fx_close", "미 국채 5년 선물"),
        ("FX_EURUSD", "FX", "EURUSD=X", "price", "utc_eod", "유로/달러"), ("FX_GBPUSD", "FX", "GBPUSD=X", "price", "utc_eod", "파운드/달러"),
        ("FX_AUDUSD", "FX", "AUDUSD=X", "price", "utc_eod", "호주달러/달러"), ("FX_USDTWD", "FX", "TWD=X", "price", "utc_eod", "달러/대만달러"),
        ("FX_EURKRW", "FX", "EURKRW=X", "price", "utc_eod", "유로/원"),
        ("US_VVIX", "VOL", "^VVIX", "price_level", "us_close", "VIX 의 변동성"), ("US_OVX", "VOL", "^OVX", "price_level", "us_close", "유가 변동성"),
        ("US_GVZ", "VOL", "^GVZ", "price_level", "us_close", "금 변동성"), ("US_VXN", "VOL", "^VXN", "price_level", "us_close", "나스닥 변동성"),
        *[(f"USETF_{t}", "US", t, "price", "us_close", d) for t, d in [
            ("XLK", "기술"), ("XLF", "금융"), ("XLE", "에너지"), ("XLI", "산업재"), ("XLY", "경기소비재"), ("XLP", "필수소비재"),
            ("XLV", "헬스케어"), ("XLU", "유틸리티"), ("XLB", "소재"), ("SMH", "반도체"), ("SOXX", "반도체(iShares)"),
            ("QQQ", "나스닥100"), ("HYG", "하이일드 회사채"), ("LQD", "투자등급 회사채"), ("TLT", "미 국채 20년+"), ("IEF", "미 국채 7-10년"),
            ("SHY", "미 국채 1-3년"), ("TIP", "물가연동 국채"), ("EMB", "신흥국 달러채")]],
        ("EU_CAC40", "EU", "^FCHI", "price", "eu_close", "프랑스 CAC40"), ("EU_STOXX50", "EU", "^STOXX50E", "price", "eu_close", "유로스톡스50"),
        ("ASIA_ASX200", "ASIA", "^AXJO", "price", "tokyo_close", "호주 ASX200(시드니 마감 <= 도쿄 마감)"),
        ("ASIA_STI", "ASIA", "^STI", "price", "kst_eod", "싱가포르 STI(18:00 KST 마감)"),
        ("ASIA_SENSEX", "ASIA", "^BSESN", "price", "eu_close", "인도 SENSEX(19:00 KST 마감 -> 런던 마감으로 보수적)"),
        ("ASIA_JKSE", "ASIA", "^JKSE", "price", "kst_eod", "인도네시아 JCI(18:00 KST 마감)"),
        ("KR_KOSDAQ_YF", "KRX_INDEX", "^KQ11", "price", "krx_close", "코스닥(yfinance)"),
        ("KR_KORU", "KR_ADR", "KORU", "price", "us_close", "미국 상장 한국 3배 ETF(2013-04~)"),
        *[(f"US_{t}", "US", t, "price", "us_close", d) for t, d in [
            ("AAPL", "애플"), ("MSFT", "마이크로소프트"), ("AMZN", "아마존"), ("GOOGL", "알파벳"), ("TSLA", "테슬라"), ("AMD", "AMD"),
            ("INTC", "인텔"), ("ASML", "ASML"), ("QCOM", "퀄컴"), ("AVGO", "브로드컴"), ("AMAT", "어플라이드머티리얼즈"), ("LRCX", "램리서치")]],
        *[(f"STK_{c}", "KR_SECTOR", f"{code}.KS", "price", "krx_close", d) for c, code, d in [
            ("MOBIS", "012330", "현대모비스"), ("LGE", "066570", "LG전자"), ("SDI", "006400", "삼성SDI"), ("SAMSUNGCT", "028260", "삼성물산(2014-12~)"),
            ("KEPCO", "015760", "한국전력"), ("SKT", "017670", "SK텔레콤"), ("SK", "034730", "SK"), ("SKINNO", "096770", "SK이노베이션"),
            ("LG", "003550", "LG"), ("KIA", "000270", "기아")]]]],
    # ---- 뉴스(Jev 기사 피처, kw.news)
    _s("NEWS", "NEWS", "db_daily", "computed", "dp.news_feature_orig", "news", P=1,
       desc="Jev 기사 피처 — 예측 시각 직전 1·3·5·10 거래일 구간 집계(2010~, 새 LLM 호출 없음)"),
    # ---- 계산
    _s("CAL", "CAL", "computed", "computed", "", "calendar", desc="요일·대상까지 거래일 수·휴장 이동·월·월 안 주차·연말연초"),
    _s("EVT", "EVENT", "computed", "computed", "kw.events", "event", P=1,
       desc="대상 기간 안 옵션·선물 만기, FOMC, 고용지표, MSCI 리밸런싱, 삼성 잠정실적 시기, 월말·분기말"),
    _s("INT", "INTERACTION", "computed", "computed", "", "interaction", P=1, desc="국면 x 모멘텀 상호작용(과적합 주의)"),
    _s("PLACEBO", "PLACEBO", "computed", "computed", "", "placebo", N=1, desc="백색잡음·평활 랜덤워크(통제)"),
    # ---- 범위 밖(설계서 3.6 뉴스)
    _s("NEWS_EXT", "NEWS", "", "", "Naver·DART·GDELT·Finnhub", "", status="hold", desc="외부 뉴스 API — 범위 밖(Jev DB 피처만 씀)"),
]

# 최종 주별 모델(Part 3·4 기준) 변수 중 라이브러리로 받던 원천 -> DB 적재 테이블(2026-11-19 적재 확인, 값 대조 test/db_link_20261119).
# 최종 모델에서 쓰지 않는 다른 라이브러리 원천은 탐색 기록이라 그대로 둔다.
DB_LINKED = {"ASIA_HSI": "yfinance_hsi", "KR_KORU": "yfinance_koru", "USETF_HYG": "yfinance_hyg", "USETF_XLU": "yfinance_xlu",
             "US_AMAT": "yfinance_amat", "US_RUSSELL2000": "yfinance_rut", "US_VVIX": "yfinance_vvix", "US_VXN": "yfinance_vxn"}
for _r in SOURCES:
    if _r["source_id"] in DB_LINKED:
        _r.update(origin="db_daily", fetch="db_sql", ref=f"select date, close from dp.{DB_LINKED[_r['source_id']]}",
                  desc=(_r["desc"] + " " if _r["desc"] else "") + f"(DB dp.{DB_LINKED[_r['source_id']]}, 2026-11-19 전에는 yfinance {_r['ref']})")


def catalog() -> pd.DataFrame:
    df = pd.DataFrame(SOURCES, columns=_COLS)
    assert df.source_id.is_unique, df.source_id[df.source_id.duplicated()].tolist()
    df["db_status"] = np.where(df.origin.str.startswith("db"), "DB", np.where(df.origin == "external", "없음(요청 대상)", "계산"))
    return df


# ------------------------------------------------------------------ 읽기
def _num(s):
    return pd.to_numeric(pd.Series(s).astype("string").str.replace(",", "").str.strip(), errors="coerce").astype(float)


def _to_date(s):
    """YYYY-MM-DD / YYYYMMDD / YYYYMM / YYYY-MM / YYYY.MM -> Timestamp(월 자료는 월말)."""
    s = pd.Series(s).astype("string").str.strip()
    out = pd.Series(pd.NaT, index=s.index, dtype="datetime64[ns]")
    m8 = s.str.fullmatch(r"\d{8}")
    m6 = s.str.fullmatch(r"\d{6}") | s.str.fullmatch(r"\d{4}[-.]\d{2}")
    out[m8] = pd.to_datetime(s[m8], format="%Y%m%d")
    mm = s[m6].str.replace(r"[-.]", "", regex=True)
    out[m6] = pd.to_datetime(mm, format="%Y%m") + pd.offsets.MonthEnd(0)
    rest = ~(m8 | m6)
    out[rest] = pd.to_datetime(s[rest].str[:10], errors="coerce")
    return out


SQL_MEM: dict[str, pd.DataFrame] = {}                                    # 이번 실행에 읽은 SQL 원천(메모리만, 파일 없음 — 2026-11-24)


def read_db_sql(sql, sid, refresh=False, conn=None):
    """읽기 전용 트랜잭션으로 조회한다(이번 실행 안에서는 한 번만). conn 을 주면 그 트랜잭션(스냅샷)에서 읽는다."""
    if sid in SQL_MEM and not refresh:
        return SQL_MEM[sid]
    from sqlalchemy import text
    if conn is not None:
        d = pd.read_sql(text(sql), conn)
    else:
        from db.connection import get_engine
        with get_engine().connect() as c:
            c.execute(text("SET TRANSACTION READ ONLY"))
            d = pd.read_sql(text(sql), c)
    SQL_MEM[sid] = d
    return d


def series_from_frame(d, date_col="date", val_col="close"):
    s = pd.Series(_num(d[val_col]).to_numpy(), index=_to_date(d[date_col]).to_numpy()).dropna()
    s = s[~s.index.isna()]
    s.index = pd.DatetimeIndex(s.index).normalize()
    return s[~s.index.duplicated(keep="last")].sort_index()


def composite_close(px):
    """여러 종목 종가(열 = 티커) -> 동일가중 지수. 날마다 전날·오늘 둘 다 값이 있는 종목만으로 변화율을 내 이어 붙인다.
    종목 구성이 늘거나 빠지는 날(예: 207940 2016-11-11 상장)에 지수가 튀지 않는다. 구성이 그대로인 날은
    예전 방식(첫 값으로 나눈 수준의 평균)과 변화율이 같다(2026-11-13 PHARMA -47% 단절 수정)."""
    n = px.apply(lambda c: c / c.dropna().iloc[0] if c.notna().any() else c)
    both = n.notna() & n.shift().notna()
    r = n.where(both).sum(axis=1) / n.shift().where(both).sum(axis=1)
    has = n.notna().any(axis=1)
    r = r.where(both.any(axis=1), 1.0)[has]                         # 이어 붙일 종목이 없는 날(첫날)은 변화 0
    return (r.cumprod() * n[has].iloc[0].mean()).reindex(px.index)


# 원천 거래소 달력(값 확정 규칙 기준). fx·utc·kst_eod·5 원천은 휴장 개념이 달라 거르지 않는다.
_RULE_CAL = {"krx_close": "XKRX", "us_close": "XNYS", "tokyo_close": "XTKS", "shanghai_close": "XSHG",
             "hk_close": "XHKG", "taipei_close": "XTAI", "eu_close": "XLON"}
_CALS = {}
# 주별 +5영업일 규칙(사용자 결정 2026-11-19): 원천 거래소 영업일이 아닌 날 값은 잘못된 자료로 보고 건너뛴다(skip). False 면 이전처럼 복사 행만 뺌.
STRICT_BUSINESS_DAY = True


def drop_holiday_copies(s, rule):
    """원천 거래소 영업일이 아닌 날의 행을 뺀다. STRICT_BUSINESS_DAY 면 값이 새로워도 잘못된 자료로 보고 모두 빼고(skip),
    아니면 전날 값을 그대로 복사한 행만 뺀다(일별 kp.missing 의 holiday 와 같은 기준).
    kst_eod(국내 금리 등)는 평일 중 DB 공휴일이 아닌 날(은행 영업일)만 남긴다(STRICT 일 때).
    예: yfinance 국내 종목 2008 공휴일, FDR 의 FRED 금리 미국 공휴일 행(2026-11-13 점검), NASDAQ 2019-04-19(성금요일) 행."""
    if rule == "krx_close" or (STRICT_BUSINESS_DAY and rule == "kst_eod"):
        s = s[s.index.dayofweek < 5]
        s = s[~s.index.isin(kr_holidays())]
    code = _RULE_CAL.get(rule)
    if code is None or s.empty:
        return s
    if code not in _CALS:
        import exchange_calendars as xc
        _CALS[code] = xc.get_calendar(code, start="2000-01-01")
    cal = _CALS[code]
    lo, hi = max(s.index.min(), cal.first_session.tz_localize(None)), min(s.index.max(), cal.last_session.tz_localize(None))
    sess = pd.DatetimeIndex(cal.sessions_in_range(lo, hi)).tz_localize(None)
    inr = (s.index >= lo) & (s.index <= hi)
    off = inr & ~s.index.isin(sess)
    out = s[~off] if STRICT_BUSINESS_DAY else s[~(off & s.eq(s.shift(1)).to_numpy())]
    return out


def kr_holidays():
    """DB 공휴일(dp.datagokr_restdeinfo ∪ _lrd, isholiday='Y'). 실행 중 메모리에 한 번 읽어 둔다.
    거래소 달력(XKRX)에 없는 임시 휴장(2026-06-03 지방선거, 2026-07-17 제헌절)과 yfinance 국내 종목의 2008 공휴일 행을 거른다."""
    if "KR" not in _CALS:
        sql = ("select locdate as date, 1 as close from dp.datagokr_restdeinfo where isholiday = 'Y' "
               "union select locdate as date, 1 as close from dp.datagokr_restdeinfo_lrd where isholiday = 'Y'")
        _CALS["KR"] = series_from_frame(read_db_sql(sql, "KR_HOLIDAY_DB")).index
    return _CALS["KR"]


def load_series(row, refresh=False):
    """원천 하나 -> 날짜 index 의 값 Series(일별: 값 날짜, 월별: 월말). daily_kp·composite·computed 는 여기서 읽지 않는다."""
    sid = row["source_id"] if "source_id" in row.index else row.name
    if row.fetch == "db_table":
        import db
        d = db.load_standardized(row.ref)
        if d is None:
            raise RuntimeError(f"{row.ref}: DB 원천 테이블에 행이 없습니다")
        values = series_from_frame(d.rename(columns={"Date": "date", "Close": "close"}))
        return drop_holiday_copies(values, row.rule) if row.rule == "krx_close" or STRICT_BUSINESS_DAY else values
    if row.fetch == "db_sql":
        values = series_from_frame(read_db_sql(row.ref, sid, refresh))
        yf_table = "dp.yfinance_" in row.ref                # DB 의 yfinance 적재본도 휴장일 복사 행이 있을 수 있어 라이브러리 때와 같이 거른다
        return drop_holiday_copies(values, row.rule) if row.rule == "krx_close" or yf_table or STRICT_BUSINESS_DAY else values
    raise ValueError(f"{sid}: load_series 대상 아님({row.fetch})")
