"""[실사용 모듈] (service_5 복사본, 2026-11-20 원본: experiments/daily/kp/models.py) 모델 후보와 하이퍼파라미터 격자. 포함: ML 모델, MLP, LSTM/GRU/BiLSTM/BiGRU, Naive 기준선.
제외: Transformer·TCN(이전 결과가 좋지 않음), AdaBoost(격자가 커서 학습이 오래 걸림).
격자는 PILOT(작음, 동작 확인·1차 탐색), FULL(기존 벤치마크와 동일한 넓은 범위),
V2(이전 실험의 폴드별 선택값 빈도로 조정: 거의 안 뽑힌 값 제거, 경계값이 자주 뽑힌 축은 바깥으로 확장) 세 가지다.
V2_MODELS = V2에서 실행할 모델(이전 결과에서 검증·홀드아웃 모두 약했던 모델 제외)."""
from __future__ import annotations
import warnings
from itertools import product
import numpy as np
import pandas as pd
from sklearn.ensemble import (RandomForestClassifier, RandomForestRegressor, ExtraTreesClassifier, ExtraTreesRegressor,
                              GradientBoostingClassifier, GradientBoostingRegressor,
                              HistGradientBoostingClassifier, HistGradientBoostingRegressor)
from sklearn.impute import SimpleImputer
from sklearn.linear_model import ElasticNet, Lasso, LogisticRegression, Ridge
from sklearn.neural_network import MLPClassifier, MLPRegressor
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC, SVR
from . import config as C
from .seq_models import HAS_TORCH
if HAS_TORCH:
    from .seq_models import TorchSequenceModel

try:
    import lightgbm as lgb
except ImportError:
    lgb = None
try:
    import xgboost as xgb
except ImportError:
    xgb = None
try:
    import catboost as cb
except ImportError:
    cb = None

RS = C.CFG["RANDOM_STATE"]


def _grid(**axes):
    keys = list(axes)
    return [dict(zip(keys, c)) for c in product(*axes.values())]


