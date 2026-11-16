"""[실사용 모듈] T2 뉴스 결합 모델 수식과 기사 집계 함수 — DB 입출력은 공통 engine.py가 처리한다."""
from __future__ import annotations

import numpy as np
import pandas as pd
from features import timepoints as TPR

CLS_COLS = ["core_mean_s", "core_wmean_s", "core_mean_sw", "core_pos", "core_neg", "core_mix",
            "core_mean_w", "core_std_s", "ctx_wmean_s_ew3", "ctx_mean_sw_ew3", "ctx_wmean_s_ew5", "ctx_mean_sw_ew5"]
REG_MODELS = ["gb", "hgb", "xgb", "ridge"]
DIR_, STR_ = ["positive", "negative", "mixed"], ["none", "weak", "moderate", "strong"]
SCORE = np.array([0, 1 / 3, 2 / 3, 1.0])


def logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


FUSION_DEFAULT = "logit_70_30"   # 2026-11-09 이전 학습본(fusion 값이 없거나 logit_70_30)
FUSION_WEIGHTS = {"logit_70_30": 0.7,
                  "logit_80_20": 0.8}   # 2026-11-09 재선정: 검증 +12일·홀드아웃 +2일(experiments/daily/test/model_reselect_20261109)


FUSION_SERVICE = "logit_80_20"   # 새 학습본 기본값(직전 학습본 값이 없을 때)


def fusion_weight(bundle) -> float:
    """방향 로짓융합의 정형 F0 비중 w: p = sigmoid(w·logit(F0) + (1-w)·logit(뉴스 RF)). 학습본 fusion 값으로 정한다."""
    name = bundle.get("fusion") or FUSION_DEFAULT
    if name not in FUSION_WEIGHTS:
        raise ValueError(f"알 수 없는 T2 방향 결합 방식: {name}")
    return FUSION_WEIGHTS[name]


def fuse(bundle, p_structured, p_news):
    w = fusion_weight(bundle)
    return 1 / (1 + np.exp(-np.clip(w * logit(p_structured) + (1 - w) * logit(p_news), -35, 35)))


def w1_days(available, days, previous, prediction_at):
    """기사 확정 시각을 직전 거래일 장 마감(time_points.json market_close) 이상·예측 시각 미만 구간에 매핑한다."""
    days = pd.DatetimeIndex(days)
    start = pd.DatetimeIndex(previous)
    if start.tz is None:
        start = start.tz_localize("Asia/Seoul")
    mh, mm = TPR.market_close()
    start = (start + pd.Timedelta(hours=mh, minutes=mm)).tz_convert("UTC").as_unit("ns").asi8
    end = pd.DatetimeIndex(prediction_at).tz_convert("UTC").as_unit("ns").asi8
    av = pd.DatetimeIndex(available)
    av = av.tz_localize("Asia/Seoul") if av.tz is None else av
    av = av.tz_convert("UTC").as_unit("ns").asi8
    pos = np.searchsorted(end, av, side="right")
    clipped = np.minimum(pos, len(days) - 1)
    return np.where((pos < len(days)) & (av >= start[clipped]), pos, -1).astype(np.int32)


# ---------------------------------------------------------------- 뉴스 일별 변수
def news_cls_features(P, day, recap, ci, days, hist):
    """기사 확률(P: 기사 x 88) -> 방향 모델용 12개 일별 변수."""
    nd = len(days)
    ok = (~recap) & (day >= 0)
    Pk, dy = P[ok].astype(np.float64), day[ok]
    pd_, ps_ = Pk[:, [ci[f"impact_direction__{d}"] for d in DIR_]], Pk[:, [ci[f"impact_strength__{s}"] for s in STR_]]
    s_, w_ = pd_[:, 0] - pd_[:, 1], ps_ @ SCORE
    acc = {k: np.zeros(nd) for k in ["n", "s", "w", "sw", "ws", "pos", "neg", "mix", "s2"]}
    for k, v in (("n", np.ones(len(Pk))), ("s", s_), ("w", w_), ("sw", np.abs(s_) * w_), ("ws", w_ * s_), ("pos", pd_[:, 0]),
                 ("neg", pd_[:, 1]), ("mix", pd_[:, 2]), ("s2", s_ * s_)):
        np.add.at(acc[k], dy, v)
    n = acc["n"]
    nz = np.where(n > 0, n, 1)
    mean_s = acc["s"] / nz
    F = pd.DataFrame({"core_mean_s": mean_s,
                      "core_wmean_s": np.where(acc["w"] > 0, acc["ws"] / np.where(acc["w"] > 0, acc["w"], 1), 0),
                      "core_mean_sw": acc["sw"] / nz, "core_pos": acc["pos"] / nz, "core_neg": acc["neg"] / nz, "core_mix": acc["mix"] / nz,
                      "core_mean_w": acc["w"] / nz, "core_std_s": np.sqrt(np.maximum(acc["s2"] / nz - mean_s ** 2, 0))}, index=days)
    F[n == 0] = 0.0
    seq = pd.concat([hist[["core_wmean_s", "core_mean_sw"]], F[["core_wmean_s", "core_mean_sw"]]])
    for hl in (3, 5):
        for c in ("core_wmean_s", "core_mean_sw"):
            F[f"ctx_{c[5:]}_ew{hl}"] = seq[c].ewm(halflife=hl, adjust=False).mean().shift(1).fillna(0).loc[days]
    return F[CLS_COLS]


