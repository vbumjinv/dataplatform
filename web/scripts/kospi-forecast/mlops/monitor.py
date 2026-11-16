"""[실사용 모듈] 성능 모니터링 — 세 시점(T0·T1·T2) 예측 + 정답으로 일별·이동(20/60거래일)·월별·누적 지표, 범위 적중, 입력 분포 변화(PSI), 경고를 만든다.

사용처: run_monitor_daily.py, mlops/champion_challenger.py
입력: 저장소 kospi_pred_cls·reg(시점별 챔피언 예측·범위·모델 입력), kospi_mlops_ledger(T2 챌린저), DB KOSPI 종가(정답), 학습본 manifest 의 drift_reference
출력: (평가 표, 지표 표, 경고 목록) — 저장은 run_monitor_daily.py 가 한다.

정답: 대상일 종가 / 직전 거래일(거래소 달력) 종가 - 1. 둘 중 하나라도 DB 에 없으면 정답 없음(채우지 않음).
지표(학습 프로토콜 2절과 같은 정의): 분류 = 적중일수·Balanced Accuracy·MCC·Brier (상승 기준 p>0.5, 적중률 = hits/n),
회귀 = MAE·RMSE·MAE skill(0 예측 대비)·부호 적중일수·80% 범위 적중일수(range80_hits, 적중률 = range80_hits/n 이 80% 근처면 정상).
주지표는 분류 MCC, 회귀 MAE skill.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score, matthews_corrcoef

WINDOWS = (20, 60)
PSI_ALERT = 0.25
RANGE_ALERT = 0.70                 # 최근 60일 80% 범위 적중률이 이보다 낮으면 경고(범위가 너무 좁음)
MAIN = {"cls": "mcc", "reg": "mae_skill"}
OPEN = 9                           # 장 시작(시): 이보다 먼저 저장한 예측만 prospective(사전 예측)



def news_count(model_input):
    """예측 행 모델 입력의 대상일 뉴스 기사 수: T2 = context.aggregated_article_count, T1 = news.n_articles, T0 = 없음(None)."""
    m = model_input or {}
    n = (m.get("context") or {}).get("aggregated_article_count")
    return (m.get("news") or {}).get("n_articles") if n is None else n

def actuals(close: pd.Series) -> pd.DataFrame:
    """대상일 정답: actual_return(소수), actual_direction(1/0). 직전 거래일은 거래소 달력 기준(DB 에 빠진 날을 건너뛰지 않음)."""
    import exchange_calendars as xcals
    close = close.dropna().sort_index()
    cal = xcals.get_calendar("XKRX")
    prev = pd.DatetimeIndex([cal.previous_session(d) for d in close.index]).tz_localize(None)
    ret = close.to_numpy() / close.reindex(prev).to_numpy() - 1
    out = pd.DataFrame({"actual_return": ret}, index=close.index)
    out["actual_direction"] = np.where(out.actual_return.isna(), np.nan, (out.actual_return > 0).astype(float))
    return out


def evaluations(st, tps, roles: dict, close: pd.Series) -> pd.DataFrame:
    """평가 표: 한 행 = 시점 x 목적 x 계열 x 대상일. 챔피언은 저장소 예측 테이블, T2 챌린저는 원장에서 읽는다."""
    rows = []
    for tp in tps:
        for obj in ("cls", "reg"):
            df = st.pred_read(obj, tp)
            if df.empty:
                continue
            df = df.drop_duplicates("target_dd", keep="last")                  # 같은 날 여러 학습본이면 늦게 쓴 것
            line = roles.get(obj, {}).get("champion", "model_1") if tp == "T2" else "model_1"
            opened = df.target_dd.dt.tz_localize("Asia/Seoul") + pd.Timedelta(hours=OPEN)
            part = pd.DataFrame({"time_point": tp, "objective": obj, "line": line, "role": "champion", "target_dd": df.target_dd.to_numpy(),
                                 "model_version": df.model_version.to_numpy(),
                                 "yhat": df.yhat_probability.astype(float).to_numpy() if obj == "cls" else df.yhat_value.astype(float).to_numpy(),
                                 "prospective": (df.load_dtm < opened).to_numpy(),
                                 "inputs": [(m or {}).get("features") for m in df.model_input],
                                 "news_articles": [news_count(m) for m in df.model_input]})
            if obj == "reg":
                part["range_lo80_pct"] = df.range_lo80_pct.astype(float).to_numpy()
                part["range_hi80_pct"] = df.range_hi80_pct.astype(float).to_numpy()
            rows.append(part)
    led = st.ledger_read()
    if len(led):
        led = led[led.role == "challenger"]
        rows.append(pd.DataFrame({"time_point": "T2", "objective": led.objective.to_numpy(), "line": led.line.to_numpy(), "role": "challenger",
                                  "target_dd": pd.to_datetime(led.target_dd).to_numpy(), "model_version": led.model_version.to_numpy(),
                                  "yhat": led.yhat.astype(float).to_numpy(), "prospective": led.prospective.astype(bool).to_numpy(),
                                  "inputs": led.inputs.to_numpy(), "news_articles": led.news_articles.to_numpy()}))
    if not rows:
        return pd.DataFrame()
    ev = pd.concat(rows, ignore_index=True)
    return ev.merge(actuals(close), left_on="target_dd", right_index=True, how="left")


def metric_block(obj: str, g: pd.DataFrame) -> dict:
    g = g.dropna(subset=["actual_return"])
    n = len(g)
    if n == 0:
        return {"n": 0}
    if obj == "cls":
        y = g.actual_direction.to_numpy(int)
        p = g.yhat.to_numpy(float)
        lab = (p > 0.5).astype(int)
        two = len(np.unique(y)) == 2
        return {"n": n, "hits": int((lab == y).sum()),
                "balanced_accuracy": float(balanced_accuracy_score(y, lab)) if two else np.nan,
                "mcc": float(matthews_corrcoef(y, lab)) if two else 0.0, "brier": float(np.mean((p - y) ** 2))}
    y = g.actual_return.to_numpy(float)
    p = g.yhat.to_numpy(float)
    z = np.mean(np.abs(y))
    out = {"n": n, "mae": float(np.mean(np.abs(y - p))), "rmse": float(np.sqrt(np.mean((y - p) ** 2))),
           "mae_skill": float(1 - np.mean(np.abs(y - p)) / z) if z > 0 else np.nan,
           "sign_hits": int(((y > 0) == (p > 0)).sum())}
    if "range_lo80_pct" in g and g.range_lo80_pct.notna().all():
        out["range80_hits"] = int(((y * 100 >= g.range_lo80_pct) & (y * 100 <= g.range_hi80_pct)).sum())
    return out


def metrics_table(ev: pd.DataFrame, prospective_only: bool = False) -> pd.DataFrame:
    """시점·목적·계열별로 날짜마다 이동 20·60일과 누적 지표, 그리고 대상월별 지표."""
    rows = []
    if ev.empty:
        return pd.DataFrame()
    ev = ev.dropna(subset=["actual_return"])
    if prospective_only:
        ev = ev[ev.prospective]
    for (tp, obj, line), g in ev.groupby(["time_point", "objective", "line"]):
        g = g.sort_values("target_dd").reset_index(drop=True)
        key = {"time_point": tp, "objective": obj, "line": line}
        for i, d in enumerate(g.target_dd):
            for w in WINDOWS:
                part = g.iloc[max(0, i - w + 1): i + 1]
                if len(part) == w:
                    rows.append({**key, "date": d, "window": f"roll{w}", **metric_block(obj, part)})
        rows.append({**key, "date": g.target_dd.max(), "window": "cumulative", **metric_block(obj, g)})
        for m, part in g.groupby(g.target_dd.dt.strftime("%Y-%m")):
            rows.append({**key, "date": part.target_dd.max(), "window": f"month:{m}", **metric_block(obj, part)})
    return pd.DataFrame(rows)


def psi(values: np.ndarray, ref: dict) -> float:
    v = values[np.isfinite(values)]
    if len(v) < 20:
        return np.nan
    edges = np.asarray(ref["edges"])
    cur = np.bincount(np.searchsorted(edges, v, side="right"), minlength=len(edges) + 1) / len(v)
    base = np.asarray(ref["share"])
    cur, base = np.clip(cur, 1e-4, None), np.clip(base, 1e-4, None)
    return float(np.sum((cur - base) * np.log(cur / base)))


def drift(ev: pd.DataFrame, manifests: dict, last: int = 60) -> pd.DataFrame:
    """챔피언 최근 last 거래일 입력값 vs 그 학습본의 학습 분포(manifest drift_reference 가 있는 학습본만). manifests: model_version -> manifest."""
    rows = []
    if ev.empty:
        return pd.DataFrame()
    for (tp, obj, line), g in ev[ev.role == "champion"].groupby(["time_point", "objective", "line"]):
        g = g.sort_values("target_dd").tail(last)
        latest = manifests.get(g.model_version.iloc[-1], {})
        ref = latest.get("drift_reference") or {}
        if not ref:
            continue
        X = pd.DataFrame([x or {} for x in g.inputs])
        for c in X.columns:
            if c in ref:
                rows.append({"time_point": tp, "objective": obj, "line": line, "feature": c, "days": len(g),
                             "psi": psi(pd.to_numeric(X[c], errors="coerce").to_numpy(float), ref[c]), "model_version": latest.get("model_version")})
    return pd.DataFrame(rows)


def alerts(ev: pd.DataFrame, mt: pd.DataFrame, dr: pd.DataFrame, trading_days: pd.DatetimeIndex, tps) -> list[dict]:
    """경고: 주지표 하락·예측 누락·뉴스 0건(T1·T2)·80% 범위 적중 낮음·입력 분포 변화(시점마다)."""
    out = []
    if ev.empty:
        return [{"level": "warn", "time_point": tp, "objective": None, "what": "저장된 예측 없음", "value": 0} for tp in tps]
    champ = ev[ev.role == "champion"]
    for tp in tps:
        for obj in ("cls", "reg"):
            rows = champ[(champ.time_point == tp) & (champ.objective == obj)]
            base = {"time_point": tp, "objective": obj}
            recent = mt[(mt.time_point == tp) & (mt.objective == obj) & mt.line.isin(rows.line.unique()) & (mt.window == "roll60")] if len(mt) else mt
            if len(recent):
                last = recent.sort_values("date").iloc[-1]
                if last[MAIN[obj]] < 0:
                    out.append({**base, "level": "warn", "what": f"챔피언 최근 60일 {MAIN[obj]} < 0", "value": float(last[MAIN[obj]]),
                                "date": str(pd.Timestamp(last.date).date())})
                if obj == "reg" and pd.notna(last.get("range80_hits")) and last.n >= 40 and last.range80_hits / last.n < RANGE_ALERT:
                    out.append({**base, "level": "warn", "what": f"최근 60일 80% 범위 적중률 < {RANGE_ALERT:.0%}",
                                "value": round(float(last.range80_hits / last.n), 3), "date": str(pd.Timestamp(last.date).date())})
            have = set(rows.target_dd)
            miss = [str(d.date()) for d in trading_days if d not in have]
            if miss:
                out.append({**base, "level": "warn", "what": "챔피언 예측 누락일", "value": len(miss), "dates": miss[-10:]})
            no_news = rows[rows.news_articles.eq(0)].target_dd
            if len(no_news):
                out.append({**base, "level": "warn", "what": "뉴스 기사 0건으로 예측한 날(dp.news_feature_orig 처리 미완료 의심)",
                            "value": len(no_news), "dates": [str(d.date()) for d in no_news.sort_values()[-10:]]})
    if len(dr):
        bad = dr[dr.psi > PSI_ALERT].sort_values("psi", ascending=False)
        for _, r in bad.head(10).iterrows():
            out.append({"level": "info", "time_point": r.time_point, "objective": r.objective, "what": f"입력 분포 변화 PSI>{PSI_ALERT}: {r.feature}",
                        "value": round(float(r.psi), 3)})
    return out
