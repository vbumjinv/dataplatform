"""[실사용 모듈] 전역 설정. 비밀번호 등 접속 정보는 코드에 쓰지 않고 .env 또는 환경변수에서 읽는다."""
import os
from pathlib import Path

# ---------------------------------------------------------------- 기간·폴드 (기존 실험과 동일)
CFG = {
    "START_DATE": "2010-01-01",
    "END_DATE": "2026-09-30",          # 기본 종료일. 실사용 예측에서는 --target 날짜로 덮어쓴다
    "FINAL_TEST_START": "2025-09-01",   # 이후 구간(~END_DATE)은 홀드아웃(튜닝·학습·조합 선택에 쓰지 않음)
    "OUTER_FOLDS": 6,
    "INNER_MONTHS": 12,
    "OUTER_MONTHS": 12,
    "GAP_TRADING_DAYS": 1,
    "MIN_TRAIN_ROWS": 1000,
    "MAX_STALE_DAYS": 10,
    "RANDOM_STATE": 42,
}

TZ_KST, TZ_EU, TZ_US = "Asia/Seoul", "Europe/London", "America/New_York"

# 예측 시점 T0·T1·T2 의 시각은 service/time_points.json 한 곳에만 둔다(features/timepoints.py 가 읽음).
# T0 15:30 -> 16:00 (사용자 결정 2026-11-03 실험·2026-11-04 운영, 15:30 은 종가 확정 직후라 촉박)
from features import timepoints as TPR  # noqa: E402
CHECKPOINTS = TPR.checkpoints()
KOSPI_KEY = "kospi"      # db/tables.py 의 key

# 소스 목록: key = db/tables.py 의 key.  kind = 변수 생성 방식(price/price_level/difference/rate).
# rule = 값이 확정되는 시각 규칙(us_close/eu_close/kst_eod), lag_days = 그 뒤 데이터가 DB에 들어오기까지 추가로 걸린다고 보는 일수.
# market = 거래일 판정에 쓰는 시장(US/EU/KR, kp/missing.py). 같은 시장 시계열끼리 거래일 근거를 공유한다.
# 주의: FRED에서 가져온 미국 지표(SP500, SOX, VIX, WTI, 달러지수)는 시장 마감 직후가 아니라 하루 이상 늦게 게시될 수 있다.
#       실제 운영에서 쓸 데이터 출처의 게시 시각을 확인해 lag_days 를 정해야 한다(기존 실험과 비교하려고 지금은 0).
SOURCE_SPECS = {
    "US_SP500":    {"key": "us_sp500",    "category": "US",    "kind": "price",       "rule": "us_close", "market": "US", "lag_days": 0},
    "US_SOX":      {"key": "us_sox",      "category": "US",    "kind": "price",       "rule": "us_close", "market": "US", "lag_days": 0},
    "US_VIX":      {"key": "us_vix",      "category": "US",    "kind": "price_level", "rule": "us_close", "market": "US", "lag_days": 0},
    "EU_STOXX600": {"key": "eu_stoxx600", "category": "EU",    "kind": "price",       "rule": "eu_close", "market": "EU", "lag_days": 0},
    "EU_DAX":      {"key": "eu_dax",      "category": "EU",    "kind": "price",       "rule": "eu_close", "market": "EU", "lag_days": 0},
    "MACRO_DXY":   {"key": "macro_dxy",   "category": "MACRO", "kind": "price",       "rule": "us_close", "market": "US", "lag_days": 0},
    "MACRO_OIL":   {"key": "macro_oil",   "category": "MACRO", "kind": "difference",  "rule": "us_close", "market": "US", "lag_days": 0},
    "MACRO_GOLD":  {"key": "macro_gold",  "category": "MACRO", "kind": "price",       "rule": "us_close", "market": "US", "lag_days": 0},
    # 국내 ECOS 일별 지표: 장 마감 후 확정, DB 반영은 다음 날로 가정(확인 필요)
    "KR_BASERATE": {"key": "kr_base_rate", "category": "KR",   "kind": "rate",        "rule": "kst_eod",  "market": "KR", "lag_days": 1},
    "KR_BOND10Y":  {"key": "kr_bond10y",  "category": "KR",    "kind": "rate",        "rule": "kst_eod",  "market": "KR", "lag_days": 1},
    "KR_USDKRW":   {"key": "kr_usdkrw",   "category": "KR",    "kind": "price",       "rule": "kst_eod",  "market": "KR", "lag_days": 1},
}
# 업종: 종목 종가를 첫 값으로 나눠 동일가중 평균(자동차는 지수 하나). 값은 db/tables.py 의 key 목록.
SECTOR_SPECS = {
    "AUTO": ["sec_auto"],
    "LIVING": ["sec_living_1", "sec_living_2"],
    "INTERNET": ["sec_internet_1", "sec_internet_2"],
    "FASHION": ["sec_fashion_1", "sec_fashion_2"],
}
KOSPI_MARKET = SECTOR_MARKET = "KR"
# 월별·계산값 거시 지표(db/tables.py 에 등록만 됨)는 발표 시차를 확인한 뒤 추가한다.


def key_market():
    """db key -> 시장(US/EU/KR)."""
    out = {KOSPI_KEY: KOSPI_MARKET}
    out.update({s["key"]: s["market"] for s in SOURCE_SPECS.values()})
    out.update({k: SECTOR_MARKET for ks in SECTOR_SPECS.values() for k in ks})
    return out

# ---------------------------------------------------------------- 전처리
MISSING_TOKENS = {"", ".", "-", "--", "na", "n/a", "nan", "null", "none", "#n/a"}   # 소문자로 비교
# 결측 정책(kp/missing.py): 휴장일 행은 항상 제거, KOSPI(정답) 결측은 항상 제외. 아래 정책은 '거래일인데 값이 없는 날'에만 적용.
#   skip | ffill1 | ffill3 | nanmean | nan
# 확정: skip (2026-10-14, test/missing_policy/compare_missing.py — 5개 정책의 검증 성능 차이가 모두 fold 간 표준편차 이내라
#        가장 단순한 skip 채택. 결과: docs/reports/structured/20261014_missing_policy/)
MISSING_POLICIES = ("skip", "ffill1", "ffill3", "nanmean", "nan")
MISSING_POLICY = os.environ.get("KOSPI_MISSING_POLICY", "skip")
FFILL_LIMIT = 3             # 이전 이름 호환용(policy="ffill"일 때 한도)
# nanmean: 창 길이 w의 이동평균·변동성에서 필요한 최소 유효값 비율(5일창 4개, 10일창 8개, 20일창 16개)
NANMEAN_MIN_FRAC = 0.8

# ---------------------------------------------------------------- 모델·평가
MAIN_METRIC = {"cls": "MCC", "reg": "MAESkillVsZero"}   # 튜닝·조합 선택의 주지표
TARGET = {"cls": "y_direction", "reg": "y_return"}
XGB_DEVICE = os.environ.get("KOSPI_XGB_DEVICE", "cpu")
DL_DEVICE = os.environ.get("KOSPI_DL_DEVICE", "cpu")     # cuda 가능하면 cuda   # GPU면 "cuda"
# 변수 구성: csv_A = 시점·목적별 선정 변수(변수 탐색 결과 그대로), csv_B = 목적별 T0∪T1∪T2 합집합(이전 단일·앙상블 실험과 동일),
#            all = 선정 전 전체 파생 변수(약 190개)
FEATURE_MODE = os.environ.get("KOSPI_FEATURE_MODE", "csv_B")
