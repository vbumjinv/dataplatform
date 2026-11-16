"""[실사용 모듈] 가격 시계열 -> 변수. 기존 벤치마크 노트북의 함수를 그대로 옮겼다."""
import numpy as np
import pandas as pd


def rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def build_multiday_features(close, kind, prefix, windows=(3, 5, 10, 20), nan_mode=None, min_frac=0.8):
    """nan_mode=None: NaN 행이 있으면 NaN이 그대로 전파된다(skip·ffill은 NaN 행이 없고, nan 정책은 의도적으로 전파).
    nan_mode="nanmean": 결측 거래일을 NaN 행으로 둔 채 창 길이를 고정하고, 창 안의 유효값만으로 계산한다.
      이동평균·변동성 = 창 안 유효값 평균/표준편차(유효값이 ceil(창*min_frac)개 미만이면 NaN)
      n일 수익률·차분 = 오늘 값 / (n행 전 값, 그 날이 결측이면 그 직전 유효값). 오늘 값이 결측이면 NaN."""
    feats = pd.DataFrame(index=close.index)
    nm = nan_mode == "nanmean"
    past = close.ffill() if nm else close                  # n행 전 기준값(nanmean: 결측이면 직전 유효값)

    def roll(x, w):
        return x.rolling(w, min_periods=int(np.ceil(w * min_frac))) if nm else x.rolling(w)

    if kind in ("price", "price_level", "level"):
        base_ret = close / past.shift(1) - 1 if nm else close.pct_change(fill_method=None)
        for w in windows:
            feats[f"{prefix}_ret_{w}d"] = close / past.shift(w) - 1
        for w in (5, 20):
            feats[f"{prefix}_ma_gap_{w}"] = close / roll(close, w).mean() - 1
        feats[f"{prefix}_vol_10"] = roll(base_ret, 10).std()
        if kind == "price_level":
            feats[f"{prefix}_level"] = close
            feats[f"{prefix}_level_chg_5"] = close - past.shift(5)
        feats[f"{prefix}_ret_1d"] = base_ret
    else:
        for w in windows:
            feats[f"{prefix}_diff_{w}d"] = close - past.shift(w)
        d1 = close - past.shift(1)
        feats[f"{prefix}_vol_10"] = roll(d1, 10).std()
        feats[f"{prefix}_ret_1d"] = d1
    return feats


def build_ta_features(open_, high, low, close, volume):
    feats = pd.DataFrame(index=close.index)
    ret = close.pct_change(fill_method=None)
    prev_close = close.shift(1)
    for w in (5, 10, 20, 60):
        feats[f"TA_SMA{w}_gap"] = close / close.rolling(w).mean() - 1
    for w in (12, 26):
        feats[f"TA_EMA{w}_gap"] = close / close.ewm(span=w, adjust=False).mean() - 1
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    macd_signal = macd.ewm(span=9, adjust=False).mean()
    feats["TA_MACD"] = macd / close
    feats["TA_MACD_signal"] = macd_signal / close
    feats["TA_MACD_hist"] = (macd - macd_signal) / close
    for w in (5, 10, 20):
        feats[f"TA_MOM{w}"] = (close - close.shift(w)) / close.shift(w)
        feats[f"TA_ROC{w}"] = close / close.shift(w) - 1
    feats["TA_RSI14"] = rsi(close, 14)
    mid20 = close.rolling(20).mean()
    std20 = close.rolling(20).std()
    upper20, lower20 = mid20 + 2 * std20, mid20 - 2 * std20
    feats["TA_BB_percentB_20"] = (close - lower20) / (upper20 - lower20).replace(0, np.nan)
    feats["TA_BB_bandwidth_20"] = (upper20 - lower20) / mid20
    lowest14, highest14 = low.rolling(14).min(), high.rolling(14).max()
    stoch_k = 100 * (close - lowest14) / (highest14 - lowest14).replace(0, np.nan)
    feats["TA_STOCH_K14"] = stoch_k
    feats["TA_STOCH_D14"] = stoch_k.rolling(3).mean()
    feats["TA_WILLR14"] = -100 * (highest14 - close) / (highest14 - lowest14).replace(0, np.nan)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    feats["TA_ATR14_norm"] = tr.rolling(14).mean() / close
    tp = (high + low + close) / 3
    tp_sma20 = tp.rolling(20).mean()
    tp_mad20 = (tp - tp_sma20).abs().rolling(20).mean()
    feats["TA_CCI20"] = (tp - tp_sma20) / (0.015 * tp_mad20.replace(0, np.nan))
    up_move, down_move = high.diff(), -low.diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=close.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=close.index)
    atr = tr.rolling(14).mean().replace(0, np.nan)
    plus_di, minus_di = 100 * plus_dm.rolling(14).mean() / atr, 100 * minus_dm.rolling(14).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    feats["TA_ADX14"] = dx.rolling(14).mean()
    obv = (np.sign(ret.fillna(0)) * volume.fillna(0)).cumsum()
    feats["TA_OBV_chg_10"] = obv.diff(10) / volume.rolling(10).mean().replace(0, np.nan)
    return feats


def build_kospi_base_and_tech(kospi_df):
    p = kospi_df[["Open", "High", "Low", "Close", "Volume"]].astype(float)
    open_, high, low, close, volume_raw = p["Open"], p["High"], p["Low"], p["Close"], p["Volume"]
    prev_close = close.shift(1)
    volume = volume_raw.replace(0, np.nan)
    base = pd.DataFrame(index=p.index)
    base["K_ret_1d"] = close.pct_change(fill_method=None)
    base["K_open_gap"] = open_ / prev_close - 1
    base["K_intraday"] = close / open_ - 1
    base["K_range"] = high / low - 1
    base["K_close_location"] = (close - low) / (high - low).replace(0, np.nan)
    base["K_log_volume_change"] = np.log(volume).diff()
    flow = build_multiday_features(close, "price", "TECH", windows=(3, 5, 10, 20))
    flow = flow.drop(columns=[c for c in flow.columns if c.endswith("_ret_1d")])
    ta = build_ta_features(open_, high, low, close, volume_raw)
    return base, pd.concat([flow, ta], axis=1), close
