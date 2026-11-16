"""[실사용 스크립트] 예약 시각 만들기 — service/time_points.json 의 시점 시각으로 cron(crontab.example)·Windows 작업 스케줄러 명령을 만든다.

실행(service 폴더): python scheduler/make_schedule.py            화면에 cron 줄·schtasks 명령 출력
                    python scheduler/make_schedule.py --write    scheduler/crontab.example 다시 쓰기
예약 시각 = 시점 시각(time) + run_delay_minutes. 저녁 작업은 time_points.json 의 evening_run.
시점 시각을 바꾸면 이 스크립트를 다시 돌려 서버 crontab(또는 작업 스케줄러)을 새 줄로 바꾼다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from features import timepoints as TPR  # noqa: E402

ROOT = HERE.parent                     # 이 폴더가 놓인 실제 위치(서버에서 실행하면 서버 경로로 나옴)


def jobs():
    """(작업 이름, 시, 분) — 실행 시각 순."""
    rows = [(tp.lower(), *TPR.run_at(tp)) for tp in TPR.TPS]
    h, m = TPR.evening_run()
    rows.append(("evening", h, m))
    return sorted(rows, key=lambda r: (r[1], r[2]))


def crontab():
    head = ["# crontab -e 에 붙여 넣는다(경로는 이 스크립트를 실행한 폴더 기준). KOSPI_VENV 는 가상환경 폴더. 서버 시간대가 KST 가 아니면 CRON_TZ 지원(cronie) 확인.",
            "# 이 파일은 scheduler/make_schedule.py --write 가 service/time_points.json 시각으로 만든다(직접 고치지 말 것).",
            "# 월간 재학습은 따로 예약하지 않는다: t0·t1·t2 작업이 대상일이 그달 마지막 거래일이면 예측 직후 다음 달용으로 재학습한다.",
            f"CRON_TZ={TPR.tz()}", "KOSPI_VENV=/opt/kospi_venv"]
    return "\n".join(head + [f"{m:<2} {h:<2} * * {'1-5' if j == 'evening' else '*  '}  {ROOT.as_posix()}/scheduler/{j}.sh"
                             for j, h, m in jobs()]) + "\n"


def schtasks():
    """예측(t0·t1·t2)은 매일(주말·휴일에도 다음 거래일 예측, 2026-11-13), 저녁 작업은 평일."""
    return "\n".join(f'schtasks /Create /TN kospi_{j} /TR "{ROOT / "scheduler" / "run_job.bat"} {j}" '
                     + ("/SC WEEKLY /D MON,TUE,WED,THU,FRI" if j == "evening" else "/SC DAILY") + f" /ST {h:02d}:{m:02d} /F"
                     for j, h, m in jobs())


def main():
    ap = argparse.ArgumentParser(description="time_points.json 시각으로 예약 줄 만들기")
    ap.add_argument("--write", action="store_true", help="scheduler/crontab.example 다시 쓰기")
    a = ap.parse_args()
    for tp in TPR.TPS:
        h, m = TPR.run_at(tp)
        print(f"{tp}: 예측 기준 {TPR.time_str(tp)} ({TPR.name(tp)}) → 예약 실행 {h:02d}:{m:02d}")
    print("\n[cron]\n" + crontab() + "\n[Windows 작업 스케줄러]\n" + schtasks())
    if a.write:
        (HERE / "crontab.example").write_text(crontab(), encoding="utf-8", newline="\n")
        print("\n저장:", HERE / "crontab.example")


if __name__ == "__main__":
    main()