def news_reg_features(P, day, ci, days):
    """기사 확률 -> 수익률 모델용 14개 일별 변수(t1_*)."""
    ok = day >= 0
    P, dy = P[ok].astype(float), day[ok]
    get = lambda field, option: P[:, ci[f"{field}__{option}"]]
    pos, neg, mix = (get("impact_direction", x) for x in DIR_)
    s = pos - neg
    strength = np.column_stack([get("impact_strength", x) for x in STR_]) @ SCORE
    rel = get("kospi_relevance", "1") + .5 * get("kospi_relevance", "0.5")
    active = get("active_at_target", "active")
    recap = get("article_role", "market_recap")
    core = 1 - recap
    impact = s * strength * rel
    w = rel * strength * active * core
    kor, usa = get("origin_region", "korea"), get("origin_region", "usa")
    surp = get("surprise_vs_expectation", "above") - get("surprise_vs_expectation", "below")
    unexp = get("surprise_vs_expectation", "unexpected")
    vals = {"n": np.ones(len(P)), "w": w, "impact_w": impact * w, "impact2_w": impact ** 2 * w, "pos_w": pos * w, "neg_w": neg * w,
            "mix_w": mix * w, "strength_core": strength * core, "core": core, "recap": recap, "impact_kor_w": impact * w * kor,
            "kor_w": w * kor, "impact_usa_w": impact * w * usa, "usa_w": w * usa, "surp_w": surp * w, "unexp_w": unexp * w}
    acc = {k: np.zeros(len(days)) for k in vals}
    for k, v in vals.items():
        np.add.at(acc[k], dy, v)
    div = lambda a, b: np.divide(a, b, out=np.zeros_like(a), where=b > 1e-12)
    imp = div(acc["impact_w"], acc["w"])
    out = pd.DataFrame(index=days)
    out["t1_no_news"] = (acc["n"] == 0).astype(float)
    out["t1_impact"] = imp
    out["t1_impact_std"] = np.sqrt(np.maximum(div(acc["impact2_w"], acc["w"]) - imp ** 2, 0))
    out["t1_pos_share"] = div(acc["pos_w"], acc["w"])
    out["t1_neg_share"] = div(acc["neg_w"], acc["w"])
    out["t1_mix_share"] = div(acc["mix_w"], acc["w"])
    out["t1_strength"] = div(acc["strength_core"], acc["core"])
    out["t1_log_n"] = np.log1p(acc["core"])
    out["t1_recap_share"] = div(acc["recap"], acc["n"])
    out["t1_log_recap_n"] = np.log1p(acc["recap"])
    out["t1_impact_kor"] = div(acc["impact_kor_w"], acc["kor_w"])
    out["t1_impact_usa"] = div(acc["impact_usa_w"], acc["usa_w"])
    out["t1_surprise"] = div(acc["surp_w"], acc["w"])
    out["t1_unexpected"] = div(acc["unexp_w"], acc["w"])
    return out.fillna(0.0)


# ---------------------------------------------------------------- 모델 입력 -> 출력
def predict_structured(fitted, X, obj):
    cols = fitted["columns"]
    miss = sorted(set(cols) - set(X.columns))
    if miss:
        raise ValueError(f"정형 변수 누락: {miss}")
    outs = [m.predict_proba(X[cols])[:, 1] if obj == "cls" else np.asarray(m.predict(X[cols]), float) for m in fitted["models"].values()]
    return np.mean(outs, axis=0)


def predict_news(fitted, X, obj):
    cols = fitted["columns"]
    miss = sorted(set(cols) - set(X.columns))
    if miss:
        raise ValueError(f"뉴스 변수 누락: {miss}")
    A = ((X[cols] - fitted["mean"]) / fitted["std"]).fillna(0.0).to_numpy(float)
    est = fitted["estimator"]
    return est.predict_proba(A)[:, 1] if obj == "cls" else np.asarray(est.predict(A), float)

