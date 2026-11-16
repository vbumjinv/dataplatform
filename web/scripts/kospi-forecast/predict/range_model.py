"""[실사용 모듈] 예측 범위 모델 — 과거 예측과 실제 수익률의 차이(오차)를 학습해 그날 예측의 80%·95% 범위를 내고, 급변 신호가 있을 때만 넓힌다.

사용처: predict/predict_range.py
오차 모델(E5): 오차 e = 실제 수익률 - K1 예측 r 을 [vol_ew, r, (p-0.5)·vol_ew, |p-0.5|·vol_ew, K1 적용·vol_ew] + 절편으로 선형 분위수 회귀
              (τ = 0.025·0.1·0.5·0.9·0.975). vol_ew = 대상일 전날까지 반감기 5일 지수가중 변동성. 범위 = r + 오차 분위수.
급변기 보정: 신호 = 최근 10거래일 중 실제가 보통 모델 80% 범위를 벗어난 날 >= miss_k (켜지면 5거래일 유지).
            켜진 날만 ACI 배율(>=1, 어제까지의 범위 이탈로 매일 갱신)로 중앙값 기준 양쪽 폭을 넓히고, 꺼진 날은 보통 모델 범위 그대로.
근거: experiments/daily/test/pred_interval/(02·06 단계, interval_lib.py 의 E5·triggered_adjust 와 같은 계산), 2026-11-03.
"""
from __future__ import annotations

import warnings
import numpy as np
import pandas as pd

TAUS = (0.025, 0.1, 0.5, 0.9, 0.975)
LEVELS = {80: (0.1, 0.9), 95: (0.025, 0.975)}
BAND = ["q50", "lo80", "hi80", "lo95", "hi95"]


def vol_ew(close: pd.Series) -> pd.Series:
    """대상일 전날 종가까지 반감기 5일 지수가중 변동성."""
    ret = close.pct_change()
    return np.sqrt((ret ** 2).ewm(halflife=5, min_periods=15).mean()).shift(1)


def _design(d: pd.DataFrame) -> pd.DataFrame:
    v = d.vol_ew.clip(lower=1e-4)
    pc, pa = d.p - 0.5, (d.p - 0.5).abs()
    return pd.DataFrame({"vol": v, "r": d.r, "pcv": pc * v, "pav": pa * v, "flipv": d.flip.astype(float) * v}, index=d.index)


class ErrorModel:
    """E5 오차 모델. fit(학습 표: p·r·flip·vol_ew·y) → predict(표) = 수익률 범위 q50·lo80·hi80·lo95·hi95."""

    def fit(self, d: pd.DataFrame) -> "ErrorModel":
        from sklearn.linear_model import QuantileRegressor
        d = d.dropna(subset=["vol20", "vol_ew", "y"])
        Z, e = _design(d), (d.y - d.r).to_numpy()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.models = [QuantileRegressor(quantile=t, alpha=0.0, solver="highs").fit(Z, e) for t in TAUS]
        self.n_train = len(d)
        return self

    def predict(self, d: pd.DataFrame) -> pd.DataFrame:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            Q = np.sort(np.column_stack([m.predict(_design(d)) for m in self.models]), axis=1)
        r = d.r.to_numpy()
        out = {"q50": r + Q[:, 2]}
        for lv, (lo, hi) in LEVELS.items():
            out[f"lo{lv}"], out[f"hi{lv}"] = r + Q[:, TAUS.index(lo)], r + Q[:, TAUS.index(hi)]
        return pd.DataFrame(out, index=d.index)


def _aci_scale(b: pd.DataFrame, y: np.ndarray, gamma: float) -> dict:
    """ACI 배율(그림자 계산): 어제 범위를 벗어났으면 log s += γ(1-α), 들어왔으면 log s -= γα. s 는 [0.5, 5]."""
    c, out = b.q50.to_numpy(), {}
    for lv in LEVELS:
        L = np.maximum(c - b[f"lo{lv}"].to_numpy(), 1e-6)
        U = np.maximum(b[f"hi{lv}"].to_numpy() - c, 1e-6)
        al, ls, s = 1 - lv / 100, 0.0, np.ones(len(b))
        for t in range(len(b)):
            s[t] = np.exp(ls)
            if not np.isnan(y[t]):
                miss = float(y[t] < c[t] - s[t] * L[t] or y[t] > c[t] + s[t] * U[t])
                ls = float(np.clip(ls + gamma * (miss - al), np.log(0.5), np.log(5.0)))
        out[lv] = s
    return out


