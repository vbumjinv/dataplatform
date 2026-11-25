"""[실사용 모듈] 주별 SHAP — 기준일 b 의 운영 예측(방향·수익률)을 변수 묶음별 기여(1단계)와 큰 묶음 안 변수별 기여(2단계)로 나눈다.

주별 모델은 구성 모델 여러 개 + 결합 규칙(평균·로짓·regime·GRU)이고 변수가 수백 개(뉴스 키워드 500개 등)라, 비슷한 변수끼리 기여가 나뉘는
다중공선성 문제를 피하려고 '묶음'(config/shap_config.json: 미국 증시·달러·코스피 추세·뉴스 분위기 등)을 한 선수로 보는 Shapley 값을 계산한다.
  · 설명 대상 = 서비스가 실제로 내는 최종 결합 예측(wk_composite.combine_parts). 방향 = 상승 확률의 로짓(위·아래로 민 크기가 대칭, 더하기 가능),
    수익률 = K1 적용 전 결합 수익률(K1 부호 바꿈은 규칙이라 기여에 섞지 않고 k1_flipped 로 따로 남김, 일별과 같음).
  · 배경 = b 직전 1,000 기준일(약 4년)에서 5행마다 1행(200행) → 기여는 '최근 4년 평소 상태 대비 이 묶음이 어느 쪽으로 밀었나'.
  · 1단계: 묶음 순서 순열(대칭 쌍, n_perm 64개) 위에서 앞 묶음부터 b 값으로 바꿔 가며 평균 출력 변화 = 묶음 기여. 방향은 같은 계산으로 확률 단위 기여(shap_prob)도 낸다.
    기준값 + 기여 합 = 예측(로짓·확률 모두, 맞지 않으면 멈춤).
  · 2단계: 기여 절댓값이 큰 detail_groups 개 묶음만, 그 묶음 안 변수(하나만 b 값으로 바꿨을 때 출력 변화가 큰 30개)를 순열로 나눔 —
    다른 묶음이 b 값일 때와 배경일 때 두 경우의 평균(묶음 Shapley 와 맞춤, Owen 값 근사).
    항목마다 쉬운 이름(wk_labels)·b 값·배경 평균·배경 안 백분위(50 = 평소)를 붙이고, 나머지 변수·상호작용 몫은 '_rest' 로 남긴다(합 = 묶음 기여).
  · 품질 점검(2026-11-23, experiments/5/test/shap_td5_20261123/eval_shap.py): 상위 묶음만 b 값일 때 되찾는 몫 W0 방향 상위 3 = 79%(무작위 61%),
    W2 방향은 묶음끼리 상호작용이 커 상위 3 = 41%(무작위 31%) — W2 방향 해설은 상위 몇 개 묶음만으로 단정하지 않는다.
  · GRU(직전 행이 필요한 구성 모델)는 b 의 실제 창(직전 lookback−1 행)을 두고 마지막 행만 바꿔 계산한다(예측과 같은지 확인).
  · 뉴스 장애(NEWS_OK=0)로 정형만 모델(fallback)로 예측한 날은 그 모델을 설명한다.
  · 해설 보조: 학습본에 있는 묶음별 학습 밖 방향 적중·수준, 그날 상위 3 묶음이 되찾는 몫
    (concentration.top3_recovered, 0.7~1.3 이 아니면 '여러 요인이 함께 작용'), 뉴스 키워드는 경제·시장 용어(config/keyword_display.json)만 이름을 보이고 나머지는 '기타 키워드'.
  · 키워드 → 기사(keyword_articles): 키워드 묶음 기여를 그 단어가 나온 창 안 기사들에 나눠 기사별 기여로 바꾸고, 상승·하락 쪽으로 가장 크게 민 기사 5건씩
    (키·제목·시각·경제 용어·기여)을 낸다 → 해설이 '이런 기사가 많아서'로 말할 수 있게(단어 이름이 의미 없어도 실제 기사로 이어짐).
  · llm_payload(tp, b, X, run 결과): LLM 해설용 '방향 근거' 정리 입력(방향 모델만, 요인 상승 3·하락 2, 확률 %p, 근거는 말로·기사 제목, 판단 성격·허용 숫자).
저장: 예측 행(kospi5_pred_cls·reg, 일별과 같은 열)의 shap_result(json)에 넣는다(--write 일 때, 2026-11-23 별도 테이블 kospi_5_shap 대신).
실행(service_5): python -B wk_shap.py --tp W2 --base 2026-11-18 [--write]      (run_automation.py 가 예측 뒤 부름)
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import json
import re
import time

import numpy as np
import pandas as pd

import wk_paths as P

EPS = 1e-4
import timepoints as _TPR  # noqa: E402
OBJECTIVE = _TPR.objectives()                                         # time_points.json({"cls": "DIR_5D", "reg": "RET_5D"})


def config() -> dict:
    return json.loads((P.CONFIG / "shap_config.json").read_text(encoding="utf-8"))


def _cfg_json(name) -> dict:
    f = P.CONFIG / name
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def shown(feature: str, show: set) -> bool:
    """세부 항목에 이름을 보여 줄 변수인가: 뉴스 키워드(KWS_)는 config/keyword_display.json 의 경제·시장 용어만(언론사·일반어·조각 단어는 '기타 키워드')."""
    return not feature.startswith("KWS_") or feature[4:] in show


def groups_of(features, cfg) -> dict:
    """변수 → 묶음(처음 맞는 규칙). 반환 {묶음: [변수]} (규칙 순서, 빈 묶음 제외)."""
    rules = [(g, re.compile(p)) for g, p in cfg["groups"]]
    out = {g: [] for g, _ in rules}
    for f in features:
        out[next(g for g, r in rules if r.search(f))].append(f)
    return {g: v for g, v in out.items() if v}


def _logit(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def _is_seq(m) -> bool:
    return hasattr(m, "lookback") and hasattr(m, "net_")


def _seq_forward(m, W: np.ndarray) -> np.ndarray:
    """순환 신경망 구성 모델을 창 배열 W(n, lookback, 변수)로 직접 계산(kp.seq_models._forward 와 같은 변환)."""
    import torch
    w = m.scaler_.transform(W.reshape(-1, W.shape[-1])).reshape(W.shape)
    m.net_.eval()
    with torch.no_grad():
        o = m.net_(torch.tensor(w, dtype=torch.float32, device=m.device)).cpu().numpy()
    return 1 / (1 + np.exp(-np.clip(o, -30, 30))) if getattr(m, "task", "reg") == "cls" else o


def seq_rows(X: pd.DataFrame, b) -> pd.DataFrame:
    """순환 신경망 창용: b 까지 직전 40행(lookback 5 보다 충분히 김)."""
    return X.loc[:pd.Timestamp(b)].tail(40)


class Target:
    """기준일 b 의 설명 함수 f(Z) — Z 는 학습본 변수 열을 가진 행들(마지막 행만 바뀐 b 로 본다)."""

    def __init__(self, m: dict, X: pd.DataFrame, b: pd.Timestamp, obj: str):
        self.model, self.features, self.obj = m["model"], list(m["features"]), obj
        self.comps = getattr(self.model, "components", None)
        self.win = {}
        if self.comps:
            for name, c in self.comps.items():
                if _is_seq(c["model"]):                                  # b 의 실제 창(직전 행 + b 행). 학습 대상 달 전 기준일(기간 요약)도 되게 직전 40행으로
                    idx, w = c["model"]._windows(seq_rows(X, b)[c["features"]], history=True)
                    self.win[name] = w[list(idx).index(b)]

    def raw(self, Z: pd.DataFrame) -> np.ndarray:
        if not self.comps:
            m = self.model
            return m.predict_proba(Z[self.features])[:, 1] if self.obj == "cls" else np.asarray(m.predict(Z[self.features]), float)
        parts = {}
        for name, c in self.comps.items():
            A = Z[c["features"]]
            mm = c["model"]
            if name in self.win:
                W = np.repeat(self.win[name][None], len(A), axis=0)
                W[:, -1, :] = A.to_numpy(float)
                parts[name] = _seq_forward(mm, W)
            else:
                parts[name] = mm.predict_proba(A)[:, 1] if self.obj == "cls" and hasattr(mm, "predict_proba") else np.asarray(mm.predict(A), float)
        return np.asarray(self.model.combine_parts(pd.DataFrame(parts, index=Z.index), Z), float)

    def __call__(self, Z: pd.DataFrame) -> np.ndarray:
        v = self.raw(Z)
        return _logit(v) if self.obj == "cls" else v


def shapley(f, x: pd.DataFrame, bg: pd.DataFrame, players: dict, n_perm: int, seed: int, fixed: pd.DataFrame | None = None, spaces=None):
    """선수(이름 → 열 목록) 순열 Shapley. 시작 = 배경 행(fixed 가 있으면 선수 밖 열은 x 값), 순서대로 선수 열을 x 값으로 바꾼다.
    대칭 쌍(순열·역순)으로 분산을 줄인다. spaces = {이름: 원래 출력 → 그 공간 값}(같은 모델 계산으로 여러 공간 기여를 함께, 예: 로짓·확률).
    반환: spaces 없으면 (기여 dict, 시작 평균, 끝 평균), 있으면 {공간: (기여 dict, 시작 평균, 끝 평균)}."""
    names = list(players)
    rng = np.random.default_rng(seed)
    start = bg.copy() if fixed is None else fixed.copy()
    sp = spaces or {"_": lambda v: v}
    r0 = f(start)
    base = {k: float(np.mean(t(r0))) for k, t in sp.items()}
    xv = x.iloc[0]
    phi = {k: dict.fromkeys(names, 0.0) for k in sp}
    orders = []
    for _ in range(max(1, n_perm // 2)):
        o = list(rng.permutation(names))
        orders += [o, o[::-1]]
    n = len(start)
    end = {}
    for o in orders:
        Z, snaps = start.copy(), []
        for g in o:
            Z.loc[:, players[g]] = xv[players[g]].to_numpy()[None, :].repeat(n, 0)
            snaps.append(Z.copy())
        raw = f(pd.concat(snaps, ignore_index=True))
        for k, t in sp.items():
            vals = t(raw).reshape(len(o), n).mean(axis=1)
            prev = base[k]
            for g, v in zip(o, vals):
                phi[k][g] += (v - prev) / len(orders)
                prev = v
            end[k] = float(vals[-1])
    out = {k: (phi[k], base[k], end[k]) for k in sp}
    return out if spaces else out["_"]


def explain(m: dict, X: pd.DataFrame, b, obj: str, cfg: dict | None = None, tp: str | None = None) -> dict:
    cfg = cfg or config()
    b = pd.Timestamp(b).normalize()
    feats = list(m["features"])
    f = Target(m, X, b, obj)
    x = X.loc[[b], feats]
    bg = background(X, b, feats, cfg)
    fx = float(f(x)[0])
    actual = float(f.raw(x)[0])
    import wk_models                                                     # 설명하는 값 = 서비스 예측(predict.py 와 같은 입력)인지
    since = getattr(m["model"], "needs_rows_from", None)
    xin = (X.loc[(X.index >= pd.Timestamp(since)) & (X.index <= b)] if b >= pd.Timestamp(since) else seq_rows(X, b)) if since else x
    served = float(wk_models.predict(m, xin)[-1])
    if abs(served - actual) > 1e-6:
        raise RuntimeError(f"SHAP 설명 함수 값 {actual} 이 서비스 예측 {served} 과 다릅니다.")
    G = groups_of(feats, cfg)
    t0 = time.time()
    spaces = {"logit": _logit, "prob": lambda v: np.clip(v, EPS, 1 - EPS)} if obj == "cls" else {"return": lambda v: v}
    res = shapley(f.raw, x, bg, G, cfg["n_perm"], cfg["seed"], spaces=spaces)
    main = "logit" if obj == "cls" else "return"
    phi, base, end = res[main]
    for k, (ph_, b_, e_) in res.items():                                  # 기준값 + 기여 합 = 예측(일별 검사, 구성 모델 float32 묶음 크기 차이 ~1e-7 허용)
        tgt = fx if k == main else float(spaces[k](np.array([actual]))[0])
        if abs(e_ - tgt) > 1e-5 or abs(b_ + sum(ph_.values()) - tgt) > 1e-5:
            raise RuntimeError(f"SHAP 합이 예측과 다릅니다({k}): base {b_} + {sum(ph_.values())} vs {tgt}")
    from wk_labels import label
    show = set(_cfg_json("keyword_display.json").get("show", []))
    order = sorted(G, key=lambda k: -abs(phi[k]))
    Z = bg.copy()                                                         # 상위 3 묶음만 b 값일 때 되찾는 몫(1 에 가까우면 소수 요인 중심, 작으면 여러 요인 복합)
    for g in order[:3]:
        Z.loc[:, G[g]] = x.iloc[0][G[g]].to_numpy()[None, :].repeat(len(Z), 0)
    top3_rec = (float(np.mean(f(Z))) - base) / (fx - base) if abs(fx - base) > 1e-9 else float("nan")
    top3_abs = sum(abs(phi[g]) for g in order[:3]) / max(sum(abs(v) for v in phi.values()), 1e-12)
    detail, detail_ph = {}, {}
    for g in sorted(G, key=lambda k: -abs(phi[k]))[:cfg["detail_groups"]]:
        cols = G[g]
        fixed = pd.DataFrame(np.repeat(x.to_numpy(float), len(bg), 0), columns=feats, index=bg.index)
        fixed.loc[:, cols] = bg[cols].to_numpy()                          # 다른 묶음 = b 값, 이 묶음 = 배경
        top = pick_detail(f, x, fixed, cols, cfg)
        if not top:
            continue
        pl = {c: [c] for c in top}                                        # 다른 묶음이 b 값일 때와 평소(배경)일 때의 평균(묶음 Shapley 는 두 경우 사이의 평균이라 나머지 몫이 줄어듦)
        ph1, _, _ = shapley(f, x, bg, pl, cfg["detail_n_perm"], cfg["seed"] + 1, fixed=fixed)
        ph2, _, _ = shapley(f, x, bg, pl, cfg["detail_n_perm"], cfg["seed"] + 2)
        ph = {c: 0.5 * (ph1[c] + ph2[c]) for c in top}
        detail_ph[g] = ph
        hidden = [c for c in ph if not shown(c, show)]
        items = sorted([kv for kv in ph.items() if shown(kv[0], show)], key=lambda kv: -abs(kv[1]))[:10]
        detail[g] = [{"feature": c, "label": label(c), "value": float(x.iloc[0][c]), "background_mean": float(bg[c].mean()),
                      "percentile": float((bg[c] < x.iloc[0][c]).mean() * 100 + (bg[c] == x.iloc[0][c]).mean() * 50),   # 배경 안 위치(50 = 평소)
                      "shap": float(v)} for c, v in items]
        if hidden:
            detail[g].append({"feature": "_hidden_keywords", "label": f"기타 키워드 {len(hidden)}개(언론사·일반어 등, 이름 생략)", "value": None,
                              "background_mean": None, "percentile": None, "shap": float(sum(ph[c] for c in hidden))})
        detail[g].append({"feature": "_rest", "label": f"나머지 {len(cols) - len(items) - len(hidden)}개 변수·묶음 안 상호작용", "value": None,
                          "background_mean": None, "percentile": None, "shap": float(phi[g] - sum(d["shap"] for d in detail[g]))})
    out = {"space": "logit" if obj == "cls" else "return", "base": base, "output": fx, "actual": actual,
           "groups": [{"group": g, "shap": float(phi[g]), "n_features": len(G[g]),
                       **({"shap_prob": float(res["prob"][0][g])} if obj == "cls" else {})} for g in sorted(G, key=lambda k: -abs(phi[k]))],
           "detail": detail, "background_rows": len(bg), "sec": round(time.time() - t0, 1),
           "keyword_articles": keyword_articles(tp, b, X, detail_ph, phi, res, obj, bg) if tp else None,
           "concentration": {"top3_recovered": top3_rec, "top3_abs_share": top3_abs,
                             "reading": "소수 요인 중심" if 0.7 <= top3_rec <= 1.3 else "여러 요인이 함께 작용(상위 요인만으로 단정 금지)"}}
    if obj == "cls":
        out["prob"], out["base_prob"] = 1 / (1 + np.exp(-fx)), 1 / (1 + np.exp(-base))
    return out


def keyword_articles(tp, b, X, detail_ph, phi, res, obj, bg, n_top=5) -> dict | None:
    """뉴스 키워드 묶음 기여를 기사 단위로. KWS_<단어> = 창 안 '그 단어가 나온 기사 수 / 기사 수'(wk_news.window_articles 로 재현).
      · 평소(배경 평균)보다 많이 나온 단어: 그 효과는 나온 기사들 때문 → 단어 기여 φ_w 를 그 단어가 나온 기사에 똑같이 나눔(언론사·일반어 단어도 실제 기사로 이어짐).
      · 평소보다 적게 나온 단어: 효과는 '기사가 없어서' → 기사에 돌리지 않고 less_than_usual 로 따로(예: '외환' 기사가 평소보다 적어서 내린 몫).
      각 단어 기여는 한 곳에만 가므로 합이 정확하다. (기여 ÷ 평소 차이로 기사 몫을 내는 선형 분해는 차이가 작은 단어에서 값이 수십 배로 튀어 쓰지 않음, 2026-11-23 시험.)
    세부 계산한 단어(출력 변화 상위 30)만 나누고 나머지(uncovered)는 묶음 기여 − 위 합.
    반환: 상승·하락 쪽 기사 n_top 건씩(키·제목·시각·경제 용어·기여 로짓/확률%p), 평소보다 적게 나온 단어 효과, 몫 합계. 키워드 묶음이 세부 묶음이 아니면 None."""
    g = next((k for k in detail_ph if any(c.startswith("KWS_") for c in detail_ph[k])), None)
    if g is None:
        return None
    import wk_news
    A, n = wk_news.window_articles(tp, b, X)
    if not n:
        return None
    show = set(_cfg_json("keyword_display.json").get("show", []))
    xb = X.loc[pd.Timestamp(b)]
    toks = [set(t.split()) for t in A.toks]
    more, less = {}, []
    for c, v in detail_ph[g].items():
        if not c.startswith("KWS_"):
            continue
        w, usual = c[4:], float(bg[c].mean())
        cnt = sum(w in t for t in toks)
        if float(xb[c]) > usual and cnt:
            more[w] = v / cnt
        else:
            less.append({"keyword": w if w in show else "(기타 키워드)", "value": float(xb[c]), "usual": usual, "shap": float(v)})
    contrib = np.array([sum(more[w] for w in more if w in t) for t in toks])
    hits = [[w for w in more if w in t] for t in toks]
    ratio = (res["prob"][0][g] / phi[g]) if obj == "cls" and abs(phi[g]) > 1e-12 else None   # 묶음의 확률/로짓 비율로 확률 %p 어림
    pick = list(np.argsort(-contrib)[:n_top]) + list(np.argsort(contrib)[:n_top])
    keys = [A.article_key[i] for i in pick]
    titles = {}
    try:                                                                  # 제목(DB 읽기 전용). 실패해도 키·기여는 남김
        t = wk_news._read("select article_key, title from dp.news_stock_article where article_key = any(:k)", {"k": keys})
        titles = dict(zip(t.article_key, t.title))
    except Exception as ex:
        print(f"[주의] 기사 제목 읽기 실패: {ex!r}", flush=True)

    def pp(v):
        return {"shap_prob": float(v * ratio)} if ratio is not None else {}

    def row(i):
        return {"article_key": A.article_key[i], "title": titles.get(A.article_key[i]),
                "available_at_kst": str(pd.Timestamp(int(A.t_ns[i]), tz="UTC").tz_convert("Asia/Seoul"))[:16],
                "keywords": [w for w in sorted(hits[i], key=lambda w: -abs(more[w])) if w in show][:6],
                "hidden_keywords": sum(w not in show for w in hits[i]), "shap": float(contrib[i]), **pp(contrib[i])}
    less_sum = sum(u["shap"] for u in less)
    less = sorted(less, key=lambda u: -abs(u["shap"]))[:8]
    for u in less:
        u.update(pp(u["shap"]))
    art = float(contrib.sum())
    return {"group": g, "window_articles": int(n), "group_shap": float(phi[g]), "articles_shap": art, "less_than_usual_shap": float(less_sum),
            "uncovered_shap": float(phi[g] - art - less_sum),
            "up": [row(i) for i in pick[:n_top] if contrib[i] > 0], "down": [row(i) for i in pick[n_top:] if contrib[i] < 0], "less_than_usual": less}


def background(X: pd.DataFrame, b, feats, cfg) -> pd.DataFrame:
    """배경 = b 직전 background_window 기준일에서 background_step 행마다 1행(약 4년을 고르게 200행). 최근 200행만 쓰면 급등기처럼 국면이 바뀔 때
    '평소' 기준이 함께 움직여 1,000행 결과와 기여가 20~73% 달라졌다(eval_shap.py, 2026-11-23)."""
    prev = X.loc[X.index < pd.Timestamp(b), feats].tail(cfg["background_window"])
    return prev.iloc[::-1].iloc[::cfg["background_step"]].iloc[::-1]       # b 바로 앞 행부터 거꾸로 세어 고름(가장 최근 행 포함)


def pick_detail(f, x, fixed, cols, cfg) -> list:
    """큰 묶음 안 세부 변수: 그 변수 하나만 b 값으로 바꿨을 때 평균 출력이 가장 많이 변하는 detail_max_features 개(변화 0 은 뺌)."""
    if len(cols) <= cfg["detail_max_features"]:
        return list(cols)
    f0 = float(np.mean(f(fixed)))
    xv = x.iloc[0]
    eff = []
    for i in range(0, len(cols), 50):                                    # 메모리: 50개 변수씩 배치
        part = cols[i:i + 50]
        snaps = []
        for c in part:
            Z = fixed.copy()
            Z.loc[:, c] = xv[c]
            snaps.append(Z)
        eff += list(np.abs(f(pd.concat(snaps, ignore_index=True)).reshape(len(part), len(fixed)).mean(1) - f0))
    eff = np.asarray(eff)
    return [cols[i] for i in np.argsort(-eff)[:cfg["detail_max_features"]] if eff[i] > 0]


def model_for(slot: str, X: pd.DataFrame, b) -> dict:
    """predict.py 와 같은 규칙으로 그날 운영 학습본(뉴스 장애면 정형만 fallback)."""
    import wk_models
    m = wk_models.load(slot, "champion")
    news_ok = int(X.loc[pd.Timestamp(b), "NEWS_OK"]) if "NEWS_OK" in X.columns else 1
    if not news_ok and m.get("fallback"):
        m = {**m, "model": m["fallback"]["model"], "features": m["fallback"]["features"], "model_version": m["fallback"]["model_version"]}
    return m


def run(tp: str, b, X: pd.DataFrame, write: bool, *, predictions=None, versions=None, staged=False):
    """W0·W2 한 시점: 방향·수익률 SHAP → 저장(write). K1 부호 바꿈 여부도 남긴다."""
    import wk_data
    import wk_models
    import wk_store
    b = pd.Timestamp(b).normalize()
    cfg = config()
    post = json.loads((P.CONFIG / "v1_postprocess.json").read_text(encoding="utf-8"))
    rows, res = [], {}
    for obj in ("cls", "reg"):
        slot = f"{tp}_{obj}"
        ver = predictions[obj]["model_version"] if predictions else (versions or {}).get(obj)
        m = wk_models.load_version(slot, ver) if ver else model_for(slot, X, b)
        if m is None:
            raise ValueError(f"{slot}: SHAP에 사용할 학습본 {ver or 'champion'}이 없습니다.")
        if predictions:
            row = predictions[obj]
            from math import isclose
            point = X.loc[b]
            for k, v in (row["model_input"] or {}).items():
                if k.startswith("_"):
                    continue
                if k not in point or (pd.notna(point[k]) if v is None else
                                      pd.isna(point[k]) or not isclose(float(point[k]), v, rel_tol=1e-8, abs_tol=1e-12)):
                    raise ValueError(f"{slot}: 저장된 입력 {k}가 현재 원천과 다릅니다.")
        e = explain(m, X, b, obj, cfg, tp=tp)
        if predictions:
            actual = e["actual"]
            expected = row["yhat_probability"] if obj == "cls" else row["yhat_raw_value"]
            if not isclose(float(actual), float(expected), abs_tol=5.1e-7):
                raise ValueError(f"{slot}: 저장된 예측값과 SHAP 계산의 예측값이 다릅니다.")
        k1 = post.get(slot, {}).get("k1")
        flipped = None
        if obj == "reg" and k1:                                            # 최종 수익률 부호 = 방향 확률 기준(K1)
            p = res["cls"]["prob"]
            flipped = bool(np.sign(e["actual"]) != (1.0 if p >= k1["threshold"] else -1.0))
        rel = m.get("shap_reliability", {})
        for g in e["groups"]:
            r = rel.get(g["group"], {})
            g["oos_dir_hit"], g["oos_level"] = r.get("dir_hit"), r.get("level", "판단 어려움")
        e["model_version"] = wk_models.version(slot, m)
        res[obj] = e
        shap = {"output_space": e["space"], "base_value": e["base"], "output_value": e["output"], "k1_flipped": flipped,
                "background_rows": e["background_rows"], "concentration": e["concentration"], "groups": e["groups"],
                "detail": e["detail"], "keyword_articles": e["keyword_articles"]}
        rows.append((f"kospi5_pred_{obj}", {"target_dd": wk_data.target_day(b).date(), "time_point": tp,
                     "model_version": wk_models.version(slot, m), "prediction_at": pd.Timestamp(X.loc[b, "prediction_at"]).isoformat()},
                     shap))
        print(summary(slot, e, flipped), flush=True)
    if staged:
        return res, {name.rsplit("_", 1)[1]: value for name, _, value in rows}
    from contextlib import nullcontext
    with (wk_store.engine()[0].begin() if write else nullcontext()) as con:
        for name, key, js in rows:
            wk_store.update(name, key, {"shap_result": js}, write, con=con)
    return res


LEVEL_WORD = [(5, "평소보다 매우 낮음"), (25, "평소보다 낮음"), (75, "평소 수준"), (95, "평소보다 높음"), (101, "평소보다 매우 높음")]
SHOW_NAME = {"뉴스 키워드": "뉴스 키워드 흐름(기사 내용)"}


def _level(pct):
    return next(w for t, w in LEVEL_WORD if pct < t)


def _pp(v):
    return f"{v * 100:+.1f}%p"


def llm_payload(tp: str, b, X: pd.DataFrame, res: dict, max_up=3, max_down=2, min_pp=0.003) -> dict:
    """LLM 해설용 '방향 근거' 정리 입력 — SHAP 원본 대신 말로 바꾼 짧은 재료만(해설이 숫자·요인을 지어내거나 인과를 단정하지 않게).
    res = run() 반환({"cls": 방향 결과, "reg": 수익률 결과}). 규칙(2026-11-23):
      · 방향은 방향 모델 SHAP 만으로(최종 수익률 부호도 K1 로 방향 모델이 정함). 수익률은 80% 범위·평소 대비 폭·급변기 보정 여부만.
      · 요인 = 묶음, 상승 쪽 최대 max_up·하락 쪽 최대 max_down(|확률 기여| ≥ min_pp), 나머지는 '기타 요인' 합. 숫자는 확률 %p 하나(로짓·z점수·원값 없음).
      · 근거: 세부 변수는 '평소보다 매우 낮음/낮음/평소 수준/높음/매우 높음'(배경 백분위)으로, 뉴스 키워드는 기사 제목(keyword_articles)과
        '평소보다 적게 나온 ○○ 기사'로. 이름을 숨긴 키워드·나머지 몫은 넘기지 않는다.
      · 판단 성격 = 상위 3 묶음 되찾는 몫으로 '소수 요인 중심'/'여러 요인이 함께 작용'. 요인 신뢰도(학습 밖 적중)는 넣지 않는다(사용자 결정 2026-11-23: 이번 예측에 반영된 요인을 그대로 설명).
      · allowed_numbers = 입력에 나온 숫자(해설 검사에 씀)."""
    import wk_data
    import wk_range
    b = pd.Timestamp(b).normalize()
    e = res["cls"]
    p = float(e["prob"])
    post = json.loads((P.CONFIG / "v1_postprocess.json").read_text(encoding="utf-8")).get(f"{tp}_reg", {}).get("k1")
    r = float(res["reg"]["actual"])
    if post:
        r = abs(r) * (1.0 if p >= post["threshold"] else -1.0)
    versions = tuple(res[obj].get("model_version") for obj in ("cls", "reg"))
    d = wk_range.history(tp, b, p, r, versions=versions)
    fb = wk_range.final_bands(tp, d, wk_data.kospi_close().loc[:b])
    w = (fb.hi80 - fb.lo80) * 100
    rank = float((w[w.index < b].tail(500) < w.loc[b]).mean() * 100)
    close = float(wk_data.kospi_close().loc[b])
    lo, hi = float(fb.lo80.loc[b]) * 100, float(fb.hi80.loc[b]) * 100
    ka = e.get("keyword_articles") or {}

    def evidence(g, sign):
        out = []
        if g == "뉴스 키워드" and ka:
            out += [f"기사: {a['title']}" for a in ka.get("up" if sign > 0 else "down", [])[:3] if a.get("title")]
            out += [f"평소보다 적게 나온 '{u['keyword']}' 기사" for u in ka.get("less_than_usual", [])
                    if u["keyword"] != "(기타 키워드)" and np.sign(u["shap"]) == sign][:2]
            return out
        for it in (e["detail"].get(g) or []):
            if it["feature"].startswith("_") or np.sign(it["shap"]) != sign or it["percentile"] is None:
                continue
            out.append(f"{it['label']}: {_level(it['percentile'])}")
            if len(out) == 2:
                break
        return out

    gs = [g for g in e["groups"] if "shap_prob" in g]
    ups = [g for g in sorted(gs, key=lambda g: -g["shap_prob"]) if g["shap_prob"] >= min_pp][:max_up]
    dns = [g for g in sorted(gs, key=lambda g: g["shap_prob"]) if g["shap_prob"] <= -min_pp][:max_down]
    used = {g["group"] for g in ups + dns}

    def item(g, sign):
        return {"factor": SHOW_NAME.get(g["group"], g["group"]), "size": _pp(g["shap_prob"]), "evidence": evidence(g["group"], sign)}
    rest = sum(g["shap_prob"] for g in gs if g["group"] not in used)
    conc = e.get("concentration", {})
    out = {"time_point": tp, "base_date": str(b.date()), "target_date": str(wk_data.target_day(b).date()),
           "prediction": {"direction": "상승" if p >= 0.5 else "하락", "up_prob": f"{p * 100:.1f}%", "usual_up_prob": f"{e['base_prob'] * 100:.1f}%"},
           "range_80": {"low_pct": f"{lo:+.1f}%", "high_pct": f"{hi:+.1f}%", "low_index": int(round(close * (1 + lo / 100))),
                        "high_index": int(round(close * (1 + hi / 100))),
                        "width_level": "매우 넓은 편" if rank >= 90 else "넓은 편" if rank >= 67 else "평소 수준" if rank >= 33 else "좁은 편",
                        "volatile_adjusted": bool(fb.regime.loc[b])},
           "judgement": conc.get("reading", "여러 요인이 함께 작용(상위 요인만으로 단정 금지)"),
           "up_factors": [item(g, 1) for g in ups], "down_factors": [item(g, -1) for g in dns],
           "other_factors_size": _pp(rest),
           "rules": ["'모델이 ~에 기대어 판단했다'로 쓰고 인과로 단정하지 않는다", "입력에 없는 숫자·요인·기사를 쓰지 않는다",
                     "판단 성격이 '여러 요인이 함께 작용'이면 요인을 둘 이상 함께 쓴다"]}
    chk = json.loads(json.dumps({k: v for k, v in out.items() if k != "rules"}, ensure_ascii=False))
    for side in ("up_factors", "down_factors"):                           # 기사 제목 속 숫자는 허용 숫자에서 뺌(해설에 기사 숫자를 옮기지 않게)
        for f_ in chk[side]:
            f_["evidence"] = [x for x in f_["evidence"] if not x.startswith("기사:")]
    nums = re.findall(r"[0-9][0-9,]*(?:[.][0-9]+)?", json.dumps(chk, ensure_ascii=False))
    out["allowed_numbers"] = sorted({float(x.replace(",", "")) for x in nums} | {5.0, 80.0})
    return out


def summary(slot, e, flipped=None) -> str:
    unit = "로짓" if e["space"] == "logit" else "수익률%"
    k = 1 if e["space"] == "logit" else 100
    head = (f"{slot}: 상승 확률 {e['prob']:.3f}(배경 평균 {e['base_prob']:.3f})" if e["space"] == "logit"
            else f"{slot}: K1 전 수익률 {e['output'] * 100:+.2f}%(배경 평균 {e['base'] * 100:+.2f}%)" + (" — K1 로 부호 바뀜" if flipped else ""))
    gs = ", ".join(f"{g['group']} {g['shap'] * k:+.3f}" for g in e["groups"][:6])
    return f"{head} | 묶음 기여({unit}) {gs} | {e['sec']}s"


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    import wk_data
    wk_data.refresh()
    X = wk_data.features(a.tp)                                           # 실행마다 DB 에서(캐시 없음)
    run(a.tp, a.base, X, a.write)


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
