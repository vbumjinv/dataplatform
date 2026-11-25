"""[실사용 모듈] (service_5 복사본, 원본: experiments/daily/kp/data_checks.py) 학습 전 데이터 점검. 알려진 DB 문제가 아직 고쳐지지 않았으면 학습을 멈춘다.

check_integer_rounding : 원래 소수점이 있는 지표(지수·원자재·FRED 값)가 정수로만 저장돼 있으면 문제.
                         2026-10-14 기준 yfinance 테이블 종가가 NUMERIC(19,0)이라 STOXX600 등이 반올림돼 있음.
                         국내 종목·ETF는 원래 원 단위 정수라 점검하지 않는다.
check_kospi_gaps       : KOSPI(정답) 누락일이 있으면 알린다(정답 제외로 처리되므로 경고만).
assert_data_ready      : 위 점검 결과에 오류가 있으면 RuntimeError. 실험 스크립트는 --allow-data-issues 로만 건너뛸 수 있다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
import db
from . import config as C

# 원래 소수점이 있는 시계열(정수로만 저장되면 반올림 문제)
NON_INTEGER_KEYS = ("eu_stoxx600", "eu_dax", "macro_gold", "us_sp500", "us_sox", "us_vix", "macro_dxy", "macro_oil")
MAX_INTEGER_SHARE = 0.99      # 기간 내 값의 99% 이상이 정수이면 반올림 저장으로 본다


def check_integer_rounding(keys=NON_INTEGER_KEYS, start=None, end=None) -> pd.DataFrame:
    start, end = start or C.CFG["START_DATE"], end or C.CFG["END_DATE"]
    rows = []
    for key in keys:
        st = db.load_standardized(key)
        if st is None:
            rows.append({"key": key, "status": "error", "message": "db/raw 캐시 없음"}); continue
        d = pd.to_datetime(st["Date"].astype("string").str[:10], errors="coerce")
        v = pd.to_numeric(st["Close"].astype("string").str.strip(), errors="coerce")
        v = v[(d >= start) & (d <= end)].dropna()
        share = float((np.abs(v - np.round(v)) < 1e-9).mean()) if len(v) else np.nan
        bad = bool(share >= MAX_INTEGER_SHARE)
        rows.append({"key": key, "table": db.TABLES[key]["table"], "rows": len(v), "integer_share": round(share, 4),
                     "status": "error" if bad else "ok",
                     "message": f"값의 {share:.1%}가 정수 -> DB에 소수점이 잘려 저장됨(열 타입 확인)" if bad else ""})
    return pd.DataFrame(rows)


def check_kospi_gaps(frames: dict) -> pd.DataFrame:
    meta = frames.get("__meta__", {})
    lab = meta.get("labels", {}).get(C.KOSPI_KEY)
    miss = [] if lab is None else list(lab.index[lab.isin(["trading_missing", "row_missing"])])
    return pd.DataFrame([{"key": C.KOSPI_KEY, "status": "warning" if miss else "ok",
                          "message": (f"KOSPI 누락 {len(miss)}일: " + ", ".join(d.strftime("%Y-%m-%d") for d in miss)
                                      + " -> 누락 다음 날 정답은 학습·평가에서 제외") if miss else ""}])


def assert_data_ready(frames: dict | None = None, allow_issues: bool = False, log=print) -> pd.DataFrame:
    """오류가 있으면 멈춘다. allow_issues=True면 경고만 출력하고 계속한다."""
    parts = [check_integer_rounding()]
    if frames is not None:
        parts.append(check_kospi_gaps(frames))
    rep = pd.concat(parts, ignore_index=True)
    for _, r in rep[rep.status != "ok"].iterrows():
        log(f"[데이터 점검 {r.status}] {r.key}: {r.message}")
    errors = rep[rep.status == "error"]
    if len(errors) and not allow_issues:
        raise RuntimeError(
            f"데이터 점검 실패 {len(errors)}건({', '.join(errors.key)}). DB 수정 후 python db/extract_raw.py --daily-only 로 다시 받으세요. "
            "알고도 진행하려면 --allow-data-issues 를 붙이세요(결과는 비교용으로만 사용).")
    if not len(errors):
        log("[데이터 점검] 반올림 저장 문제 없음")
    return rep