GRIDS = {
    "PILOT": {
        "LASSO_reg": _grid(alpha=[1e-3, 1e-2, 1e-1]), "Ridge_reg": _grid(alpha=[0.1, 3.0, 30.0, 300.0]),
        "ElasticNet_reg": _grid(alpha=[1e-3, 1e-2], l1_ratio=[0.3, 0.7]),
        "RollingLASSO_reg": _grid(alpha=[1e-3, 1e-2], window=[500, 1000]),
        "RandomForest_reg": _grid(n_estimators=[200], max_depth=[3, 8], min_samples_leaf=[5, 20]),
        "ExtraTrees_reg": _grid(n_estimators=[300], max_depth=[5, 12], min_samples_leaf=[3, 10], max_features=[0.5, 1.0]),
        "GradientBoosting_reg": _grid(n_estimators=[500], max_depth=[2, 3], learning_rate=[0.01, 0.05]),
        "HistGradientBoosting_reg": _grid(max_iter=[500], max_leaf_nodes=[7, 31], learning_rate=[0.03, 0.1], min_samples_leaf=[20]),
        "XGBoost_reg": _grid(n_estimators=[300], max_depth=[3, 5], learning_rate=[0.03, 0.1]),
        "LightGBM_reg": _grid(num_leaves=[7, 31], n_estimators=[200], learning_rate=[0.03, 0.1]),
        "CatBoost_reg": _grid(iterations=[300], depth=[4, 6], learning_rate=[0.03, 0.1]),
        "SVR_reg": _grid(C=[0.1, 1.0, 10.0], epsilon=[0.01]), "KNN_reg": _grid(n_neighbors=[10, 40], weights=["uniform"]),
        "LogisticL1_cls": _grid(C=[0.03, 0.1, 0.3, 1.0]), "LogisticL2_cls": _grid(C=[0.03, 0.1, 0.3, 1.0, 3.0]),
        "RollingLogisticL1_cls": _grid(C=[0.1, 1.0], window=[500, 1000]),
        "RandomForest_cls": _grid(n_estimators=[200], max_depth=[3, 8], min_samples_leaf=[5, 20]),
        "ExtraTrees_cls": _grid(n_estimators=[300], max_depth=[5, 12], min_samples_leaf=[3, 10], max_features=[0.5, 1.0]),
        "GradientBoosting_cls": _grid(n_estimators=[500], max_depth=[2, 3], learning_rate=[0.01, 0.05]),
        "HistGradientBoosting_cls": _grid(max_iter=[500], max_leaf_nodes=[7, 31], learning_rate=[0.03, 0.1], min_samples_leaf=[20]),
        "XGBoost_cls": _grid(n_estimators=[300], max_depth=[3, 5], learning_rate=[0.03, 0.1]),
        "LightGBM_cls": _grid(num_leaves=[7, 31], n_estimators=[200], learning_rate=[0.03, 0.1]),
        "CatBoost_cls": _grid(iterations=[300], depth=[4, 6], learning_rate=[0.03, 0.1]),
        "SVC_cls": _grid(C=[0.1, 1.0, 10.0]), "KNN_cls": _grid(n_neighbors=[10, 40], weights=["uniform"]),
        "MLP_reg": _grid(hidden_layer_sizes=[(32,), (64, 32)], alpha=[1e-3, 1e-2], learning_rate_init=[1e-3]),
        "LSTM_reg": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "GRU_reg": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "BiLSTM_reg": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "BiGRU_reg": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "MLP_cls": _grid(hidden_layer_sizes=[(32,), (64, 32)], alpha=[1e-3, 1e-2], learning_rate_init=[1e-3]),
        "LSTM_cls": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "GRU_cls": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "BiLSTM_cls": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "BiGRU_cls": _grid(hidden_size=[32], num_layers=[1], lookback=[10, 20], lr=[1e-3, 3e-3], epochs=[100]),
        "Naive_reg": [{}], "Naive_cls": [{}],
    },
    "FULL": {
        "LASSO_reg": _grid(alpha=[1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1, 3e-1]),
        "Ridge_reg": _grid(alpha=[1e-2, 3e-2, 1e-1, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0]),
        "ElasticNet_reg": _grid(alpha=[1e-4, 1e-3, 1e-2, 1e-1], l1_ratio=[0.1, 0.3, 0.5, 0.7, 0.9]),
        "RollingLASSO_reg": _grid(alpha=[1e-4, 1e-3, 1e-2, 1e-1], window=[250, 500, 750, 1000, 1500]),
        "RandomForest_reg": _grid(n_estimators=[200, 400, 800], max_depth=[3, 5, 8, 12, None], min_samples_leaf=[1, 5, 20]),
        "ExtraTrees_reg": _grid(n_estimators=[400, 800, 1200], max_depth=[5, 8, 12, None], min_samples_leaf=[1, 3, 5, 10], max_features=[0.5, 0.75, 1.0]),
        "GradientBoosting_reg": _grid(n_estimators=[500, 1000, 2000], max_depth=[2, 3, 4], learning_rate=[0.005, 0.01, 0.03, 0.05]),
        "HistGradientBoosting_reg": _grid(max_iter=[1000], max_leaf_nodes=[7, 15, 31, 63], learning_rate=[0.01, 0.03, 0.05, 0.1], l2_regularization=[0.0, 0.1, 1.0, 10.0], min_samples_leaf=[10, 20, 40]),
        "XGBoost_reg": _grid(n_estimators=[100, 300, 600], max_depth=[3, 4, 5, 7], learning_rate=[0.01, 0.03, 0.05, 0.1]),
        "LightGBM_reg": _grid(num_leaves=[7, 15, 31, 63], n_estimators=[100, 200, 400], learning_rate=[0.01, 0.03, 0.05, 0.1]),
        "CatBoost_reg": _grid(iterations=[200, 400, 800], depth=[4, 6, 8], learning_rate=[0.01, 0.03, 0.05, 0.1]),
        "SVR_reg": _grid(C=[0.03, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0], epsilon=[0.001, 0.01, 0.05, 0.1]),
        "KNN_reg": _grid(n_neighbors=[3, 5, 10, 20, 40, 80], weights=["uniform", "distance"]),
        "LogisticL1_cls": _grid(C=[1e-2, 3e-2, 0.1, 0.3, 1.0, 3.0, 10.0]),
        "LogisticL2_cls": _grid(C=[1e-2, 3e-2, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0]),
        "RollingLogisticL1_cls": _grid(C=[0.03, 0.1, 0.3, 1.0, 3.0], window=[250, 500, 750, 1000, 1500]),
        "RandomForest_cls": _grid(n_estimators=[200, 400, 800], max_depth=[3, 5, 8, 12, None], min_samples_leaf=[1, 5, 20]),
        "ExtraTrees_cls": _grid(n_estimators=[400, 800, 1200], max_depth=[5, 8, 12, None], min_samples_leaf=[1, 3, 5, 10], max_features=[0.5, 0.75, 1.0]),
        "GradientBoosting_cls": _grid(n_estimators=[500, 1000, 2000], max_depth=[2, 3, 4], learning_rate=[0.005, 0.01, 0.03, 0.05]),
        "HistGradientBoosting_cls": _grid(max_iter=[1000], max_leaf_nodes=[7, 15, 31, 63], learning_rate=[0.01, 0.03, 0.05, 0.1], l2_regularization=[0.0, 0.1, 1.0, 10.0], min_samples_leaf=[10, 20, 40]),
        "XGBoost_cls": _grid(n_estimators=[100, 300, 600], max_depth=[3, 4, 5, 7], learning_rate=[0.01, 0.03, 0.05, 0.1]),
        "LightGBM_cls": _grid(num_leaves=[7, 15, 31, 63], n_estimators=[100, 200, 400], learning_rate=[0.01, 0.03, 0.05, 0.1]),
        "CatBoost_cls": _grid(iterations=[200, 400, 800], depth=[4, 6, 8], learning_rate=[0.01, 0.03, 0.05, 0.1]),
        "SVC_cls": _grid(C=[0.03, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0]),
        "KNN_cls": _grid(n_neighbors=[3, 5, 10, 20, 40, 80], weights=["uniform", "distance"]),
        "MLP_reg": _grid(hidden_layer_sizes=[(16,), (32,), (64,), (64, 32), (128, 64), (64, 32, 16)], alpha=[1e-5, 1e-4, 1e-3, 1e-2], learning_rate_init=[1e-3, 3e-3]),
        "LSTM_reg": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[1e-3, 3e-3], epochs=[300]),
        "GRU_reg": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[1e-3, 3e-3], epochs=[300]),
        "BiLSTM_reg": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[3e-4, 1e-3, 3e-3], epochs=[300]),
        "BiGRU_reg": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[3e-4, 1e-3, 3e-3], epochs=[300]),
        "MLP_cls": _grid(hidden_layer_sizes=[(16,), (32,), (64,), (64, 32), (128, 64), (64, 32, 16)], alpha=[1e-5, 1e-4, 1e-3, 1e-2], learning_rate_init=[1e-3, 3e-3]),
        "LSTM_cls": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[1e-3, 3e-3], epochs=[300]),
        "GRU_cls": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[1e-3, 3e-3], epochs=[300]),
        "BiLSTM_cls": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[3e-4, 1e-3, 3e-3], epochs=[300]),
        "BiGRU_cls": _grid(hidden_size=[16, 32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[3e-4, 1e-3, 3e-3], epochs=[300]),
        "Naive_reg": [{}], "Naive_cls": [{}],
    },
}

