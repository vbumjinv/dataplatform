"""[실사용 모듈] 시점 등록부 읽기 — 예측 시점 T0·T1·T2 의 시각을 service/time_points.json 한 곳에서 읽어 모든 코드에 준다.

코드는 시점 이름(T0·T1·T2, 소문자 t0 도 됨)만 받는다. 예측 시각·뉴스 집계 구간·예약 실행 시각·화면 이름·목적 이름(DIR_1D 등)은 모두 여기서 계산한다.
시각을 바꾸려면 time_points.json 의 time 만 고친다(이 파일은 바꾸지 않는다).
묶음: 등록부 models 아래 daily(일별) 묶음의 시점이 TPS 다. 주별 모델은 weekly 묶음을 더하고 group('weekly') 로 읽는다(일별 TPS 는 그대로).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import pandas as pd

FILE = Path(__file__).resolve().parents[1] / "time_points.json"
DAILY = "daily"


@lru_cache(maxsize=1)
def _reg():
    return json.loads(FILE.read_text(encoding="utf-8"))


def group(name: str = DAILY) -> dict:
    """모델 묶음(daily·weekly …): horizon·objectives·time_points."""
    return _reg()["models"][name]


def _all() -> dict:
    """모든 묶음의 시점 -> (묶음 이름, 설정). 시점 이름은 묶음 사이에 겹치지 않아야 한다."""
    out = {}
    for g, v in _reg()["models"].items():
        for tp, s in v["time_points"].items():
            if tp in out:
                raise ValueError(f"time_points.json: 시점 이름 {tp} 가 묶음 {out[tp][0]}·{g} 에 겹칩니다.")
            out[tp] = (g, s)
    return out


TPS = tuple(group(DAILY)["time_points"])          # 일별 운영 시점(T0·T1·T2)


def norm(tp: str) -> str:
    t = str(tp).strip().upper()
    if t not in _all():
        raise ValueError(f"등록되지 않은 시점입니다: {tp!r} (time_points.json: {', '.join(_all())})")
    return t


def spec(tp: str) -> dict:
    return _all()[norm(tp)][1]


def objective(tp: str, obj: str) -> str:
    """DB·CSV objective 열 값: 일별 분류 DIR_1D, 회귀 RET_1D(묶음의 objectives)."""
    return group(_all()[norm(tp)][0])["objectives"][obj]


def _hm(s: str):
    h, m = s.split(":")
    return int(h), int(m)


def hour_minute(tp: str):
    return _hm(spec(tp)["time"])


def time_str(tp: str) -> str:
    return spec(tp)["time"]


def tz() -> str:
    return _reg()["timezone"]


def checkpoint(tp: str) -> dict:
    """features/dataset.py 가 쓰는 시점 설정(name = 학습본 안 이름표)."""
    s = spec(tp)
    h, m = _hm(s["time"])
    return {"name": s["checkpoint_id"], "time_point": norm(tp), "anchor": s["anchor"], "hour": h, "minute": m, "desc": s["name"]}


def checkpoints() -> list:
    return [checkpoint(tp) for tp in TPS]


def checkpoint_id(tp: str) -> str:
    return spec(tp)["checkpoint_id"]


def tp_of(checkpoint_name: str) -> str:
    """학습본 안 이름표(T2_0830 등) → 시점 이름."""
    for tp in TPS:
        if spec(tp)["checkpoint_id"] == checkpoint_name or tp == checkpoint_name:
            return tp
    raise ValueError(f"등록되지 않은 시점 이름표: {checkpoint_name}")


def name(tp: str) -> str:
    """화면용 이름: '코스피 장 마감'."""
    return spec(tp)["name"]


def label(tp: str) -> str:
    """설명용: '코스피 장 마감(예측 전날 16:00)'."""
    s = spec(tp)
    return f"{s['name']}({s['when']} {s['time']})"


def short(tp: str) -> str:
    """그래프·출력용: 'T0 (예측 전날 16:00)'."""
    s = spec(tp)
    return f"{norm(tp)} ({s['when']} {s['time']})"


def cutoff(tp: str, target, prev_day=None) -> pd.Timestamp:
    """대상일 target 의 예측 기준 시각(KST). T0 처럼 직전 거래일 기준이면 prev_day(없으면 거래소 달력의 직전 거래일)를 쓴다."""
    s = spec(tp)
    if s["anchor"] == "prev_trading_day":
        if prev_day is None:
            import exchange_calendars as xcals
            prev_day = xcals.get_calendar("XKRX").previous_session(pd.Timestamp(target).normalize().tz_localize(None))
        day = pd.Timestamp(prev_day).normalize()
    else:
        day = pd.Timestamp(target).normalize()
    h, m = _hm(s["time"])
    day = day.tz_localize(None) if day.tzinfo is not None else day
    return (day + pd.Timedelta(hours=h, minutes=m)).tz_localize(tz())


def run_point(tp: str, day) -> tuple[pd.Timestamp, pd.Timestamp]:
    """실행일 day(KST 날짜)의 (대상일, 예측 기준 시각). 주말·휴일에도 실행한다(사용자 결정 2026-11-13).
    기준 시각 = 실행일의 시점 시각(토요일 T0 → 토 16:00). 대상일 = T0 는 실행일 다음 첫 거래일, T1·T2 는 실행일 포함 첫 거래일
    (금·토·일 T0, 토·일·월 T1·T2 → 모두 월요일). 거래일에 실행하면 cutoff(tp, 대상일) 과 같다."""
    import exchange_calendars as xcals
    day = pd.Timestamp(day)
    day = (day.tz_localize(None) if day.tzinfo is not None else day).normalize()
    first = day + pd.Timedelta(days=1) if spec(tp)["anchor"] == "prev_trading_day" else day
    target = pd.Timestamp(xcals.get_calendar("XKRX").date_to_session(first, direction="next"))
    h, m = hour_minute(tp)
    return target.tz_localize(None) if target.tzinfo is not None else target, (day + pd.Timedelta(hours=h, minutes=m)).tz_localize(tz())


def run_day(tp: str, now=None) -> pd.Timestamp:
    """지금 시각 이전 가장 최근 시점 시각의 실행일(오늘 시점 시각 전이면 어제)."""
    now = pd.Timestamp.now(tz=tz()) if now is None else pd.Timestamp(now).tz_convert(tz())
    h, m = hour_minute(tp)
    day = now.tz_localize(None).normalize()
    return day if now.tz_localize(None) >= day + pd.Timedelta(hours=h, minutes=m) else day - pd.Timedelta(days=1)


def evening_run():
    """저녁 작업(정답 결합·지표·경고) 예약 (시, 분)."""
    return _hm(_reg()["evening_run"])


def market_close():
    """코스피 장 마감 (시, 분): 뉴스 집계·근거 기사 구간의 시작."""
    return _hm(_reg()["market_close"])


def market_close_str() -> str:
    return _reg()["market_close"]


def run_at(tp: str):
    """예약 실행 시각 (시, 분) = 예측 기준 시각 + run_delay_minutes."""
    h, m = hour_minute(tp)
    t = h * 60 + m + int(spec(tp).get("run_delay_minutes", 0))
    return (t // 60) % 24, t % 60