def adjust(b: pd.DataFrame, y: pd.Series, cfg: dict) -> pd.DataFrame:
    """날짜순 보통 모델 범위 b 와 실제 수익률 y(모르면 NaN)로 급변기 보정 범위를 만든다. 대상일 실제값은 그날 범위에 쓰지 않는다.
    cfg: gamma, miss_k, window, hold. 반환: 보정 범위 + regime_signal + s80·s95."""
    yy = y.reindex(b.index).to_numpy()
    shadow = _aci_scale(b, yy, cfg["gamma"])
    miss = ((yy < b.lo80.to_numpy()) | (yy > b.hi80.to_numpy())).astype(float)
    miss[np.isnan(yy)] = np.nan
    recent = pd.Series(miss, index=b.index).rolling(cfg["window"], min_periods=1).sum().shift(1).fillna(0).to_numpy()
    sig = recent >= cfg["miss_k"]
    on, last = np.zeros(len(b), bool), -10 ** 9
    for t in range(len(b)):
        if sig[t]:
            last = t
        on[t] = t - last < cfg["hold"]
    out, c = b.copy(), b.q50.to_numpy()
    for lv in LEVELS:
        s = np.where(on, np.maximum(shadow[lv], 1.0), 1.0)
        out[f"lo{lv}"], out[f"hi{lv}"] = scaled_bounds(c, b[f"lo{lv}"].to_numpy(), b[f"hi{lv}"].to_numpy(), s)
        out[f"s{lv}"] = s
    out["regime_signal"] = on
    return out


PRED_COLS = ['p', 'r', 'r_raw', 'flip', 'prev_close', 'close', 'y', 'vol20', 'vol_ew']

def previous_values(series, days, trading_days=None):
    """거래소 달력의 직전 거래일 값. 누락일을 건너뛰어 오래된 값을 사용하지 않는다."""
    import exchange_calendars as xcals
    days = pd.DatetimeIndex(days)
    trading_days = trading_days if trading_days is not None else series.attrs.get('trading_days')
    if trading_days is None:
        cal = xcals.get_calendar('XKRX')
        prev = pd.DatetimeIndex([cal.previous_session(d) for d in days]).tz_localize(None)
    else:
        observed = pd.DatetimeIndex(trading_days).sort_values()
        if len(days) and days.max() > observed.max():
            # 아직 자료가 들어오지 않은 미래 거래일은 휴장일로 오인하지 않는다.
            from features.missing import trading_calendar
            observed = observed.union(trading_calendar('KR', observed.max(), days.max()))
        seq = observed.union(days).sort_values()
        mapping = pd.Series(seq[:-1], index=seq[1:])
        prev = pd.DatetimeIndex(mapping.reindex(days))
    return pd.Series(series.reindex(prev).to_numpy(), index=days)


def attach_market_inputs(predictions, close):
    """학습·운영 공용: 같은 KR 거래일 근거로 직전 종가·정답·변동성을 붙인다."""
    frame = predictions.copy()
    days, calendar = frame.index, close.attrs.get('trading_days')
    frame['prev_close'] = previous_values(close, days, calendar)
    frame['close'] = close.reindex(days)
    frame['y'] = frame.close / frame.prev_close - 1
    ret = close.pct_change(fill_method=None)
    frame['vol20'] = previous_values(ret.rolling(20, min_periods=15).std(), days, calendar)
    frame['vol_ew'] = previous_values(np.sqrt((ret ** 2).ewm(halflife=5, min_periods=15).mean()), days, calendar)
    if frame[['prev_close', 'vol_ew']].isna().any(axis=None):
        raise ValueError('직전 KR 거래일 종가·변동성 누락: 원천을 복구해야 합니다.')
    return frame


