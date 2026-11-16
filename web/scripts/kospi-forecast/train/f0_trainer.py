"""[실사용 모듈] 정형 F0 월간 재학습 — 운영 학습본의 구성 모델·변수는 그대로 두고, 매달 새 자료로 다시 학습한다(파라미터 격자는 3개월마다).

사용처: train/retrain_f0.py(T0·T1 정형 F0, run_retrain.py --tp T0|T1), train/trainer.py(T2 정형 F0, 2026-11-04 통일)
입력: 정형 데이터셋 ds(정답 y_return·y_direction 포함), 지금 운영 학습본 manifest(구성 모델·변수·임계값·후처리)
출력: {'cls': 학습본, 'reg': 학습본} — predict/artifacts.predict_f0 가 읽는 형식(members·features·combine·threshold·post_rule)
규칙(experiments/daily/test/ml_t1fixed/03_run_monthly_grid.py task·04_train_final.py 와 같음, 사용자 결정 2026-10-30):
- 대상월 첫 거래일보다 앞선 행만 쓰고 그중 마지막 1거래일을 gap 으로 뺀다.
- 파라미터: 격자 달(train/grid_schedule.GRID_MONTHS, 1·4·7·10월 대상월)에만 다시 고르고, 다른 달은 지금 운영 학습본의
  members[이름].params 를 그대로 쓴다(사용자 결정 2026-11-04). 직전 파라미터가 없으면 그달에도 격자를 돌린다.
- 격자 달: 대상월 시작 12개월 전부터를 inner 로 두고, 그 앞 구간(마지막 1거래일 gap)으로 격자(estimators.F0_GRID)의 각 설정을 학습해
  inner 주지표(분류 MCC, 회귀 MAE 개선율)로 고른 뒤 학습 자료 전체로 다시 학습한다.
- 예외: manifest param_policy = fixed_no_grid 인 목적은 격자 달에도 직전 파라미터로 재적합만 한다(FIXED_POLICY, 목적별:
  T0 방향·수익률 2026-11-09, T1 수익률 2026-11-10). force_grid=True(--grid on)면 다시 고른다.
- 첫 파라미터(2026-10 학습본)는 세 시점 공통으로 experiments/daily/test/f0_fixed_params/02_select.py 가 85개월 월별 재학습 OOS 의
  검증·홀드아웃 순위로 고른 값이다(manifest param_policy = fixed_best_valhold, 사용자 결정 2026-11-04). 그 뒤 격자 달에는 위 inner 규칙으로 다시 고른다.
- 실험처럼 모델마다 스레드 1개로 학습한다(XGBoost 는 스레드 수에 따라 결과가 달라 격자 선택이 바뀐다, 2026-11-04 확인).
- 예측은 구성 모델 평균(분류 상승확률 > threshold 면 상승), 회귀 후처리(K1)는 manifest 의 post_rule 을 그대로 잇는다.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import estimators as E
from features import config as C

# 파라미터 고정 정책(사용자 요청 2026-11-09 재선정): T0 는 2026-10 첫 학습본 파라미터를 계속 쓰고 격자 달에도 grid search 하지 않는다.
# 근거 experiments/daily/test/model_reselect_20261109(검증 +42일·홀드아웃 +11일, 선택 구간 밖 2018-10~2019-08 +6일).
# T1 수익률(회귀 6개 평균)도 같은 정책(사용자 요청 2026-11-10, 근거 experiments/daily/test/model_improve_20261110 evaluate_variants.py).
# manifest param_policy 가 이 값인 목적은 fit_point 가 격자 달에도 격자를 끈다(force_grid=True, 즉 --grid on 이면 다시 고름).
FIXED_POLICY = "fixed_no_grid"


def _model(name, params):
    """스레드 1개로 고정한 모델(experiments 03_run_monthly_grid._one_thread 와 같음)."""
    model = E.make_model(name, params)
    for k in model.get_params() if hasattr(model, "get_params") else ():
        if k.endswith(("n_jobs", "thread_count")):
            model.set_params(**{k: 1})
    return model


def fit_member(ds, feats, obj, name, month, fixed=None):
    """구성 모델 하나를 대상월용으로 학습: (모델, 파라미터, inner 점수, 학습 행 index, gap 날짜).

    fixed 가 있으면 격자 없이 그 파라미터로 학습 자료 전체에 재적합한다(inner 점수는 기록용으로 같은 방식 계산).
    """
    tgt = C.TARGET[obj]
    start = pd.Period(month, "M").start_time
    prior = ds.index[ds.index < start]
    tr = ds.loc[prior[:-1]].dropna(subset=[tgt])                                   # gap 1거래일
    inner_start = start - pd.DateOffset(months=12)
    inn = tr[tr.index >= inner_start]
    fit = tr.loc[tr.index[tr.index < inner_start][:-1]]                            # 적합 구간과 inner 사이 gap 1거래일
    grid = [dict(fixed)] if fixed is not None else E.F0_GRID[name]
    scores = []
    for p in grid:
        try:
            m = E.fit_model(_model(name, p), fit[feats], fit[tgt].to_numpy(float), name)
            scores.append(E.score(obj, inn[tgt].to_numpy(float), E.predict_model(m, inn[feats], obj)))
        except Exception:
            scores.append(np.nan)
    if np.all(np.isnan(scores)):
        raise ValueError(f"{obj}/{name}: 격자의 모든 설정이 학습에 실패했습니다.")
    i = int(np.nanargmax(scores))
    best = dict(grid[i])
    model = E.fit_model(_model(name, best), tr[feats], tr[tgt].to_numpy(float), name)
    if isinstance(model, E.RollingWindowModel):                                    # 저장용: 이 모듈 클래스에 의존하지 않게 안의 sklearn 모델만
        model = model.model_
    return model, best, float(scores[i]), tr.index, prior[-1]


def fit_point(ds, month, current, grid=True, force_grid=False):
    """current: {'cls': manifest, 'reg': manifest}(지금 운영 학습본). 같은 구성으로 month 용 학습본 두 개를 만든다.

    grid=False 면 current 의 구성 모델 파라미터를 고정해 재학습만 한다(파라미터가 없는 모델은 격자).
    param_policy 가 FIXED_POLICY 인 목적은 grid=True 여도 고정한다(force_grid=True 면 격자).
    """
    out = {}
    for obj in ("cls", "reg"):
        man = current[obj]
        policy = man.get("param_policy")
        obj_grid = grid and (force_grid or policy != FIXED_POLICY)
        members = {}
        for name in man["members"]:
            fixed = None if obj_grid else (man["members"][name] or {}).get("params")
            if fixed is None:
                print(f"  {obj}/{name}: 격자 {len(E.F0_GRID[name])}개", flush=True)
            else:
                print(f"  {obj}/{name}: 직전 파라미터 고정 {fixed}", flush=True)
            model, best, sc, idx, gap = fit_member(ds, man["features"], obj, name, month, fixed)
            members[name] = {"model": model, "params": best, "inner_score": sc, "tuned": fixed is None}
            print(f"    {'선택' if fixed is None else '사용'} {best} (inner {sc:.4f})", flush=True)
        out[obj] = {"format_version": 1, "objective": obj, "checkpoint": man["checkpoint"], "target_month": month,
                    "features": list(man["features"]), "members": members, "combine": man["combine"], "threshold": man["threshold"],
                    "train_start": str(idx.min().date()), "train_end": str(idx.max().date()), "train_rows": int(len(idx)),
                    "excluded_gap_date": str(gap.date())}
        if policy and not obj_grid:                                                      # 격자를 다시 돌리면 첫 파라미터 출처·고정 정책은 이어 쓰지 않는다
            out[obj]["param_policy"] = policy
        if man.get("post_rule"):
            out[obj]["post_rule"] = man["post_rule"]
    return out
