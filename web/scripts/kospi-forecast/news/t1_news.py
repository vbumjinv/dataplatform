"""[실사용 모듈] T1(유럽 장 마감) 뉴스 일별 변수 — dp.news_feature_orig 기사를 대상일 window(직전 거래일 장 마감 ~ T1 예측 시각)로 모아 모델 입력과 조건 값을 만든다.

사용처: predict/engine.py --tp T1(예측), train/retrain_t1.py(월간 재학습: 새 거래일 이력)
입력: DB dp.news_feature_orig(stage2_status='ok', probs) + dp.news_stock_article(발행·수정 시각) — 읽기 전용
출력: 대상일 x [뉴스 10개(t1_*), sec_market, rel_mid_share, n_articles]
  t1_* 10개 = 영향 점수·흩어짐·긍정/부정/혼재 비중·강도·국내/미국 영향 점수·서프라이즈·예상 밖 비중(시황 기사 제외 가중 평균, 기사 없으면 0)
  sec_market = 시장 전체 업종 영향 점수(Σ 가중치 x 영향 점수 x 업종=시장전체 확률 / Σ 가중치) — 방향 모델 조건
  rel_mid_share = 시황이 아닌 기사 중 kospi_relevance 라벨이 0.5 인 비중(속성 11개 항목 건수 합 대비, 기사 없으면 NaN) — 수익률 모델 조건
window: [직전 KOSPI 거래일 장 마감(time_points.json market_close), 대상일 예측 시각) 에 확정(available_at_kst = max(발행, 수정))된 기사.
근거: experiments/daily/test/news_signal/news_agg.py(article_scores·_day_features), news_t1/windows.py(WA), news_signal/item_table.py·rule_atoms.py,
      news_best_refit/08_t1_service_seed.py(시드와 같은 값인지 확인, 2026-11-05).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
from .source import FEATURE_READ_TABLE, available, utc

KST = "Asia/Seoul"
SEM = ["t1_impact", "t1_impact_std", "t1_pos_share", "t1_neg_share", "t1_mix_share", "t1_strength",
       "t1_impact_kor", "t1_impact_usa", "t1_surprise", "t1_unexpected"]
COLS = SEM + ["sec_market", "rel_mid_share", "n_articles"]
STRENGTH = {"none": 0.0, "weak": 1 / 3, "moderate": 2 / 3, "strong": 1.0}
N_ATTRS = 11                                    # 기사 속성 11개(항목 건수 합 = 시황 제외 기사 수 x 11)


def read_articles(con, lo, hi) -> pd.DataFrame:
    """[lo, hi) 에 확정된 기사(Stage 2 ok). lo·hi: tz-aware 시각."""
    from sqlalchemy import text
    art = pd.read_sql(text(f"""select f.article_key, {available()} AS available_at_kst, f.kospi_relevance, f.article_role, f.probs,
                                     a.published_at, a.modified_at
                              from {FEATURE_READ_TABLE} f join dp.news_stock_article a using(article_key)
                              where f.stage2_status='ok' and f.probs is not null
                                and {available()} >= :lo and {available()} < :hi"""),
                      con, params={"lo": pd.Timestamp(lo).to_pydatetime(), "hi": pd.Timestamp(hi).to_pydatetime()})
    if art.article_key.duplicated().any():
        raise ValueError("기사 키 중복: 뉴스 피처 버전을 먼저 확정하세요.")
    for c in ("available_at_kst", "published_at", "modified_at"):
        art[c] = utc(art[c])
    if len(art) and (art[["published_at", "modified_at"]].max(axis=1) != art.available_at_kst).any():
        raise ValueError("available_at_kst 가 max(발행, 수정) 과 다른 기사가 있습니다(뉴스 피처 점검 필요).")
    return art


def _p(probs: list[dict], field: str, option: str) -> np.ndarray:
    return np.array([float(p.get(field, {}).get(option, 0.0)) for p in probs])


def article_scores(art: pd.DataFrame) -> pd.DataFrame:
    """기사 단위 수치(news_agg.article_scores 의 필요한 열만, 같은 식)."""
    pr = [json.loads(x) if isinstance(x, str) else x for x in art["probs"]]
    s = _p(pr, "impact_direction", "positive") - _p(pr, "impact_direction", "negative")
    strength = sum(v * _p(pr, "impact_strength", k) for k, v in STRENGTH.items())
    rel = _p(pr, "kospi_relevance", "1") + 0.5 * _p(pr, "kospi_relevance", "0.5")
    core = 1.0 - _p(pr, "article_role", "market_recap")
    impact = s * strength * rel
    lab_rel = pd.to_numeric(art["kospi_relevance"], errors="coerce").map(lambda v: "na" if pd.isna(v) else f"{v:g}")
    return pd.DataFrame({
        "t_ns": art["available_at_kst"].dt.as_unit("ns").astype("int64").to_numpy(),
        "impact": impact, "w": rel * strength * _p(pr, "active_at_target", "active") * core, "wc": core, "strength": strength,
        "pos": _p(pr, "impact_direction", "positive"), "neg": _p(pr, "impact_direction", "negative"), "mix": _p(pr, "impact_direction", "mixed"),
        "kor": _p(pr, "origin_region", "korea"), "usa": _p(pr, "origin_region", "usa"),
        "surp": _p(pr, "surprise_vs_expectation", "above") - _p(pr, "surprise_vs_expectation", "below"),
        "unexp": _p(pr, "surprise_vs_expectation", "unexpected"), "sec": _p(pr, "primary_sector", "시장전체"),
        "lab_recap": (art["article_role"].fillna("na").astype(str) == "market_recap").to_numpy(),
        "lab_rel_mid": (lab_rel == "0.5").to_numpy(),
    })


def _wmean(x, w):
    sw = w.sum()
    return float((x * w).sum() / sw) if sw > 1e-12 else 0.0


def _day(a: pd.DataFrame) -> dict:
    n = len(a)
    if n == 0:
        out = {c: 0.0 for c in SEM + ["sec_market"]}
        out.update(rel_mid_share=np.nan, n_articles=0)
        return out
    w, wc, imp = a.w.to_numpy(), a.wc.to_numpy(), a.impact.to_numpy()
    f = {"t1_impact": _wmean(imp, w)}
    f["t1_impact_std"] = float(np.sqrt(_wmean((imp - f["t1_impact"]) ** 2, w)))
    f["t1_pos_share"], f["t1_neg_share"], f["t1_mix_share"] = (_wmean(a[c].to_numpy(), w) for c in ("pos", "neg", "mix"))
    f["t1_strength"] = _wmean(a.strength.to_numpy(), wc)
    f["t1_impact_kor"] = _wmean(imp, w * a.kor.to_numpy())
    f["t1_impact_usa"] = _wmean(imp, w * a.usa.to_numpy())
    f["t1_surprise"] = _wmean(a.surp.to_numpy(), w)
    f["t1_unexpected"] = _wmean(a.unexp.to_numpy(), w)
    f["sec_market"] = float((w * imp * a.sec.to_numpy()).sum() / max(w.sum(), 1e-12))
    nr = ~a.lab_recap.to_numpy()
    f["rel_mid_share"] = float(a.lab_rel_mid.to_numpy()[nr].sum() / (N_ATTRS * nr.sum())) if nr.any() else np.nan
    f["n_articles"] = n
    return f


def window_edges(prediction_at, previous) -> tuple[pd.DatetimeIndex, pd.DatetimeIndex]:
    """대상일별 [시작, 끝): 직전 거래일 장 마감 ~ 예측 시각(KST)."""
    from features import timepoints as TPR
    mh, mm = TPR.market_close()
    start = pd.DatetimeIndex(previous).normalize().tz_localize(KST) + pd.Timedelta(hours=mh, minutes=mm)
    end = pd.DatetimeIndex(prediction_at).tz_convert(KST)
    if (start >= end).any():
        raise ValueError("뉴스 window 시작이 예측 시각보다 늦은 대상일이 있습니다.")
    return start, end


def daily(art: pd.DataFrame, days, prediction_at, previous) -> pd.DataFrame:
    """기사 표 -> 대상일 x COLS. days·prediction_at·previous 는 같은 순서."""
    sc = article_scores(art)
    sc = sc.iloc[np.argsort(sc.t_ns.to_numpy(), kind="stable")].reset_index(drop=True)
    t = sc.t_ns.to_numpy()
    start, end = window_edges(prediction_at, previous)
    lo = np.searchsorted(t, start.as_unit("ns").asi8, side="left")
    hi = np.searchsorted(t, end.as_unit("ns").asi8, side="left")
    return pd.DataFrame([_day(sc.iloc[a:b]) for a, b in zip(lo, hi)], index=pd.DatetimeIndex(days))[COLS]


def build(con, days, prediction_at, previous) -> pd.DataFrame:
    """DB 에서 필요한 기간 기사만 읽어 대상일 x COLS 를 만든다."""
    start, end = window_edges(prediction_at, previous)
    return daily(read_articles(con, start.min(), end.max()), days, prediction_at, previous)