GRIDS["V2"] = {
    # 회귀 선형: Ridge는 300(상한)이 31/53회 -> 확장, LASSO는 1e-4·3e-4(하한 쪽) 최다 -> 하한 확장
    "LASSO_reg": _grid(alpha=[3e-5, 1e-4, 3e-4, 1e-3, 3e-3]),
    "Ridge_reg": _grid(alpha=[0.01, 1.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0]),
    "ElasticNet_reg": _grid(alpha=[1e-4, 1e-3, 1e-2], l1_ratio=[0.1, 0.3, 0.5]),
    "RollingLASSO_reg": _grid(alpha=[1e-5, 1e-4, 1e-3], window=[250, 500, 1000, 1500]),
    # 분류 선형: LogisticL2는 C=0.01(하한) 최다 -> 하한 확장, SVC도 C=0.03(하한) 최다
    "LogisticL1_cls": _grid(C=[3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0, 3.0, 10.0]),
    "LogisticL2_cls": _grid(C=[1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0, 30.0]),
    "RollingLogisticL1_cls": _grid(C=[0.03, 0.1, 0.3, 1.0, 3.0], window=[250, 500, 1000, 1500]),
    "SVC_cls": _grid(C=[3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0]),
    # 트리: RF 분류는 min_samples_leaf=20(상한)이 많음 -> 50 추가
    "RandomForest_reg": _grid(n_estimators=[200, 400], max_depth=[3, 5, 8, 12, None], min_samples_leaf=[1, 5, 20]),
    "RandomForest_cls": _grid(n_estimators=[200, 400], max_depth=[3, 5, 8, 12, None], min_samples_leaf=[1, 5, 20, 50]),
    "ExtraTrees_reg": _grid(n_estimators=[400, 800], max_depth=[5, 8, 12, None], min_samples_leaf=[1, 3, 10], max_features=[0.5, 0.75, 1.0]),
    "ExtraTrees_cls": _grid(n_estimators=[400, 800], max_depth=[5, 8, 12, None], min_samples_leaf=[1, 3, 10], max_features=[0.5, 0.75, 1.0]),
    # 부스팅: GB는 early stopping이 있어 n_estimators 고정, XGB·LGBM은 n=100(하한) 최다 -> 50 추가, HGB는 l2=10(상한) 최다 -> 30 추가
    "GradientBoosting_reg": _grid(n_estimators=[1000], max_depth=[2, 3, 4], learning_rate=[0.005, 0.01, 0.05]),
    "GradientBoosting_cls": _grid(n_estimators=[1000], max_depth=[2, 3, 4], learning_rate=[0.005, 0.01, 0.05]),
    "HistGradientBoosting_reg": _grid(max_iter=[1000], max_leaf_nodes=[7, 15, 31], learning_rate=[0.01, 0.05, 0.1], l2_regularization=[0.0, 1.0, 10.0, 30.0], min_samples_leaf=[10, 20, 40]),
    "HistGradientBoosting_cls": _grid(max_iter=[1000], max_leaf_nodes=[7, 15, 31], learning_rate=[0.01, 0.05, 0.1], l2_regularization=[0.0, 1.0, 10.0, 30.0], min_samples_leaf=[10, 20, 40]),
    "XGBoost_reg": _grid(n_estimators=[50, 100, 300], max_depth=[3, 5, 7], learning_rate=[0.01, 0.03, 0.1]),
    "XGBoost_cls": _grid(n_estimators=[50, 100, 300], max_depth=[3, 5, 7], learning_rate=[0.01, 0.03, 0.1]),
    "LightGBM_reg": _grid(num_leaves=[7, 15, 31], n_estimators=[50, 100, 200], learning_rate=[0.01, 0.05, 0.1]),
    "LightGBM_cls": _grid(num_leaves=[7, 15, 31], n_estimators=[50, 100, 200], learning_rate=[0.01, 0.05, 0.1]),
    "CatBoost_reg": _grid(iterations=[200, 400, 800], depth=[4, 6, 8], learning_rate=[0.01, 0.03, 0.1]),
    "CatBoost_cls": _grid(iterations=[200, 400, 800], depth=[4, 6, 8], learning_rate=[0.01, 0.03, 0.1]),
    # 딥러닝(분류만): 검증 상위지만 T0 홀드아웃이 음수 -> 범위를 좁혀 마지막에 실행
    "LSTM_cls": _grid(hidden_size=[32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[1e-3, 3e-3], epochs=[300]),
    "GRU_cls": _grid(hidden_size=[32, 64], num_layers=[1, 2], lookback=[10, 20, 40], lr=[1e-3, 3e-3], epochs=[300]),
    "Naive_reg": [{}], "Naive_cls": [{}],
}
# 이전 결과(변수세트 B) 기준 제외: 분류 KNN·MLP·BiLSTM·BiGRU, 회귀 SVR·KNN·MLP·LSTM·GRU·BiLSTM·BiGRU (AdaBoost·TCN·Transformer는 원래 제외)
V2_MODELS = {
    "cls": ["Naive_cls", "LogisticL1_cls", "LogisticL2_cls", "RollingLogisticL1_cls", "RandomForest_cls", "ExtraTrees_cls",
            "GradientBoosting_cls", "HistGradientBoosting_cls", "XGBoost_cls", "LightGBM_cls", "CatBoost_cls", "SVC_cls",
            "LSTM_cls", "GRU_cls"],
    "reg": ["Naive_reg", "LASSO_reg", "Ridge_reg", "ElasticNet_reg", "RollingLASSO_reg", "RandomForest_reg", "ExtraTrees_reg",
            "GradientBoosting_reg", "HistGradientBoosting_reg", "XGBoost_reg", "LightGBM_reg", "CatBoost_reg"],
}

ML = {
    "reg": ["LASSO_reg", "Ridge_reg", "ElasticNet_reg", "RollingLASSO_reg", "RandomForest_reg", "ExtraTrees_reg",
            "GradientBoosting_reg", "HistGradientBoosting_reg", "XGBoost_reg", "LightGBM_reg", "CatBoost_reg",
            "SVR_reg", "KNN_reg", "MLP_reg"],
    "cls": ["LogisticL1_cls", "LogisticL2_cls", "RollingLogisticL1_cls", "RandomForest_cls", "ExtraTrees_cls",
            "GradientBoosting_cls", "HistGradientBoosting_cls", "XGBoost_cls", "LightGBM_cls", "CatBoost_cls",
            "SVC_cls", "KNN_cls", "MLP_cls"],
}
SEQ = {"reg": [f"{a}_reg" for a in ("LSTM", "GRU", "BiLSTM", "BiGRU")], "cls": [f"{a}_cls" for a in ("LSTM", "GRU", "BiLSTM", "BiGRU")]}
NAIVE = {"reg": "Naive_reg", "cls": "Naive_cls"}


def is_naive(name): return name.startswith("Naive_")


def available_models(objective, include_seq=True):
    """실행할 모델 이름 목록(Naive 기준선 포함). 설치되지 않은 라이브러리의 모델은 뺀다."""
    out = [NAIVE[objective]]
    for m in ML[objective] + (SEQ[objective] if include_seq else []):
        if m.startswith("XGBoost") and xgb is None: continue
        if m.startswith("LightGBM") and lgb is None: continue
        if m.startswith("CatBoost") and cb is None: continue
        if m.split("_")[0] in ("LSTM", "GRU", "BiLSTM", "BiGRU") and not HAS_TORCH: continue
        out.append(m)
    return out


class NaiveModel:
    """회귀: 항상 0 예측. 분류: 학습 구간 다수 방향을 그대로 예측(기준선)."""
    def __init__(self, task): self.task = task
    def fit(self, X, y):
        self.const_ = (1.0 if np.mean(np.asarray(y) >= 0.5) >= 0.5 else 0.0) if self.task == "cls" else 0.0
        return self
    def predict(self, X): return np.full(len(X), self.const_, dtype=float)
    def predict_proba(self, X): return np.tile([1 - self.const_, self.const_], (len(X), 1))


def _pipe(est, scale=True):
    steps = [("impute", SimpleImputer(strategy="median"))]
    if scale:
        steps.append(("scale", StandardScaler()))
    return Pipeline(steps + [("model", est)])


class RollingWindowModel:
    """학습 구간 중 최근 `window`행만으로 내부 모델을 적합하는 래퍼."""
    def __init__(self, base_name, base_params, window):
        self.base_name, self.base_params, self.window = base_name, base_params, window

    def fit(self, X, y):
        X = X.sort_index()
        y = pd.Series(np.asarray(y, float), index=X.index)
        if self.window and len(X) > self.window:
            X, y = X.iloc[-self.window:], y.iloc[-self.window:]
        self.model_ = make_model(self.base_name, self.base_params)
        self.model_.fit(X, y.to_numpy())
        return self

    def predict(self, X): return self.model_.predict(X)
    def predict_proba(self, X): return self.model_.predict_proba(X)


class PercentTarget:
    """정답 ×100(%)으로 학습하고 예측은 ÷100 — Huber 손실 경계(alpha 0.9)를 % 단위로 쓰려고(2026-11-24 v3 W0 수익률, 실험 robust_objectives_20261124)."""
    def __init__(self, model):
        self.model = model

    def fit(self, X, y):
        self.model.fit(X, np.asarray(y, float) * 100)
        return self

    def predict(self, X): return np.asarray(self.model.predict(X), float) / 100


def make_model(name, params):
    p = dict(params)
    if name == "LightGBMHuber_reg": return PercentTarget(lgb.LGBMRegressor(objective="huber", verbosity=-1, **p))   # early stopping 없음(이름이 LightGBM_ 로 시작하지 않음)
    if name == "LASSO_reg": return _pipe(Lasso(max_iter=10000, **p))
    if name == "Ridge_reg": return _pipe(Ridge(**p))
    if name == "ElasticNet_reg": return _pipe(ElasticNet(max_iter=5000, **p))
    if name == "RollingLASSO_reg": return RollingWindowModel("LASSO_reg", p, p.pop("window"))
    if name == "RandomForest_reg": return _pipe(RandomForestRegressor(random_state=RS, n_jobs=-1, **p), False)
    if name == "ExtraTrees_reg": return _pipe(ExtraTreesRegressor(random_state=RS, n_jobs=-1, **p), False)
    if name == "GradientBoosting_reg":
        return _pipe(GradientBoostingRegressor(random_state=RS, subsample=0.8, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, **p), False)
    if name == "HistGradientBoosting_reg":
        return HistGradientBoostingRegressor(random_state=RS, early_stopping=True, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, **p)
    if name == "XGBoost_reg": return xgb.XGBRegressor(random_state=RS, verbosity=0, subsample=0.8, device=C.XGB_DEVICE, **p)
    if name == "LightGBM_reg": return lgb.LGBMRegressor(random_state=RS, verbosity=-1, **p)
    if name == "CatBoost_reg": return cb.CatBoostRegressor(random_seed=RS, verbose=False, allow_writing_files=False, **p)   # catboost_info 로그 폴더를 만들지 않음
    if name == "SVR_reg": return _pipe(SVR(gamma="scale", **p))
    if name == "KNN_reg": return _pipe(KNeighborsRegressor(**p))
    if name == "LogisticL1_cls": return _pipe(LogisticRegression(penalty="l1", solver="liblinear", max_iter=2000, random_state=RS, **p))
    if name == "LogisticL2_cls": return _pipe(LogisticRegression(penalty="l2", max_iter=2000, random_state=RS, **p))
    if name == "RollingLogisticL1_cls": return RollingWindowModel("LogisticL1_cls", p, p.pop("window"))
    if name == "RandomForest_cls": return _pipe(RandomForestClassifier(random_state=RS, n_jobs=-1, class_weight="balanced", **p), False)
    if name == "ExtraTrees_cls": return _pipe(ExtraTreesClassifier(random_state=RS, n_jobs=-1, class_weight="balanced", **p), False)
    if name == "GradientBoosting_cls":
        return _pipe(GradientBoostingClassifier(random_state=RS, subsample=0.8, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, **p), False)
    if name == "HistGradientBoosting_cls":
        return HistGradientBoostingClassifier(random_state=RS, early_stopping=True, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, **p)
    if name == "XGBoost_cls": return xgb.XGBClassifier(random_state=RS, verbosity=0, subsample=0.8, eval_metric="logloss", device=C.XGB_DEVICE, **p)
    if name == "LightGBM_cls": return lgb.LGBMClassifier(random_state=RS, verbosity=-1, **p)
    if name == "CatBoost_cls": return cb.CatBoostClassifier(random_seed=RS, verbose=False, allow_writing_files=False, **p)
    if name == "SVC_cls": return _pipe(SVC(probability=True, gamma="scale", random_state=RS, **p))
    if name == "KNN_cls": return _pipe(KNeighborsClassifier(**p))
    if name == "MLP_reg": return _pipe(MLPRegressor(max_iter=2000, early_stopping=True, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, random_state=RS, **p))
    if name == "MLP_cls": return _pipe(MLPClassifier(max_iter=2000, early_stopping=True, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, random_state=RS, **p))
    if name in ("Naive_reg", "Naive_cls"): return NaiveModel(name.split("_")[1])
    base = name.split("_")[0]
    if base in ("LSTM", "GRU", "BiLSTM", "BiGRU"):
        return TorchSequenceModel(arch=base.lower(), task=name.split("_")[1], seed=RS, **p)
    raise ValueError(name)


def _val_tail(X, y, frac=0.15, min_rows=40):
    order = np.argsort(pd.DatetimeIndex(X.index).asi8)
    X, y = X.iloc[order], np.asarray(y)[order]
    n_val = min(max(min_rows, int(np.ceil(len(X) * frac))), max(1, len(X) // 3))
    s = len(X) - n_val
    return (X, y, None, None) if (s < 30 or n_val < 10) else (X.iloc[:s], y[:s], X.iloc[s:], y[s:])


def fit_model(model, X, y, name, target_dates=None):
    """XGBoost/LightGBM/CatBoost는 학습 구간의 시간순 마지막 15%로 early stopping, 나머지는 일반 fit."""
    if name.startswith(("XGBoost_", "LightGBM_", "CatBoost_")):
        Xf, yf, Xv, yv = _val_tail(X, y)
        if Xv is not None and target_dates is not None:
            known = pd.to_datetime(target_dates.reindex(Xf.index)) < Xv.index.min()
            Xf, yf = Xf.loc[known], np.asarray(yf)[known.to_numpy()]
        if Xv is not None:
            if name.startswith("XGBoost_"):
                model.set_params(early_stopping_rounds=75)
                model.fit(Xf, yf, eval_set=[(Xv, yv)], verbose=False)
            elif name.startswith("LightGBM_"):
                model.fit(Xf, yf, eval_set=[(Xv, yv)], callbacks=[lgb.early_stopping(75, verbose=False), lgb.log_evaluation(0)])
            else:
                model.fit(Xf, yf, eval_set=(Xv, yv), early_stopping_rounds=75, use_best_model=True, verbose=False)
            return model
        model.fit(Xf, yf)
        return model
    model.fit(X, y)
    return model


def predict(model, X, objective):
    if objective == "cls":
        return model.predict_proba(X)[:, 1] if hasattr(model, "predict_proba") else model.predict(X)
    return np.asarray(model.predict(X), float)
