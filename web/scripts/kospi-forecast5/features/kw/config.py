"""[실사용 모듈] (service_5 복사본, 2026-11-19 원본: experiments/5/kw/config.py) 주별 예측 설정 — 예측 시점 W0(16:00)·W2(08:30), 대상일 규칙, 경로, 분할 기간.

예측 문제(사용자 결정 2026-11-10):
  - 행 = 기준일 b(코스피 거래일). 대상일 = b 다음 거래일부터 센 5번째 거래일(휴장일은 세지 않음, 사용자 결정 2026-11-12).
    예: b 월요일 -> 다음 주 월요일, 그 주 수요일 휴장 -> 다음 주 화요일. (2026-11-10~11 실험은 b + 7일 달력 기준이었다.)
  - 정답(두 시점 같음): y_return = 대상일 종가 / b 종가 - 1, y_direction = y_return > 0.
  - 시점 두 개:
      W0 = b 16:00 KST(코스피 마감 뒤) — 국내 b 값, 해외는 b 16:00 전 확정 값(일별 T0 정렬, 일별 T0 의 대상일 next(b) 행과 같음)
      W2 = next(b) 08:30 KST — W0 정보 + b 밤 미국·유럽 마감(일별 T2 정렬, 일별 T2 의 대상일 next(b) 행과 같음)
    예: b = 11/9(월) -> W0 11/9 16:00, W2 11/10 08:30, 둘 다 "11/9 종가 -> 5거래일 뒤 종가"를 맞춘다.
  - 시점은 환경변수 KOSPI5_TP(W0|W2)로 고른다(스크립트의 --tp 가 설정, 병렬 작업자에도 이어짐).
결측 처리는 일별과 같은 skip(kp.config.MISSING_POLICY).
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]                 # service_5 (kp·kw·db 가 모두 이 폴더 안에 있음)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


# 예측 시점. pred_time = "base_day"(b 당일) | "next_day"(b 다음 코스피 거래일). 국내 값은 두 시점 모두 b 자신(기준일 b 종가까지).
TPS = {"W0": {"name": "W0_1600", "pred_time": "base_day", "hour": 16, "minute": 0, "daily_twin": "T0_1600",
              "desc": "기준일 b 16:00(코스피 마감 뒤), 해외는 b 16:00 전 확정 값"},
       "W2": {"name": "W2_0830", "pred_time": "next_day", "hour": 8, "minute": 30, "daily_twin": "T2_0830",
              "desc": "b 다음 거래일 08:30, W0 정보 + b 밤 미국·유럽 마감"}}
try:                                                   # 운영: 시각은 service_5/time_points.json 한 곳에서(features/timepoints.py, 2026-11-23). 위 값은 기본값
    import timepoints as _TPR
    for _tp in TPS:
        TPS[_tp]["hour"], TPS[_tp]["minute"] = _TPR.schedule_time(_tp) if _tp == "W2" else _TPR.hour_minute(_tp)
except ImportError:
    pass
TP = os.environ.get("KOSPI5_TP", "W2")
os.environ.setdefault("KOSPI_STRICT_CALENDAR", "1")   # +5영업일: 원천 영업일 아닌 날 값은 잘못된 자료로 보고 skip(kp.missing, 사용자 결정 2026-11-19)
if TP not in TPS:
    raise ValueError(f"KOSPI5_TP={TP} (W0|W2)")
CP = TPS[TP]
HORIZON_TD = 5            # 대상일 = b 뒤 5번째 코스피 거래일(사용자 결정 2026-11-12)
RUN = "feature_select_td5_20261112"   # 거르기 파이프라인 산출물 폴더(outputs/test/<RUN>)

# 분할: 아래 PERIODS(2차, 일별 최종 protocol 과 같음)와 kw/folds.py 가 기준이다.

# ------------------------------------------------------------------ 2차(2026-11-10): 일별 최종과 같은 분할·자료 범위
# 분할 = experiments/daily/test/service_refit_20261109/protocol.py 와 같다(01 에서 대조). 연 단위 fold 1~7 + 홀드아웃.
PERIODS = {"validation": ("2018-10-01", "2025-09-30"), "holdout": ("2025-10-01", "2026-10-31")}
for _k in range(1, 8):
    PERIODS[f"fold{_k}"] = (f"{2017 + _k}-10-01", f"{2018 + _k}-09-30")
SELECTION_END = "2024-10-01"        # 변수 선택(단변량·중복)은 이 날짜 앞 예측일만. fold 7 outer(2024-10~2025-09)는 깨끗한 검증
DATA_END = "2026-11-09"             # 홀드아웃 마지막 예측일(2026-10-30)의 대상일 종가까지 필요
PRED_END = PERIODS["holdout"][1]


def cfg_w():
    from kp import config as C
    return {**C.CFG, "END_DATE": DATA_END}

