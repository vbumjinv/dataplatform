"""[실사용 스크립트] 주별 저녁 성능 모니터링 — 예측에 정답을 붙여 지표·경고를 기록하고 챔피언/챌린저를 비교한다(일별 run_monitor_daily.py 와 같은 자리).

실행(service_5): python -B run_monitor_5.py [--asof 2026-11-23] [--write]   (자료는 실행마다 DB 에서)
  출력: kospi5_mlops_metric·kospi5_mlops_alert(mlops/wk_monitor), 챔피언/챌린저 비교 kospi5_mlops_compare(mlops/evaluate, 챌린저가 있을 때), 실행 기록 kospi5_mlops_job.
  예약 실행은 run_automation.py evening(거래일 time_points.json evening_run 시각). 경고는 기록·알림만(멈추지 않음).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "mlops"))
import wk_paths as P  # noqa: E402

P.add_paths()

if __name__ == "__main__":
    import run_automation
    sys.argv = [sys.argv[0], "evening"] + [x if x != "--asof" else "--date" for x in sys.argv[1:]]
    run_automation.logged_main()                                       # 잠금은 run_when_ready 가 잡는다(여기서 또 잡으면 다른 연결이라 늘 StoreBusy)