def prepare_range(tp, hist, svc, close, cfg):
    """[실사용 모듈] 운영·시뮬레이션 공용: 입력 정렬 → 월별 오차 학습 → 급변 상태 → 범위 표."""
    svc = svc[~svc.index.duplicated(keep='last')].sort_index()
    svc = svc[svc.index > hist.index.max()].copy()
    svc = attach_market_inputs(svc, close)
    # 보통 모델 범위: 달마다 그 달 첫날 이전 자료(마지막 1거래일 gap)로 E5 를 맞춘다
    known = pd.concat([hist[PRED_COLS], svc[PRED_COLS]]).sort_index()
    models, bands = {}, []
    for m in svc.index.to_period('M').unique():
        rows = svc[svc.index.to_period('M') == m]
        em = models[str(m)] = ErrorModel().fit(known[known.index < m.start_time].iloc[:-1])
        bands.append(em.predict(rows))
    if bands:
        svc = svc.join(pd.concat(bands))
    seq = pd.concat([hist.assign(source='backtest'), svc.assign(source='service')]).sort_index()
    seq = seq[seq.index >= cfg['state_start']]
    adj = adjust(seq[BAND], seq.y, cfg)
    t = pd.DataFrame({'source': seq.source.to_numpy(), 'p': seq.p.to_numpy(), 'r': seq.r.to_numpy(),
                      'prev_close': seq.prev_close.to_numpy(), 'close': seq.close.to_numpy(), 'y': seq.y.to_numpy()}, index=seq.index)
    for lv in (80, 95):
        for side in ('lo', 'hi'):
            t[f'range_{side}{lv}_pct'] = (adj[f'{side}{lv}'] * 100).round(6).to_numpy()
    t['range_regime'] = adj.regime_signal.astype(bool).to_numpy()     # 범위 배율·설정 이름은 매번 다시 계산·range_config.json 에 있어 저장하지 않는다
    return t, svc, models, adj[['s80', 's95', 'regime_signal']]


def scaled_bounds(center, lo, hi, scale):
    """운영·시나리오 공용 급변 배율 적용. 최소 반폭도 동일하다."""
    return (center - scale * np.maximum(center - lo, 1e-6),
            center + scale * np.maximum(hi - center, 1e-6))


class RangeRuntime:
    """운영 일괄 범위와 동일 상태에서 단일 입력 시나리오 범위를 계산한다."""
    def __init__(self, tp, hist, svc, close, cfg):
        self.cfg = cfg
        self.table, self.inputs, self.models, self.scale = prepare_range(tp, hist, svc, close, cfg)

    def scenario(self, target, p, r, flip):
        d = pd.Timestamp(target)
        source = self.inputs.loc[d]
        row = pd.DataFrame({'p': [p], 'r': [r], 'flip': [flip],
                            'vol20': [source.vol20], 'vol_ew': [source.vol_ew]}, index=[d])
        b = self.models[str(d.to_period('M'))].predict(row).iloc[0]
        sc = self.scale.loc[d]
        result = self.table.loc[d].copy()
        result['p'], result['r'] = p, r
        for lv in LEVELS:
            lo, hi = scaled_bounds(b.q50, b[f'lo{lv}'], b[f'hi{lv}'], float(sc[f's{lv}']))
            result[f'range_lo{lv}_pct'], result[f'range_hi{lv}_pct'] = float(lo)*100, float(hi)*100
        return result


def range_summary(table, target, row=None):
    """운영 해설·시뮬레이션 공용: 범위와 과거 대비 폭을 LLM 입력 단위로 표시한다."""
    target = pd.Timestamp(target)
    r = table.loc[target] if row is None else row
    width = table.range_hi80_pct - table.range_lo80_pct
    past = width[table.index < target]
    w = float(r.range_hi80_pct - r.range_lo80_pct)
    rank = float((past < w).mean()*100) if len(past) else 50.0
    level = '좁은 편' if rank < 33 else '평소 수준' if rank < 67 else '넓은 편' if rank < 90 else '매우 넓은 편'
    return {'prev_close': round(float(r.prev_close), 2),
            'range80_pct': [round(float(r.range_lo80_pct), 2), round(float(r.range_hi80_pct), 2)],
            'range80_close': [int(round(r.prev_close*(1+r.range_lo80_pct/100))), int(round(r.prev_close*(1+r.range_hi80_pct/100)))],
            'range95_pct': [round(float(r.range_lo95_pct), 2), round(float(r.range_hi95_pct), 2)],
            'width80_pp': round(w,2), 'width_rank_pct': round(rank,1), 'width_level': level,
            'volatile_adjusted': bool(r.range_regime)}
