"""[실사용 모듈] (service_5 복사본, 2026-11-20 원본: experiments/daily/test/news_signal/news_agg.py) [실험] 뉴스 기사 단위 수치화와 일별 집계 — DB의 Stage 2 확률(dp.news_feature)을 예측 대상일별 변수로 바꾼다.

사용처: 00_diag_signal.py, 02_news_only.py, 03_fusion.py, 04_null_test.py, 10_smoke_connect.py, test/unit/test_news_agg.py
입력: db_feature_store.read_features(..., flatten_probs=True) 결과(기사 단위, `prob_<변수>__<선택지>` 열 + 라벨 + available_at_kst)
출력: 대상일 x 변수 표. 열 이름 접두어가 변수 묶음(tier)을 나타낸다.
  t1_* : 핵심(영향 점수·양/음/mixed 비중·평균 강도·기사 수·시황 비중·한국/미국 점수·surprise) — 항상 투입
  t2_* : 범주별 영향 점수 (Σ 가중치 x 방향 x 범주 확률 / Σ 가중치) — 방향이 있는 범주 정보
  t3_* : 방향 없는 범주 비중 (role, event_type, status)
  c1_* : 필드별 신뢰도(conf_<필드>) 가중 집계 (확장 실험 12_feature_selection.py 에서만 사용; P1~P4 입력에는 포함되지 않음)
  p4_* : 88개 선택지 확률의 일별 단순 평균 (전처리 최소 대조군)
  p3_* : 확정 라벨 기반 단순 변환 (확률을 쓰는 P1·P2의 이득을 보는 대조군)
  m_*  : 점검용(window 길이·기사 수) — 모델 입력에는 쓰지 않는다
전처리 묶음: P1 = t1, P2 = t1+t2+t3, P3 = p3, P4 = p4  (`select_columns`)

window (T2 기준, 모두 available_at_kst 가 [시작, 예측 시각) 에 있는 기사만)
  W1: 직전 KOSPI 거래일 15:30 ~ 대상일 08:30   (장 마감 후 새 정보)
  W2: 전일 08:30 ~ 대상일 08:30                  (24시간, 장중 뉴스 포함)
  W1+최근 3일 평균 열(`*_ma3`)은 `add_ma3`로 덧붙이고 `select_columns(..., ma3=True)`로 고른다.
시황(article_role=market_recap)은 핵심 점수에서 제외하고 비중·건수만 별도 변수로 둔다(사용자 결정 2026-10-16).
기사 없는 날: 점수·비중 0, 기사 수 0, `t1_no_news`=1.
"""
from __future__ import annotations
import re
import numpy as np
import pandas as pd

KST = "Asia/Seoul"
STRENGTH_SCORE = {"none": 0.0, "weak": 1 / 3, "moderate": 2 / 3, "strong": 1.0}
SECTOR_GROUPS = {"시장전체": ["시장전체"], "반도체": ["반도체"], "금융": ["금융/은행", "증권/자산운용", "보험"]}     # 나머지는 '기타'
CHANNEL_GROUPS = {"금리통화": ["금리·통화정책"], "환율": ["환율"], "수급": ["수급(자금흐름)"], "실적": ["실적·가이던스"],
                  "지정학": ["지정학"]}                                                                  # 나머지는 '기타'
ORIGIN_GROUPS = ["korea", "usa", "china"]                                                                # 나머지는 other
ROLE_GROUPS = ["event_report", "analysis_outlook", "scheduled_preview", "opinion_recommendation"]       # market_recap은 t1 시황 비중
STATUS_GROUPS = ["confirmed", "ongoing", "scheduled", "rumor_or_outlook"]
EVENT_GROUPS = {"통화정책": ["monetary_policy"], "경제지표": ["economic_indicator"], "실적": ["earnings_or_guidance"],
                "지정학": ["geopolitical", "trade_or_sanction"], "정책": ["fiscal_or_government_policy", "legal_or_regulatory"],
                "수급": ["capital_flow"], "기업": ["corporate_action"], "산업": ["industry_supply_demand"]}


CONF_FIELDS = ["kospi_relevance", "article_role", "event_type", "event_status", "origin_region", "primary_sector", "primary_channel",
               "surprise_vs_expectation", "impact_direction", "impact_strength", "active_at_target"]


