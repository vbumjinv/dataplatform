"""[실사용 모듈] (service_5 복사본, 원본: service_daily/db/tables.py) 테이블 매핑표(KOSPI 정형 데이터)를 코드로 옮긴 등록부.

key   : 프로젝트 코드에서 쓰는 이름
table : dp.<table>  (스키마는 settings.DB_SCHEMA)
where : 같은 테이블에 여러 지표가 들어 있을 때의 필터 {열: 값 또는 [값...]}
freq  : D=일, M=월, derived=계산값
열 이름을 모를 때는 cols 를 비워 두면 standardize.py 가 후보 이름으로 자동 인식한다.
자동 인식이 틀리면 cols={"Date": "열이름", "Close": "열이름", ...} 로 직접 지정한다.
뉴스 등 새 데이터는 같은 방식으로 이 등록부(또는 tables_news.py)에 추가한다.
"""

T = {
    # ---- 가격
    # 이 테이블에는 업종 지수 등 여러 지수가 함께 들어 있어 idx_nm 으로 KOSPI 본지수만 고른다
    "kospi":        {"table": "krx_kospi_dd_trd", "where": {"idx_nm": "코스피"}, "freq": "D", "desc": "KOSPI OHLCV (KRX 1001)",
                     "cols": {"Date": "bas_dd", "Open": "opnprc_idx", "High": "hgprc_idx", "Low": "lwprc_idx",
                              "Close": "clsprc_idx", "Volume": "acc_trdvol"}},
    # 당일 KOSPI(KRX 1001, 장중 적재). 모델 학습에는 쓰지 않고 학습된 모델로 예측할 때의 입력으로만 쓴다(사용자 지시 2026-10-26).
    # 매핑표_F 의 'dp.krx_kospi_dd(당일)' 은 DB 에 없고, 실제 당일 테이블은 krx_kospi_1001 이다(DB 관리자 확인 2026-10-26).
    "kospi_today":  {"table": "krx_kospi_1001", "freq": "D", "desc": "KOSPI 당일 OHLCV (KRX 1001) — 예측 입력 전용, 학습 제외",
                     "cols": {"Date": "date", "Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}},
    # ---- 해외
    "us_sp500":     {"table": "yfinance_sp500", "freq": "D", "desc": "S&P 500 (^GSPC) — 2026-11-13 FRED SP500 에서 교체(DB 테이블 변경)"},
    "us_sox":       {"table": "yfinance_sox", "freq": "D", "desc": "필라델피아 반도체지수 (^SOX) — 2026-11-13 FRED NASDAQSOX 에서 교체"},
    "us_nasdaq":    {"table": "fred_nasdaqcom", "freq": "D", "desc": "나스닥 종합지수 (FRED NASDAQCOM) — 월별 트랙 해외 증시 확장용"},
    "us_djia":      {"table": "fred_djia", "freq": "D", "desc": "다우존스 산업평균 (FRED DJIA) — 월별 트랙 해외 증시 확장용"},
    "us_w5000":     {"table": "yfinance_w5000", "freq": "D", "desc": "윌셔5000 (^W5000) — 월별 트랙 해외 증시 확장용"},
    "eu_stoxx600":  {"table": "yfinance_stoxx", "freq": "D", "desc": "STOXX Europe 600 (^STOXX)"},
    "eu_dax":       {"table": "yfinance_gdaxi", "freq": "D", "desc": "DAX (^GDAXI)"},
    "macro_dxy":    {"table": "fred_dtwexbgs", "freq": "D", "desc": "달러 지수 (FRED DTWEXBGS, 광의 달러지수)"},
    # ---- 원자재
    "us_vix":       {"table": "yfinance_vix", "freq": "D", "desc": "VIX (^VIX) — 2026-11-13 FRED VIXCLS 에서 교체"},
    "macro_oil":    {"table": "fred_dcoilwtico", "freq": "D", "desc": "WTI 유가 (FRED DCOILWTICO)"},
    "macro_gold":   {"table": "yfinance_gcf", "freq": "D", "desc": "금 선물 (GC=F)"},
    # ---- 업종
    "sec_auto":     {"table": "yfinance_091180ks", "freq": "D", "desc": "자동차 (091180.KS)"},
    "sec_living_1": {"table": "yfinance_051900ks", "freq": "D", "desc": "생활: LG생활건강 (051900.KS)"},
    "sec_living_2": {"table": "yfinance_090430ks", "freq": "D", "desc": "생활: 아모레퍼시픽 (090430.KS)"},
    "sec_internet_1": {"table": "yfinance_035420ks", "freq": "D", "desc": "인터넷: NAVER (035420.KS)"},
    "sec_internet_2": {"table": "yfinance_035720ks", "freq": "D", "desc": "인터넷: 카카오 (035720.KS)"},
    "sec_fashion_1": {"table": "yfinance_383220ks", "freq": "D", "desc": "패션: F&F (383220.KQ, 테이블명은 ks)"},
    "sec_fashion_2": {"table": "yfinance_020000ks", "freq": "D", "desc": "패션: 한섬 (020000.KS)"},
    # ---- 거시 (일)
    "kr_base_rate": {"table": "bok_722y001", "where": {"item_code1": "0101000"}, "freq": "D", "desc": "기준금리 (ECOS 722Y001)"},
    "kr_bond10y":   {"table": "bok_817y002", "where": {"item_code1": "010210000"}, "freq": "D", "desc": "국고채 10년 (ECOS 817Y002)"},
    "kr_usdkrw":    {"table": "bok_731y001", "where": {"item_code1": "0000001"}, "freq": "D", "desc": "원/달러 환율 (ECOS 731Y001)"},
    # ---- 신용스프레드 재계산용 원천 (일별, 월별 트랙): CBS = 회사채(3년, AA-) - 국고채(3년). 설계서의 721Y001 은 DB 에서 817Y002 로 들어와 있다.
    "kr_corp_aa3y": {"table": "bok_817y002", "where": {"item_code1": "010300000"}, "freq": "D", "desc": "회사채(3년, AA-) (ECOS 817Y002)"},
    "kr_gov3y":     {"table": "bok_817y002", "where": {"item_code1": "010200000"}, "freq": "D", "desc": "국고채(3년) (ECOS 817Y002)"},
    # ---- 거시 (월·계산값): 월별 예측 트랙(monthly/)이 사용한다. 일별 모델에는 쓰지 않는다.
    # 월별 표의 time 은 YYYYMM 이며 standardize 가 월말 날짜로 바꾼다. 한 표에 여러 항목이 섞인 것은 where 로 하나만 고른다.
    # 항목 선택 근거는 monthly/README.md 의 '매핑 가정' 표. (확인 필요 표시는 DB 관리자·사용자 확인 대기)
    "kr_base_money": {"table": "bok_102y004", "where": {"item_code1": "ABA1"}, "freq": "M", "desc": "본원통화(평잔, 계절조정계열)"},
    "kr_deposit_rate": {"table": "bok_121y002", "where": {"item_code1": "BEABAA222"}, "freq": "M", "desc": "예금은행 수신금리(신규취급) 환매조건부채권매도 — 논문 Table 3 통계와 일치(정기예금 BEABAA211 은 불일치), 항목 의미는 확인 필요"},
    "kr_cpi":       {"table": "kosis_dt_1j22003", "where": {"c1_nm": "전국", "itm_id": "T"}, "freq": "M", "desc": "소비자물가지수 총지수(KOSIS, 2020=100)",
                     "cols": {"Date": "prd_de", "Close": "dt"}},
    "kr_ip":        {"table": "bok_901y033", "where": {"item_code1": "A00", "item_code2": "2"}, "freq": "M", "desc": "전산업생산지수(농림어업 제외, 계절조정)"},
    "kr_unemp":     {"table": "bok_901y027", "where": {"item_code1": "I61BC", "item_code2": "I28B"}, "freq": "M", "desc": "실업률(계절조정) — 논문 Table 3 통계와 일치(원계열 I28A 는 불일치)"},
    "kr_esi":       {"table": "bok_513y001", "where": {"item_code1": "E2000"}, "freq": "M", "desc": "경제심리지수(순환변동치) — 논문 Table 3 통계와 일치(원계열 E1000 은 불일치)"},
    "kr_bsi":       {"table": "bok_512y013", "where": {"item_code1": "99988", "item_code2": "AA"}, "freq": "M", "desc": "기업경기실사지수 전산업 업황실적BSI — 항목(AA vs AX) 확인 필요"},
    "kr_ccsi":      {"table": "bok_511y002", "where": {"item_code1": "FMAB", "item_code2": "99988"}, "freq": "M", "desc": "현재경기판단CSI(전체) — 논문 Table 3 통계와 일치(소비자심리지수 FME 는 불일치), 항목 의미는 확인 필요"},
    "kr_term_spread": {"table": "viz_map_data", "where": {"map_id": 187}, "freq": "derived", "desc": "국채 장단기 스프레드(국고채10년 - 기준금리, 일별 계산값)",
                       "cols": {"Date": "obs_date", "Close": "obs_value"}},
    "kr_credit_spread": {"table": "viz_map_data", "where": {"map_id": 189}, "freq": "derived", "desc": "회사채 신용스프레드(AA- 3년 - 국고채 3년, 일별 계산값)",
                         "cols": {"Date": "obs_date", "Close": "obs_value"}},
}
