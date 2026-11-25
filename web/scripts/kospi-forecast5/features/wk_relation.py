"""[실사용 모듈] 시장 관계 변수 3개 — v3 학습본(W0 수익률 Huber)이 쓰는 exp_chip_spread·exp_sector_dispersion·exp_fx_vol 을 DB 로 만든다.

원본 계산: experiments/5/test/v2_challengers_20261124/run.py relation_features (2026-11-24, 그대로 옮김).
  exp_chip_spread       = US_SOX_ret_1d − US_SP500_ret_1d (이미 있는 정형 변수)
  exp_sector_dispersion = KRX 업종 4개(sec_auto·sec_living_1·sec_internet_1·sec_fashion_1) 5거래일 수익률의 표준편차(3개 이상 있을 때)
  exp_fx_vol            = min(원/달러 5일 수익률⁺, VKOSPI 5일 변화율⁺) — 원화 약세와 변동성 상승이 함께 날 때
원천(DB 읽기 전용, 이번 실행 메모리): extract_db 가 받은 표준화 원천. 정렬: 업종 krx_close 지연 0, 환율 kst_eod 지연 1(예측 시각 앞 확정 값).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import wk_paths as P
from kw import align as AL

COLS = ["exp_chip_spread", "exp_sector_dispersion", "exp_fx_vol"]
SECTORS = ("sec_auto", "sec_living_1", "sec_internet_1", "sec_fashion_1")


def _returns(X, key, rule, lag=0, days=1):
    source, db = P.setup()
    raw = db.load_standardized(key)
    if raw is None or raw.empty:
        raise RuntimeError(f"DB 원천 {key} 를 받지 못했습니다.")
    clean = pd.DataFrame({"date": source._to_date(raw.Date), "close": source._num(raw.Close)})
    close = clean.drop_duplicates("date", keep="last").set_index("date").close.sort_index()
    close = source.drop_holiday_copies(close[close > 0], rule)
    r = close.pct_change(days, fill_method=None).rename(key)
    values, _, age = AL.asof_join(pd.DatetimeIndex(X.index), X.prediction_at, r.to_frame(), rule, lag)
    AL.check_no_future(age, key)
    return values[key]


def build(X: pd.DataFrame) -> pd.DataFrame:
    sectors = pd.concat([_returns(X, k, "krx_close", days=5) for k in SECTORS], axis=1)
    fx = _returns(X, "kr_usdkrw", "kst_eod", lag=1, days=5)
    vk = X["NEW_KR_VKOSPI_level"].pct_change(5, fill_method=None)
    return pd.DataFrame({
        "exp_chip_spread": X.US_SOX_ret_1d - X.US_SP500_ret_1d,
        "exp_sector_dispersion": sectors.std(axis=1, ddof=0).where(sectors.notna().sum(axis=1) >= 3),
        "exp_fx_vol": np.minimum(fx.clip(lower=0), vk.clip(lower=0)),
    }, index=X.index)


def attach(X: pd.DataFrame) -> pd.DataFrame:
    """VKOSPI(wk_vkospi.attach) 뒤에 붙인다(exp_fx_vol 이 VKOSPI 수준을 씀)."""
    return pd.concat([X.drop(columns=[c for c in COLS if c in X.columns]), build(X)], axis=1)