def _p(df: pd.DataFrame, field: str, option: str) -> np.ndarray:
    col = f"prob_{field}__{option}"
    return df[col].to_numpy(float) if col in df.columns else np.zeros(len(df))


def _group_prob(df: pd.DataFrame, field: str, options: list[str]) -> np.ndarray:
    return sum(_p(df, field, o) for o in options) if options else np.zeros(len(df))


def article_scores(arts: pd.DataFrame) -> pd.DataFrame:
    """기사 단위 수치. 입력은 flatten_probs=True 로 읽은 표. 반환: t_ns(available_at_kst, UTC ns 정수)와 점수 열(기사와 같은 순서)."""
    n = len(arts)
    s = _p(arts, "impact_direction", "positive") - _p(arts, "impact_direction", "negative")        # 방향 점수 -1~1
    strength = sum(STRENGTH_SCORE[k] * _p(arts, "impact_strength", k) for k in STRENGTH_SCORE)      # 0~1
    rel = _p(arts, "kospi_relevance", "1") + 0.5 * _p(arts, "kospi_relevance", "0.5")               # 0~1
    active = _p(arts, "active_at_target", "active")
    recap = _p(arts, "article_role", "market_recap")
    core = 1.0 - recap                                                                              # 시황이 아닐 확률
    impact = s * strength * rel                                                                     # 영향 점수
    w = rel * strength * active * core                                                              # 집계 가중치(시황 제외)
    out = pd.DataFrame({
        "t_ns": pd.to_datetime(arts["available_at_kst"], utc=True).dt.as_unit("ns").astype("int64").to_numpy(),
        "s": s, "strength": strength, "rel": rel, "active": active, "recap": recap, "core": core,
        "impact": impact, "w": w, "wc": core,                                                       # wc: 시황 제외 단순 가중(기사 수 세기용)
        "pos": _p(arts, "impact_direction", "positive"), "neg": _p(arts, "impact_direction", "negative"),
        "mix": _p(arts, "impact_direction", "mixed"),
        "kor": _p(arts, "origin_region", "korea"), "usa": _p(arts, "origin_region", "usa"),
        "surp": _p(arts, "surprise_vs_expectation", "above") - _p(arts, "surprise_vs_expectation", "below"),
        "unexp": _p(arts, "surprise_vs_expectation", "unexpected"),
    }, index=arts.index)
    for f_ in CONF_FIELDS:                                                                           # 필드별 신뢰도(없으면 0.5)
        out[f"cf_{f_}"] = pd.to_numeric(arts[f"conf_{f_}"], errors="coerce").fillna(0.5).to_numpy() if f"conf_{f_}" in arts.columns else 0.5
    for g, opts in SECTOR_GROUPS.items():
        out[f"sec_{g}"] = _group_prob(arts, "primary_sector", opts)
    out["sec_기타"] = 1 - sum(out[f"sec_{g}"] for g in SECTOR_GROUPS)
    for g, opts in CHANNEL_GROUPS.items():
        out[f"ch_{g}"] = _group_prob(arts, "primary_channel", opts)
    out["ch_기타"] = 1 - sum(out[f"ch_{g}"] for g in CHANNEL_GROUPS)
    for o in ORIGIN_GROUPS:
        out[f"or_{o}"] = _p(arts, "origin_region", o)
    out["or_other"] = 1 - sum(out[f"or_{o}"] for o in ORIGIN_GROUPS)
    for o in ROLE_GROUPS:
        out[f"role_{o}"] = _p(arts, "article_role", o)
    for o in STATUS_GROUPS:
        out[f"st_{o}"] = _p(arts, "event_status", o)
    for g, opts in EVENT_GROUPS.items():
        out[f"ev_{g}"] = _group_prob(arts, "event_type", opts)
    # P3(라벨 기반): 순서형은 수치, 무순서는 원핫
    lab = arts["impact_direction"].map({"positive": 1.0, "negative": -1.0}).fillna(0.0).to_numpy()
    lstr = arts["impact_strength"].map(STRENGTH_SCORE).fillna(0.0).to_numpy()
    out["l_dir"] = lab
    out["l_str"] = lstr
    out["l_rel"] = pd.to_numeric(arts["kospi_relevance"], errors="coerce").fillna(0.0).to_numpy()
    out["l_recap"] = (arts["article_role"] == "market_recap").astype(float).to_numpy()
    out["l_active"] = (arts["active_at_target"] == "active").astype(float).to_numpy()
    for g, opts in SECTOR_GROUPS.items():
        out[f"l_sec_{g}"] = arts["primary_sector"].isin(opts).astype(float).to_numpy()
    for g, opts in CHANNEL_GROUPS.items():
        out[f"l_ch_{g}"] = arts["primary_channel"].isin(opts).astype(float).to_numpy()
    assert len(out) == n
    return out


