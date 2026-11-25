"""[실사용 모듈] 주별 해설 근거 기사 고르기(LLM 토큰 0) — 뉴스 DB 영향력·SHAP 묶음과의 분류·키워드 일치 점수로 기사 4~5건을 고르고 article_key 를 저장한다.

일별 service_daily/explain/news_pick.py 의 규칙을 주별에 옮긴 것(일별 코드는 import 하지 않음, service_5 단독 실행):
  ① 시황 기사(market_recap) 제외, 영향 강도 moderate·strong, 코스피 관련성 >= 0.5, 방향 신뢰도 >= 0.5, 링크 정상
  ② 기본 점수 = 관련성 x 신뢰도 x (strong 1, moderate 2/3)
  ③ SHAP 연결(각 0~1 = 이어진 묶음 비중 합): 분류 일치(지역·업종·경로, GROUP_TAG) + 키워드 일치(제목·요약, GROUP_KW)
     최종 점수 = 기본 점수 x (1 + 2 x 분류 일치 + 2 x 키워드 일치)
  ④ 제목이 거의 같은 기사(공백·기호 뺀 앞 24자)는 하나만, ⑤의 개수가 모자랄 때만 뺀 기사로 채운다
  ⑤ 방향 확신 강도(|상승 확률 − 0.5|)별 같은·반대 방향 수(TIERS): 강함(>=0.10) 4·0, 보통(>=0.05) 3·1, 약함 2·2
  ⑥ 5번째는 앞 4건이 다루지 않은 묶음과 이어지고 점수가 앞 4건 최저의 0.5배 이상인 기사만(강함·보통은 같은 방향, 약함은 아무 방향)
주별에서 다른 점:
  · SHAP 요인 = 변수가 아니라 묶음(config/shap_config.json). 묶음 비중 = 방향 모델(로짓) |기여| / 합(2026-11-23 방향 모델 기준으로 바꿈, 해설과 같은 요인).
  · '업종'·'기타' 묶음은 해설·기사 연결에서 뺀다(패션 업종처럼 시장 설명과 상관없는 변수, 사용자 결정 2026-11-23).
  · 기사 기간 = 예측 시각 앞 5거래일(같은 시각) ~ 예측 시각(대상이 5거래일 뒤라 1거래일보다 넓게, 뉴스 변수 KWS 창과 같음).
  · 방향 판정 = 상승 확률 >= 0.5 이면 상승(predict.py 와 같음).
저장: 따로 저장하지 않는다. 고른 기사 키는 일별처럼 해설 테이블 kospi5_pred_explain 의 article_keys 에만 남는다(사용자 결정 2026-11-24, 기사 고른 기록 테이블 삭제). run_automation.py 가 SHAP 뒤 부름.
실행(service_5): python -B wk_news_pick.py --tp W2 --base 2026-11-18   (SHAP 을 다시 계산한 뒤 고른 기사를 출력만)
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import html
import re

import pandas as pd

import wk_paths as P
from wk_news import EXTRACTED_BY
from timepoints import news_cutoff

KST = "Asia/Seoul"
DAYS = 5
SUMMARY_CHARS = 80
EXCLUDE = {"업종", "기타"}
TIERS = ((0.10, "strong", 4, 0), (0.05, "medium", 3, 1), (0.0, "weak", 2, 2))   # 일별 news_pick 과 같음(2026-11-19 사용자 결정)
EXTRA_MIN = 0.5

# 묶음 → 이어지는 기사 분류(지역·업종·경로 중 하나라도 맞으면 연결). 값은 dp.news_feature_orig 의 실제 분류 이름.
RISK = "위험선호·안전자산"
GROUP_TAG = {
    "미국 증시": {"region": {"usa"}},
    "미국 반도체": {"sector": {"반도체"}},
    "미국 변동성": {"channel": {RISK}},
    "미국 신용·방어 ETF": {"channel": {RISK}},
    "유럽·아시아 증시": {"region": {"europe", "china", "japan"}},
    "달러·원자재": {"channel": {"환율", "원자재·원가"}},
    "국내 금리": {"channel": {"금리·통화정책"}},
    "한국 레버리지 ETF(미국 상장)": {"sector": {"시장전체"}, "channel": {"수급(자금흐름)"}},
    "코스피 당일 가격": {"sector": {"시장전체"}, "channel": {"수급(자금흐름)"}},
    "코스피 추세·낙폭": {"sector": {"시장전체"}, "channel": {"수급(자금흐름)"}},
    "국내 변동성(VKOSPI)": {"channel": {RISK}},
}
GROUP_KW = {
    "미국 증시": ("미국", "뉴욕", "S&P", "나스닥", "다우", "연준", "월가"),
    "미국 반도체": ("반도체", "엔비디아", "HBM", "메모리", "하이닉스", "삼성전자", "필라델피아"),
    "미국 변동성": ("변동성", "VIX", "공포지수"),
    "미국 신용·방어 ETF": ("하이일드", "회사채", "신용", "안전자산"),
    "유럽·아시아 증시": ("유럽", "STOXX", "독일", "DAX", "ECB", "유로존", "홍콩", "항셍", "중국", "일본", "닛케이"),
    "달러·원자재": ("달러", "환율", "원화", "원·달러", "원/달러", "유가", "WTI", "원유", "금값", "금 가격"),
    "국내 금리": ("금리", "국고채", "한국은행", "한은", "기준금리"),
    "한국 레버리지 ETF(미국 상장)": ("코스피", "외국인", "한국 증시"),
    "코스피 당일 가격": ("코스피", "외국인", "기관", "증시"),
    "코스피 추세·낙폭": ("코스피", "외국인", "기관", "증시"),
    "국내 변동성(VKOSPI)": ("변동성", "VKOSPI", "공포"),
}

SQL = f"""SELECT f.article_key, f.available_at_kst, f.article_role, f.impact_direction, f.impact_strength, f.kospi_relevance,
       f.conf_impact_direction, f.origin_region, f.primary_sector, f.primary_channel, a.title, a.summary, a.url AS news_url
  FROM dp.news_feature_orig f JOIN dp.news_stock_article a USING (article_key)
 WHERE f.available_at_kst >= :lo AND f.available_at_kst < :hi
   AND {EXTRACTED_BY.format(column="f.extracted_at")}
   AND (a.modified_at IS NULL OR (a.modified_at AT TIME ZONE 'Asia/Seoul') < :hi)
 ORDER BY f.available_at_kst, f.article_key"""


def factors(res: dict) -> dict:
    """wk_shap.run 결과 → {묶음: 비중}(방향 모델 |기여| 비중, 업종·기타 제외, 합 1).
    2026-11-23: 방향·수익률 평균 → 방향 모델만(최종 방향은 K1 로 방향 모델이 정하고 해설도 방향 모델 기준이라, 근거 기사도 같은 요인을 가리키게)."""
    gs = [g for g in res["cls"]["groups"] if g["group"] not in EXCLUDE]
    tot = sum(abs(g["shap"]) for g in gs) or 1.0
    return {g["group"]: abs(g["shap"]) / tot for g in gs}


def tier(p: float):
    s = abs(p - 0.5)
    return next((name, same, opp) for cut, name, same, opp in TIERS if s >= cut)


def links_to(row, fw: dict):
    """기사 한 건이 이어지는 묶음(비중 큰 순), 분류 일치 비중 합, 키워드 일치 비중 합."""
    text_ = f"{row.title or ''} {row.summary or ''}"
    names, w_tag, w_kw = [], 0.0, 0.0
    for g, w in sorted(fw.items(), key=lambda kv: -kv[1]):
        m, kw = GROUP_TAG.get(g), GROUP_KW.get(g)
        tag = bool(m) and (row.origin_region in m.get("region", ()) or row.primary_sector in m.get("sector", ())
                           or row.primary_channel in m.get("channel", ()))
        hit = bool(kw) and any(k in text_ for k in kw)
        if tag or hit:
            names.append(g)
            w_tag += w * tag
            w_kw += w * hit
    return names, w_tag, w_kw


def window(prediction_at) -> tuple[pd.Timestamp, pd.Timestamp]:
    """(시작, 끝) KST naive: 예측일 앞 5번째 거래일의 같은 시각 ~ 예측 시각."""
    import wk_data
    hi = pd.Timestamp(prediction_at).tz_convert(KST).tz_localize(None)
    day = hi.normalize()
    start_day = wk_data.sessions(day - pd.Timedelta(days=30), day - pd.Timedelta(days=1))[-DAYS]
    return start_day + (hi - day), hi


def _norm_title(t) -> str:
    return re.sub(r"[\W_]+", "", str(t or ""))[:24]


def _valid(url) -> bool:
    from urllib.parse import urlsplit
    try:
        p = urlsplit(url)
        return p.scheme in ("https", "http") and bool(p.hostname) and not p.username and not p.password and not any(c.isspace() for c in url)
    except (ValueError, TypeError):
        return False


def choose(e: pd.DataFrame, p: float, dups: pd.DataFrame | None = None):
    """점수 순 기사 표 e 에서 확신 강도 규칙(⑤·⑥)으로 고른 행과 기록(일별 news_pick.choose 와 같은 규칙, 판정만 p >= 0.5)."""
    name, n_same, n_opp = tier(p)
    up = p >= 0.5
    dups = e.iloc[:0] if dups is None else dups
    pick_side = lambda d: pd.concat([e[e.impact_direction == d], dups[dups.impact_direction == d]])  # noqa: E731
    side = "positive" if up else "negative"
    same, opp = pick_side(side), pick_side("negative" if up else "positive")
    a = [r for _, r in same.head(n_same).iterrows()]
    b = [r for _, r in opp.head(min(n_opp, len(a))).iterrows()]              # 반대 방향은 같은 방향보다 많지 않게
    a += [r for _, r in same.iloc[n_same:n_same + n_opp - len(b)].iterrows()]  # 반대가 모자라면 같은 방향으로
    chosen, extra = a + b, False
    if len(chosen) == n_same + n_opp:
        used = {r.article_key for r in chosen}
        covered = {n for r in chosen for n in r.linked}
        pool = e if name == "weak" else e[e.impact_direction == side]
        floor = EXTRA_MIN * min(r.score for r in chosen)
        for _, r in pool[~pool.article_key.isin(used)].iterrows():
            if r.score < floor:
                break
            if set(r.linked) - covered:
                chosen.append(r)
                extra = True
                break
    d = [r.impact_direction for r in chosen]
    return chosen, {"tier": name, "shown_prob_pct": round(max(p, 1 - p) * 100, 1), "decision": "up" if up else "down",
                    "n_same": d.count(side), "n_opposite": sum(x not in (side, "mixed") for x in d), "n_mixed": d.count("mixed"),
                    "extra": extra, "n_dup_title": sum(r.article_key in set(dups.article_key) for r in chosen)}


def read_articles(lo, hi, *, as_of=None) -> pd.DataFrame:
    from sqlalchemy import text
    from db.connection import get_engine
    with get_engine().connect() as c:
        c.execute(text("SET TRANSACTION READ ONLY"))
        return pd.read_sql(text(SQL), c, params={"lo": lo.to_pydatetime(), "hi": hi.to_pydatetime(), "as_of": as_of})


def pick(art: pd.DataFrame, fw: dict, p: float) -> tuple[list, dict]:
    """기사 표 art 에서 고른 기사 목록(순서대로)과 기록."""
    counts = {"in_window": int(len(art)), "tier": tier(p)[0]}
    if art.empty:
        return [], counts | {"eligible": 0}
    ok = (art.article_role.ne("market_recap") & art.impact_strength.isin(["moderate", "strong"])
          & (pd.to_numeric(art.kospi_relevance, errors="coerce") >= .5)
          & (pd.to_numeric(art.conf_impact_direction, errors="coerce") >= .5) & art.news_url.map(_valid))
    e = art[ok].copy()
    e["base"] = (pd.to_numeric(e.kospi_relevance) * pd.to_numeric(e.conf_impact_direction)
                 * e.impact_strength.map({"strong": 1.0, "moderate": 2 / 3}))
    lk = [links_to(r, fw) for r in e.itertuples()]
    e["linked"] = [n for n, _, _ in lk]
    e["link_share"] = [w for _, w, _ in lk]
    e["keyword_share"] = [w for _, _, w in lk]
    e["score"] = e.base * (1 + 2 * e.link_share + 2 * e.keyword_share)
    e = e.sort_values(["score", "article_key"], ascending=[False, True])
    dup = e.title.map(_norm_title).duplicated()
    dups, e = e[dup], e[~dup]
    counts |= {"eligible": int(len(e)), "linked_to_shap": int(((e.link_share > 0) | (e.keyword_share > 0)).sum()),
               **{f"n_{d}": int((e.impact_direction == d).sum()) for d in ("positive", "negative", "mixed")}}
    chosen, how = choose(e, p, dups)
    out = []
    for k, r in enumerate(chosen, 1):
        s = html.unescape(str(r.summary or "")).strip()                      # 제목·요약의 &#8943; 같은 HTML 문자 표기를 글자로
        out.append({"rank": k, "article_key": str(r.article_key), "title": html.unescape(str(r.title or "")).strip(),
                    "summary": s[:SUMMARY_CHARS] + ("…" if len(s) > SUMMARY_CHARS else ""), "url": r.news_url,
                    "available_at_kst": pd.Timestamp(r.available_at_kst).strftime("%Y-%m-%d %H:%M"),
                    "direction": r.impact_direction, "linked": list(r.linked), "impact": round(float(r.base), 3),
                    "tag_match": round(float(r.link_share), 3), "keyword_match": round(float(r.keyword_share), 3),
                    "score": round(float(r.score), 3)})
    return out, counts | how


def run(tp: str, b, X: pd.DataFrame, res: dict) -> tuple[list, dict]:
    """W0·W2 한 기준일: SHAP 결과 res(wk_shap.run 반환)로 기사를 고른다(저장 없음, 키는 해설 article_keys 로). 반환 (기사 목록, 고른 기록)."""
    b = pd.Timestamp(b).normalize()
    at = X.loc[b, "prediction_at"]
    lo, hi = window(at)
    fw = factors(res)
    arts, counts = pick(read_articles(lo, hi, as_of=news_cutoff(tp, at)), fw, float(res["cls"]["prob"]))
    counts["group_weight"] = {g: round(w, 4) for g, w in sorted(fw.items(), key=lambda kv: -kv[1])}
    print(f"{tp} {b.date()} 기사 {len(arts)}건(강도 {counts['tier']}, 후보 {counts.get('eligible', 0)}건, 기간 {lo:%m-%d %H:%M}~{hi:%m-%d %H:%M})", flush=True)
    for a in arts:
        print(f"  {a['rank']}. [{a['direction']}] {a['title']} | {', '.join(a['linked'][:2]) or '연결 없음'} | {a['score']}", flush=True)
    return arts, counts


def main():
    import argparse
    import wk_shap
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    ap.add_argument("--base", required=True)
    a = ap.parse_args()
    import wk_data
    wk_data.refresh()
    X = wk_data.features(a.tp)                                           # 실행마다 DB 에서(캐시 없음)
    res = wk_shap.run(a.tp, a.base, X, False)
    run(a.tp, a.base, X, res)


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
