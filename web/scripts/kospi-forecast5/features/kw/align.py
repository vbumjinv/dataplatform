"""[실사용 모듈] (service_5 복사본, 원본: experiments/5/kw/align.py) 주별 시점 정렬 — 원천별 값 확정 시각(rule)과 반영 지연(lag_days)으로 '예측 시각 W1(08:30 KST) 전에 확정된 마지막 값'을 붙인다.

규칙(값 날짜 D 의 현지 확정 시각):
  krx_close 15:40 KST | kst_eod 18:00 KST | us_close 16:15 New York | eu_close 16:45 London
  tokyo_close 15:45 Tokyo | shanghai_close 15:15 Shanghai | hk_close 16:30 Hong Kong | taipei_close 13:45 Taipei
  fx_close 17:00 New York | utc_eod 다음 날 00:00 UTC(비트코인, yfinance 통화 일봉 — 런던 자정 근처에 끝나 08:30 KST 를 넘을 수 있어 보수적으로)
  weekly_fri  금요일 값을 lag_days 뒤 09:00 New York 에 발표(NFCI: 다음 수요일)
  monthly     기준 달 말일 + lag_days 일 09:00 KST(발표 시차 가정, lag_status 열)
merge_asof(backward, 같은 시각 제외)로 붙이고, 너무 오래된 값(일 10일·주 20일·월 100일 초과)은 결측으로 둔다.
일별 kp 원천(KOSPI·업종 대용·SOURCE_SPECS)은 일별 T2 와 같은 함수(kp.dataset.align_source·align_domestic)로 정렬한다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

RULES = {
    "krx_close": ("Asia/Seoul", 15, 40), "kst_eod": ("Asia/Seoul", 18, 0),
    "us_close": ("America/New_York", 16, 15), "eu_close": ("Europe/London", 16, 45),
    "tokyo_close": ("Asia/Tokyo", 15, 45), "shanghai_close": ("Asia/Shanghai", 15, 15),
    "hk_close": ("Asia/Hong_Kong", 16, 30), "taipei_close": ("Asia/Taipei", 13, 45),
    "fx_close": ("America/New_York", 17, 0), "utc_eod": ("UTC", 24, 0),
    "weekly_fri": ("America/New_York", 9, 0), "monthly": ("Asia/Seoul", 9, 0),
}
STALE_DAYS = {"weekly_fri": 20, "monthly": 100}


def available_at(dates, rule, lag_days=0):
    tz, h, m = RULES[rule]
    idx = pd.DatetimeIndex(dates).tz_localize(None).normalize()
    local = (idx + pd.Timedelta(hours=h, minutes=m) + pd.Timedelta(days=int(lag_days)))
    return pd.DatetimeIndex(local).tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward").tz_convert("UTC")


def asof_join(pred_dd, pred_at, feats, rule, lag_days=0, stale_days=None):
    """feats(index=값 날짜) 를 예측일별로 붙인다. 반환: (예측일 index 프레임, 사용한 값 날짜, age 시간)."""
    stale_days = stale_days or STALE_DAYS.get(rule, 10)
    feats = feats.sort_index()
    av = available_at(feats.index, rule, lag_days)
    ok = ~pd.isna(av)
    right = feats[ok].reset_index(drop=True)
    right["_av"] = av[ok].as_unit("ns")
    right["_src"] = feats.index[ok]
    right = right.sort_values("_av")
    left = pd.DataFrame({"_dd": pd.DatetimeIndex(pred_dd), "_pa": pd.DatetimeIndex(pred_at).as_unit("ns")}).sort_values("_pa")
    j = pd.merge_asof(left, right, left_on="_pa", right_on="_av", direction="backward", allow_exact_matches=False,
                      tolerance=pd.Timedelta(days=stale_days))
    j = j.set_index("_dd").reindex(pd.DatetimeIndex(pred_dd))
    age = (j["_pa"] - j["_av"]).dt.total_seconds() / 3600
    src = j["_src"]
    return j.drop(columns=["_pa", "_av", "_src"]), src, age


def check_no_future(age, name):
    bad = int((age.dropna() <= 0).sum())
    if bad:
        raise RuntimeError(f"[STOP] {name}: 예측 시각 뒤에 확정된 값 {bad}건")
