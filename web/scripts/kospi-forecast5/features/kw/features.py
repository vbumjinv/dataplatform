"""[실사용 모듈] (service_5 복사본, 원본: experiments/5/kw/features.py) 주별 파생 변수 — 원천 kind 별로 같은 변환 묶음을 만든다. 정답이 '5거래일 뒤'라 짧은 창을 촘촘히 둔다(사용자 결정 2026-11-12).

price/price_level : 노트북 8개(_ret_1d, _ret_3/5/10/20d, _ma_gap_5/20, _vol_10 — kp.features.build_multiday_features, 일별과 같은 이름)
                    + 수익률 _ret_2/7/15d, 이평 괴리 _ma_gap_3/10, 변동성 _vol_5/20, _vol_ratio_5_20, z점수 _z_5/10/20,
                      20일 고점·저점 대비 _dd_20/_up_20, 방향(_dir_3/5/10d 부호, _upcnt_5/10 오른 날 수, _streak 연속 상승·하락 일수)
                    + 국면 4개(_ret_60d, _ma_gap_60, _vol_60, _dd_250 — 이전 탐색에서 뽑힌 변수와 기본 9개 TECH 를 잇기 위해 유지)
                    price_level 은 노트북 _level, _level_chg_5 + _level_z_250
rate/difference   : 노트북 _diff_3/5/10/20d, _vol_10, _ret_1d(1일 차분) + _diff_2/7/15d, _vol_5/20, _level, _level_z_20/250,
                    방향(1일 차분 기준 _dir_3/5/10d, _upcnt_5/10, _streak) + 국면 _diff_60d
sector(KRX 지수)  : price 묶음 (+ 정렬 뒤 코스피 대비 _rel_kospi_1/3/5/10/20d, dataset.py)
flow(외국인 순매수): _net_1/3/5/10/20d(순매수 / 같은 기간 거래대금), _net5_z_20, _streak, _poscnt_5/10(순매수 일수)
monthly           : 최근 발표값의 변화 <ID>_L1 만(월 자료라 짧은 창 없음). 월별 시장 가격 변수(KSP·SP·GR·OIL·VIX·BR·MR·ER·GBS·CBS)는
                    같은 원천의 일별 변수로 대신해 원천 등록부에서 hold.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from kp.features import build_multiday_features

NOTEBOOK_TF = {"price": ["ret_1d", "ret_3d", "ret_5d", "ret_10d", "ret_20d", "ma_gap_5", "ma_gap_20", "vol_10"],
               "price_level": ["ret_1d", "ret_3d", "ret_5d", "ret_10d", "ret_20d", "ma_gap_5", "ma_gap_20", "vol_10", "level", "level_chg_5"],
               "rate": ["diff_3d", "diff_5d", "diff_10d", "diff_20d", "vol_10", "ret_1d"],
               "difference": ["diff_3d", "diff_5d", "diff_10d", "diff_20d", "vol_10", "ret_1d"]}


def _z(x, w):
    return (x - x.rolling(w, min_periods=int(w * 0.8)).mean()) / x.rolling(w, min_periods=int(w * 0.8)).std()


def direction_feats(chg, prefix):
    """chg: 1일 변화(수익률 또는 차분). 부호 3·5·10일 합의 부호, 오른 날 수 5·10일, 연속 상승(+n)·하락(−n) 일수(0 이면 0 에서 다시)."""
    f = pd.DataFrame(index=chg.index)
    up = (chg > 0).astype(float).where(chg.notna())
    for w in (3, 5, 10):
        f[f"{prefix}_dir_{w}d"] = np.sign(chg.rolling(w).sum())
    for w in (5, 10):
        f[f"{prefix}_upcnt_{w}"] = up.rolling(w).sum()
    sgn = np.sign(chg)
    grp = (sgn != sgn.shift()).cumsum()
    f[f"{prefix}_streak"] = (sgn * (sgn.groupby(grp).cumcount() + 1)).where(chg.notna())
    return f


def price_short(close, prefix):
    """노트북 8개를 뺀 짧은 창·방향·국면 변수(가격형 공통)."""
    f = pd.DataFrame(index=close.index)
    r1 = close.pct_change(fill_method=None)
    for w in (2, 7, 15, 60):
        f[f"{prefix}_ret_{w}d"] = close / close.shift(w) - 1
    for w in (3, 10, 60):
        f[f"{prefix}_ma_gap_{w}"] = close / close.rolling(w).mean() - 1
    v5, v20 = r1.rolling(5).std(), r1.rolling(20).std()
    f[f"{prefix}_vol_5"], f[f"{prefix}_vol_20"], f[f"{prefix}_vol_60"] = v5, v20, r1.rolling(60).std()
    f[f"{prefix}_vol_ratio_5_20"] = v5 / v20.replace(0, np.nan) - 1
    for w in (5, 10, 20):
        f[f"{prefix}_z_{w}"] = _z(close, w)
    f[f"{prefix}_dd_20"] = close / close.rolling(20).max() - 1
    f[f"{prefix}_up_20"] = close / close.rolling(20).min() - 1
    f[f"{prefix}_dd_250"] = close / close.rolling(250, min_periods=120).max() - 1
    return pd.concat([f, direction_feats(r1, prefix)], axis=1)


def price_feats(close, prefix, kind="price"):
    base = build_multiday_features(close, kind, prefix)
    out = pd.concat([base, price_short(close, prefix)], axis=1)
    if kind == "price_level":
        out[f"{prefix}_level_z_250"] = _z(close, 250)
    return out


def rate_feats(level, prefix, kind="rate"):
    base = build_multiday_features(level, kind, prefix)
    d1 = level.diff()
    for w in (2, 7, 15, 60):
        base[f"{prefix}_diff_{w}d"] = level - level.shift(w)
    base[f"{prefix}_vol_5"], base[f"{prefix}_vol_20"] = d1.rolling(5).std(), d1.rolling(20).std()
    base[f"{prefix}_level"] = level
    base[f"{prefix}_level_z_20"] = _z(level, 20)
    base[f"{prefix}_level_z_250"] = _z(level, 250)
    return pd.concat([base, direction_feats(d1, prefix)], axis=1)


def sector_feats(close, prefix):
    return price_feats(close, prefix, "price")


def flow_feats(net, tv, prefix):
    """net: 외국인 순매수(억원), tv: 같은 시장 거래대금(억원). 같은 날짜끼리만 계산."""
    d = pd.concat({"net": net, "tv": tv}, axis=1).dropna()
    f = pd.DataFrame(index=d.index)
    f[f"{prefix}_net_1d"] = d.net / d.tv
    for w in (3, 5, 10, 20):
        f[f"{prefix}_net_{w}d"] = d.net.rolling(w).sum() / d.tv.rolling(w).sum()
    f[f"{prefix}_net5_z_20"] = _z(d.net.rolling(5).sum(), 20)
    sgn = np.sign(d.net)
    grp = (sgn != sgn.shift()).cumsum()
    f[f"{prefix}_streak"] = sgn * sgn.groupby(grp).cumcount().add(1)
    for w in (5, 10):
        f[f"{prefix}_poscnt_{w}"] = (d.net > 0).astype(float).rolling(w).sum()
    return f


def trading_value_feats(tv, mcap, prefix="KOSPI_TV"):
    d = pd.concat({"tv": tv, "mcap": mcap}, axis=1).dropna()
    d = d[(d.tv > 0) & (d.mcap > 0)]
    f = pd.DataFrame(index=d.index)
    f[f"{prefix}_ratio_1_5"] = d.tv / d.tv.rolling(5).mean() - 1
    f[f"{prefix}_ratio_5_20"] = d.tv.rolling(5).mean() / d.tv.rolling(20).mean() - 1
    f[f"{prefix}_log_z_20"] = _z(np.log(d.tv), 20)
    f[f"{prefix}_log_z_250"] = _z(np.log(d.tv), 250)
    turn = d.tv / d.mcap
    f[f"{prefix}_turnover"] = turn.rolling(5).mean()
    f[f"{prefix}_turnover_z_250"] = _z(turn.rolling(5).mean(), 250)
    return f


def kospi_extra(kospi):
    """코스피 OHLCV 의 주별 추가 변수(TECH_ 접두어는 일별과 같게). 기본 9개의 TECH_dd_250·TECH_ret_60d·TECH_vol_60 포함."""
    close = kospi["Close"].astype(float)
    vol = kospi["Volume"].astype(float).replace(0, np.nan)
    f = price_short(close, "TECH")
    f["TECH_ma_gap_200"] = close / close.rolling(200).mean() - 1
    f["K_vol_ma_ratio_1_5"] = vol / vol.rolling(5).mean() - 1
    f["K_vol_ma_ratio_5_20"] = vol.rolling(5).mean() / vol.rolling(20).mean() - 1
    intr = close / kospi["Open"].astype(float) - 1
    for w in (3, 5):
        f[f"K_intraday_dret_{w}d_sum"] = intr.rolling(w).sum()
    v20 = close.pct_change(fill_method=None).rolling(20).std()
    f["TECH_vol_regime"] = v20 / v20.rolling(250, min_periods=200).median() - 1
    return f


# ------------------------------------------------------------------ 월별
def to_month(s, agg="last"):
    s = s.dropna()
    g = s.groupby(s.index.to_period("M"))
    m = g.last() if agg == "last" else g.mean()
    m.index = m.index.to_timestamp(how="end").normalize()
    return m


def monthly_feats(level_m, sid, tform):
    """level_m: 월말 index 의 수준값. 최근 발표 달의 변화 하나만 L1 로 둔다(diff | pct | yoy | level)."""
    lv = level_m.sort_index()
    x = {"diff": lambda: lv.diff(), "pct": lambda: lv.pct_change(fill_method=None),
         "yoy": lambda: lv / lv.shift(12) - 1}.get(tform, lambda: lv)()
    return pd.DataFrame({f"{sid}_L1": x}, index=lv.index)
