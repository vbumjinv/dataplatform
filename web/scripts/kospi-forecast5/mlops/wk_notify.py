"""[실사용 모듈] 주별 알림 보내기 자리 — 경고·실패·승격 후보를 한 함수로 모아 DB 경고 테이블 kospi5_mlops_alert(objective = 'notify')에 남긴다.

일별 service_daily/mlops/notify.py 와 같은 역할(일별 코드는 쓰지 않음). 사용처: run_automation.py(단계 실패·건너뜀), wk_monitor.py(저녁 경고), predict.py(지난 학습본·뉴스 0건),
retrain.py(재학습 실패·복구), evaluate.py 결과(승격 후보). 알림 채널(메일·메신저)이 생기면 여기만 고친다.
파일에 쓰지 않는다(2026-11-25 배포본, DB 만). DB 쓰기는 --write 실행에서만, 실패해도 예외를 내지 않는다 — 화면 출력이 작업 로그(outputs/logs)에 남는다.
"""
from __future__ import annotations

import sys

import pandas as pd

NOTIFY = "notify"                                                       # kospi5_mlops_alert.objective 값(저녁 모니터 경고와 구분, wk_monitor 가 지우지 않음)


def send(title: str, lines, level: str = "warn") -> None:
    """level: info·warn·error. 화면에 한 줄 출력하고, --write 실행이면 kospi5_mlops_alert 에 한 행 덧붙인다."""
    lines = [str(x) for x in (lines or [])]
    print(f"[알림:{level}] {title}" + "".join(f" | {x}" for x in lines[:3]), flush=True)
    if "--write" not in sys.argv[1:]:                                    # 시험 실행은 DB 에 쓰지 않는다
        return
    try:
        import wk_store
        now = wk_store.stamp_now()
        wk_store.append("kospi5_mlops_alert", pd.DataFrame([{
            "asof": str(pd.Timestamp.now(tz="Asia/Seoul").date()), "time_point": None, "objective": NOTIFY, "level": level,
            "what": title[:2000], "value": None, "detail": {"lines": lines}, "created_at": now}]))
    except Exception as ex:                                              # 알림 실패로 본 작업을 멈추지 않는다
        print(f"[주의] 알림 DB 기록 실패: {ex!r}", flush=True)