def window_bounds(prediction_at, prev_trading_day, window: str):
    """대상일별 (시작, 끝) KST 시각. prediction_at: UTC 또는 tz-aware, prev_trading_day: 직전 KOSPI 거래일(날짜)."""
    end = pd.DatetimeIndex(prediction_at).tz_convert(KST)
    if window == "W1":
        start = pd.DatetimeIndex(prev_trading_day).tz_localize(KST) + pd.Timedelta(hours=15, minutes=30)
    elif window == "W2":
        start = end - pd.Timedelta(days=1)
    else:
        raise ValueError(window)
    return start, end


def _wmean(x: np.ndarray, w: np.ndarray) -> float:
    sw = w.sum()
    return float((x * w).sum() / sw) if sw > 1e-12 else 0.0


def _day_features(a: pd.DataFrame, hours: float) -> dict:
    """기사 묶음 하나(= 대상일 하나의 window) -> 변수 dict."""
    n = len(a)
    f: dict[str, float] = {"m_n_articles": float(n), "m_window_hours": hours}
    if n == 0:
        for k in T1_ZERO + T2_NAMES + T3_NAMES + C1_NAMES:
            f[k] = 0.0
        f["t1_no_news"] = 1.0
        for k in P3_NAMES:
            f[k] = 0.0
        return f
    w, s, imp = a["w"].to_numpy(), a["s"].to_numpy(), a["impact"].to_numpy()
    wc = a["wc"].to_numpy()
    f["t1_no_news"] = 0.0
    f["t1_impact"] = _wmean(imp, w)                                    # 가중 평균 영향 점수(시황 제외)
    f["t1_impact_std"] = float(np.sqrt(_wmean((imp - f["t1_impact"]) ** 2, w)))
    f["t1_pos_share"] = _wmean(a["pos"].to_numpy(), w)
    f["t1_neg_share"] = _wmean(a["neg"].to_numpy(), w)
    f["t1_mix_share"] = _wmean(a["mix"].to_numpy(), w)
    f["t1_strength"] = _wmean(a["strength"].to_numpy(), wc)            # 시황 제외 평균 강도
    f["t1_log_n"] = float(np.log1p(wc.sum()))                          # 시황 제외 유효 기사 수
    f["t1_recap_share"] = float(a["recap"].mean())
    f["t1_log_recap_n"] = float(np.log1p(a["recap"].sum()))
    f["t1_impact_kor"] = _wmean(imp, w * a["kor"].to_numpy())
    f["t1_impact_usa"] = _wmean(imp, w * a["usa"].to_numpy())
    f["t1_surprise"] = _wmean(a["surp"].to_numpy(), w)
    f["t1_unexpected"] = _wmean(a["unexp"].to_numpy(), w)
    for f_ in CONF_FIELDS:
        f[f"c1_conf_{f_}"] = _wmean(a[f"cf_{f_}"].to_numpy(), wc)
    f["c1_impact_cw"] = _wmean(imp, w * a["cf_impact_direction"].to_numpy())                    # 방향 신뢰도 가중 영향 점수
    # 범주별 영향 점수: Σ(가중치 x 영향 점수 x 범주 확률) / Σ가중치
    for g in list(SECTOR_GROUPS) + ["기타"]:
        f[f"t2_sec_{g}"] = float((w * imp * a[f"sec_{g}"].to_numpy()).sum() / max(w.sum(), 1e-12))
    for g in list(CHANNEL_GROUPS) + ["기타"]:
        f[f"t2_ch_{g}"] = float((w * imp * a[f"ch_{g}"].to_numpy()).sum() / max(w.sum(), 1e-12))
    for o in ORIGIN_GROUPS + ["other"]:
        f[f"t2_or_{o}"] = float((w * imp * a[f"or_{o}"].to_numpy()).sum() / max(w.sum(), 1e-12))
    for o in ROLE_GROUPS:
        f[f"t3_role_{o}"] = _wmean(a[f"role_{o}"].to_numpy(), wc)
    for o in STATUS_GROUPS:
        f[f"t3_st_{o}"] = _wmean(a[f"st_{o}"].to_numpy(), wc)
    for g in EVENT_GROUPS:
        f[f"t3_ev_{g}"] = _wmean(a[f"ev_{g}"].to_numpy(), wc)
    # P3 (라벨 기반): 시황 제외 라벨 평균과 원핫 비율
    core = a["l_recap"].to_numpy() < 0.5
    if core.any():
        f["p3_dir"] = float(a.loc[core, "l_dir"].mean())
        f["p3_str"] = float(a.loc[core, "l_str"].mean())
        f["p3_dir_x_str"] = float((a.loc[core, "l_dir"] * a.loc[core, "l_str"] * a.loc[core, "l_rel"]).mean())
        f["p3_active"] = float(a.loc[core, "l_active"].mean())
        for g in SECTOR_GROUPS:
            f[f"p3_sec_{g}"] = float(a.loc[core, f"l_sec_{g}"].mean())
        for g in CHANNEL_GROUPS:
            f[f"p3_ch_{g}"] = float(a.loc[core, f"l_ch_{g}"].mean())
    else:
        for k in P3_NAMES:
            f.setdefault(k, 0.0)
    f["p3_recap_share"] = float(a["l_recap"].mean())
    f["p3_log_n"] = float(np.log1p(core.sum()))
    return f


