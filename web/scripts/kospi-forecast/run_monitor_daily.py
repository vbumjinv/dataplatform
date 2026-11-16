"""[실사용 스크립트] 매일 성능 모니터링 — 장 마감 뒤 세 시점(T0·T1·T2) 예측에 정답을 붙여 지표·범위 적중·입력 분포 변화·경고를 저장소에 기록하고 T2 챔피언/챌린저를 비교한다.

저장소: --mode db(dp 테이블) | csv(outputs/tables/<테이블>.csv), 빼면 .env KOSPI_MLOPS_MODE(기본 csv) — mlops/store.py.
실행(service 폴더): python run_monitor_daily.py --write              # 오늘까지
                   python run_monitor_daily.py --include-backfill        # 소급 기록 행도 비교에 포함(참고용)
                   (--write 없으면 계산·출력만, 저장소에 쓰지 않음)
입력: kospi_pred_cls·reg(시점별 챔피언 예측·범위·모델 입력), kospi_mlops_ledger(T2 챌린저 원장), DB KOSPI 종가(읽기 전용, 정답),
      kospi_mlops_model(drift_reference), kospi_mlops_role
출력(저장소, --write): kospi_mlops_metric — 시점·목적·계열별 이동 20·60일·월별·누적 지표(예측 + 정답에서만 계산, 매번 전부 다시 계산)
      kospi_mlops_alert — 경고(60일 주지표<0, 80% 범위 적중률<70%, 예측 누락일, 뉴스 0건 예측, 입력 PSI>0.25)
      kospi_mlops_compare — T2 챔피언/챌린저 판정,  kospi_mlops_job — 실행 기록
"""
from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

SERVICE = Path(__file__).resolve().parent
sys.path[:0] = [str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import champion_challenger as CC  # noqa: E402
import monitor as MO  # noqa: E402
import notify  # noqa: E402
import registry as R  # noqa: E402
from features import timepoints as TPR  # noqa: E402
from store import add_args, open_store  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="정답 결합 → 세 시점 지표·경고 → T2 챔피언/챌린저 비교 (저장소 기록)")
    ap.add_argument("--asof", help="기준일(기본 오늘)")
    ap.add_argument("--include-backfill", action="store_true")
    add_args(ap)
    a = ap.parse_args()
    asof = pd.Timestamp(a.asof) if a.asof else pd.Timestamp.now(tz=TPR.tz()).tz_localize(None).normalize()
    st = open_store(a.write, a.mode)
    st.require_tables()
    job = st.job_start("monitor_daily", {"asof": str(asof.date())})
    try:
        import predict_range as PR
        close = PR.kospi_close()
        close = close[close.index <= asof]
        roles = st.roles()
        ev = MO.evaluations(st, TPR.TPS, roles, close)
        if ev.empty:
            raise RuntimeError("저장된 예측이 없습니다. run_predict.py --tp <시점> --write 를 먼저 실행하세요.")
        ev = ev[ev.target_dd <= asof]
        n_wait = int(ev.actual_return.isna().sum())
        print(f"평가 {len(ev)}행(시점 {sorted(ev.time_point.unique())}), 정답 있음 {len(ev) - n_wait}행, 정답 대기 {n_wait}행 | {st.describe()}")

        mt = MO.metrics_table(ev, prospective_only=not a.include_backfill)
        manifests = {m["model_version"]: m for o in ("cls", "reg") for m in R.versions(st, o)}
        dr = MO.drift(ev if a.include_backfill else ev[ev.prospective], manifests)
        import exchange_calendars as xcals
        # 원천 종가가 누락된 거래일도 예측 누락 검사에 포함한다.
        trading = pd.DatetimeIndex(xcals.get_calendar("XKRX").sessions_in_range(ev.target_dd.min(), asof)).tz_localize(None)
        al = MO.alerts(ev, mt, dr, trading[-20:], TPR.TPS)
        missing_actuals = trading[-20:].difference(MO.actuals(close).dropna().index)
        if len(missing_actuals):
            al.append({"level": "warn", "time_point": None, "objective": None,
                       "what": "정답 종가 또는 직전 거래일 종가 누락", "value": len(missing_actuals),
                       "dates": [str(d.date()) for d in missing_actuals]})
        t2 = ev[ev.time_point == "T2"]
        results = [CC.compare(t2, obj, roles, prospective_only=not a.include_backfill) for obj in roles]

        n_m = st.metrics_put(mt) if len(mt) else 0
        n_a = st.alerts_put(asof, al)
        n_c = st.compare_put(asof, results)
        print(f"저장소 기록: 지표 {n_m}행, 경고 {n_a}건, 비교 {n_c}건")

        latest = (pd.concat([g.sort_values("date").tail(1) for _, g in mt.groupby(["time_point", "objective", "line", "window"])])
                  if len(mt) else mt)
        show = latest[latest.window.isin(["roll20", "roll60", "cumulative"])] if len(latest) else latest
        cols = [c for c in ("time_point", "objective", "line", "window", "date", "n", "hits", "mcc", "brier", "mae", "mae_skill", "sign_hits",
                            "range80_hits") if c in show]
        pd.set_option("display.width", 220)
        print(show[cols].to_string(index=False) if len(show) else "정답이 붙은 예측이 아직 없습니다.")
        for r in results:
            print(f"[비교 T2] {r['objective']}: {r['decision']} (공통 {r.get('common_days', 0)}일, 차이 {r.get('diff', float('nan')):.4f})")
        for x in al:
            print(f"[경고:{x['level']}] {x.get('time_point')} {x['objective']} {x['what']} = {x['value']}")
        if len(dr):
            print("PSI 상위:", dr.sort_values("psi", ascending=False).head(5)[["time_point", "objective", "feature", "psi"]].to_dict("records"))
        msgs = [f"{x.get('time_point')} {x['objective']} {x['what']} = {x['value']}" for x in al if x["level"] == "warn"]
        msgs += [f"T2 {r['objective']}: 챌린저 {r['challenger']} 승격 후보 (차이 {r['diff']:.4f})" for r in results if r["decision"] == "승격 후보"]
        if msgs:
            notify.send(f"KOSPI 모니터링 {asof.date()}", msgs)
        st.job_end(job, "ok", {"rows": len(ev), "waiting": n_wait, "alerts": len(al),
                               "decisions": {r["objective"]: r["decision"] for r in results}})
    except Exception as e:
        st.job_end(job, "failed", None, f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
        notify.send(f"KOSPI 모니터링 실패 {asof.date()}", [f"{type(e).__name__}: {e}"], level="error")
        raise


if __name__ == "__main__":
    main()
