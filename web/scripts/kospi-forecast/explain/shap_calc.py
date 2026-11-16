"""[실사용 모듈] SHAP 기여도 계산 — 세 시점(T0·T1·T2) 공용: 예측 함수·대상일 입력 한 행·배경으로 변수별 기여를 계산한다.

사용처: explain/explain_timepoint.py(run_shap), explain/time_pipeline.py
방법: 공식 shap.PermutationExplainer(link=identity), 시드 2개(20261029·20261030) 평균, 시드당 permutation 8회. 배경 행은 전부 쓴다
      (배경: outputs/explain/shap_background/<T>/, 행 수 explain/shap_config.json, build_shap_background.py 가 학습본마다 만듦).
      base + 기여도 합이 예측과 1e-7 넘게 다르면 멈춘다.
회귀 K1: 최종 수익률은 K1(부호를 방향 예측에 맞춤) 적용 값이지만, SHAP 은 K1 적용 전 수익률 모델 출력을 설명한다.
      부호 변경은 학습된 관계가 아니라 규칙이므로 기여도에 섞지 않고 해설 입력에 따로 알린다.
필요 패키지: shap==0.54.1 (requirements.txt)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SEEDS = (20261029, 20261030)


def shap_values(fn, x, background, permutations=8, seeds=SEEDS):
    """세 시점 공용 SHAP 계산(explain_timepoint.py). fn: DataFrame -> 1차원 예측, x: 1행 DataFrame, background: 배경 DataFrame(같은 열).
    반환: (기준값, 그날 예측, 변수별 기여 배열, 변수별 시드 간 차이, 합계 오차). 순열 방식, 시드마다 permutations 회 평균."""
    import shap
    columns = list(x.columns)
    if list(background.columns) != columns:
        raise ValueError('배경 컬럼 순서 불일치')

    def f(values):
        return np.asarray(fn(pd.DataFrame(np.asarray(values, float), columns=columns)), float)
    yhat = float(f(x)[0])
    # shap 기본 masker 는 배경을 100행까지만 무작위로 줄여 쓰므로 max_samples 를 행 수로 둬 배경 전체를 쓴다
    masker = shap.maskers.Independent(background, max_samples=len(background))
    runs = [shap.PermutationExplainer(f, masker, seed=s, feature_names=columns)(
        x, max_evals=(2 * len(columns) + 1) * permutations, batch_size=512, silent=True) for s in seeds]
    values = np.mean([r.values[0] for r in runs], axis=0)
    base = float(np.mean([r.base_values[0] for r in runs]))
    spread = np.max([r.values[0] for r in runs], axis=0) - np.min([r.values[0] for r in runs], axis=0)
    error = abs(base + float(values.sum()) - yhat)
    if error > 1e-7:
        raise ValueError('SHAP 합계 오차 허용치 초과')
    return base, yhat, values, spread, error