T1_ZERO = ["t1_impact", "t1_impact_std", "t1_pos_share", "t1_neg_share", "t1_mix_share", "t1_strength", "t1_log_n",
           "t1_recap_share", "t1_log_recap_n", "t1_impact_kor", "t1_impact_usa", "t1_surprise", "t1_unexpected"]
T2_NAMES = ([f"t2_sec_{g}" for g in list(SECTOR_GROUPS) + ["기타"]] + [f"t2_ch_{g}" for g in list(CHANNEL_GROUPS) + ["기타"]]
            + [f"t2_or_{o}" for o in ORIGIN_GROUPS + ["other"]])
T3_NAMES = ([f"t3_role_{o}" for o in ROLE_GROUPS] + [f"t3_st_{o}" for o in STATUS_GROUPS] + [f"t3_ev_{g}" for g in EVENT_GROUPS])
C1_NAMES = [f"c1_conf_{f_}" for f_ in CONF_FIELDS] + ["c1_impact_cw"]
P3_NAMES = (["p3_dir", "p3_str", "p3_dir_x_str", "p3_active", "p3_recap_share", "p3_log_n"]
            + [f"p3_sec_{g}" for g in SECTOR_GROUPS] + [f"p3_ch_{g}" for g in CHANNEL_GROUPS])


