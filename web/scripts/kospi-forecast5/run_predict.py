"""[실사용 스크립트] 주별 예측 한 번 — 시점(W0·W2) 하나의 실행일 예측 → 범위 → SHAP → 근거 기사 → (LLM 해설)을 저장한다(일별 run_predict.py 와 같은 자리).

실행(service_5): python -B run_predict.py --tp W2 [--date 2026-11-18] [--llm] [--write]   (자료는 실행마다 DB 에서)
  --date 실행일(기본 오늘, 주말·휴일 포함 — 기준일 = 직전 거래일), --write 없으면 저장 없이 출력만, --llm 없으면 해설 입력만 출력(유료 호출 없음).
  예약 실행은 run_automation.py w0·w2(같은 함수 predict_day). 단계마다 실행 기록(kospi5_mlops_job), 실패는 기록·알림만 하고 멈추지 않는다.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "mlops"))
import wk_paths as P  # noqa: E402

P.add_paths()

import argparse  # noqa: E402

import pandas as pd  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    ap.add_argument("--date", help="실행일(기본 오늘, KST)")
    ap.add_argument("--llm", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--wait-minutes", type=int, choices=range(0, 181), metavar="0–180", default=0)
    a = ap.parse_args()
    import run_automation
    import wk_data
    d = pd.Timestamp(a.date) if a.date else pd.Timestamp.now(tz="Asia/Seoul").tz_localize(None).normalize()
    cutoff = wk_data.news_cutoff(a.tp, wk_data.run_time(a.tp, d))

    def X():
        wk_data.refresh()
        return wk_data.features(a.tp, write=a.write, news_cutoff=cutoff)

    return run_automation.run_when_ready(
        a.tp, d, lambda: run_automation.predict_day(a.tp, d, X, a.llm, a.write, replace_result=a.write),
        write=a.write, wait_minutes=a.wait_minutes)


if __name__ == "__main__":
    import run_automation
    run_automation.quiet_write(main, job="kospi5_predict")
