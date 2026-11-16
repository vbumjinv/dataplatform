"""[실사용 모듈] 재학습 격자 주기 — 대상월이 grid search 하는 달인지 정한다(매달 재학습, 격자는 3개월마다).

사용처: run_retrain.py(입구, --grid), train/retrain_f0.py·f0_trainer.py(T0·T1 정형 F0), train/retrain_t2.py·trainer.py(T2 뉴스 모델)
규칙(사용자 결정 2026-11-04): 매달 새 자료로 다시 학습하되 파라미터는 직전 학습본 값을 그대로 쓰고,
  대상월이 GRID_MONTHS(1·4·7·10월, 분기 첫 달)일 때만 격자로 파라미터를 다시 고른다.
  직전 파라미터가 없으면(첫 학습·구성 변경) 그달에도 격자를 돌린다.
"""
from __future__ import annotations

import pandas as pd

GRID_MONTHS = (1, 4, 7, 10)
CHOICES = ("auto", "on", "off")


def grid_due(month: str, mode: str = "auto") -> bool:
    """month: 'YYYY-MM' 대상월. mode: auto(GRID_MONTHS 만) | on(항상) | off(직전 파라미터 고정)."""
    if mode not in CHOICES:
        raise ValueError(f"grid mode {mode!r}: {CHOICES} 중 하나")
    if mode != "auto":
        return mode == "on"
    return pd.Period(month, freq="M").month in GRID_MONTHS


def next_grid_month(month: str) -> str:
    """month 다음(포함하지 않음)으로 격자를 돌리는 첫 대상월."""
    p = pd.Period(month, freq="M") + 1
    while p.month not in GRID_MONTHS:
        p += 1
    return p.strftime("%Y-%m")


def add_args(ap) -> None:
    ap.add_argument("--grid", choices=CHOICES, default="auto",
                    help="격자 탐색: auto(1·4·7·10월 대상월만, 기본) | on(이번에 격자) | off(직전 파라미터로 재학습만)")
