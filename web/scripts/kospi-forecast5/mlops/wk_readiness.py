"""[실사용 모듈] 예약 시각과 기준일의 KOSPI 확정 종가를 확인한다."""
from __future__ import annotations

import pandas as pd

import wk_data


def pending(tp, day) -> str | None:
    at = wk_data.run_time(tp, day)
    if pd.Timestamp.now(tz="UTC") < wk_data.news_cutoff(tp, at):       # 뉴스 마감(W0 = 16:00 + 지연)까지 기다린다
        return "예측 기준 시각 대기"
    base = wk_data.base_day(tp, day)
    if not wk_data.close_ready(base):
        return f"{base.date()} KOSPI 확정 종가 적재 대기"
    return None
