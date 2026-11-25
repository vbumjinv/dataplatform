"""[실사용 모듈] 주별 수익률 예측 범위 — 기준일 b 의 수익률 예측에 80%·95% 범위를 붙인다(W0 = 경험 분위 C, W2 = EWMA + 급변기 trig — trig 는 일별과 같은 방식).

2026-11-24 운영 모델(v3) 기준 재선정(experiments/5/test/range_v3_20261124/run_range.py, 사용자 요청 '범위 모델 여러 개 중 가장 잘 맞추는 것'):
  W0 = C(척도 vk = VKOSPI/100·√(5/250) · vol20 · vol_ew 중, 분위 창과 함께 연도별로 고름, 보정 없음) — 지금 운영(EWMA·add·trig)보다 검증·홀드아웃 Winkler 작고 적중률 오차도 작음.
  W2 = EWMA·trig 유지(이긴 조합 없음). 설정 config/range_config.json 의 시점별 model·grid.

사용처: predict.py(운영 수익률 저장 때 range_lo80_pct·range_hi80_pct·range_lo95_pct·range_hi95_pct 를 함께 씀).
방식(config/range_config.json, 근거 experiments/5/test/range_td5_20261123, 사용자 결정 2026-11-23):
  · 이력 = 예측에 사용한 방향·수익률 학습본의 OOS + 같은 모델 구성으로 만든 운영 예측. 수익률은 K1 뒤 값, 정답·대상일은 wk_data.answers(거래소 달력).
  · 척도 s = 그달 첫날 전 평균을 뺀 일 수익률의 EWMA(λ) 분산 × 5 의 제곱근(기준일 b 종가까지). 범위 = r + s × 분위(오차/s, 최근 zwin 행).
  · 오차 분위는 달마다 '그달 첫날 전에 정답이 확정된 행'(target_dd < 그달 첫날, +5영업일 purge)으로 다시 계산 — 매달 새 자료로 계속 학습.
  · λ·zwin 은 튜닝 연도(tune_starts, 2026-11 부터 12개월마다) 시작 때 직전 12개월 Winkler(80)+(95) 최소로 다시 고르고,
    같은 12개월 범위로 add 보정 계수(이탈 점수 분위, CQR)를 계산해 그 연도에 쓴다(실험 tune_fold 와 같은 계산).
  · 급변기 trig(두 시점, 일별 range_model.adjust 와 같은 방식): 정답이 확정된 최근 10행 중 80% 범위 이탈 ≥ 4 면 hold 일(W0 5·W2 3) 동안 ACI 배율(≥1)로 넓힘. 상태는 first_month 부터 매번 다시 계산.
  매 예측마다 학습본에 연결된 이력과 정답으로 범위를 계산한다.
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import json
import numpy as np
import pandas as pd

import wk_paths as P

TAUS = (0.025, 0.1, 0.5, 0.9, 0.975)
LEVELS = {80: (0.1, 0.9), 95: (0.025, 0.975)}
BAND = ["q50", "lo80", "hi80", "lo95", "hi95"]
COLS = ("range_lo80_pct", "range_hi80_pct", "range_lo95_pct", "range_hi95_pct")   # 일별 kospi_pred_reg 와 같은 이름


def config() -> dict:
    return json.loads((P.CONFIG / "range_config.json").read_text(encoding="utf-8"))


# ---------------- 이력 ----------------
def _k1(tp, p, r):
    pp = P.CONFIG / "v1_postprocess.json"
    k1 = json.loads(pp.read_text(encoding="utf-8")).get(f"{tp}_reg", {}).get("k1") if pp.exists() else None
    return np.abs(r) * np.where(p >= k1["threshold"], 1.0, -1.0) if k1 else r


def _bundle(tp, obj, model_version=None):
    import wk_models
    slot = f"{tp}_{obj}"
    m = wk_models.load(slot) if model_version is None else wk_models.load_version(slot, model_version)
    if m is None:
        raise ValueError(f"{slot}: 범위 계산에 사용할 학습본 {model_version or 'champion'}이 없습니다.")
    return m


def seed(tp: str, obj: str, model_version=None) -> pd.Series:
    """선택한 학습본의 학습 밖 점예측, 인덱스는 기준일."""
    import wk_models
    return wk_models.range_oos(f"{tp}_{obj}", _bundle(tp, obj, model_version))


def align_seeds(cls, reg):
    d = pd.concat([cls.rename("p"), reg.rename("r")], axis=1, join="inner").sort_index()
    if len(d) < config()["min_fit_rows"]:
        raise ValueError("방향·수익률 모델의 공통 OOS 이력이 범위를 보정하기에 부족합니다.")
    return d


def history(tp: str, b, p_b: float, r_b: float, live: pd.DataFrame | None = None, *, versions=None) -> pd.DataFrame:
    """기준일별 p·r(K1 뒤)·y·target_dd. b 행은 지금 예측(p_b, r_b). live = 운영 기록(없으면 wk_store 에서 읽음)."""
    b = pd.Timestamp(b).normalize()
    import wk_models
    cls, reg = versions or (None, None)
    models = [_bundle(tp, obj, ver) for obj, ver in (("cls", cls), ("reg", reg))]
    slots = [f"{tp}_cls", f"{tp}_reg"]
    d = align_seeds(*(wk_models.range_oos(slot, m).loc[:b] for slot, m in zip(slots, models)))
    d["r"] = _k1(tp, d.p.to_numpy(), d.r.to_numpy())
    if live is None:
        live = live_rows(tp, *(wk_models.calibration_id(slot, m) for slot, m in zip(slots, models)))
    live = live[(live.index > d.index.max()) & (live.index < b)]
    d = pd.concat([d, live[["p", "r"]], pd.DataFrame({"p": [p_b], "r": [r_b]}, index=[b])])
    d = d[d.index <= b]
    d = d[~d.index.duplicated(keep="last")].sort_index()
    assert d[["p", "r"]].notna().all().all(), tp
    import wk_data
    A = wk_data.answers(d.index)
    d["target_dd"], d["y"] = pd.to_datetime(A.target_dd.to_numpy()), A.y_return.to_numpy(float)
    d.loc[d.target_dd > b, "y"] = np.nan                                 # b 시점에 아직 모르는 정답은 쓰지 않음
    return d


def live_rows(tp: str, cls_calibration: str, reg_calibration: str) -> pd.DataFrame:
    """운영 예측 기록(kospi5_pred_cls·reg)의 기준일별 p·r(r = 저장 값, K1 뒤). 거래일 실행 행만(주말·휴일 실행 행은 같은 기준일의 뉴스만 다른 반복이라 뺌).
    기준일 = 대상일보다 5거래일 앞(일별과 같은 열이라 base_dd 열이 없음)."""
    import wk_data
    import wk_store
    c, g = wk_store.read("kospi5_pred_cls"), wk_store.read("kospi5_pred_reg")
    if c.empty or g.empty:
        return pd.DataFrame(columns=["p", "r"], index=pd.DatetimeIndex([]))

    def matching(t, calibration):
        t = t[t.time_point == tp].copy()
        matches = t.model_input.map(lambda inputs: inputs.get("_range_calibration") if isinstance(inputs, dict) else None)
        return t[matches == calibration]

    c = matching(c, cls_calibration)[["target_dd", "prediction_at", "yhat_probability"]]
    g = matching(g, reg_calibration)[["target_dd", "prediction_at", "yhat_value"]]
    t = c.merge(g, on=["target_dd", "prediction_at"], validate="one_to_one")
    if len(t):
        run = pd.to_datetime(t.prediction_at, utc=True).dt.tz_convert("Asia/Seoul").dt.tz_localize(None).dt.normalize()
        t = t[[wk_data.is_session(d) for d in run]]
    t = t.sort_values("prediction_at")
    t.index = pd.DatetimeIndex([wk_data.base_of_target(d) for d in t.target_dd])
    t = t[~t.index.duplicated(keep="last")]
    return t.rename(columns={"yhat_probability": "p", "yhat_value": "r"})[["p", "r"]].astype(float).dropna()


_SCALE: dict = {}
_VK: dict = {}


def _vkospi() -> pd.Series:
    """VKOSPI 종가(거래일, 기준일 b 종가까지 확정 — W0 16:00·W2 다음 날 08:30 모두 앎). DB 읽기 전용(wk_vkospi 와 같은 원천)."""
    if "s" not in _VK:
        import wk_vkospi
        from kw import sources as SRC
        raw = SRC.series_from_frame(SRC.read_db_sql(wk_vkospi.SQL, "KR_VKOSPI_DB", refresh=True))
        s = SRC.drop_holiday_copies(raw, "krx_close")
        _VK["s"] = s[s > 0].sort_index()
    return _VK["s"]


def _scale_of(prm: dict, month: pd.Timestamp, close: pd.Series) -> pd.Series:
    """범위 척도(5거래일 합 표준편차) — EWMA(lam) 또는 C(scale: vol_ew·vol20·vk, 실험 scale_series 와 같음)."""
    if "lam" in prm:
        return _scale(month, prm["lam"], close)
    r = close.pct_change(fill_method=None)
    if prm["scale"] == "vol_ew":
        return np.sqrt((r ** 2).ewm(halflife=5, min_periods=15).mean()).clip(lower=1e-4) * np.sqrt(5)
    if prm["scale"] == "vol20":
        return r.rolling(20, min_periods=15).std() * np.sqrt(5)
    vk = _vkospi()
    return (vk.reindex(vk.index.union(close.index)).ffill().reindex(close.index) / 100 * np.sqrt(5 / 250))


def _scale(month: pd.Timestamp, lam: float, close: pd.Series) -> pd.Series:
    """그달 첫날 전 평균을 뺀 일 수익률의 EWMA 분산으로 낸 '기준일 다음 5거래일 합' 표준편차(실험 vol_model EWMA 와 같음)."""
    key = (month, lam, close.index[-1], len(close))
    if key in _SCALE:
        return _SCALE[key]
    r = close.pct_change(fill_method=None).dropna()
    r = r - r[r.index < month].mean()
    _SCALE[key] = np.sqrt(5 * (r ** 2).ewm(alpha=1 - lam, adjust=False).mean())
    return _SCALE[key]


def known_count(d: pd.DataFrame) -> np.ndarray:
    """행 t 예측 시점까지 정답이 확정된 행 수(target_dd ≤ 기준일 b_t)."""
    td = d.target_dd.to_numpy()
    assert (np.diff(td.astype("int64")) >= 0).all()
    k = np.searchsorted(td, d.index.to_numpy(), side="right")
    assert (k <= np.arange(len(d))).all()
    return k


# ---------------- 범위 ----------------
def make_bands(d, months, prm, close, step=1):
    out = []
    for i in range(0, len(months), step):
        blk = months[i:i + step]
        start = blk[0].start_time
        fit = d[d.target_dd < start]
        rows = d[d.index.to_period("M").isin(blk)]
        if not len(rows):
            continue
        s = _scale_of(prm, start, close)
        z = ((fit.y - fit.r) / s.reindex(fit.index)).to_numpy(dtype=float, na_value=np.nan)
        z = z[np.isfinite(z)]
        if not len(z):
            continue
        win = prm.get("zwin", prm.get("window"))
        z = z[-int(win):] if win else z
        Q = np.sort(np.outer(s.reindex(rows.index).to_numpy(), np.quantile(z, TAUS)), axis=1)
        r = rows.r.to_numpy()
        out.append(pd.DataFrame({"q50": r + Q[:, 2], "lo80": r + Q[:, 1], "hi80": r + Q[:, 3], "lo95": r + Q[:, 0], "hi95": r + Q[:, 4]}, index=rows.index))
    return pd.concat(out) if out else pd.DataFrame(columns=BAND)


def wink(y, b):
    w = 0.0
    for lv in LEVELS:
        lo, hi, al = b[f"lo{lv}"], b[f"hi{lv}"], 1 - lv / 100
        w += float(((hi - lo) + 2 / al * ((lo - y).clip(lower=0) + (y - hi).clip(lower=0))).mean() * 100)
    return w


def calib_add(b, y):
    """add(CQR) 계수: 튜닝 구간 범위의 이탈 점수 분위."""
    coef = {}
    for lv in LEVELS:
        lev = min(1.0, (lv / 100) * (1 + 1 / len(y)))
        coef[lv] = float(np.quantile(np.maximum(b[f"lo{lv}"].to_numpy() - y, y - b[f"hi{lv}"].to_numpy()), lev))
    return coef


def apply_add(b, coef):
    out, c = b.copy(), b.q50.to_numpy()
    for lv in LEVELS:
        out[f"lo{lv}"] = np.minimum(b[f"lo{lv}"].to_numpy() - coef[lv], c)
        out[f"hi{lv}"] = np.maximum(b[f"hi{lv}"].to_numpy() + coef[lv], c)
    out["lo95"], out["hi95"] = np.minimum(out.lo95, out.lo80), np.maximum(out.hi95, out.hi80)
    return out


def tune_starts(cfg, last_month: pd.Period) -> list:
    st = [pd.Period(m, "M") for m in cfg["tune_starts"]]
    m = pd.Period(cfg["next_tune_start"], "M")
    while m <= last_month:
        st.append(m)
        m += cfg["tune_every_months_after"]
    return [x for x in st if x <= last_month]


def bands(tp: str, d: pd.DataFrame, close: pd.Series, cfg=None):
    """first_month 부터 d 끝까지 보정 전·후 범위와 연도별 고른 설정. 반환 (범위 표, 설정 목록)."""
    cfg = cfg or config()
    months = [m for m in d.index.to_period("M").unique() if m >= pd.Period(cfg["first_month"], "M")]
    known = d[d.y.notna()]
    history_months = pd.Index(known.index.to_period("M").unique())

    def inner_months(st):
        return [m for m in history_months if st - 12 <= m < st and
                (known.target_dd < m.start_time).sum() >= cfg["min_fit_rows"] and
                ((known.index.to_period("M") == m) & (known.target_dd < st.start_time)).any()]

    first_ready = next((m for m in months if inner_months(m)), None)
    if first_ready is None:
        raise ValueError(f"{tp}: 확정된 OOS 오차가 부족해 예측 범위를 보정할 수 없습니다.")
    starts = sorted({first_ready, *(m for m in tune_starts(cfg, months[-1]) if m >= first_ready and inner_months(m))})
    g = tp_cfg(cfg, tp).get("grid", cfg["grid"])                       # 시점별 범위 모델(model·grid), 없으면 공통(EWMA)
    grid = [dict(zip(g, v)) for v in __import__("itertools").product(*g.values())]
    out, log = [], []
    for i, st in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else months[-1] + 1
        outer = [m for m in months if st <= m < end]
        if not outer:
            continue
        inner = inner_months(st)
        cutoff = st.start_time
        best = None
        # 동점(학습 행이 zwin 보다 적어 창이 같은 결과)이면 더 최근 창(작은 zwin)을 고른다 — 실험(GridSampler)은 동점을 임의로 골랐다
        for prm in sorted(grid, key=lambda g: (g.get("zwin", g.get("window")) or 10 ** 9, str(g.get("lam", g.get("scale"))))):
            b = make_bands(d, inner, prm, close, cfg["inner_step_months"])
            b = b[(d.target_dd.reindex(b.index) < cutoff) & d.y.reindex(b.index).notna()]
            b = b.dropna()
            if b.empty:
                continue
            sc = wink(d.y.reindex(b.index), b)
            if best is None or sc < best[0] - 1e-9:
                best = (sc, prm, b)
        if best is None:
            raise ValueError(f"{tp}: {st} 범위의 유효한 OOS 오차를 계산하지 못했습니다.")
        sc, prm, b_in = best
        coef = calib_add(b_in, d.y.reindex(b_in.index).to_numpy())
        bo = make_bands(d, outer, prm, close, 1)
        if tp_cfg(cfg, tp)["calib"] == "add":
            bo = apply_add(bo, coef)
        out.append(bo)
        log.append({"start": str(st), **prm, "inner_wink": round(sc, 4), "coef": coef})
    return pd.concat(out).sort_index(), log


def tp_cfg(cfg, tp):
    return cfg[tp]


def aci_scale(b, y, k, gamma):
    c, out = b.q50.to_numpy(), {}
    for lv in LEVELS:
        L = np.maximum(c - b[f"lo{lv}"].to_numpy(), 1e-6)
        U = np.maximum(b[f"hi{lv}"].to_numpy() - c, 1e-6)
        al, ls, s, done = 1 - lv / 100, 0.0, np.ones(len(b)), 0
        for t in range(len(b)):
            while done < k[t]:
                j = done
                if not np.isnan(y[j]):
                    miss = float(y[j] < c[j] - s[j] * L[j] or y[j] > c[j] + s[j] * U[j])
                    ls = float(np.clip(ls + gamma * (miss - al), np.log(0.5), np.log(5.0)))
                done += 1
            s[t] = np.exp(ls)
        out[lv] = s
    return out


def adjust_trig(b, d, cfg):
    """급변기 trig: 정답 확정된 최근 window 행 중 80% 이탈 ≥ miss_k 면 hold 일 동안 ACI 배율(≥1)로 넓힘."""
    dd = d.loc[b.index]
    y, k = dd.y.to_numpy(), known_count(dd)
    sh = aci_scale(b, y, k, cfg["gamma"])
    with np.errstate(invalid="ignore"):                                  # 정답 미확정(NaN) 행은 이탈 아님 → 어차피 k 밖
        miss = ((y < b.lo80.to_numpy()) | (y > b.hi80.to_numpy())).astype(float)
    cs = np.concatenate([[0.0], np.cumsum(np.nan_to_num(miss))])
    sig = (cs[k] - cs[np.maximum(k - cfg["window"], 0)]) >= cfg["miss_k"]
    on, last = np.zeros(len(b), bool), -10 ** 9
    for t in range(len(b)):
        if sig[t]:
            last = t
        on[t] = t - last < cfg["hold"]
    out, c = b.copy(), b.q50.to_numpy()
    for lv in LEVELS:
        s = np.where(on, np.maximum(sh[lv], 1.0), 1.0)
        out[f"lo{lv}"] = c - s * np.maximum(c - b[f"lo{lv}"].to_numpy(), 1e-6)
        out[f"hi{lv}"] = c + s * np.maximum(b[f"hi{lv}"].to_numpy() - c, 1e-6)
    out["regime"] = on
    return out


def final_bands(tp: str, d: pd.DataFrame, close: pd.Series, cfg=None) -> pd.DataFrame:
    cfg = cfg or config()
    b, _ = bands(tp, d, close, cfg)
    adj = tp_cfg(cfg, tp)["adjust"]
    return adjust_trig(b[BAND], d, adj) if adj else b[BAND].assign(regime=False)


def verify_oos(tp, cls, reg):
    """승격 전에 두 모델의 OOS로 마지막 기준일의 범위까지 계산한다."""
    import wk_data
    d = align_seeds(cls, reg)
    d["r"] = _k1(tp, d.p.to_numpy(), d.r.to_numpy())
    close = wk_data.kospi_close()
    d = d.loc[:close.index.max()]
    d = d.join(wk_data.answers(d.index)[["target_dd", "y_return"]].rename(columns={"y_return": "y"}))
    fb = final_bands(tp, d, close.loc[:d.index.max()])
    if d.index[-1] not in fb.index or not np.isfinite(fb.loc[d.index[-1], BAND].to_numpy(float)).all():
        raise ValueError(f"{tp}: 새 모델 조합으로 유효한 80%·95% 범위를 만들 수 없습니다.")


def predict_range(tp: str, b, p_b: float, r_b: float, *, versions=None) -> dict:
    """기준일 b 의 범위(%) — predict.py 가 부른다."""
    import wk_data
    d = history(tp, b, p_b, r_b, versions=versions)
    fb = final_bands(tp, d, wk_data.kospi_close().loc[:pd.Timestamp(b)])
    row = fb.loc[pd.Timestamp(b).normalize()]
    out = {f"range_{s}{lv}_pct": float(row[f"{s}{lv}"]) * 100 for lv in (80, 95) for s in ("lo", "hi")}
    out["range_regime"] = bool(row["regime"])                         # 급변기 보정이 켜진 날(일별 range_regime 과 같은 뜻)
    assert out["range_lo95_pct"] <= out["range_lo80_pct"] <= out["range_hi80_pct"] <= out["range_hi95_pct"], out
    return out