def daily_features(arts: pd.DataFrame, prediction_at, prev_trading_day, window: str = "W1",
                   p4: bool = True, scores: pd.DataFrame | None = None) -> pd.DataFrame:
    """기사 표 + 대상일별 예측 시각/직전 거래일 -> 대상일 x 변수 표(인덱스 = prediction_at 과 같은 순서의 대상일은 호출자가 붙인다).

    prediction_at, prev_trading_day 는 같은 길이의 배열(대상일 순서). 반환 행 순서도 같다.
    scores: 이미 계산한 article_scores 결과(window를 바꿔 반복 호출할 때 재사용).
    """
    sc = scores if scores is not None else article_scores(arts)
    order = np.argsort(sc["t_ns"].to_numpy(), kind="stable")
    sc = sc.iloc[order].reset_index(drop=True)
    t_av = sc["t_ns"].to_numpy()
    start, end = window_bounds(prediction_at, prev_trading_day, window)
    lo = np.searchsorted(t_av, start.as_unit("ns").asi8, side="left")
    hi = np.searchsorted(t_av, end.as_unit("ns").asi8, side="left")                   # 예측 시각 이후(같은 시각 포함) 기사는 제외
    rows = []
    for l, h, st, en in zip(lo, hi, start, end):
        rows.append(_day_features(sc.iloc[l:h], (en - st).total_seconds() / 3600))
    out = pd.DataFrame(rows)
    if p4:
        prob_cols = [c for c in arts.columns if c.startswith("prob_")]
        parr = arts[prob_cols].to_numpy(float)[order]
        cum = np.vstack([np.zeros((1, parr.shape[1])), np.cumsum(parr, axis=0)])
        n = (hi - lo).astype(float)
        mean = np.where(n[:, None] > 0, (cum[hi] - cum[lo]) / np.maximum(n[:, None], 1), 0.0)
        out = pd.concat([out, pd.DataFrame(mean, columns=[f"p4_{c[5:]}" for c in prob_cols])], axis=1)
    return out.fillna(0.0)


def add_ma3(df: pd.DataFrame, cols: list[str] | None = None) -> pd.DataFrame:
    """대상일 순서로 정렬된 표에 최근 3행(오늘 포함) 평균 열 `<col>_ma3`를 덧붙인다(핵심 t1 열 기본)."""
    cols = cols or [c for c in df.columns if c.startswith("t1_") and c != "t1_no_news"]
    ma = df[cols].rolling(3, min_periods=1).mean().add_suffix("_ma3")
    return pd.concat([df, ma], axis=1)


def add_accum(df: pd.DataFrame, kind: str, cols: list[str] | None = None) -> pd.DataFrame:
    """누적 window 열을 덧붙인다. kind: 'ma<N>'(최근 N행 단순평균, 오늘 포함) 또는 'ew<H>'(반감기 H행 지수 감쇠 평균). 열 이름 `<col>_<kind>`.

    행은 대상일 순서이며 각 값은 그 날 이전(오늘 08:30까지) 뉴스만 담으므로 미래 정보는 들어가지 않는다.
    """
    cols = cols or [c for c in df.columns if c.startswith("t1_") and c != "t1_no_news" and not re.search(ACCUM_RE, c)]
    n = int(kind[2:])
    roll = df[cols].rolling(n, min_periods=1).mean() if kind.startswith("ma") else df[cols].ewm(halflife=n, adjust=False).mean()
    return pd.concat([df, roll.add_suffix(f"_{kind}")], axis=1)


ACCUM_RE = r"_(ma|ew)\d+$"


def select_columns(df: pd.DataFrame, preproc: str, ma3: bool | str = False) -> list[str]:
    """전처리 묶음 이름 -> 입력 열. P1=t1, P2=t1+t2+t3, P3=p3, P4=p4.

    ma3=True 면 `_ma3` 열을, 문자열(예: 'ma5','ew3')이면 그 누적 열을 포함한다. 그 외 누적 열은 항상 제외.
    """
    pre = {"P1": ("t1_",), "P2": ("t1_", "t2_", "t3_"), "P3": ("p3_",), "P4": ("p4_",)}[preproc]
    suf = "_ma3" if ma3 is True else (f"_{ma3}" if ma3 else None)
    return [c for c in df.columns if c.startswith(pre) and (not re.search(ACCUM_RE, c) or (suf and c.endswith(suf)))]


def tier_of(col: str) -> int:
    """열 이름 -> 변수 묶음 번호(1,2,3). 그 외(p3·p4)는 1로 취급(γ 적용 안 함)."""
    return 2 if col.startswith("t2_") else 3 if col.startswith("t3_") else 1


def fit_scaler(train: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """학습 구간 평균·표준편차(표준편차 0이면 1). 평가 구간 통계는 쓰지 않는다."""
    mu = train.mean()
    sd = train.std(ddof=0).replace(0, 1.0).fillna(1.0)
    return mu.fillna(0.0), sd


def apply_scaler(df: pd.DataFrame, mu: pd.Series, sd: pd.Series) -> pd.DataFrame:
    return ((df - mu) / sd).fillna(0.0)
