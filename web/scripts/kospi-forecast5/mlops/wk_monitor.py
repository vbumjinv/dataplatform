"""[실사용 모듈] 주별 저녁 성능 모니터링 — 예측(kospi5_pred_cls·reg)과 챌린저 원장(등록했을 때만)에 정답(대상일 종가 / 기준일 종가 − 1)을 붙여 지표·범위 적중·경고를 기록한다.

일별 service_daily/run_monitor_daily.py·mlops/monitor.py 와 같은 계산·같은 열(참고만, 일별 코드는 쓰지 않음 — 이 폴더만으로 돈다). 테이블 이름 = 일별 이름의 kospi 뒤에 5(kospi5_*, 2026-11-25 사용자 결정, 이전 이름 + _5):
  kospi5_mlops_metric  시점·목적·계열(line = champion·challenger, 일별과 같은 열)별 날짜마다 이동 20·60건, 누적, 대상월별 지표
                             열: time_point·objective·line·window·date·n·hits·balanced_accuracy·mcc·brier·mae·rmse·mae_skill·sign_hits·range80_hits·computed_at
                             (예측 + 정답에서만 매번 전부 다시 계산, 시점·목적·계열 단위로 바꿔 넣음)
  kospi5_mlops_alert   경고: 최근 60건 주지표(방향 MCC·수익률 MAE 개선율) < 0, 80% 범위 적중률 < 70%, 최근 20거래일 예측 누락, 뉴스 장애로 정형만 예측,
                             정답·기준 종가 누락, 뉴스 0건 예측, 입력 분포 PSI>0.25(기록만, 실행은 멈추지 않음; warn 은 wk_notify 로 kospi5_mlops_alert objective=notify)
                             열: id·asof·time_point·objective·level·what·value·detail·created_at (같은 asof 는 바꿔 넣음)
평가 행: 시점별 '거래일 실행' 예측 1건 = 기준일 1건(주말·휴일 실행은 같은 기준일 반복이라 뺌). 정답은 대상일 종가가 나온 뒤에만(5거래일 뒤).
수익률 지표는 최종 값(K1 뒤 yhat_value)으로, 범위 적중은 80% 범위 안에 실제가 들어갔는지. 입력 분포 PSI 기준 = 학습본 학습 끝 앞 750 기준일 변수 분포(manifest 대신).
실행: run_automation.py evening --write(거래일 19:00) 가 부르고, 이어서 evaluate(챔피언/챌린저 비교)를 돈다. 단독 python -B wk_monitor.py [--asof YYYY-MM-DD] [--write]
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

WINDOWS = (20, 60)
RANGE_ALERT = 0.70
MAIN = {"cls": "mcc", "reg": "mae_skill"}
METRIC_COLS = ("n", "hits", "balanced_accuracy", "mcc", "brier", "mae", "rmse", "mae_skill", "sign_hits", "range80_hits")
METRIC = "kospi5_mlops_metric"
_X: dict = {}                                                            # 이번 실행에 만든 변수 표(PSI 기준 분포용, 메모리만)
ALERT = "kospi5_mlops_alert"


def _trading_rows(df: pd.DataFrame) -> pd.DataFrame:
    """거래일 실행 행만, 기준일(대상일보다 5거래일 앞)을 붙인다. 같은 기준일 여러 학습본이면 늦게 쓴 것."""
    import wk_data
    run = pd.to_datetime(df.prediction_at, utc=True).dt.tz_convert("Asia/Seoul").dt.tz_localize(None).dt.normalize()
    df = df.loc[run.isin(wk_data.sessions(run.min(), run.max()))].copy() if len(run) else df.copy()
    df["target_dd"] = pd.to_datetime(df.target_dd)
    df["base_dd"] = [wk_data.base_of_target(t) for t in df.target_dd]
    return df.sort_values("load_dtm").drop_duplicates(["time_point", "base_dd"], keep="last")


def evaluations(asof) -> pd.DataFrame:
    """한 행 = 시점 x 목적 x 계열 x 기준일: yhat(방향 = 상승 확률, 수익률 = 최종 수익률 소수), 범위, 정답."""
    import wk_data
    import wk_store
    rows = []
    for obj in ("cls", "reg"):
        df = wk_store.read(f"kospi5_pred_{obj}")
        if df.empty:
            continue
        df = _trading_rows(df)
        news = [_obj(m).get("_news_articles_1d") for m in df.model_input] if "model_input" in df else [None] * len(df)
        part = pd.DataFrame({"time_point": df.time_point.to_numpy(), "objective": obj, "line": "champion", "base_dd": df.base_dd.to_numpy(),
                             "news_articles": news, "model_input": df.model_input.to_numpy() if "model_input" in df else None,
                             "target_dd": df.target_dd.to_numpy(), "model_version": df.model_version.to_numpy(),
                             "yhat": (df.yhat_probability.astype(float) if obj == "cls" else df.yhat_value.astype(float)).to_numpy()})
        if obj == "reg":
            part["range_lo80_pct"] = df.range_lo80_pct.astype(float).to_numpy()
            part["range_hi80_pct"] = df.range_hi80_pct.astype(float).to_numpy()
        rows.append(part)
    import evaluate                                                      # 챌린저(등록했을 때만) 원장 — 계열 line = challenger
    led = evaluate.ledger()
    led = led[led.role == "challenger"] if len(led) else led
    if len(led):
        rows.append(pd.DataFrame({"time_point": led.slot.str[:2].to_numpy(), "objective": led.slot.str[3:].to_numpy(), "line": "challenger",
                                  "base_dd": pd.to_datetime(led.base_dd).to_numpy(), "target_dd": pd.to_datetime(led.target_dd).to_numpy(),
                                  "model_version": led.model_version.to_numpy(), "yhat": led.yhat.astype(float).to_numpy()}))
    if not rows:
        return pd.DataFrame()
    ev = pd.concat(rows, ignore_index=True)
    ev = ev[ev.base_dd <= pd.Timestamp(asof)]
    A = wk_data.answers(pd.DatetimeIndex(sorted(ev.base_dd.unique())))
    known = ev.target_dd <= pd.Timestamp(asof)                            # 대상일이 asof 뒤면 정답 대기(행은 남겨 누락 검사에 씀)
    ev["actual_return"] = ev.base_dd.map(A.y_return).where(known)
    ev["actual_direction"] = ev.base_dd.map(A.y_direction).where(known)
    return ev


def metric_block(obj: str, g: pd.DataFrame) -> dict:
    from sklearn.metrics import balanced_accuracy_score, matthews_corrcoef
    g = g.dropna(subset=["actual_return"])
    n = len(g)
    if n == 0:
        return {"n": 0}
    if obj == "cls":
        y = g.actual_direction.to_numpy(int)
        p = g.yhat.to_numpy(float)
        lab = (p >= 0.5).astype(int)                                      # 주별 방향 판정 = 상승 확률 ≥ 0.5(predict.py 와 같음)
        two = len(np.unique(y)) == 2
        return {"n": n, "hits": int((lab == y).sum()), "balanced_accuracy": float(balanced_accuracy_score(y, lab)) if two else np.nan,
                "mcc": float(matthews_corrcoef(y, lab)) if two else 0.0, "brier": float(np.mean((p - y) ** 2))}
    y = g.actual_return.to_numpy(float)
    p = g.yhat.to_numpy(float)
    z = np.mean(np.abs(y))
    out = {"n": n, "mae": float(np.mean(np.abs(y - p))), "rmse": float(np.sqrt(np.mean((y - p) ** 2))),
           "mae_skill": float(1 - np.mean(np.abs(y - p)) / z) if z > 0 else np.nan, "sign_hits": int(((y > 0) == (p > 0)).sum())}
    if "range_lo80_pct" in g and g.range_lo80_pct.notna().all():
        out["range80_hits"] = int(((y * 100 >= g.range_lo80_pct) & (y * 100 <= g.range_hi80_pct)).sum())
    return out


def metrics_table(ev: pd.DataFrame) -> pd.DataFrame:
    """시점·목적·계열별로 날짜(대상일)마다 이동 20·60건과 누적 지표, 대상월별 지표(일별 monitor.metrics_table 과 같음)."""
    rows = []
    ev = ev.dropna(subset=["actual_return"]) if len(ev) else ev
    if ev.empty:
        return pd.DataFrame()
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


def _safe(name, fn, out):
    try:
        out.extend(fn())
    except Exception as exc:
        import wk_notify
        wk_notify.send(f"5거래일 모니터링 {name} 계산 실패", [repr(exc)], level="error")


def missing_actuals(asof) -> list[dict]:
    """최근 20거래일 중 코스피 종가가 DB 에 없는 날(정답·기준 종가 누락) — 기록만."""
    import wk_data
    days = wk_data.sessions(pd.Timestamp(asof) - pd.Timedelta(days=40), pd.Timestamp(asof))[-20:]
    close = wk_data.kospi_close()
    miss = [d for d in days if d not in close.index or pd.isna(close.get(d))]
    return [{"level": "warn", "time_point": None, "objective": None, "what": "정답·기준 종가 누락(코스피 종가 DB 없음)", "value": len(miss),
             "dates": [str(d.date()) for d in miss]}] if miss else []


def news_zero(ev) -> list[dict]:
    """뉴스 기사 0건(직전 1거래일 창)으로 예측한 날 — 일별 '뉴스 0건 예측' 경고와 같음. 기록만."""
    out = []
    rows = ev[(ev.line == "champion") & (ev.objective == "cls")] if len(ev) else ev
    for tp, g in rows.groupby("time_point") if len(rows) else []:
        z = g[pd.to_numeric(g.news_articles, errors="coerce").eq(0)]
        if len(z):
            out.append({"level": "warn", "time_point": tp, "objective": "cls", "what": "뉴스 기사 0건으로 예측한 날(뉴스 처리 미완료 의심)", "value": len(z),
                        "dates": [str(pd.Timestamp(d).date()) for d in z.base_dd.sort_values()[-10:]]})
    return out


PSI_ALERT = 0.25


def psi(values, ref) -> float:
    v = np.asarray(values, float)
    v, ref = v[np.isfinite(v)], np.asarray(ref, float)
    ref = ref[np.isfinite(ref)]
    if len(v) < 20 or len(ref) < 100 or np.nanstd(ref) == 0:
        return np.nan
    edges = np.unique(np.quantile(ref, np.linspace(0.1, 0.9, 9)))
    cur = np.bincount(np.searchsorted(edges, v, side="right"), minlength=len(edges) + 1) / len(v)
    base = np.bincount(np.searchsorted(edges, ref, side="right"), minlength=len(edges) + 1) / len(ref)
    cur, base = np.clip(cur, 1e-4, None), np.clip(base, 1e-4, None)
    return float(np.sum((cur - base) * np.log(cur / base)))


def drift(ev, last: int = 60) -> list[dict]:
    """입력 분포 변화(PSI) — 운영 모델 최근 last 건 입력(model_input) vs 그 학습본 학습 끝 앞 750 기준일(약 3년) 변수 분포(DB 원천으로 다시 만든 변수 표).
    일별은 학습본 manifest 의 기준 분포를 쓰지만 주별은 manifest 가 없어 변수 표에서 계산한다. 뉴스 키워드·주제(수백 개, 희소)는 뺀다. 기록만(info)."""
    import wk_models
    out = []
    rows = ev[ev.line == "champion"] if len(ev) else ev
    for (tp, obj), g in rows.groupby(["time_point", "objective"]) if len(rows) else []:
        m = wk_models.load(f"{tp}_{obj}", "champion")
        import wk_data
        if tp not in _X:
            _X[tp] = wk_data.features(tp)                                  # 캐시 없이 DB 에서(이번 실행 안에서 시점마다 한 번)
        X = _X[tp]
        ref = X.loc[X.index <= pd.Timestamp(m.get("train_end", X.index.max()))].tail(750)
        cur = pd.DataFrame([_obj(x) for x in g.sort_values("base_dd").model_input.tail(last)])
        feats = [f for f in m["features"] if not f.startswith(("KWS_", "TOPIC_", "KWR_")) and f in cur and f in ref]
        vals = {f: psi(pd.to_numeric(cur[f], errors="coerce"), pd.to_numeric(ref[f], errors="coerce")) for f in feats}
        for f, v in sorted(((f, v) for f, v in vals.items() if np.isfinite(v) and v > PSI_ALERT), key=lambda kv: -kv[1])[:10]:
            out.append({"level": "info", "time_point": tp, "objective": obj, "what": f"입력 분포 변화 PSI>{PSI_ALERT}: {f}", "value": round(v, 3),
                        "days": len(cur)})
    return out


def alerts(ev: pd.DataFrame, mt: pd.DataFrame, asof) -> list[dict]:
    """경고: 최근 60건 주지표 < 0, 80% 범위 적중 < 70%, 최근 20거래일 기준일 예측 누락, 뉴스 장애로 정형만 예측한 날,
    정답·기준 종가 누락, 뉴스 0건 예측, 입력 분포 변화(PSI). 모두 기록만 하고 실행은 멈추지 않는다(일별과 같음, 사용자 결정 2026-11-23)."""
    out = []
    _safe("성능·누락·정형만", lambda: _base_alerts(ev, mt, asof), out)
    _safe("정답 종가 누락", lambda: missing_actuals(asof), out)
    _safe("뉴스 0건", lambda: news_zero(ev), out)
    _safe("입력 분포 PSI", lambda: drift(ev), out)
    return out


def _base_alerts(ev: pd.DataFrame, mt: pd.DataFrame, asof) -> list[dict]:
    import wk_data
    out = []
    champ = ev[ev.line == "champion"] if len(ev) else ev
    for tp in P.TPS:
        latest_base = wk_data.base_day(tp, asof)
        days = wk_data.sessions(latest_base - pd.Timedelta(days=40), latest_base)[-20:]
        for obj in ("cls", "reg"):
            base = {"time_point": tp, "objective": obj}
            rows = champ[(champ.time_point == tp) & (champ.objective == obj)] if len(champ) else champ
            recent = mt[(mt.time_point == tp) & (mt.objective == obj) & (mt.line == "champion") & (mt.window == "roll60")] if len(mt) else mt
            if len(recent):
                last = recent.sort_values("date").iloc[-1]
                if last[MAIN[obj]] < 0:
                    out.append({**base, "level": "warn", "what": f"운영 모델 최근 60건 {MAIN[obj]} < 0", "value": float(last[MAIN[obj]]),
                                "date": str(pd.Timestamp(last.date).date())})
                if obj == "reg" and pd.notna(last.get("range80_hits")) and last.n >= 40 and last.range80_hits / last.n < RANGE_ALERT:
                    out.append({**base, "level": "warn", "what": f"최근 60건 80% 범위 적중률 < {RANGE_ALERT:.0%}",
                                "value": round(float(last.range80_hits / last.n), 3), "date": str(pd.Timestamp(last.date).date())})
            have = set(pd.to_datetime(rows.base_dd)) if len(rows) else set()
            first = min(have) if have else None                                # 운영 시작 전 날짜는 누락으로 세지 않음
            miss = [str(d.date()) for d in days if first is not None and d >= first and d not in have]
            if miss:
                out.append({**base, "level": "warn", "what": "운영 예측 누락 기준일(거래일 실행)", "value": len(miss), "dates": miss[-10:]})
            fb = rows[rows.model_version.astype(str).str.endswith("_struct")] if len(rows) else rows
            if len(fb):
                out.append({**base, "level": "warn", "what": "뉴스 변수 장애로 정형만 모델(fallback)로 예측한 날", "value": len(fb),
                            "dates": [str(pd.Timestamp(d).date()) for d in fb.base_dd.sort_values()[-10:]]})
    return out


def _clean(v):
    if isinstance(v, (np.floating, np.integer)):
        v = v.item()
    return None if isinstance(v, float) and not np.isfinite(v) else v


def _obj(x) -> dict:
    """json 열 값(DB 는 객체, 예전 기록은 문자열) → dict."""
    return x if isinstance(x, dict) else json.loads(x) if isinstance(x, str) and x else {}


def save(mt: pd.DataFrame, al: list[dict], asof, write: bool) -> tuple[int, int]:
    """지표: 시점·목적·계열 단위로 전부 바꿔 넣음. 경고: 같은 asof 행을 바꿔 넣음(DB 저장소)."""
    import wk_store
    now = wk_store.stamp_now()
    m = pd.DataFrame([{**{c: _clean(r.get(c)) for c in ("time_point", "objective", "line", "window") + METRIC_COLS},
                       "date": str(pd.Timestamp(r["date"]).date()), "computed_at": now} for r in mt.to_dict("records")]) if len(mt) else pd.DataFrame()
    day = str(pd.Timestamp(asof).date())
    a = pd.DataFrame([{"asof": day, "time_point": x.get("time_point"), "objective": x.get("objective"), "level": x.get("level"), "what": x.get("what"),
                       "value": float(x["value"]) if isinstance(x.get("value"), (int, float)) else None,
                       "detail": {k: _clean(v) for k, v in x.items()}, "created_at": now} for x in al])
    if not write:
        print(f"[dry-run] {METRIC}: {len(m)}행, {ALERT}: {len(a)}행")
        return len(m), len(a)
    wk_store.replace(METRIC, m, ["time_point", "objective", "line"])
    eng, _ = wk_store.engine()
    from sqlalchemy import delete, or_
    ta = wk_store.table(ALERT)
    with eng.begin() as con:                                             # 같은 asof 경고를 원자적으로 교체
        con.execute(delete(ta).where(ta.c.asof == pd.Timestamp(day).date(),
                                     or_(ta.c.objective.is_(None), ta.c.objective != "notify")))   # 알림(wk_notify) 행은 남긴다
        wk_store.append(ALERT, a, con=con)
    print(f"저장 {METRIC}: {len(m)}행, {ALERT}: {len(a)}행")
    return len(m), len(a)


def run(asof, write: bool) -> pd.DataFrame:
    asof = pd.Timestamp(asof).normalize()
    ev = evaluations(asof)
    if ev.empty:
        print("저장된 주별 예측이 없습니다(run_automation.py w0·w2 --write 먼저).")
        return pd.DataFrame()
    n_wait = int(ev.actual_return.isna().sum())
    print(f"평가 {len(ev)}행, 정답 있음 {len(ev) - n_wait}행, 정답 대기 {n_wait}행(대상일 종가 전)")
    mt = metrics_table(ev)
    al = alerts(ev, mt, asof)
    save(mt, al, asof, write)
    if len(mt):
        show = pd.concat([g.sort_values("date").tail(1) for _, g in mt.groupby(["time_point", "objective", "line", "window"])])
        show = show[show.window.isin(["roll20", "roll60", "cumulative"]) | show.window.str.startswith("month:")]
        cols = [c for c in ("time_point", "objective", "line", "window", "date", "n", "hits", "mcc", "brier", "mae", "mae_skill", "sign_hits", "range80_hits") if c in show]
        with pd.option_context("display.width", 220):
            print(show[cols].to_string(index=False))
    else:
        print("정답이 붙은 예측이 아직 없습니다(대상일 = 기준일 뒤 5거래일).")
    for x in al:
        print(f"[경고:{x['level']}] {x.get('time_point')} {x['objective']} {x['what']} = {x['value']}")
    msgs = [f"{x.get('time_point')} {x['objective']} {x['what']} = {x['value']}" for x in al if x["level"] == "warn"]
    if msgs:
        import wk_notify
        wk_notify.send(f"KOSPI 주별 모니터링 {asof.date()}", msgs)
    return mt


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--asof")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    from wk_lock import service_lock
    with service_lock():
        run(a.asof or pd.Timestamp.now(tz="Asia/Seoul").tz_localize(None).normalize(), a.write)
