"""[실사용 모듈] 주별 뉴스 변수 — DB 기사 점수·제목으로 1차 학습본이 쓰는 뉴스 변수를 기준일마다 만들어 정형 변수 표에 붙인다(새 LLM 호출 없음).

변수(실험과 같은 계산, 원본: experiments/5/kw/news.py·test/news_td5_20261117/news_feats.py·05_topics.py·04_keywords.py·common.py):
  NEWS_w<k>_*  176  예측 시각 앞 1·3·5·10 거래일 기사 점수 집계(kw.news_agg = 일별 news_agg 복사본, 시황 기사는 영향 점수에서 뺌)
  CHG_*         13  1거래일 핵심 점수 − 직전 20거래일 평균
  TOPIC_*      130  주제 26개의 최근 1·5·20 거래일 기사 비중, 5거래일 긍정·부정 몫
  KWS_*        500  키워드 500개(저장 어휘 wk_news_vocab.json 앞 500개)의 최근 5거래일 기사 비중(시황 제외, 제목 + 요약 앞 300자 형태소)
  KWR_<창>:<키워드>  학습본이 요구하는 키워드 급증 조건(0/1): 최근 k 거래일 비중 > 직전 250일 평균 + 1 표준편차(오늘 미포함)
1거래일 창: W0 = [전 거래일 16:00, b 16:00), W2 = [b 08:30, 다음 거래일 08:30). 마지막 기준일의 W2 창 끝은 prediction_at.
계산 범위: 최근 LOOKBACK 기준일(급증 조건의 250일 창 + 여유). 그 앞 행은 비운다(학습본은 최근 행만 예측에 씀).
원천(DB 읽기 전용): dp.news_feature_orig(기사 점수·확률), dp.news_stock_article(제목·요약). 로컬 캐시 없음(2026-11-24).
  기사 점수는 실행마다 DB 에서 계산한다(이번 실행 메모리에만 둠). 형태소는 저장소 테이블 kospi5_mlops_news_token(어휘 안 단어만)에서 읽고,
  없는 기사만 Kiwi 로 분석한다. --write 에서만 DB 에 추가하고 시험 실행은 메모리에서 사용한다.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import wk_paths as P
from kw import news_agg as NA

TOKENS = "kospi5_mlops_news_token"
_MEM: dict = {}                      # 이번 실행에 받은 연도별 점수·형태소(메모리만)
VOCAB = Path(__file__).resolve().parent / "wk_news_vocab.json"
KST = "Asia/Seoul"
WINDOWS = (1, 3, 5, 10)
LOOKBACK = 600                       # 기준일 수(약 2.4년): 급증 조건 250일 + min 60 + 20일 창보다 넉넉히
ASCII = {"시장전체": "mkt", "반도체": "semi", "금융": "fin", "기타": "etc", "금리통화": "rate", "환율": "fx", "수급": "flow",
         "실적": "earn", "지정학": "geo", "통화정책": "monpol", "경제지표": "macro", "정책": "policy", "기업": "corp", "산업": "ind"}
COLS = ("article_key, available_at_kst, kospi_relevance, article_role, event_type, event_status, origin_region, primary_sector, "
        "primary_channel, surprise_vs_expectation, impact_direction, impact_strength, active_at_target, conf_kospi_relevance, "
        "conf_article_role, conf_event_type, conf_event_status, conf_origin_region, conf_primary_sector, conf_primary_channel, "
        "conf_surprise_vs_expectation, conf_impact_direction, conf_impact_strength, conf_active_at_target, probs")
# extracted_at is a PostgreSQL timestamp without time zone recorded by the KST writer.
AS_OF_KST = "(CAST(:as_of AS timestamptz) AT TIME ZONE 'Asia/Seoul')"
EXTRACTED_BY = "(CAST(:as_of AS timestamptz) IS NULL OR {column} <= " + AS_OF_KST + ")"
AVAILABLE_BY = "(CAST(:as_of AS timestamptz) IS NULL OR {column} < " + AS_OF_KST + ")"
SCORE_SQL = (
    f"select {COLS} from dp.news_feature_orig where available_at_kst >= :s and available_at_kst < :e "
    f"and {EXTRACTED_BY.format(column='extracted_at')} and {AVAILABLE_BY.format(column='available_at_kst')} "
    "order by available_at_kst, article_key"
)
TOKEN_FEATURE_SQL = f"""select f.article_key, f.available_at_kst from dp.news_feature_orig f
    where f.probs is not null and f.article_role is distinct from 'market_recap'
      and f.available_at_kst >= :s and f.available_at_kst < :e
      and {EXTRACTED_BY.format(column="f.extracted_at")} and {AVAILABLE_BY.format(column="f.available_at_kst")}
      and not exists (
          select 1 from dp.news_stock_article a
          where a.article_key = f.article_key and a.modified_at >= CAST(:as_of AS timestamptz)
      )
    order by f.available_at_kst, f.article_key"""
TOKEN_ARTICLE_SQL = """select article_key, title, summary from dp.news_stock_article where article_key = any(:k)
    and (CAST(:as_of AS timestamptz) is null or modified_at is null or modified_at < CAST(:as_of AS timestamptz))"""
TOPIC_PFX = ("sec_", "ch_", "ev_", "or_", "st_")
TAGS = {"NNG", "NNP", "XR", "SL"}
N_SHARE, N_PAIR = 500, 200


# ------------------------------------------------------------------ DB·캐시
def _read(sql, params):
    from sqlalchemy import text
    from db.connection import get_engine
    with get_engine().connect() as c:
        c.execute(text("SET TRANSACTION READ ONLY"))
        return pd.read_sql(text(sql), c, params=params)


def clear_memory():
    _MEM.clear()


def _fresh(year, today):
    return year >= today.year or (today.month == 1 and year == today.year - 1)


def scores(first_year, last_year, *, as_of=None):
    """기사 점수(kw.news_agg.article_scores) — 연도별로 DB 에서 받아 계산(이번 실행 안에서는 올해만 다시). t_ns = UTC ns, 시간순."""
    today, out = pd.Timestamp.today(), []
    for y in range(first_year, last_year + 1):
        if ("sc", y, as_of) in _MEM and not _fresh(y, today):
            out.append(_MEM[("sc", y, as_of)])
            continue
        a = _read(SCORE_SQL, {"s": f"{y}-01-01", "e": f"{y + 1}-01-01", "as_of": as_of})
        a["available_at_kst"] = pd.to_datetime(a["available_at_kst"]).dt.tz_localize(KST)
        flat = pd.DataFrame([{f"prob_{f}__{o}": v for f, opts in (p_ or {}).items() for o, v in opts.items()} for p_ in a["probs"]], index=a.index)
        a = pd.concat([a.drop(columns="probs"), flat], axis=1)
        sc = NA.article_scores(a)
        sc = sc[[c for c in sc.columns if not c.startswith("l_")] + [c for c in sc.columns if c.startswith("l_")]]
        sc[[c for c in sc.columns if c != "t_ns"]] = sc[[c for c in sc.columns if c != "t_ns"]].astype("float32")
        _MEM[("sc", y, as_of)] = sc
        out.append(sc)
    return pd.concat(out, ignore_index=True).sort_values("t_ns", kind="stable").reset_index(drop=True)


def _vocab() -> set:
    return set(json.loads(VOCAB.read_text(encoding="utf-8")))


def tokens(first_year, last_year, refresh=True, *, write=False, as_of=None):
    """기사 형태소(시황 제외, 제목 + 요약 앞 300자, 명사·어근·외래어 2자 이상, 기사 안 중복 제거, 어휘 안 단어만) — 연도별.
    기사 목록·시각은 news_feature_orig 에서, 형태소는 저장소 테이블에서 읽고 없는 기사만 분석해 더한다. refresh=False: 이번 실행에 받은 것이 있으면 그대로."""
    import wk_store
    today, out, kiwi, vocab = pd.Timestamp.today(), [], None, None
    for y in range(first_year, last_year + 1):
        if ("tk", y, as_of) in _MEM and (not refresh or (not write or ("stored", y, as_of) in _MEM) and not _fresh(y, today)):
            out.append(_MEM[("tk", y, as_of)])
            continue
        d = _read(TOKEN_FEATURE_SQL, {"s": f"{y}-01-01", "e": f"{y + 1}-01-01", "as_of": as_of}).drop_duplicates("article_key", keep="last")
        have = wk_store.read_in(TOKENS, "article_key", d.article_key.tolist(), columns=["article_key", "toks"]) if len(d) else pd.DataFrame(columns=["article_key", "toks"])
        new = d[~d.article_key.isin(have.article_key)]
        if len(new):
            keys = new.article_key.tolist()
            t = pd.concat([_read(TOKEN_ARTICLE_SQL,
                                 {"k": keys[i:i + 5000], "as_of": as_of}) for i in range(0, len(keys), 5000)], ignore_index=True)
            t = new[["article_key"]].merge(t, on="article_key", how="inner", validate="one_to_one")
            if len(t) != len(new):
                print(f"[주의] 뉴스 형태소 {y}: 원문을 찾지 못한 {len(new) - len(t)}건은 이후 다시 조회", flush=True)
            if kiwi is None:
                from kiwipiepy import Kiwi
                kiwi, vocab = Kiwi(num_workers=4), _vocab()
            docs = (t.title.fillna("") + " " + t.summary.fillna("").str.slice(0, 300)).tolist()
            toks = [" ".join(sorted({x.form for x in r if x.tag in TAGS and len(x.form) >= 2} & vocab)) for r in kiwi.tokenize(docs)]
            add = pd.DataFrame({"article_key": t.article_key.to_numpy(), "toks": toks})
            if write:
                wk_store.append(TOKENS, add)
                print(f"뉴스 형태소 {y}: 새 기사 {len(add)}건 분석·저장", flush=True)
            have = pd.concat([have, add], ignore_index=True)
        T = d.merge(have, on="article_key", how="inner")
        T["t_ns"] = pd.to_datetime(T.available_at_kst).dt.tz_localize(KST).dt.tz_convert("UTC").dt.as_unit("ns").astype("int64")
        _MEM[("tk", y, as_of)] = T[["article_key", "t_ns", "toks"]]
        if write and len(T) == len(d):
            _MEM[("stored", y, as_of)] = True
        out.append(_MEM[("tk", y, as_of)])
    T = pd.concat(out, ignore_index=True)
    T["t_ns"] = T.t_ns.astype("int64")
    return T.sort_values("t_ns", kind="stable").reset_index(drop=True)


# ------------------------------------------------------------------ 계산
def _name(k, c):
    for ko, en in ASCII.items():
        c = c.replace(ko, en)
    return f"NEWS_w{k}_{c}"


def windows(tp, idx, last_end):
    """기준일마다 1거래일 창 [시작, 끝)의 UTC ns(실험 common.windows 와 같음, W2 마지막 창 끝 = prediction_at)."""
    idx = pd.DatetimeIndex(idx)
    if tp == "W0":
        import timepoints
        tod = timepoints.offset("W0")                                    # time_points.json(2026-11-23)
        lo, hi = pd.DatetimeIndex(np.r_[[idx[0] - pd.offsets.BDay(1)], idx[:-1]]), idx
        f = lambda d: (d + tod).tz_localize(KST).tz_convert("UTC").as_unit("ns").asi8  # noqa: E731
        hi = f(hi)
        end = pd.Timestamp(last_end).tz_convert("UTC").as_unit("ns").value
        hi[-1] = max(hi[-1], end)                                        # 주말·휴일 실행: 마지막 창 끝 = 실행 시각(2026-11-23), 거래일 실행은 같음
        return f(lo), hi
    import timepoints
    tod = timepoints.offset("W2")
    f = lambda d: (d + tod).tz_localize(KST).tz_convert("UTC").as_unit("ns").asi8  # noqa: E731
    hi = np.r_[f(idx[1:]), [pd.Timestamp(last_end).tz_convert("UTC").as_unit("ns").value]]
    return f(idx), hi


def roll_k(X, k):
    return X.rolling(k, min_periods=1).sum()


def spike(X, win=250, z=1.0):
    m, s = X.shift(1).rolling(win, min_periods=60).mean(), X.shift(1).rolling(win, min_periods=60).std()
    return ((X > m + z * s) & (X > 0)).astype(np.int8)


def wsum(t_ns, V, lo, hi):
    V = np.asarray(V, float)
    if V.ndim == 1:
        V = V[:, None]
    cs = np.vstack([np.zeros((1, V.shape[1])), np.cumsum(V, axis=0)])
    a, b = np.searchsorted(t_ns, lo, "left"), np.searchsorted(t_ns, hi, "left")
    return cs[b] - cs[a]


def news_windows(idx, pred_at, kospi_days, sc):
    """NEWS_* (실험 kw.news.features_5 와 같음)."""
    t = sc["t_ns"].to_numpy()
    end = pd.DatetimeIndex(pred_at).tz_convert(KST)
    cal = pd.DatetimeIndex(kospi_days).sort_values()
    day = end.tz_localize(None).normalize()
    tod = end.tz_localize(None) - day
    pos = cal.searchsorted(day, side="left")
    hi = np.searchsorted(t, end.as_unit("ns").asi8, side="left")
    keep = NA.T1_ZERO + ["t1_no_news"] + NA.T2_NAMES + NA.T3_NAMES
    out = []
    for k in WINDOWS:
        sd = pd.DatetimeIndex([cal[p - k] if p - k >= 0 else pd.NaT for p in pos])
        start = (sd + tod).tz_localize(KST)
        lo = np.searchsorted(t, start.as_unit("ns").asi8, side="left")
        rows = [NA._day_features(sc.iloc[l:h], (e - s_).total_seconds() / 3600) for l, h, s_, e in zip(lo, hi, start, end)]
        f = pd.DataFrame(rows, index=pd.DatetimeIndex(idx))[keep]
        f.columns = [_name(k, c) for c in keep]
        out.append(f)
    return pd.concat(out, axis=1).astype(float)


def chg(N):
    c = [x for x in N.columns if x.startswith("NEWS_w1_t1_") and not x.endswith("no_news")]
    return (N[c] - N[c].shift(1).rolling(20, min_periods=10).mean()).fillna(0.0).rename(columns=lambda x: "CHG_" + x[len("NEWS_w1_"):])


def topics(sc, idx, lo, hi):
    tops = [c for c in sc.columns if c.startswith(TOPIC_PFX)]
    w = sc.wc.to_numpy(float)
    t = sc.t_ns.to_numpy()
    V = {"_all": w}
    for c in tops:
        x = w * sc[c].to_numpy(float)
        V[c], V[c + "_pos"], V[c + "_neg"] = x, x * sc.pos.to_numpy(float), x * sc.neg.to_numpy(float)
    keys = list(V)
    S = pd.DataFrame(np.hstack([wsum(t, np.c_[tuple(V[k] for k in keys[j:j + 16])], lo, hi) for j in range(0, len(keys), 16)]), index=idx, columns=keys)
    out = {}
    for k in (1, 5, 20):
        Sk = roll_k(S, k)
        for c in tops:
            out[f"TOPIC_{c}_share_{k}"] = Sk[c] / Sk["_all"].clip(lower=1e-9)
            if k == 5:
                out[f"TOPIC_{c}_pos_{k}"] = Sk[c + "_pos"] / Sk[c].clip(lower=1e-9)
                out[f"TOPIC_{c}_neg_{k}"] = Sk[c + "_neg"] / Sk[c].clip(lower=1e-9)
    F = pd.DataFrame(out).astype("float32")
    F.columns = [_name(0, c).replace("NEWS_w0_", "") for c in F.columns]
    return F


def keywords(T, idx, lo, hi, rules):
    """KWS_ 500 + 요구된 KWR_ 조건. rules = ['KWR_w5:내년+코로나', ...]."""
    import scipy.sparse as sp
    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    vi = {w: i for i, w in enumerate(vocab)}
    need = set(vocab[:N_SHARE]) | {w for r in rules for w in r.split(":", 1)[1].split("+")}
    col = {w: i for i, w in enumerate(sorted(need))}
    ind = [[col[w] for w in s.split() if w in col] for s in T.toks]
    A = sp.csr_matrix((np.ones(sum(map(len, ind)), np.float32), np.concatenate([np.array(i, int) for i in ind] + [np.array([], int)]),
                       np.r_[0, np.cumsum(list(map(len, ind)))]), shape=(len(T), len(col)))
    t = T.t_ns.to_numpy()
    day = np.searchsorted(hi, t, "right")
    ok = (t >= lo[0]) & (day < len(idx))
    M = sp.csr_matrix((np.ones(ok.sum(), np.float32), (day[ok], np.flatnonzero(ok))), shape=(len(idx), len(T)))
    n = pd.Series(np.asarray(M.sum(axis=1)).ravel(), index=idx)
    single = pd.DataFrame((M @ A[:, [col[w] for w in vocab[:N_SHARE]]]).toarray(), index=idx, columns=vocab[:N_SHARE])
    n5 = roll_k(n.to_frame("n"), 5)["n"].clip(lower=1)
    out = [roll_k(single, 5).div(n5, axis=0).add_prefix("KWS_").astype("float32")]
    kr = {}
    for r in rules:
        win, kw_ = r.removeprefix("KWR_").split(":", 1)
        ws = kw_.split("+")
        assert all(w in vi for w in ws), r
        a = np.ones(len(T), bool)
        for w_ in ws:
            a &= A[:, col[w_]].toarray().ravel() > 0
        k = int(win[1:])
        cnt = pd.Series(M @ a.astype(np.float32), index=idx)
        share = roll_k(cnt.to_frame("c"), k)["c"] / roll_k(n.to_frame("n"), k)["n"].clip(lower=1)
        kr[r] = spike(share.to_frame("s"), z=1.0)["s"].astype(float)
    if kr:
        out.append(pd.DataFrame(kr, index=idx))
    return pd.concat(out, axis=1)


def window_articles(tp: str, b, X: pd.DataFrame, k: int = 5) -> tuple[pd.DataFrame, int]:
    """기준일 b 의 키워드 변수(KWS_, 최근 k 거래일 창)에 들어간 기사 — keywords() 와 같은 창·같은 형태소 캐시(시황 제외).
    반환 (기사 표[article_key, t_ns, toks], 창 안 기사 수 n). KWS_<단어> = 그 단어가 나온 기사 수 / n (wk_shap 의 기사별 기여에 씀)."""
    idx = pd.DatetimeIndex(X.index).sort_values()
    b = pd.Timestamp(b)
    sub = idx[idx <= b][-k:]
    pat = pd.DatetimeIndex(X.loc[sub, "prediction_at"])
    lo, hi = windows(tp, sub, pat[-1])
    import timepoints
    cutoff = timepoints.news_cutoff(tp, pat[-1])
    T = tokens(sub[0].year - (1 if sub[0].month == 1 else 0), max(pat.max().year, b.year),
               refresh=False, as_of=cutoff)
    t = T.t_ns.to_numpy()
    day = np.searchsorted(hi, t, "right")
    A = T[(t >= lo[0]) & (day < len(sub))].reset_index(drop=True)
    return A, len(A)


def rules_needed(tp):
    """이 시점 학습본(챔피언·등록된 챌린저)이 요구하는 KWR_ 조건 이름."""
    import wk_models
    out = []
    for o in ("cls", "reg"):
        for role in wk_models.ROLES:
            try:
                m = wk_models.load(f"{tp}_{o}", role)
            except Exception:                                            # 학습본 형식 오류는 예측 단계에서 알린다
                m = None
            if m:
                out += [f for f in m["features"] if f.startswith("KWR_") and f not in out]
    return out


def build(tp: str, X: pd.DataFrame, lookback: int = LOOKBACK, rules: list | None = None, *, write=False, as_of=None) -> pd.DataFrame:
    """정형 변수 표 X(index = 기준일, prediction_at 열)의 최근 lookback 기준일에 뉴스 변수를 만든다. rules = KWR_ 조건 이름(None 이면 학습본에서 읽음)."""
    idx = pd.DatetimeIndex(X.index).sort_values()
    sub = idx[-lookback:]
    pat = pd.DatetimeIndex(X.loc[sub, "prediction_at"])
    y0, y1 = sub[0].year - (1 if sub[0].month == 1 else 0), max(pat.max().year, sub[-1].year)
    sc = scores(y0, y1, as_of=as_of)
    N = news_windows(sub, pat, idx, sc)
    lo, hi = windows(tp, sub, pat[-1])
    T = tokens(y0, y1, write=write, as_of=as_of)
    return pd.concat([N, chg(N), topics(sc, sub, lo, hi), keywords(T, sub, lo, hi, rules_needed(tp) if rules is None else rules)], axis=1)


def attach(tp: str, X: pd.DataFrame, *, write=False, as_of=None) -> pd.DataFrame:
    """X 에 뉴스 변수를 붙인다(같은 이름 열은 뉴스 값으로 바꿈). 최근 LOOKBACK 기준일 앞 행의 뉴스 열은 비어 있다.
    기사 수는 있는 그대로 반영한다(0건이면 0건 — 기사 없음 표시와 0 값, 학습 때와 같음).
    NEWS_OK 열: 뉴스 변수를 만들었으면 1. DB 읽기·계산이 실패하면 뉴스 열 없이 NEWS_OK = 0 으로 돌려준다
    (predict.py 가 이 날은 학습본의 정형만 모델(fallback)로 예측한다)."""
    try:
        Nw = build(tp, X, write=write, as_of=as_of)
    except Exception as ex:                                                   # 뉴스 원천 장애: 예측을 멈추지 않고 정형만으로
        print(f"[주의] 뉴스 변수를 만들지 못함({type(ex).__name__}: {str(ex)[:200]}) — 정형만 모델로 예측", flush=True)
        return X.drop(columns=[c for c in X if c.startswith(("NEWS_", "CHG_", "TOPIC_", "KWS_", "KWR_"))]).assign(NEWS_OK=0)
    Nw["NEWS_OK"] = 1
    return pd.concat([X.drop(columns=[c for c in Nw.columns if c in X.columns]), Nw], axis=1).assign(NEWS_OK=lambda d: d.NEWS_OK.fillna(0).astype(int))
