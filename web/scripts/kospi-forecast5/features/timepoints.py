"""[실사용 모듈] 주별 시점 시각 읽기 — time_points.json(루트) 한 곳에서 W0·W2 예측 시각·저녁 작업 시각·목적 이름을 읽는다(일별 features/timepoints.py 와 같은 역할).

코드·DB 는 시점 이름(W0·W2)만 쓰고 시각은 여기서만 읽는다. 시각을 바꾸면 예측 시각(prediction_at)·뉴스 창·변수 정렬 시각(kw.config)·예약 줄
(scheduler/make_schedule.py)이 함께 바뀐다. 파일만 고치면 다음 실행부터 바로 반영된다(해시·manifest 없음).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import pandas as pd

FILE = Path(__file__).resolve().parents[1] / "time_points.json"


@lru_cache(maxsize=1)
def registry() -> dict:
    return json.loads(FILE.read_text(encoding="utf-8"))


def tz() -> str:
    return registry().get("timezone", "Asia/Seoul")


def points() -> dict:
    """{시점: {anchor, time, run_delay_minutes, name, when, checkpoint_id}}."""
    return registry()["models"]["5"]["time_points"]


def objectives() -> dict:
    """{"cls": "DIR_5D", "reg": "RET_5D"} — DB objective 열 값."""
    return registry()["models"]["5"]["objectives"]


def hour_minute(tp: str) -> tuple[int, int]:
    h, m = points()[tp]["time"].split(":")
    return int(h), int(m)


def offset(tp: str) -> pd.Timedelta:
    """하루 시작에서 예측 시각까지(예: W0 16:00 → 16시간)."""
    h, m = hour_minute(tp)
    point = pd.Timedelta(hours=h, minutes=m)
    if tp == "W2":
        point += pd.Timedelta(minutes=int(points()[tp].get("run_delay_minutes", 0)))
        if not pd.Timedelta(0) <= point < pd.Timedelta(days=1):
            raise ValueError("W2 예약 시각은 같은 실행일 00:00~23:59에 있어야 합니다.")
    return point


def run_time(tp: str, run_day) -> pd.Timestamp:
    """실행일의 예측 시각(prediction_at, UTC)."""
    return (pd.Timestamp(run_day).normalize() + offset(tp)).tz_localize(tz()).tz_convert("UTC")


def evening_run() -> tuple[int, int]:
    h, m = registry().get("evening_run", "19:00").split(":")
    return int(h), int(m)


def news_cutoff(tp: str, prediction_at) -> pd.Timestamp:
    """뉴스 마감 = 예약 실행 시각(W0 는 예측 시각 + run_delay_minutes, W2 는 예측 시각에 이미 포함). 이 시각까지 DB 에 적재된 기사만 쓴다.
    뉴스 기간 끝은 예측 시각 그대로라 학습과 같고, 지연은 16:00 뉴스 처리(16:00~16:04) 적재를 기다리는 몫(2026-11-25)."""
    delay = int(points()[tp].get("run_delay_minutes", 0)) if tp == "W0" else 0
    return pd.Timestamp(prediction_at) + pd.Timedelta(minutes=delay)


def schedule_time(tp: str) -> tuple[int, int]:
    """W2의 예약 실행과 자료 마감은 같은 시각이다."""
    delay = int(points()[tp].get("run_delay_minutes", 0)) if tp == "W0" else 0
    t = pd.Timestamp("2000-01-01") + offset(tp) + pd.Timedelta(minutes=delay)
    return t.hour, t.minute
