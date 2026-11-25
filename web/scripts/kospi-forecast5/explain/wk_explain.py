"""[실사용 모듈] 주별 LLM 해설 — SHAP 묶음·DB 시장 지표·근거 기사로 입력 JSON 을 만들고 GPT 로 '5거래일 뒤 코스피' 해설을 쓴다.

흐름(run_automation.py w0·w2 가 SHAP·근거 기사 뒤 부름, --llm 일 때만 유료 호출):
  ① 범주: SHAP 묶음을 방향 모델(로짓) |기여| 비중으로 줄 세움(2026-11-23: 수익률 모델 비중 섞기 → 방향 모델만). '업종'·'기타'는 빼고(사용자 결정 2026-11-23),
     뉴스 묶음들은 '뉴스 흐름' 하나로 합침. 상위 4개. effect = 방향 모델 비중 부호, in_both = 수익률 모델에서도 상위 4 안.
     top_explains_little = 그날 상위 3 묶음 되찾는 몫이 0.7~1.3 밖(시점 고정값 대신),
     뉴스 흐름 model_articles = 모델의 키워드 신호가 effect 쪽으로 가장 크게 기댄 기사 제목 2건(wk_shap keyword_articles).
  ② 시장 지표(MARKET): 범주마다 같은 범주의 DB 지표(모델이 안 쓴 것 포함, 예: 미국 증시 = S&P500·나스닥·다우·러셀2000)의 같은 기간 변화.
     기간 = 그 묶음에서 기여가 가장 큰 변수의 창(ret_20d → 20거래일). 예측 시각에 쓸 수 있던 값만(해외 = 날짜 d 가 d+1일 06:00 KST 전,
     국내 = d 16:00 KST 전). 같은 범주 안에서 마지막 날짜가 다른 지표(FRED 지연 등)는 뺀다.
  ③ 기사: wk_news_pick 이 고른 기사(확신 강도별 수)를 연결된 범주에 붙인다. 근거 기사 링크는 코드가 그대로 저장한다.
  ④ GPT(OPENAI_MODEL, 기본 gpt-5.6-sol) → 검사(시작 문구·80% 범위·URL·변수명·입력에 없는 숫자·반대 요인 문장·길이) → 실패면 이유를 붙여 최대 3번,
     그래도 실패하면 운영 로그에 남기고 다음 실행에서 해설을 다시 만든다.
프롬프트: prompts/explain_5_v3.txt(2026-11-23, v1 + model_articles 쓰는 법, 요인 신뢰도는 쓰지 않음(사용자 결정)). 해시 검사 없음 — 파일이 바뀌면 바뀐 대로 쓰고 prompt_version 만 남긴다(사용자 결정 2026-11-23).
다시 실행: 같은 (대상일, 시점, prediction_at) 해설이 DB 에 ok 로 있으면 만들지 않는다(캐시 파일 없음, 2026-11-24).
저장: wk_store 'kospi5_pred_explain'(일별 kospi_pred_explain 과 같은 열, 키 target_dd·time_point·prediction_at, --write 일 때). .env: OPENAI_API_KEY, OPENAI_MODEL.
실행(service_5): python -B wk_explain.py --tp W2 --base 2026-11-18            # 입력 JSON·토큰 추정만(호출 없음)
                     python -B wk_explain.py --tp W2 --base 2026-11-18 --llm [--write]
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import json
import os
import re

import numpy as np
import pandas as pd

import wk_paths as P

PROMPT = P.PROMPTS / "explain_5_v3.txt"
PROMPT_VERSION = "v3"
N_CAT = 4
EXCLUDE = {"업종", "기타"}
LENGTH = (350, 1000)
DISPLAY = {"코스피 당일 가격": "코스피 기준일 움직임", "코스피 추세·낙폭": "코스피 흐름", "미국 신용·방어 ETF": "미국 신용시장",
           "한국 레버리지 ETF(미국 상장)": "미국에 상장된 한국 ETF", "국내 변동성(VKOSPI)": "국내 변동성", "달러·원자재": "달러·환율·원자재"}

# 지표 이름 → (원천, 테이블, 조건, 해외 여부, 금리(%p) 여부)
SERIES = {
    "S&P500": ("yf", "yfinance_sp500", None, True, False), "나스닥": ("fred", "fred_nasdaqcom", None, True, False),
    "다우": ("fred", "fred_djia", None, True, False), "러셀2000": ("yf", "yfinance_rut", None, True, False),
    "필라델피아 반도체지수": ("yf", "yfinance_sox", None, True, False), "어플라이드머티리얼즈": ("yf", "yfinance_amat", None, True, False),
    "VIX": ("yf", "yfinance_vix", None, True, False), "나스닥 변동성지수": ("yf", "yfinance_vxn", None, True, False),
    "미국 하이일드 채권 ETF": ("yf", "yfinance_hyg", None, True, False), "미국 유틸리티 ETF": ("yf", "yfinance_xlu", None, True, False),
    "유럽 STOXX600": ("yf", "yfinance_stoxx", None, True, False), "독일 DAX": ("yf", "yfinance_gdaxi", None, True, False),
    "홍콩 항셍지수": ("yf", "yfinance_hsi", None, True, False),
    "달러지수": ("fred", "fred_dtwexbgs", None, True, False), "원/달러 환율": ("bok", "bok_731y001", "0000001", False, False),
    "국제 유가(WTI)": ("fred", "fred_dcoilwtico", None, True, False), "금 가격": ("yf", "yfinance_gcf", None, True, False),
    "국고채 3년 금리": ("bok", "bok_817y002", "010200000", False, True), "국고채 10년 금리": ("bok", "bok_817y002", "010210000", False, True),
    "한국 3배 레버리지 ETF(KORU)": ("yf", "yfinance_koru", None, True, False),
    "코스피": ("krx", "krx_kospi_dd_trd", "코스피", False, False), "코스피200 변동성지수": ("krx", "krx_drvprod_dd_trd", "코스피 200 변동성지수", False, False),
}
MARKET = {
    "미국 증시": ["S&P500", "나스닥", "다우", "러셀2000"], "미국 반도체": ["필라델피아 반도체지수", "어플라이드머티리얼즈"],
    "미국 변동성": ["VIX", "나스닥 변동성지수"], "미국 신용·방어 ETF": ["미국 하이일드 채권 ETF", "미국 유틸리티 ETF"],
    "유럽·아시아 증시": ["유럽 STOXX600", "독일 DAX", "홍콩 항셍지수"], "달러·원자재": ["달러지수", "원/달러 환율", "국제 유가(WTI)", "금 가격"],
    "국내 금리": ["국고채 3년 금리", "국고채 10년 금리"], "한국 레버리지 ETF(미국 상장)": ["한국 3배 레버리지 ETF(KORU)"],
    "코스피 당일 가격": ["코스피"], "코스피 추세·낙폭": ["코스피"], "국내 변동성(VKOSPI)": ["코스피200 변동성지수"],
}
BACKDROP = [("VIX", 5), ("원/달러 환율", 5), ("국고채 10년 금리", 5), ("코스피", 5)]
DIRECTION = {"positive": "상승 쪽", "negative": "하락 쪽", "mixed": "혼재"}
OPPOSITE = ("반대로 작용", "반대 요인은", "반면에 작용")


# ------------------------------------------------------------------ DB 시장 지표
def _sql(kind, table, cond):
    if kind == "yf":
        return f"select date, close from dp.{table}", {}
    if kind == "fred":
        return f"select date, value as close from dp.{table}", {}
    if kind == "bok":
        return f"select time as date, data_value as close from dp.{table} where item_code1 = :c", {"c": cond}
    return f"select bas_dd as date, clsprc_idx as close from dp.{table} where idx_nm = :c", {"c": cond}


def load_series(names) -> dict:
    """{이름: 날짜 index 값 Series}(DB 읽기 전용)."""
    from sqlalchemy import text
    from db.connection import get_engine
    out = {}
    with get_engine().connect() as c:
        c.execute(text("SET TRANSACTION READ ONLY"))
        for n in sorted(set(names)):
            if n == "코스피":                                          # 예측과 같은 종가(1001 우선 + krx_kospi_dd_trd, db.extract.with_today)
                import wk_data
                out[n] = wk_data.kospi_close()
                continue
            kind, table, cond, _, _ = SERIES[n]
            q, prm = _sql(kind, table, cond)
            d = pd.read_sql(text(q), c, params=prm)
            idx = pd.to_datetime(d["date"].astype(str).str.replace("-", "").str[:8], format="%Y%m%d", errors="coerce")
            s = pd.Series(pd.to_numeric(d["close"], errors="coerce").to_numpy(), index=idx).dropna()
            out[n] = s[~s.index.duplicated(keep="last")].sort_index()
    return out


def change(s: pd.Series, name: str, n: int, at: pd.Timestamp):
    """예측 시각 at(KST naive)에 쓸 수 있던 마지막 값의 n 관측 전 대비 변화 → (변화, 마지막 날짜). 금리는 %p 차이, 나머지는 %."""
    foreign, rate = SERIES[name][3], SERIES[name][4]
    ready = s.index + (pd.Timedelta(days=1, hours=6) if foreign else pd.Timedelta(hours=16))
    s = s[(ready <= at) & (s > 0 if not rate else True)]
    if len(s) <= n:
        return None, None
    v = s.iloc[-1] - s.iloc[-1 - n] if rate else (s.iloc[-1] / s.iloc[-1 - n] - 1) * 100
    return round(float(v), 2), s.index[-1]


def market_rows(names, n, at, data):
    rows = []
    for nm in names:
        v, last = change(data[nm], nm, n, at)
        if v is not None:
            rows.append((nm, v, last))
    if not rows:
        return [], None
    newest = max(r[2] for r in rows)
    rows = [r for r in rows if r[2] == newest]                    # 같은 기간만(FRED 처럼 늦게 들어오는 지표는 그날 뺌)
    out = [{"label": nm, ("change_pp" if SERIES[nm][4] else "change_pct"): v} for nm, v, _ in rows]
    signs = {np.sign(v) for _, v, _ in rows if v != 0}
    return out, (len(signs) <= 1 if len(rows) > 1 else None)


# ------------------------------------------------------------------ 범주
def _cat(g):
    return "뉴스 흐름" if g.startswith("뉴스") else g


def _window(feature: str) -> int:
    if feature.startswith("K_"):
        return 1
    nums = re.findall(r"\d+", feature.split("_", 1)[-1])              # 접두어 뒤 마지막 숫자: ret_60d → 60, SMA10_gap → 10
    return int(nums[-1]) if nums else 1


def _period_feature(g, res, feats):
    """묶음 g 의 기간을 정할 변수: SHAP 세부(큰 묶음만)에서 기여가 가장 큰 것, 없으면 그 묶음의 첫 변수."""
    for obj in ("cls", "reg"):
        items = [d for d in res[obj]["detail"].get(g, []) if d["feature"] != "_rest"]
        if items:
            return max(items, key=lambda d: abs(d["shap"]))
    return {"feature": feats[g][0]} if feats.get(g) else None


def _note(item):
    p = item.get("percentile") if item else None
    if p is None or "label" not in item:
        return None
    return f"{item['label']}: 평소보다 높은 수준" if p >= 80 else f"{item['label']}: 평소보다 낮은 수준" if p <= 20 else None


def categories(res: dict, feats: dict) -> list:
    """상위 범주 [{name(원래 묶음들), display, effect, in_both, signed}].
    순위·effect 는 방향 모델 SHAP 만(2026-11-23: 최종 수익률 부호도 K1 로 방향 모델이 정하므로 방향 이유는 방향 모델로, wk_shap.llm_payload 와 같은 원칙).
    in_both = 수익률 모델에서도 상위 4 안(크기 쪽에서도 큰 요인인지 참고)."""
    share, top = {}, {}
    for obj in ("cls", "reg"):
        gs = [g for g in res[obj]["groups"] if g["group"] not in EXCLUDE]
        tot = sum(abs(g["shap"]) for g in gs) or 1.0
        per = {}
        for g in gs:
            c = _cat(g["group"])
            per[c] = per.get(c, 0.0) + g["shap"] / tot
            share.setdefault(c, {"w": 0.0, "signed": 0.0, "groups": []})
            share[c]["groups"] += [g["group"]] if g["group"] not in share[c]["groups"] else []
        for c, v in per.items():
            if obj == "cls":
                share[c]["w"] += abs(v)
                share[c]["signed"] += v
        top[obj] = set(sorted(per, key=lambda c: -abs(per[c]))[:N_CAT])
    order = sorted(share, key=lambda c: -share[c]["w"])[:N_CAT]
    return [{"key": c, "groups": share[c]["groups"], "display": DISPLAY.get(c, c), "weight": share[c]["w"],
             "effect": "상승 쪽" if share[c]["signed"] > 0 else "하락 쪽", "in_both": c in top["cls"] and c in top["reg"]} for c in order]


def top_explains_little(res) -> bool:
    """그날 방향 SHAP 상위 3 묶음만으로 예측을 0.7~1.3 만큼 되찾지 못하면 True(여러 요인이 함께 작용) — 시점 고정값 대신 그날 값(2026-11-23)."""
    rec = (res["cls"].get("concentration") or {}).get("top3_recovered")
    return rec is None or not (0.7 <= rec <= 1.3)


def model_articles(res, effect, n=2) -> list:
    """모델의 뉴스 키워드 신호가 effect 쪽으로 가장 크게 기댄 기사 제목(wk_shap keyword_articles: 평소보다 많이 나온 단어의 기여를 그 단어가 나온 기사에 나눔)."""
    ka = res["cls"].get("keyword_articles") or {}
    side = ka.get("up" if effect == "상승 쪽" else "down", [])
    return [a["title"] for a in side if a.get("title")][:n]


# ------------------------------------------------------------------ 입력 JSON
def news_note(counts: dict) -> str | None:
    """뉴스 흐름 범주 설명: 기사 기간 안 코스피 영향 기사(시황 제외·영향 보통 이상)의 방향 분포."""
    up, dn = counts.get("n_positive", 0), counts.get("n_negative", 0)
    if not up + dn:
        return None
    side = "상승 쪽이 더 많음" if up > dn else "하락 쪽이 더 많음" if dn > up else "상승 쪽과 하락 쪽이 비슷함"
    return f"최근 5거래일 코스피 영향 기사 중 {side}(상승 쪽 {up}건, 하락 쪽 {dn}건)"


def build_input(tp, b, X, res, arts, counts=None, *, predictions=None, bands=None) -> dict:
    import wk_data
    import wk_range
    import wk_shap
    b = pd.Timestamp(b).normalize()
    at = pd.Timestamp(X.loc[b, "prediction_at"]).tz_convert("Asia/Seoul").tz_localize(None)
    feats = {}
    for obj in ("cls", "reg"):
        if predictions:
            features = [k for k in predictions[obj]["model_input"] if not k.startswith("_")]
        else:
            features = wk_shap.model_for(f"{tp}_{obj}", X, b)["features"]
        for g, fs in wk_shap.groups_of(features, wk_shap.config()).items():
            feats.setdefault(g, []).extend(f for f in fs if f not in feats.get(g, []))
    p = float(res["cls"]["prob"])
    r = float(res["reg"]["actual"])
    post = json.loads((P.CONFIG / "v1_postprocess.json").read_text(encoding="utf-8")).get(f"{tp}_reg", {}).get("k1")
    flipped = False
    if post:                                                           # predict.py 와 같은 K1
        r_final = abs(r) * (1.0 if p >= post["threshold"] else -1.0)
        flipped = bool(np.sign(r) != np.sign(r_final))
        r = r_final
    versions = tuple(predictions[obj]["model_version"] if predictions else res[obj].get("model_version") for obj in ("cls", "reg"))
    rng = bands if bands is not None else wk_range.predict_range(tp, b, p, r, versions=versions)
    close = float(wk_data.kospi_close().loc[b])
    cats = categories(res, feats)
    data = load_series([n for c in cats for g in c["groups"] for n in MARKET.get(g, [])] + [n for n, _ in BACKDROP])
    used_series, out_cats = set(), []
    for c in cats:
        item = None if c["key"] == "뉴스 흐름" else _period_feature(c["groups"][0], res, feats)
        n = _window(item["feature"]) if item else 5
        names = [nm for g in c["groups"] for nm in MARKET.get(g, [])]
        mk, same = market_rows(names, n, at, data) if names else ([], None)
        used_series |= {x["label"] for x in mk}
        row = {"name": c["display"], "effect": c["effect"], "in_both": c["in_both"],
               "period_label": f"최근 {n}거래일", "market": mk}
        if c["key"] == "뉴스 흐름" and (ma := model_articles(res, c["effect"])):
            row["model_articles"] = ma
        if same is not None:
            row["same_trend"] = same
        if (note := news_note(counts or {}) if c["key"] == "뉴스 흐름" else _note(item)):
            row["note"] = note
        row["articles"] = []
        out_cats.append(row)
    news_i = next((i for i, c in enumerate(cats) if c["key"] == "뉴스 흐름"), None)
    for a in arts:                                                     # 기사 → 연결된 첫 범주(묶음 비중 큰 순), 없으면 뉴스 흐름
        hit = next((i for g in a["linked"] for i, c in enumerate(cats) if g in c["groups"]), news_i)
        if hit is not None:
            out_cats[hit]["articles"].append({"title": a["title"], "summary": a["summary"], "direction": DIRECTION.get(a["direction"], "혼재")})
    backdrop = []
    for nm, n in BACKDROP:
        if nm in used_series:
            continue
        v, _ = change(data[nm], nm, n, at)
        if v is not None:
            backdrop.append({"label": nm, "period_label": f"최근 {n}거래일", ("change_pp" if SERIES[nm][4] else "change_pct"): v})
    lo, hi = rng.get("range_lo80_pct"), rng.get("range_hi80_pct")
    if lo is None or not np.isfinite(lo):
        raise RuntimeError(f"{tp} {b.date()}: 80% 범위가 없어 해설을 만들지 않습니다.")
    return {"time_point": tp, "base_date": str(b.date()), "target_date": str(wk_data.target_day(b).date()),
            "direction": {"decision": "상승" if p >= 0.5 else "하락", "shown_prob_pct": round(max(p, 1 - p) * 100, 1)},
            "range": {"low_pct": round(lo, 2), "high_pct": round(hi, 2),
                      "low_index": int(round(close * (1 + lo / 100))), "high_index": int(round(close * (1 + hi / 100)))},
            "k1_flipped": flipped, "top_explains_little": top_explains_little(res),
            "categories": out_cats, "backdrop": backdrop}


# ------------------------------------------------------------------ 검사·호출
class OutputError(ValueError):
    pass


def prompt_text() -> str:
    """프롬프트 파일을 그대로 읽는다(해시 검사 없음, 2026-11-23 사용자 결정: 프롬프트가 바뀌면 바뀐 대로 실행)."""
    return PROMPT.read_text(encoding="utf-8")


def numbers(text) -> set:
    return {round(float(x.replace(",", "")), 2) for x in re.findall(r"\d[\d,]*(?:\.\d+)?", text)}


def allowed_numbers(payload) -> set:
    """입력에서 기사(title·summary)를 뺀 모든 숫자 + 50(반반)·80(범위 수준)·5(5거래일)."""
    p = json.loads(json.dumps(payload))
    for c in p["categories"]:
        c.pop("articles", None)
        c.pop("model_articles", None)
    return numbers(json.dumps(p, ensure_ascii=False)) | {50.0, 80.0, 5.0}


def check(ans: dict, payload: dict) -> None:
    text = " ".join(ans.values())
    if not ans["conclusion"].startswith("5거래일 뒤 코스피는"):
        raise OutputError('conclusion 은 "5거래일 뒤 코스피는"으로 시작하세요.')
    lo, hi = payload["range"]["low_pct"], payload["range"]["high_pct"]
    if f"{abs(lo):.2f}" not in ans["conclusion"] or f"{abs(hi):.2f}" not in ans["conclusion"]:
        raise OutputError("conclusion 에 80% 범위(low_pct·high_pct, 소수 둘째 자리)를 쓰세요.")
    if "http" in text.lower():
        raise OutputError("본문에 URL을 쓰지 마세요.")
    if re.search(r"\b[A-Z]{2,}_[A-Za-z0-9_]+", text) or "SHAP" in text:
        raise OutputError("변수명·SHAP 같은 내부 용어를 쓰지 마세요.")
    if any(w in ans["detail_reason"] for w in OPPOSITE):
        raise OutputError("반대 요인을 따로 덧붙이지 말고 정리 문장 안에 녹이거나 빼세요.")
    extra = sorted(numbers(text) - allowed_numbers(payload))
    if extra:
        raise OutputError(f"입력에 없는 수치({', '.join(map(str, extra))})를 쓰지 마세요. 기사 속 숫자도 옮기지 않습니다.")
    n = len(text)
    if not LENGTH[0] <= n <= LENGTH[1]:
        raise OutputError(f"길이 {n}자 — 합쳐서 약 450~800자로 쓰세요.")


def ask_gpt(instructions: str, raw: str):
    from openai import OpenAI
    from pydantic import BaseModel, Field
    from db import settings  # noqa: F401  (service_5/.env 로드)

    class Explanation(BaseModel):
        conclusion: str = Field(min_length=1)
        detail_reason: str = Field(min_length=1)

    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENAI_API_KEY 가 비어 있습니다(service_5/.env).")
    model = os.getenv("OPENAI_MODEL", "gpt-5.6-sol")
    r = OpenAI(api_key=key, timeout=180, max_retries=2).responses.parse(
        model=model, instructions=instructions, input=raw, text_format=Explanation, max_output_tokens=3000, store=False)
    if r.status != "completed" or r.output_parsed is None:
        raise OutputError("완료된 해설 응답이 없습니다.")
    u = r.usage
    return r.output_parsed.model_dump(), model, (u.input_tokens if u else None), (u.output_tokens if u else None)


def generate(payload: dict, attempts: int = 3) -> dict:
    prompt = prompt_text()
    raw = json.dumps(payload, ensure_ascii=False)
    feedback, out, ans = "", {"status": "failed", "model": None, "input_tokens": 0, "output_tokens": 0}, {}
    for k in range(1, attempts + 1):
        try:
            ans, model, ti, to = ask_gpt(prompt + ("\n[수정 요청]\n" + feedback if feedback else ""), raw)
            out |= {"model": model, "input_tokens": out["input_tokens"] + (ti or 0), "output_tokens": out["output_tokens"] + (to or 0), "attempts": k}
            check(ans, payload)
            return out | {"status": "ok", **ans, "error": None}
        except OutputError as ex:
            feedback = str(ex)
            print(f"  해설 검사 실패({k}/{attempts}): {ex}", flush=True)
    return out | {"conclusion": ans.get("conclusion"), "detail_reason": ans.get("detail_reason"), "error": feedback}   # 일별처럼 마지막 문장을 failed 로 남김




# ------------------------------------------------------------------ 실행
def run(tp: str, b, X: pd.DataFrame, res: dict, picked: tuple, llm: bool, write: bool, *, predictions=None, bands=None, staged=False) -> dict:
    """picked = wk_news_pick.run 반환(기사 목록, 고른 기록)."""
    import wk_data
    import wk_store
    b = pd.Timestamp(b).normalize()
    arts, counts = picked
    if not llm:
        payload = build_input(tp, b, X, res, arts, counts, predictions=predictions, bands=bands)
        raw = json.dumps(payload, ensure_ascii=False)
        print(f"[해설 입력] {tp} {b.date()} (LLM 호출 없음, 추정 입력 토큰 약 {int((len(prompt_text()) + len(raw)) / 1.5):,})\n"
              + json.dumps(payload, ensure_ascii=False, indent=1), flush=True)
        return {"status": "skipped", "payload": payload}
    import wk_models
    import wk_notify
    import wk_shap
    tgt, at = wk_data.target_day(b).date(), pd.Timestamp(X.loc[b, "prediction_at"])
    old = wk_store.explain_rows(tp, tgt, at) if write else pd.DataFrame()
    if len(old) and (old.status == "ok").any():                       # 일별과 같음: 같은 (대상일, 시점, prediction_at) 성공 해설이 있으면 GPT 를 부르지 않는다(failed 는 다시 만듦)
        print(f"[해설] {tp} {b.date()}: 이미 저장된 해설(ok)이 있어 다시 만들지 않습니다.", flush=True)
        return {"status": "exists"}
    ver = {o: predictions[o]["model_version"] if predictions else wk_models.version(f"{tp}_{o}", wk_shap.model_for(f"{tp}_{o}", X, b))
           for o in ("cls", "reg")}
    base = {"target_dd": tgt, "time_point": tp, "prediction_at": at.isoformat(),   # 일별 kospi_pred_explain 과 같은 열
            "cls_model_version": ver["cls"], "reg_model_version": ver["reg"], "prompt_version": PROMPT_VERSION}
    payload = None
    try:
        payload = build_input(tp, b, X, res, arts, counts, predictions=predictions, bands=bands)
        out = generate(payload)
    except Exception as ex:                                            # 일별과 같음: 호출 실패는 로그에 남기고 다음 실행에서 다시 만든다
        err = f"{type(ex).__name__}: {ex}"[:2000]
        print(f"[해설] {tp} {b.date()} failed: {err}", flush=True)
        wk_notify.send(f"KOSPI 주별 {tp} {b.date()} 해설 실패", [err[:300]], level="warn")
        return {"status": "failed", "error": err, "payload": payload}
    row = {**base, "conclusion": out.get("conclusion"), "detail_reason": out.get("detail_reason"),
           "article_keys": json.dumps([a["article_key"] for a in arts], ensure_ascii=False),
           "llm_model": out["model"], "status": out["status"], "error": (out.get("error") or None) and str(out["error"])[:2000],
           "input_tokens": out["input_tokens"], "output_tokens": out["output_tokens"]}
    print(f"[해설] {tp} {b.date()} {out['status']} (토큰 입력 {out['input_tokens']:,}·출력 {out['output_tokens']:,})", flush=True)
    if out["status"] == "ok" and out.get("conclusion") and out.get("detail_reason"):
        print(out["conclusion"] + "\n" + out["detail_reason"], flush=True)
    if out["status"] != "ok":                                          # 검사 실패는 로그에만 남기고 다음 실행에서 해설만 다시 시도
        wk_notify.send(f"KOSPI 주별 {tp} {b.date()} 해설 검사 실패", [str(out.get("error"))[:300]], level="warn")
    shown = bool(out.get("conclusion") and out.get("detail_reason"))      # 검사 실패 해설도 failed 로 저장해 화면에 보이고, 다음 실행에서 해설만 다시 만들어 덮어쓴다(일별과 같음, 2026-11-25)
    if staged:
        return out | {"row": row if shown else None}
    if shown:
        wk_store.explain_put(row, write)
    return out | {"payload": payload}


def main():
    import argparse
    import wk_news_pick
    import wk_shap
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--llm", action="store_true", help="GPT 해설 생성(유료)")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    import wk_data
    wk_data.refresh()
    X = wk_data.features(a.tp)                                           # 실행마다 DB 에서(캐시 없음)
    res = wk_shap.run(a.tp, a.base, X, False)
    run(a.tp, a.base, X, res, wk_news_pick.run(a.tp, a.base, X, res), a.llm, a.write)


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
