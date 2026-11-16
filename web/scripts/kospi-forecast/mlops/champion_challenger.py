"""[실사용 모듈] 챔피언/챌린저 비교 — 두 계열이 모두 예측한 같은 거래일만으로 주지표 차이와 월 블록 부트스트랩 신뢰구간을 계산해 승격 여부를 판정한다.

사용처: run_monitor_daily.py, run_promote.py
입력: monitor.evaluations 결과의 T2 행(챔피언 = kospi_pred_*, 챌린저 = 원장, 정답 포함), 역할(store.roles(): 목적별 champion/challenger 계열)
판정: 공통 거래일 MIN_DAYS(60) 미만 -> '판정 보류'. 차이(챌린저 - 챔피언)의 부트스트랩 5% 하한 > 0 -> '승격 후보',
      95% 상한 < 0 -> '챔피언 우세', 나머지 -> '차이 없음(챔피언 유지)'. 승격은 사람이 run_promote.py 로 한다.
기본은 prospective(장 시작 전 기록) 행만 쓴다. 소급 기록은 참고용(--include-backfill).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from monitor import MAIN, metric_block

MIN_DAYS = 60
N_BOOT = 2000
SEED = 20261102


def paired(ev: pd.DataFrame, obj: str, champ: str, chal: str, prospective_only=True) -> pd.DataFrame:
    g = ev[(ev.objective == obj) & ev.line.isin([champ, chal])].dropna(subset=["actual_return"])
    if prospective_only:
        g = g[g.prospective]
    w = g.pivot_table(index="target_dd", columns="line", values="yhat", aggfunc="first")
    if champ not in w or chal not in w:
        return pd.DataFrame()
    w = w[[champ, chal]].dropna()
    act = g.drop_duplicates("target_dd").set_index("target_dd")[["actual_return", "actual_direction"]]
    return w.join(act, how="inner")


def _score(obj, frame, col):
    return metric_block(obj, frame.rename(columns={col: "yhat"}))[MAIN[obj]]


def compare(ev: pd.DataFrame, obj: str, lines: dict, prospective_only=True) -> dict:
    champ, chal = lines[obj]["champion"], lines[obj].get("challenger")
    res = {"objective": obj, "champion": champ, "challenger": chal, "metric": MAIN[obj], "prospective_only": prospective_only}
    if not chal:
        return {**res, "decision": "챌린저 없음"}
    p = paired(ev, obj, champ, chal, prospective_only)
    res["common_days"] = len(p)
    if len(p) == 0:
        return {**res, "decision": "판정 보류(공통 거래일 없음)"}
    res["start"], res["end"] = str(p.index.min().date()), str(p.index.max().date())
    res["champion_score"] = _score(obj, p, champ)
    res["challenger_score"] = _score(obj, p, chal)
    res["diff"] = res["challenger_score"] - res["champion_score"]
    res["champion_detail"] = metric_block(obj, p.rename(columns={champ: "yhat"}))
    res["challenger_detail"] = metric_block(obj, p.rename(columns={chal: "yhat"}))
    months = p.index.strftime("%Y-%m")
    groups = [p[months == m] for m in sorted(set(months))]
    if len(groups) >= 2:
        rng = np.random.default_rng(SEED)
        diffs = []
        for _ in range(N_BOOT):
            s = pd.concat([groups[i] for i in rng.integers(0, len(groups), len(groups))])
            diffs.append(_score(obj, s, chal) - _score(obj, s, champ))
        res["ci90"] = [float(np.nanpercentile(diffs, 5)), float(np.nanpercentile(diffs, 95))]
        res["p_challenger_better"] = float(np.mean(np.asarray(diffs) > 0))
    if len(p) < MIN_DAYS:
        res["decision"] = f"판정 보류(공통 거래일 {len(p)} < {MIN_DAYS})"
    elif "ci90" not in res:
        res["decision"] = "판정 보류(월 2개 미만)"
    elif res["ci90"][0] > 0:
        res["decision"] = "승격 후보"
    elif res["ci90"][1] < 0:
        res["decision"] = "챔피언 우세"
    else:
        res["decision"] = "차이 없음(챔피언 유지)"
    return res
