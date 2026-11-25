"""[실사용 스크립트] 주별 챔피언/챌린저 비교 — 운영 예측(kospi5_pred_*, 거래일 실행)과 챌린저 원장(kospi5_mlops_ledger)이 같이 예측했고 정답이 나온 기준일만 모아 비교한다.

일별 service_daily mlops/champion_challenger.py 와 같은 자리(2026-11-25 사용자 요청: 챌린저는 자리만 두고 일별처럼 운영).
판정: 공통 정답 일수 < wk_paths.MIN_COMPARE_DAYS(60, 일별 MIN_DAYS 와 같음) → '판정 보류'.
  그 이상이면 주별 판정 규칙(사용자 결정 2026-11-19)으로 방향(cls) = 챌린저 MCC 또는 정확도가 더 높으면, 수익률(reg) = 챌린저 MAE 가 더 낮으면 '승격 후보',
  아니면 '챔피언 유지'. 승격은 자동으로 하지 않고 사람이 run_promote.py promote <슬롯> 으로 한다('승격 후보'일 때만, --force 예외).
챌린저가 등록되지 않은 슬롯은 건너뛴다(지금은 등록된 챌린저 없음).
출력: kospi5_mlops_compare(asof x 슬롯 한 행, --write 일 때만). 실행: run_automation.py evening 의 단계 'compare', 단독 python evaluate.py [--refresh] [--write]
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import argparse

import numpy as np
import pandas as pd
from sklearn.metrics import matthews_corrcoef

import wk_data
import wk_models
import wk_paths as P
import wk_store

COMPARE = "kospi5_mlops_compare"                                 # 일별 kospi_mlops_compare 와 같은 열(이름은 kospi5_)


def scores(obj: str, yhat: pd.Series, ans: pd.DataFrame) -> dict:
    if obj == "cls":
        pred = (yhat >= 0.5).astype(int)
        y = ans["y_direction"].astype(int)
        return {"mcc": float(matthews_corrcoef(y, pred)), "acc": float((pred == y).mean())}
    return {"mae": float(np.abs(yhat - ans["y_return"]).mean())}


def better(obj: str, ch: dict, ca: dict) -> bool:
    return (ch["mcc"] > ca["mcc"] or ch["acc"] > ca["acc"]) if obj == "cls" else ch["mae"] < ca["mae"]


def family(v: str) -> str:
    """모델 이름에서 학습 달(_YYYYMM…)·뉴스 장애 표시(_struct)를 뗀 구조 이름. 월간 재학습으로 버전이 바뀌어도 같은 구조의 예측은 이어서 비교한다."""
    import re
    return re.sub(r"_\d{6}(_[A-Za-z0-9]+)*$", "", str(v))


def ledger() -> pd.DataFrame:
    """비교용 원장(열 slot·base_dd·target_dd·role·model_version·yhat): 챔피언 = 예측 테이블의 거래일 실행 행, 챌린저 = 챌린저 원장. 수익률은 K1 뒤 값."""
    import wk_monitor
    out = []
    for obj in ("cls", "reg"):
        df = wk_store.read(f"kospi5_pred_{obj}")
        if df.empty:
            continue
        df = wk_monitor._trading_rows(df)
        out.append(pd.DataFrame({"slot": df.time_point + "_" + obj, "base_dd": df.base_dd, "target_dd": df.target_dd, "role": "champion",
                                 "model_version": df.model_version, "yhat": (df.yhat_probability if obj == "cls" else df.yhat_value).astype(float)}))
    ch = wk_store.read("kospi5_mlops_ledger").sort_values("recorded_at")
    if len(ch):
        out.append(pd.DataFrame({"slot": ch.objective, "base_dd": wk_data.to_base(ch.target_dd), "target_dd": pd.to_datetime(ch.target_dd), "role": "challenger",
                                 "model_version": ch.model_version, "yhat": ch.yhat.astype(float)}))
    cols = ["slot", "base_dd", "target_dd", "role", "model_version", "yhat"]
    return pd.concat(out, ignore_index=True)[cols] if out else pd.DataFrame(columns=cols)


def compare(slot: str, ledger: pd.DataFrame, asof=None) -> dict | None:
    """지금 챔피언·챌린저 학습본 구조의 예측이 둘 다 있고 정답이 나온 기준일로 비교. 챌린저가 없으면 None."""
    champ, chall = wk_models.load(slot, "champion"), wk_models.load(slot, "challenger")
    if champ is None or chall is None:
        return None
    if wk_models.version(slot, champ) == wk_models.version(slot, chall):
        raise ValueError(f"{slot}: 챔피언과 챌린저 model_version 이 같습니다. 챌린저의 model_version 을 다르게 지정하세요.")
    L = ledger[ledger.slot == slot]
    pair = {}
    for role, m in (("champion", champ), ("challenger", chall)):
        r = L[(L.role == role) & (L.model_version.map(family) == family(wk_models.version(slot, m)))].drop_duplicates("base_dd", keep="last")
        pair[role] = r.set_index(pd.to_datetime(r.base_dd))["yhat"].astype(float)
    days = pair["champion"].index.intersection(pair["challenger"].index)
    ans = wk_data.answers(days).dropna(subset=["y_return"]) if len(days) else pd.DataFrame(columns=["target_dd", "y_return", "y_direction"])
    if asof is not None and len(ans):
        ans = ans[pd.DatetimeIndex(ans.target_dd) <= pd.Timestamp(asof)]
    days = ans.index
    obj = slot.split("_")[1]
    out = {"slot": slot, "champion": wk_models.version(slot, champ), "challenger": wk_models.version(slot, chall), "n_days": len(days)}
    if len(days):
        out["champion_score"] = scores(obj, pair["champion"].reindex(days), ans)
        out["challenger_score"] = scores(obj, pair["challenger"].reindex(days), ans)
        out["challenger_better"] = better(obj, out["challenger_score"], out["champion_score"])
    need = P.MIN_COMPARE_DAYS
    out["decision"] = (f"판정 보류({len(days)}/{need}일)" if len(days) < need else "승격 후보" if out["challenger_better"] else "챔피언 유지")
    return out


def run(write: bool, asof=None) -> list[dict]:
    """챌린저가 등록된 슬롯만 비교해 기록한다(승격하지 않음)."""
    if not any(wk_models.load(s, "challenger") for s in P.SLOTS):
        print("[비교] 등록된 챌린저가 없습니다.")
        return []
    L = ledger()
    res = [c for c in (compare(slot, L, asof) for slot in P.SLOTS) if c is not None]
    for c in res:
        print(c)
    save_compare(res, asof, write)
    return res


def save_compare(res: list[dict], asof, write: bool) -> None:
    """비교 결과를 kospi5_mlops_compare 에(같은 asof·objective 행은 바꿔 넣음). objective = 슬롯(W0_cls 등), 점수 = 주지표(방향 MCC·수익률 MAE).
    신뢰구간(ci_lo·ci_hi)은 주별 비교가 점수 비교라 비운다(일별은 월 블록 부트스트랩)."""
    day = str(pd.Timestamp(asof or pd.Timestamp.now(tz="Asia/Seoul").tz_localize(None)).date())
    main = {"cls": "mcc", "reg": "mae"}
    rows = []
    for c in res:
        k = main[c["slot"].split("_")[1]]
        cs, hs = (c.get("champion_score") or {}).get(k), (c.get("challenger_score") or {}).get(k)
        rows.append({"asof": day, "objective": c["slot"], "champion": c.get("champion"), "challenger": c.get("challenger"), "common_days": c.get("n_days", 0),
                     "champion_score": cs, "challenger_score": hs, "decision": c.get("decision"),
                     "detail": {k: c[k] for k in ("champion_score", "challenger_score", "challenger_better") if k in c}})
    if rows:
        wk_store.upsert(COMPARE, pd.DataFrame(rows), write)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="DB 원천을 새로 받아 정답(대상일 종가)을 갱신")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    if a.refresh:
        wk_data.refresh()
    run(a.write)


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
