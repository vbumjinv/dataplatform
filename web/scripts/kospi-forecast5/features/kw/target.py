"""[실사용 모듈] (service_5 복사본, 원본: experiments/5/kw/target.py) 주별 대상일·정답·누수 방지 — 기준일 b 종가 대비 b 뒤 5번째 거래일(휴장일은 세지 않음) 종가.

정답 y_return = 대상일 종가 / b 종가 - 1 (W0·W2 같음, 사용자 결정 2026-11-10). horizon_td = b 다음 날부터 대상일까지 거래일 수.
보조 정답(이번 탐색에는 안 씀): y_maxdd = 기간 안 최저 종가 / 기준 종가 - 1, y_range = (기간 최고가 - 최저가) / 기준 종가.
정답 기간이 겹치므로 학습 행은 대상일이 평가 첫 예측일보다 앞선 행만 쓴다(purge_before).
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from . import config as WC


def target_dates(pred_dd, cal):
    """기준일 -> 대상일 = 기준일 뒤 HORIZON_TD 번째 거래일. cal = 코스피 거래일(거래소 달력 ∩ 실제 종가가 있는 날).
    두 번째 반환값(target_shifted)은 대상일이 '다음 주 같은 요일'이 아닌 행(휴장 때문에 밀림) — 달력 변수로만 쓴다."""
    cal = pd.DatetimeIndex(cal).sort_values()
    base = pd.DatetimeIndex(pred_dd)
    pos = cal.searchsorted(base, side="right") + WC.HORIZON_TD - 1      # base 다음 거래일 = searchsorted(right)
    tgt = pd.DatetimeIndex([cal[p] if p < len(cal) else pd.NaT for p in pos])
    return tgt, pd.Series(np.asarray((tgt - base).days != 7), index=base)


def build_targets(kospi, base_dd, cal, end_date):
    """kospi: OHLCV(index=코스피 거래일), base_dd: 기준일 b(코스피 거래일). 반환: b index 의 target_dd·base_dd·horizon_td·target_shifted·y_*."""
    base = pd.DatetimeIndex(base_dd)
    kidx = pd.DatetimeIndex(kospi.index)
    close, hi, lo = (kospi[c].astype(float) for c in ("Close", "High", "Low"))
    tgt, shifted = target_dates(base, cal)
    cal = pd.DatetimeIndex(cal)
    h = [int(((cal > b) & (cal <= t)).sum()) if pd.notna(t) else np.nan for b, t in zip(base, tgt)]
    c_base = close.reindex(base).to_numpy()
    c_tgt = close.reindex(tgt).to_numpy()
    y = c_tgt / c_base - 1
    y[(tgt > pd.Timestamp(end_date)) | pd.isna(tgt)] = np.nan
    mdd, rng = [], []
    for b, t, cb in zip(base, tgt, c_base):
        if pd.isna(t) or not np.isfinite(cb):
            mdd.append(np.nan); rng.append(np.nan); continue
        w = (kidx > b) & (kidx <= t)
        mdd.append(close[w].min() / cb - 1); rng.append((hi[w].max() - lo[w].min()) / cb)
    out = pd.DataFrame({"base_dd": base, "target_dd": tgt, "horizon_td": h, "target_shifted": shifted.to_numpy(),
                        "y_return": y, "y_maxdd": mdd, "y_range": rng}, index=base)
    out.loc[out.y_return.isna(), ["y_maxdd", "y_range"]] = np.nan
    out["y_direction"] = (out.y_return > 0).astype(float).where(out.y_return.notna())
    return out


def purge_before(ds, first_pred_dd):
    """first_pred_dd 의 예측 시각에 정답을 아직 모르는 행을 뺀다: 대상일 < first_pred_dd 인 행만 남긴다."""
    return ds[pd.DatetimeIndex(ds["target_dd"]) < pd.Timestamp(first_pred_dd)]


def fold_parts(ds, fold):
    """kp.folds 의 fold(날짜 목록) -> (train, inner, outer). train·inner 는 정답 기간 겹침을 purge 한다."""
    inner = ds.loc[ds.index.intersection(fold["inner"])]
    outer = ds.loc[ds.index.intersection(fold["outer"])]
    train = purge_before(ds.loc[ds.index.intersection(fold["train"])], inner.index.min())
    inner = purge_before(inner, outer.index.min()) if len(outer) else inner
    return train, inner, outer
