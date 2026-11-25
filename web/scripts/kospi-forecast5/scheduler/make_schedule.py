"""[실사용 스크립트] 주별 예약 시각 만들기 — service_5/time_points.json 의 시점 시각으로 cron(crontab.example)·Windows 작업 스케줄러 명령을 만든다(일별 scheduler/make_schedule.py 와 같음).

실행(service_5): python scheduler/make_schedule.py            화면에 cron 줄·schtasks 명령 출력
                     python scheduler/make_schedule.py --write    scheduler/crontab.example 다시 쓰기
예약 시각 = 시점 시각(time) + run_delay_minutes, 저녁 작업 = time_points.json 의 evening_run(거래일만, 휴장일은 run_automation.py 가 건너뜀).
W0·W2 는 매일(주말·휴일 포함) 실행. 시점 시각을 바꾸면 이 스크립트를 다시 돌려 서버 crontab(또는 작업 스케줄러)을 새 줄로 바꾼다.
"""
from __future__ import annotations

import argparse
from shlex import quote
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "features"))
import timepoints as TPR  # noqa: E402


def jobs():
    """(작업 이름, 시, 분, cron 요일) — 실행 시각 순."""
    rows = [(tp.lower(), *TPR.schedule_time(tp), "*") for tp in TPR.points()]
    h, m = TPR.evening_run()
    rows.append(("evening", h, m, "1-5"))
    return sorted(rows, key=lambda r: (r[1], r[2]))


def crontab() -> str:
    lines = ["# [주별] crontab -e 에 일별 줄 아래로 붙여 넣는다(경로는 서버 위치로). scheduler/make_schedule.py --write 가 time_points.json 으로 만든 파일.",
             "# W0·W2 = 매일(주말·휴일 포함, W0는 당일 종가 또는 직전 종가, W2는 직전 종가, 대상일 = 기준일 + 5거래일), 저녁 = 거래일(휴장일은 run_automation.py 가 건너뜀).",
             "# W0·W2는 기준일 종가를 최대 90분 확인한다. W0·W2는 각자 예약 시각까지 DB에 적재된 뉴스를 쓴다.",
             "# 서버 시간대가 Asia/Seoul 이 아니면: CRON_TZ 를 지원하는 cron(cronie)인지 확인하거나, 서버를 KST 로 두거나, 아래 시각을 UTC 로 바꾼다(Debian/Ubuntu 기본 cron 은 CRON_TZ 를 무시).",
             f"CRON_TZ={TPR.tz()}"]
    for name, h, m, dow in jobs():
        script = quote(str(HERE / f"{name}.sh").replace("%", r"\%"))
        lines.append(f"{m:<2} {h:<2} * * {dow:<4} /bin/bash {script}")
    return "\n".join(lines) + "\n"


def schtasks() -> list[str]:
    out = []
    for name, h, m, dow in jobs():
        days = "/sc daily" if dow == "*" else "/sc weekly /d MON,TUE,WED,THU,FRI"
        bat = ROOT / "scheduler" / "run_job.bat"
        out.append(f'schtasks /create /tn "kospi5_{name}" /tr "\\"{bat}\\" {name}" {days} /st {h:02d}:{m:02d} /f')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    text = crontab()
    print(text)
    print("\n".join(schtasks()))
    if a.write:
        (HERE / "crontab.example").write_text(text, encoding="utf-8")
        print(f"썼음: {HERE / 'crontab.example'}")


if __name__ == "__main__":
    main()
