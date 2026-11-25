"""[실사용 스크립트] 5거래일 예측(W0·W2)과 저녁 평가를 예약하거나 다시 실행한다.

기준일 종가 대기 중에는 결과를 저장하지 않는다. 쓰기 실행은 로그에만 진행과 실패를 남긴다.
예측 대상월이 바뀌면 같은 시점의 새 월간 모델을 준비한 뒤 예측한다.
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parent / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import argparse

import pandas as pd

import wk_data

FAILED: list[str] = []          # 이번 실행에서 실패한 단계('<작업>/<단계>: 이유') — 끝에서 종료 코드 1


def skip_step(job: str, name: str, reason: str, write: bool, *, detail=None) -> None:
    """다시 실행하지 않는 단계를 skipped + 이유로 기록한다(일별 '이미 실행해 저장된 예측입니다' 와 같은 자리)."""
    import wk_store
    print(f"[{job}/{name}] {reason}", flush=True)
    wk_store.job_end(wk_store.job_start(f"{job}/{name}", detail, write), "skipped", {**(detail or {}), "reason": reason})


def saved(tp: str, target, at) -> dict:
    """(대상일, 시점, prediction_at) 에 이미 저장된 것: predict(방향·수익률 행)·range(80·95% 범위)·shap(두 행 shap_result)·explain(status ok)."""
    import wk_store
    def rows(name):
        return wk_store.read(name, {"time_point": tp, "target_dd": target, "prediction_at": at})
    c, r, e = rows("kospi5_pred_cls"), rows("kospi5_pred_reg"), rows("kospi5_pred_explain")
    if len(c) != 1 or len(r) != 1:
        return {"predict": False, "range": False, "shap": False, "explain": False, "rows": {}}
    c, r = c.iloc[0].to_dict(), r.iloc[0].to_dict()
    return {"predict": True, "range": all(pd.notna(r[k]) for k in wk_store.RANGE),
            "shap": isinstance(c["shap_result"], dict) and isinstance(r["shap_result"], dict),
            "explain": bool(len(e) and ((e.status == "ok") & (e.cls_model_version == c["model_version"])
                                       & (e.reg_model_version == r["model_version"])).any()),
            "rows": {"cls": c, "reg": r}}


def step(job: str, name: str, fn, write: bool, *, detail=None):
    """단계 하나를 실행 기록(kospi5_mlops_job, job = '<작업>/<단계>', 일별 run_automation.step 과 같음)과 함께 돌린다.
    실패하면 기록·알림(kospi5_mlops_alert)만 남기고 (None, False) — 다음 단계는 호출한 쪽이 정한다(실행 전체를 멈추지 않음)."""
    import traceback
    import wk_notify
    import wk_store
    jid = wk_store.job_start(f"{job}/{name}", detail, write)
    try:
        r = fn()
        if name == "explain" and r.get("status") == "failed" and not r.get("row"):   # 문장이 있는 검사 실패(failed 행)는 예측과 함께 저장
            raise RuntimeError(r.get("error") or "해설 생성 실패")
    except Exception as ex:
        wk_store.job_end(jid, "failed", detail, (repr(ex) + chr(10) + traceback.format_exc())[:20000])
        wk_notify.send(f"KOSPI 주별 {job}/{name} 실패", [repr(ex)[:300]], level="error")
        FAILED.append(f"{job}/{name}: {repr(ex)[:300]}")
        return None, False
    wk_store.job_end(jid, "ok", detail)
    return r, True


def predict_day(tp: str, d, X, llm: bool, write: bool, *, auto_retrain=True, replace_result=False) -> str:
    """한 실행 시점의 결과를 준비해 검증 후 공개용 테이블에 함께 저장하고, 예측이 끝나면 다음 실행에 필요한 달의 학습본을 준비한다.
    재학습 → 예측이 아니라 예측 → 재학습(2026-11-25): 그달 마지막 예측 직후 다음 달용으로 학습해 두어 예측 시각이 밀리지 않는다."""
    result = _predict_day(tp, d, X, llm, write, replace_result=replace_result)
    if result == "ok" and auto_retrain and write:
        step(f"kospi5_{tp.lower()}_{pd.Timestamp(d):%Y%m%d}", "retrain_next", lambda: retrain_next(tp, d, write), write)
    return result


def retrain_next(tp: str, d, write: bool):
    """다음 실행(d 다음 날)의 대상월 학습본이 운영·챌린저 중 하나라도 없으면 지금 학습한다(학습 정답 = 지금까지 확정된 것, wk_data.training_cutoff).
    되돌린 달(wk_models.hold_month)은 건너뛴다. 실패하면 단계 실패로 남고, 다음 실행은 직전 학습본으로 예측한 뒤 다시 시도한다."""
    import retrain
    import wk_models
    nb = wk_data.base_day(tp, pd.Timestamp(d) + pd.Timedelta(days=1))
    need = wk_data.model_month(nb)
    slots = [f"{tp}_{o}" for o in ("cls", "reg")]
    stale = [(s, r) for s in slots for r in wk_models.ROLES
             if (wk_models.role_month(s, r) or need) < need and not (r == "champion" and wk_models.hold_month(s) >= need)]
    if not stale:
        return None
    print(f"{tp}: 다음 실행 대상월 {need} 학습본 준비 — {stale}", flush=True)
    wk_data.refresh()                                                  # 저장된 예측 재사용 경로에서는 원천을 아직 받지 않았다
    return retrain.run(tp, nb, wk_data.features(tp, write=write), write, run_day=d)


def _predict_day(tp: str, d, X, llm: bool, write: bool, *, replace_result=False) -> str:
    import predict
    import wk_explain
    import wk_models
    import wk_news_pick
    import wk_range
    import wk_shap
    import wk_store

    b = wk_data.base_day(tp, d)
    tgt, at = wk_data.target_day(b), wk_data.run_time(tp, d)
    job = f"kospi5_{tp.lower()}_{pd.Timestamp(d):%Y%m%d}"
    key = {"target_dd": tgt.date(), "time_point": tp, "prediction_at": at.isoformat()}
    detail = {**key, "base_dd": str(b.date()), "target_dd": str(tgt.date())}
    print(f"{tp}: 기준일 {b.date()} · 대상일 {tgt.date()} · {at.isoformat()}", flush=True)
    have = saved(tp, tgt, at) if write and not replace_result else {}
    if all(have.get(field) for field in ("predict", "range", "shap")):
        skip_step(job, "predict", "저장된 정상 예측 재사용", write, detail=detail)
        if not llm or have["explain"]:
            return "ok"
        _, ok = step(job, "source", wk_data.refresh, write, detail=detail)
        if not ok:
            return "failed"
        rows = have["rows"]
        shap = {obj: dict(row["shap_result"]) for obj, row in rows.items()}
        shap["cls"]["prob"] = rows["cls"]["yhat_probability"]
        shap["reg"]["actual"] = rows["reg"]["yhat_raw_value"]
        Xat = pd.DataFrame({"prediction_at": [at]}, index=[b])
        picked, ok = step(job, "news_pick", lambda: wk_news_pick.run(tp, b, Xat, shap), write, detail=detail)
        if ok:
            _, ok = step(job, "explain", lambda: wk_explain.run(
                tp, b, Xat, shap, picked, True, True, predictions=rows, bands=rows["reg"]), write, detail=detail)
        return "ok" if ok else "failed"

    features, ok = step(job, "source", lambda: X() if callable(X) else X, write, detail=detail)
    if not ok:
        return "failed"
    if b not in features.index:
        skip_step(job, "inputs", f"{b.date()} 기준일 입력 행 없음", write, detail=detail)
        return "skipped"

    def model_inputs(frame):
        _, _, result = wk_data.run_inputs(tp, d, frame, write=write)
        if tp == "W2" and write and "NEWS_OK" in result and result.loc[b, "NEWS_OK"] != 1:
            raise RuntimeError("W2 뉴스 변수 조회 또는 계산 실패")
        return result

    Xb, ok = step(job, "inputs", lambda: model_inputs(features), write, detail=detail)
    if not ok:
        return "failed"

    if write:
        month = tgt.strftime("%Y%m")

        def model_ready():
            active = [wk_models.role_month(f"{tp}_{obj}") for obj in ("cls", "reg")]
            if not all(active):
                raise FileNotFoundError(f"{tp}: 운영 학습본이 없습니다(run_mlops_setup.py 로 첫 학습본 등록).")
            if any(m > month for m in active):
                raise ValueError(f"{tp} 대상월 {month}: 더 늦은 달의 모델을 과거 예측에 사용할 수 없습니다.")
            if active != [month, month]:                               # 재학습 실패·되돌리기: 직전 학습본으로 예측(일별 check_month 와 같은 규칙)
                print(f"[주의] {tp} 대상월 {month} 학습본 없음 — 직전 학습본({', '.join(active)})으로 예측", flush=True)

        _, ok = step(job, "model_ready", model_ready, write, detail=detail)
        if not ok:
            return "failed"

    prepared, ok = step(job, "predict", lambda: predict.run(
        tp, b, Xb, False, trading=wk_data.is_session(d), with_range=False, staged=True), write, detail=detail)
    if not ok:
        return "failed"
    res, tables = prepared
    rows = {obj: tables[i][1].iloc[0].to_dict() for i, obj in enumerate(("cls", "reg"))}

    def bands_for_prediction():
        p, cls_ver = res["cls"]["champion"]
        r, reg_ver = res["reg"]["champion"]
        bands = wk_range.predict_range(tp, b, p, r, versions=(cls_ver, reg_ver))
        vals = [bands.get(k) for k in wk_store.RANGE]
        if not all(pd.notna(v) and abs(v) < float("inf") for v in vals) or not vals[2] <= vals[0] <= vals[1] <= vals[3]:
            raise ValueError("80%·95% 예측 범위의 값과 순서를 확인하세요.")
        return bands

    bands, ok = step(job, "range", bands_for_prediction, write, detail=detail)
    if not ok:
        return "failed"
    rows["reg"].update(bands)
    tagged, ok = step(job, "shap", lambda: wk_shap.run(tp, b, Xb, False, predictions=rows, staged=True),
                      write, detail=detail)
    if not ok:
        return "failed"
    shap, shap_rows = tagged
    rows["cls"]["shap_result"] = shap_rows["cls"]
    rows["reg"]["shap_result"] = shap_rows["reg"]
    explanation = None
    if llm or not write:
        picked, ok = step(job, "news_pick", lambda: wk_news_pick.run(tp, b, Xb, shap), write, detail=detail)
        if not ok:
            return "failed"
        explained, ok = step(job, "explain", lambda: wk_explain.run(
            tp, b, Xb, shap, picked, llm, False, predictions=rows, bands=bands, staged=True), write, detail=detail)
        if not ok:
            return "failed"
        explanation = explained.get("row")

    if write:
        tables[:2] = [(f"kospi5_pred_{obj}", pd.DataFrame([rows[obj]])) for obj in ("cls", "reg")]
        _, ok = step(job, "publish", lambda: wk_store.publish_prediction(key, tables, explanation), write, detail=detail)
    return "ok" if ok else "failed"


def _raise(error):
    raise error


RETRY_DAYS = 2                                                         # 예약 실행이 다시 시도하는 지난날 수(2026-11-25)


def run_when_ready(tp, day, run, *, write, wait_minutes=0):
    """입력 대기 중에는 저장소 잠금을 비운다. 결과가 없으면 다음 실행에서 같은 키로 다시 시도한다."""
    from time import monotonic, sleep
    from wk_lock import StoreBusy, service_lock
    import wk_notify
    import wk_readiness
    deadline = monotonic() + wait_minutes * 60
    while True:
        try:
            reason = wk_readiness.pending(tp, day) if write and tp != "evening" else None
        except Exception as exc:
            reason = f"입력 준비 확인 실패: {exc!r}"
        if reason is None:
            try:
                with service_lock(write):
                    result = run()
                if result != "skipped":
                    return result
                reason = "예측 기준일의 입력 행이 아직 없음"
            except StoreBusy as exc:
                reason = str(exc)
        print(f"[{tp} {pd.Timestamp(day).date()}] {reason}", flush=True)
        remaining = deadline - monotonic()
        if remaining <= 0:
            wk_notify.send(f"KOSPI 5거래일 {tp} {pd.Timestamp(day).date()} 예측 보류", [reason], level="warn")
            return "skipped"
        sleep(min(120, remaining))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=["w0", "w2", "evening"])
    ap.add_argument("--date", help="실행일(기본 오늘, KST)")
    ap.add_argument("--from", dest="start", help="여러 날 실행 시작일(소급)")
    ap.add_argument("--to", dest="end", help="여러 날 실행 끝일(포함)")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--replace-result", action="store_true", help="같은 실행 시점의 정상 결과를 다시 계산해 교체")
    ap.add_argument("--llm", action="store_true", help="w0·w2: GPT 해설 생성(유료, OPENAI_API_KEY). 없으면 해설 입력만 출력")
    ap.add_argument("--wait-minutes", type=int, choices=range(0, 181), metavar="0–180", default=0,
                    help="종가·저장소가 준비될 때까지 기다릴 최대 분")
    ap.add_argument("--scheduled", action="store_true", help="서버 예약 실행(PostgreSQL 전용)")
    a = ap.parse_args()
    if a.replace_result and (not a.write or a.job == "evening"):
        ap.error("--replace-result는 예측 작업에서 --write와 함께 사용하세요.")
    if a.scheduled:
        import os
        if not a.write:
            ap.error("--scheduled에는 --write가 필요합니다.")
        a.llm |= os.getenv("KOSPI5_SCHEDULE_LLM", "0") == "1" and a.job != "evening"
    today = pd.Timestamp.now(tz="Asia/Seoul").tz_localize(None).normalize()
    days = list(pd.date_range(a.start, a.end or today)) if a.start else [pd.Timestamp(a.date) if a.date else today]
    if a.scheduled and not a.start and not a.date and a.job != "evening":
        days = [today - pd.Timedelta(days=k) for k in range(RETRY_DAYS, 0, -1)] + days   # 놓친 날 다시(저장된 날은 바로 건너뜀, 2026-11-25)
    if a.job == "evening":
        if not wk_data.is_session(days[-1]):
            print(f"{days[-1].date()} 휴장일: 저녁 평가를 건너뜀")
            return
        import wk_monitor
        job = f"kospi5_evening_{days[-1]:%Y%m%d}"

        def monitor():
            wk_data.refresh()
            step(job, "monitor", lambda: wk_monitor.run(days[-1], a.write), a.write)
            import evaluate
            res, _ = step(job, "compare", lambda: evaluate.run(a.write, asof=days[-1]), a.write)
            import wk_notify
            cand = [f"{r['slot']}: {r['challenger']}" for r in (res or []) if r.get("decision") == "승격 후보"]
            if cand:
                wk_notify.send(f"KOSPI 주별 승격 후보 {days[-1].date()} (run_promote.py promote <슬롯> 로 확인 뒤 승격)", cand, level="info")
            return None

        return run_when_ready("evening", days[-1], monitor, write=a.write, wait_minutes=a.wait_minutes)
    from functools import lru_cache
    tp = a.job.upper()

    @lru_cache(maxsize=1)
    def X(news_cutoff):
        wk_data.refresh()
        return wk_data.features(tp, write=a.write, news_cutoff=news_cutoff)

    failed = []
    for d in days:
        cutoff = wk_data.news_cutoff(tp, wk_data.run_time(tp, d))
        try:
            def predict_once():
                status = predict_day(tp, d, lambda: X(cutoff), a.llm, a.write, replace_result=a.replace_result,
                                     auto_retrain=(d == days[-1]))      # 재학습은 마지막(오늘) 실행 뒤에만 — 지난날 재시도가 오래된 정답으로 학습하지 않게
                if status == "skipped":
                    X.cache_clear()
                return status
            r = run_when_ready(tp, d, predict_once, write=a.write,
                               wait_minutes=a.wait_minutes if d == days[-1] else 0)   # 지난날 재시도는 기다리지 않는다(오늘 예측이 밀리지 않게)
        except Exception as ex:                                        # 입력 만들기 등 단계 밖 오류: 그날만 실패로 기록·알림, 다음 날 계속
            step(f"kospi5_{tp.lower()}_{d:%Y%m%d}", "prepare", lambda: _raise(ex), a.write)
            r = "failed"
        if a.write:
            X.cache_clear()
        if r != "ok":
            failed.append((str(d.date()), r))
    if failed:
        print(f"\n{tp} 예측하지 못한 날 {len(failed)}일: " + "; ".join(f"{d} {r}" for d, r in failed))
        return "skipped"


def logged_main(operation=None, *, job=None):
    """main 을 실행 기록(kospi5_mlops_job, 일별 kospi_mlops_job 과 같음)으로 감싼다: 시작 running → 끝 ok·failed(오류·추적 내용). --write 일 때만 기록."""
    import sys
    import traceback
    import wk_store
    args = sys.argv[1:]
    write = "--write" in args
    FAILED.clear()
    job = job or (f"kospi5_{args[0]}" if args and args[0] in {"w0", "w2", "evening"} else "5")
    if "--scheduled" in args:
        wk_store.require_server_db()
    try:
        jid = wk_store.job_start(job, {"args": args}, write)
    except Exception:
        traceback.print_exc()
        jid = None
    try:
        status = (operation or main)()
        if FAILED:                                                     # 단계 실패: 다 돌린 뒤 실패로 끝냄(멈추지는 않음)
            msg = f"실패한 단계 {len(FAILED)}개\n" + "\n".join(FAILED)
            print("\n" + msg, flush=True)
            wk_store.job_end(jid, "failed", {"args": args, "failed_steps": FAILED}, msg[:20000])
            sys.exit(1)
    except BaseException as e:
        if isinstance(e, SystemExit) and FAILED:
            raise
        if isinstance(e, SystemExit) and e.code in (0, None):
            wk_store.job_end(jid, "ok", {"args": args})
            raise
        wk_store.job_end(jid, "failed", {"args": args}, (f"{type(e).__name__}: {e}" + chr(10) + traceback.format_exc())[:20000])
        raise
    wk_store.job_end(jid, "skipped" if status == "skipped" else "ok", {"args": args})
    return status


def quiet_write(operation=None, *, job=None):
    """쓰기 실행의 운영 오류를 화면 경로로 보내지 않고 일지에 남긴다."""
    if "--write" not in _sys.argv[1:]:
        return logged_main(operation, job=job)
    from contextlib import redirect_stderr, redirect_stdout
    import traceback

    _WP.LOGS.mkdir(parents=True, exist_ok=True)
    name = job or (_sys.argv[1] if _sys.argv[1] in ("w0", "w2", "evening") else "automation")
    with (_WP.LOGS / f"{name}.log").open("a", encoding="utf-8", buffering=1) as log:
        with redirect_stdout(log), redirect_stderr(log):
            code = 0
            try:
                if logged_main(operation, job=job) == "skipped":
                    code = 2                                           # 예측 보류(입력·DB 미준비): 실패(1)와 구분
            except SystemExit as exc:
                if exc.code:
                    print(f"작업 종료 코드 {exc.code}", flush=True)
                    code = exc.code if isinstance(exc.code, int) else 1
            except Exception:
                traceback.print_exc()
                code = 1
    if code:                                                           # cron·작업 스케줄러가 실패를 알 수 있게(로그는 위 파일)
        _sys.exit(code)


if __name__ == "__main__":
    quiet_write()
