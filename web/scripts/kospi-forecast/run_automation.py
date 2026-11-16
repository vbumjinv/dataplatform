"""[실사용 스크립트] 자동화 통합 실행 — 시점별 예측(T0·T1·T2)·저녁 모니터링 작업을 정해진 순서로 돌리고, 그달 마지막 예측 직후 다음 달용 재학습까지 한다. 노트북·서버 같은 명령.

저장소: --mode db(dp 테이블) | csv(outputs/tables/<테이블>.csv), 빼면 .env KOSPI_MLOPS_MODE(기본 csv) — mlops/store.py.
        예측·해설(kospi_pred_*)과 자동화 기록(kospi_mlops_*)이 같은 모드·같은 이름·같은 열이다. 정형 원천·dp.news_feature_orig 는 운영 DB에서 읽기만 한다.
실행(service 폴더):
  예약 시각은 service/time_points.json(시점 시각 + run_delay_minutes, scheduler/make_schedule.py 가 cron 줄을 만듦). 지금 값:
  python run_automation.py t0 --write        # 매일 16:00(주말·휴일 포함): 다음 거래일 T0 예측·범위·SHAP(·해설) 저장 → [그 대상일이 그달 마지막 거래일이면] 다음 달용 T0 재학습·배포
                                             #   재학습은 세 시점 모두 run_retrain.py --tp <시점> (학습 방식은 시점별로 그 안에서 고름)
  python run_automation.py t1 --write        # 매일 02:00(주말·휴일 포함, 대상일 = 그날 또는 다음 거래일): [뉴스 피처] → T1 예측·범위·SHAP(·해설) → [그달 마지막 거래일이면] 다음 달용 T1 재학습·배포
  python run_automation.py t2 --write        # 매일 08:30(주말·휴일 포함, 대상일 = 그날 또는 다음 거래일): [뉴스 피처] → T2 예측·범위·SHAP(·해설) → T2 챌린저 원장
                                             #   → [그달 마지막 거래일이면] 다음 달용 T2 재학습·등록·배포
  python run_automation.py evening --write   # 거래일 장 마감 뒤(19:00): 정답 결합 → 세 시점 지표·경고 → 챔피언/챌린저 비교(T2)
  --write 없으면 각 단계가 dry-run(계산·출력만, 저장 없음). --mode 는 원장·모니터링·T2 재학습 스크립트에 그대로 넘긴다
  (빼면 .env 의 KOSPI_MLOPS_MODE, 없으면 csv). --date YYYY-MM-DD 로 실행일 지정(시험용).
주말·휴일 실행(2026-11-13): prediction_at = 실행일 시점 시각, 같은 대상일에 실행일마다 예측·해설 행이 쌓인다. 챌린저 원장·재학습은 거래일 실행만.
재학습 시각(사용자 결정 2026-11-04): 시점마다 "대상일이 이번 달인 마지막 예측"을 마친 직후 다음 달용 학습본을 학습·배포한다.
  매달은 직전 파라미터로 새 자료 재학습, grid search 는 대상월이 1·4·7·10월일 때만(train/grid_schedule.py, 각 재학습 스크립트가 판단).
  대상월 학습본은 그달 직전 거래일을 gap 으로 빼므로 그때 자료가 모두 있고, 다음 예측(다음 달 첫 거래일)까지 약 하루 여유가 있다.
  월말 재학습을 놓치거나 실패하면 다음 거래일부터 같은 작업이 예측 직후 그달 학습본을 다시 시도한다(그날 예측은 직전 학습본 + 경고).
  T0(직전 거래일 16:00 예측)은 그달 끝에서 두 번째 거래일 16:00 예측(대상일 = 마지막 거래일) 직후가 된다(2026-11-04 추가).
예측 단계는 세 시점 모두 run_predict.py --tp <시점> --write --mode <저장소>(예측 → 범위 → SHAP·해설)이다.
  재학습 스크립트는 배포 뒤 그 시점만 mlops/post_deploy.py 로 예측 범위 이력·SHAP 배경·통합본을 새 학습본에 맞추고 슬롯을 저장소에 백업한다.
뉴스 자료 준비(T1·T2): KOSPI_RUN_NEWS_FEATURES=1 이면 예측 직전에 뉴스 피처 단계를 돌린다(아니면 서버 뉴스 처리가 예약 시각 전에 끝나 있어야 한다).
  T2 는 그 실행 시각을 --ready-through 로 넘긴다.
  대상일 기사가 0건이면 예측 화면 [주의]와 저녁 모니터링 경고(뉴스 0건)로 알린다.
설정(.env): KOSPI_RUN_NEWS_FEATURES=1  T1·T2 예측 전에 run_news_features.py 실행(유료 API, dp.news_feature_orig 쓰기)
           KOSPI_PREDICT_LLM=1        세 시점 GPT 해설(유료)
           KOSPI_RETRAIN_DEPLOY=1     T2 월간 재학습 뒤 챔피언 배포(기본 1, 0 이면 학습·등록만)
기록(저장소): 단계마다 kospi_mlops_job(작업·단계 이름, 상태, 오류), 실패는 mlops/notify.py 알림.
동시 실행: db 모드는 PostgreSQL advisory lock(노트북·서버 사이에도), csv 모드는 잠금 파일로 같은 작업이 겹치지 않게 한다.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import pandas as pd

SERVICE = Path(__file__).resolve().parent
sys.path[:0] = [str(SERVICE / "mlops"), str(SERVICE)]

import notify  # noqa: E402
from features import timepoints as TPR  # noqa: E402
from store import add_args, open_store  # noqa: E402


def flag(name, default="0") -> bool:
    return os.environ.get(name, default).strip() == "1"





@lru_cache(maxsize=1)
def calendar():
    import exchange_calendars as xcals
    return xcals.get_calendar("XKRX")


def is_trading_day(d: pd.Timestamp) -> bool:
    return bool(calendar().is_session(d.normalize()))


def retrain_month(tp: str, d: pd.Timestamp) -> str | None:
    """예측 직후 학습할 대상월(YYYY-MM) 또는 None(d = 그 예측의 대상일, T0 는 실행일의 다음 거래일). 대상일 d 가 그달 마지막 거래일이면 다음 달,
    아니어도 운영 슬롯이 d 의 달보다 이른 학습본이면(지난 월말 재학습을 놓침·실패) 그달을 다시 시도한다."""
    nxt = pd.Timestamp(calendar().next_session(d.normalize()))
    if nxt.month != d.month:
        return nxt.strftime("%Y-%m")
    month = d.strftime("%Y-%m")
    slot = json.loads((SERVICE / "model" / "artifacts" / tp / "cls_model_1_manifest.json").read_text(encoding="utf-8"))
    return month if slot["target_month"] < month else None


def step(st, job, name, args, required=True) -> bool:
    """하위 스크립트 하나를 실행하고 결과를 DB 작업 기록에 남긴다."""
    args = list(args)              # 저장 모드는 open_store 가 정한 환경변수(KOSPI_PRED_MODE·KOSPI_MLOPS_MODE)로 하위 스크립트에 넘어간다
    cmd = [sys.executable, *args]
    print(f"\n===== [{job}/{name}] {' '.join(args)}", flush=True)
    jid = st.job_start(f"{job}/{name}", {"cmd": args})
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    rc = subprocess.run(cmd, cwd=SERVICE, env=env).returncode
    st.job_end(jid, "ok" if rc == 0 else "failed", {"cmd": args, "returncode": rc}, None if rc == 0 else f"종료 코드 {rc}")
    if rc != 0:
        notify.send(f"KOSPI {job}/{name} 실패", [f"종료 코드 {rc}", " ".join(args)], level="error")
        if required:
            raise SystemExit(rc)
    return rc == 0


def predict_args(tp, target, w, prediction_at=None):
    """run_predict.py --tp 시점: 예측 → (저장할 때) 범위 → SHAP·해설. 시각은 service/time_points.json. 저장 모드는 환경변수로 넘어간다.
    prediction_at: 실행일 기준 시각(TPR.run_point). 주말 실행도 그날 시각으로 저장한다."""
    args = ["run_predict.py", "--tp", tp, "--target", str(target.date())]
    if prediction_at is not None:
        args += ["--prediction-at", prediction_at.isoformat()]
    if w:
        args.append("--write")
        if flag("KOSPI_PREDICT_LLM"):
            args.append("--llm")
    if tp == "T2":                       # 뉴스 단계를 마친 지금 시각까지 자료가 준비됐다고 넘긴다(당일 실행에 필요)
        ready = (pd.Timestamp.now(tz=TPR.tz()).isoformat(timespec="seconds")
                 if flag("KOSPI_RUN_NEWS_FEATURES") else os.environ.get("KOSPI_NEWS_READY_THROUGH"))
        if ready:
            args += ["--ready-through", ready]
    return args


def retrain_args(tp, month, w):
    """run_retrain.py --tp 시점: 그 시점 학습 방식으로 다음 달용 재학습 → (--write) 배포 → SHAP 배경. 저장 모드는 환경변수로 넘어간다."""
    args = ["run_retrain.py", "--tp", tp, "--month", month] + (["--write"] if w else [])
    if tp == "T2" and w and not flag("KOSPI_RETRAIN_DEPLOY", "1"):     # T2 는 --write 면 챔피언 배포, 끄면 학습·등록만
        args.append("--no-deploy")
    return args



def news_features(st, job, w):
    """뉴스를 쓰는 시점(T1·T2) 예측 직전 뉴스 피처 단계. 실패하면 뉴스가 빈 채로 예측하지 않도록 멈춘다."""
    if flag("KOSPI_RUN_NEWS_FEATURES"):
        from news.settings import FEATURE_TABLE, FEATURE_READ_TABLE
        if FEATURE_TABLE != FEATURE_READ_TABLE:
            raise RuntimeError(f'자동 뉴스 적재 대상({FEATURE_TABLE})과 예측 원천({FEATURE_READ_TABLE})이 다릅니다. '
                               '외부 원천 적재 완료를 확인하고 자동 적재 옵션을 끄세요.')
        step(st, job, "news_features", ["run_news_features.py", "--require-completion"] + ([] if w else ["--no-write", "--limit", "20"]))


def run_timepoint(st, d, w, tp):
    """실행일 d(주말·휴일 포함): 대상일 = T0 는 d 다음 첫 거래일, T1·T2 는 d 포함 첫 거래일, prediction_at = d 의 시점 시각.
    챌린저 원장·월간 재학습은 거래일 실행에서만 한다(주말 반복 실행으로 다시 돌지 않게)."""
    target, at = TPR.run_point(tp, d)
    trading = is_trading_day(d)
    job = tp.lower()
    if tp != 'T0':
        news_features(st, job, w)
    ok = step(st, job, 'predict', predict_args(tp, target, w, at), required=False)
    if tp == 'T2' and trading:
        step(st, job, 'record_predictions', ['run_record_predictions.py', '--target', str(target.date())] + (['--write'] if w else []))
    month = retrain_month(tp, target) if trading else None
    if month:
        step(st, job, 'retrain', retrain_args(tp, month, w))
    if not ok:
        raise SystemExit(1)


def t0(st, d, w):
    return run_timepoint(st, d, w, 'T0')


def t1(st, d, w):
    return run_timepoint(st, d, w, 'T1')


def t2(st, d, w):
    return run_timepoint(st, d, w, 'T2')


def evening(st, d, w):
    step(st, "evening", "monitor", ["run_monitor_daily.py", "--asof", str(d.date())] + (["--write"] if w else []))


JOBS = {"t0": t0, "t1": t1, "t2": t2, "evening": evening}


def main():
    ap = argparse.ArgumentParser(description="자동화 통합 실행")
    ap.add_argument("job", choices=list(JOBS))
    add_args(ap)
    ap.add_argument("--date", help="실행일 YYYY-MM-DD(기본 오늘 KST)")
    a = ap.parse_args()
    d = pd.Timestamp(a.date) if a.date else pd.Timestamp.now(tz=TPR.tz()).tz_localize(None).normalize()
    st = open_store(a.write, a.mode)
    st.require_tables()
    print(f"{a.job} {d.date()} | DB {st.describe()}", flush=True)
    if a.job == "evening" and not is_trading_day(d):          # 예측(t0·t1·t2)은 주말·휴일에도 다음 거래일을 예측한다(2026-11-13)
        print(f"{d.date()}: 휴장일이라 건너뜁니다.")
        return
    with st.lock(a.job) as locked:
        if not locked:
            print(f"{a.job}: 다른 곳(노트북/서버)에서 실행 중이라 건너뜁니다.")
            return
        JOBS[a.job](st, d, a.write)


if __name__ == "__main__":
    main()
