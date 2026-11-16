"""[실사용 모듈] 월간 재학습용 추정기·격자·지표 — 실험 코드(daily/kp/models·metrics, news_signal/news_models·news_agg)에서 운영에 필요한 부분만 옮겼다.

사용처: train/trainer.py(T2), train/f0_trainer.py(T1 정형 F0), mlops/monitor.py
동작은 원본과 같다(정형 F0 모델 생성·early stopping·월간 격자 F0_GRID, 뉴스 모델 추정기, 학습 구간 z 표준화, 주지표).
joblib 번들에는 sklearn·xgboost·catboost 객체와 dict만 들어가므로 이 모듈의 클래스에 의존하지 않는다
(롤링 모델 RollingWindowModel 은 학습에만 쓰고, 저장 전 f0_trainer 가 안의 sklearn 모델(model_)만 꺼낸다).
"""
from __future__ import annotations

from itertools import product

import numpy as np
import pandas as pd
from sklearn.ensemble import (ExtraTreesClassifier, ExtraTreesRegressor, GradientBoostingClassifier,
                              GradientBoostingRegressor, HistGradientBoostingClassifier,
                              HistGradientBoostingRegressor, RandomForestClassifier, RandomForestRegressor)
from sklearn.impute import SimpleImputer
from sklearn.linear_model import ElasticNet, Lasso, LogisticRegression, Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC, SVR

from features import config as C

RS = C.CFG["RANDOM_STATE"]          # 정형 F0 (daily/kp/models.py 와 같은 값 42)
NEWS_RS = 42                        # 뉴스 모델 (news_models.RS)


# ---------------------------------------------------------------- 정형 F0 (daily/kp/models.py)
def _pipe(est, scale=True):
    steps = [("impute", SimpleImputer(strategy="median"))]
    if scale:
        steps.append(("scale", StandardScaler()))
    return Pipeline(steps + [("model", est)])


class RollingWindowModel:
    """학습 구간 중 최근 window 행만으로 내부 모델을 적합하는 래퍼(daily/kp/models.RollingWindowModel 과 같음, T0 분류 F0 에 쓰임)."""
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


def make_model(name, params):
    """final_ensemble.json 구성 모델 이름 -> 추정기. 순차 모델·Naive는 운영 후보가 아니라 뺐다. RollingLogisticL1_cls 는 T0 F0 구성(2026-11-04 추가)."""
    import catboost as cb
    import lightgbm as lgb
    import xgboost as xgb
    p = dict(params)
    if name == "LASSO_reg": return _pipe(Lasso(max_iter=10000, **p))
    if name == "Ridge_reg": return _pipe(Ridge(**p))
    if name == "ElasticNet_reg": return _pipe(ElasticNet(max_iter=5000, **p))
    if name == "RandomForest_reg": return _pipe(RandomForestRegressor(random_state=RS, n_jobs=-1, **p), False)
    if name == "ExtraTrees_reg": return _pipe(ExtraTreesRegressor(random_state=RS, n_jobs=-1, **p), False)
    if name == "GradientBoosting_reg":
        return _pipe(GradientBoostingRegressor(random_state=RS, subsample=0.8, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, **p), False)
    if name == "HistGradientBoosting_reg":
        return HistGradientBoostingRegressor(random_state=RS, early_stopping=True, validation_fraction=0.15, n_iter_no_change=50, tol=1e-6, **p)
    if name == "XGBoost_reg": return xgb.XGBRegressor(random_state=RS, verbosity=0, subsample=0.8, device=C.XGB_DEVICE, **p)
    if name == "LightGBM_reg": return lgb.LGBMRegressor(random_state=RS, verbosity=-1, **p)
    if name == "CatBoost_reg": return cb.CatBoostRegressor(random_seed=RS, verbose=False, allow_writing_files=False, **p)
    if name == "SVR_reg": return _pipe(SVR(gamma="scale", **p))
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
    raise ValueError(f"운영 재학습에서 지원하지 않는 모델: {name}")


def _val_tail(X, y, frac=0.15, min_rows=40):
    order = np.argsort(pd.DatetimeIndex(X.index).asi8)
    X, y = X.iloc[order], np.asarray(y)[order]
    n_val = min(max(min_rows, int(np.ceil(len(X) * frac))), max(1, len(X) // 3))
    s = len(X) - n_val
    return (X, y, None, None) if (s < 30 or n_val < 10) else (X.iloc[:s], y[:s], X.iloc[s:], y[s:])


def fit_model(model, X, y, name):
    """XGBoost/LightGBM/CatBoost는 학습 구간의 시간순 마지막 15%로 early stopping, 나머지는 일반 fit."""
    if name.startswith(("XGBoost_", "LightGBM_", "CatBoost_")):
        Xf, yf, Xv, yv = _val_tail(X, y)
        if Xv is not None:
            if name.startswith("XGBoost_"):
                model.set_params(early_stopping_rounds=75)
                model.fit(Xf, yf, eval_set=[(Xv, yv)], verbose=False)
            elif name.startswith("LightGBM_"):
                import lightgbm as lgb
                model.fit(Xf, yf, eval_set=[(Xv, yv)], callbacks=[lgb.early_stopping(75, verbose=False), lgb.log_evaluation(0)])
            else:
                model.fit(Xf, yf, eval_set=(Xv, yv), early_stopping_rounds=75, use_best_model=True, verbose=False)
            return model
        model.fit(Xf, yf)
        return model
    model.fit(X, y)
    return model


def _g(**axes):
    return [dict(zip(axes, v)) for v in product(*axes.values())]


F0_GRID = {            # 정형 F0 월간 grid search 격자 — experiments/daily/test/ml_t1fixed/03_run_monthly_grid.py GRID(T0·T1 F0 선정에 쓴 격자)
    "LogisticL1_cls": _g(C=[1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0]),
    "LogisticL2_cls": _g(C=[1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0]),
    "SVC_cls": _g(C=[1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0]),
    "RollingLogisticL1_cls": _g(C=[0.03, 0.1, 0.3, 1.0, 3.0], window=[250, 500, 750, 1000, 1500]),
    "RandomForest_cls": _g(n_estimators=[200], max_depth=[5, 8, 12, None], min_samples_leaf=[1, 5, 20, 50]),
    "ExtraTrees_cls": _g(n_estimators=[400], max_depth=[8, 12, None], min_samples_leaf=[1, 3, 10], max_features=[0.5, 1.0]),
    "GradientBoosting_cls": _g(n_estimators=[1000], max_depth=[2, 4], learning_rate=[0.005, 0.01, 0.05]),
    "HistGradientBoosting_cls": _g(max_iter=[1000], max_leaf_nodes=[7, 31], learning_rate=[0.01, 0.1], l2_regularization=[0.0, 30.0], min_samples_leaf=[10, 40]),
    "XGBoost_cls": _g(n_estimators=[50, 100], max_depth=[3, 5, 7], learning_rate=[0.01, 0.03, 0.1]),
    "LightGBM_cls": _g(num_leaves=[7, 15, 31], n_estimators=[50, 100, 200], learning_rate=[0.01, 0.05, 0.1]),
    "CatBoost_cls": _g(iterations=[200, 400], depth=[4, 6, 8], learning_rate=[0.01, 0.03, 0.1]),
    "LASSO_reg": _g(alpha=[1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2]),
    "Ridge_reg": _g(alpha=[0.1, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0, 10000.0]),
    "ElasticNet_reg": _g(alpha=[1e-4, 3e-4, 1e-3, 3e-3, 1e-2], l1_ratio=[0.1, 0.3, 0.5, 0.7, 0.9]),
    "RandomForest_reg": _g(n_estimators=[200], max_depth=[3, 5, 8, 12], min_samples_leaf=[1, 5, 20]),
    "ExtraTrees_reg": _g(n_estimators=[400], max_depth=[8, 12, None], min_samples_leaf=[1, 3, 10], max_features=[0.75, 1.0]),
    "GradientBoosting_reg": _g(n_estimators=[1000], max_depth=[2, 3, 4], learning_rate=[0.005, 0.01, 0.05]),
    "HistGradientBoosting_reg": _g(max_iter=[1000], max_leaf_nodes=[7, 15, 31], learning_rate=[0.01, 0.1], l2_regularization=[1.0, 10.0, 30.0], min_samples_leaf=[10, 40]),
    "XGBoost_reg": _g(n_estimators=[50, 100], max_depth=[3, 5, 7], learning_rate=[0.01, 0.03, 0.1]),
    "LightGBM_reg": _g(num_leaves=[7, 15, 31], n_estimators=[50, 100, 200], learning_rate=[0.01, 0.05, 0.1]),
    "CatBoost_reg": _g(iterations=[200], depth=[4, 6, 8], learning_rate=[0.03, 0.1]),
}


def predict_model(model, X, objective):
    if objective == "cls":
        return model.predict_proba(X)[:, 1] if hasattr(model, "predict_proba") else model.predict(X)
    return np.asarray(model.predict(X), float)


# ---------------------------------------------------------------- 뉴스 모델 (news_models.py)
SMALL_GRIDS = {        # news_models.BASE_GRIDS — 학습 프로토콜 3절의 월간 내부 튜닝 격자(챔피언 계열 model_1)
    "ridge": [{"alpha": a} for a in (10.0, 30.0, 100.0, 300.0, 1000.0)],
    "rf": [{"max_depth": d, "min_samples_leaf": l} for d in (3, 6) for l in (5, 15)],
    "gb": [{"max_depth": d, "learning_rate": lr} for d in (2, 3) for lr in (0.02, 0.05)],
    "hgb": [{"max_depth": d, "learning_rate": lr, "max_iter": 80, "min_samples_leaf": 15} for d in (2, 3) for lr in (0.03, 0.1)],
    "xgb": [{"max_depth": d, "learning_rate": lr} for d in (2, 4) for lr in (0.03, 0.1)],
    "et": [{"max_depth": d, "min_samples_leaf": l} for d in (4, 8) for l in (3, 10)],            # T1 잔차 모델(2026-11-05)
    "lgbm": [{"num_leaves": n, "learning_rate": lr} for n in (4, 8) for lr in (0.03, 0.1)],       # T1 잔차 모델(2026-11-05)
}
BIG_GRIDS = {          # news_models.BIG_GRIDS — 확장 격자(챌린저 계열 model_2)
    "ridge": [{"alpha": a} for a in (3.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0)],
    "rf": [{"max_depth": d, "min_samples_leaf": l} for d in (2, 3, 4, 6, 8) for l in (3, 8, 15, 30)],
    "gb": [{"max_depth": d, "learning_rate": lr} for d in (1, 2, 3, 4) for lr in (0.01, 0.02, 0.05, 0.1)],
    "hgb": [{"max_depth": d, "learning_rate": lr, "max_iter": 80, "min_samples_leaf": l} for d in (2, 3, 4) for lr in (0.02, 0.05, 0.1) for l in (10, 20)],
    "xgb": [{"max_depth": d, "learning_rate": lr} for d in (1, 2, 3, 4, 6) for lr in (0.02, 0.05, 0.1, 0.2)],
}


def grid_for(model: str, size: str = "small") -> list[dict]:
    grids = BIG_GRIDS if size == "big" else SMALL_GRIDS
    return [{"model": model, "params": p, "gamma": g} for p, g in product(grids[model], (1.0,))]


def news_estimator(model: str, params: dict, obj: str):
    """news_models._estimator 와 같은 설정. 운영 재학습은 병렬 실행 차이를 없애려고 n_jobs=1 로 둔다."""
    if model == "ridge":
        return Ridge(alpha=params["alpha"])
    if model == "rf":
        cls = RandomForestClassifier if obj == "cls" else RandomForestRegressor
        return cls(n_estimators=200, max_features="sqrt", random_state=NEWS_RS, n_jobs=1, **params)
    if model == "gb":
        cls = GradientBoostingClassifier if obj == "cls" else GradientBoostingRegressor
        return cls(n_estimators=150, subsample=0.8, min_samples_leaf=10, random_state=NEWS_RS, **params)
    if model == "hgb":
        cls = HistGradientBoostingClassifier if obj == "cls" else HistGradientBoostingRegressor
        return cls(random_state=NEWS_RS, early_stopping=False, **params)
    if model == "xgb":
        import xgboost as xgb
        cls = xgb.XGBClassifier if obj == "cls" else xgb.XGBRegressor
        return cls(n_estimators=120, subsample=0.8, colsample_bytree=0.7, min_child_weight=5, random_state=NEWS_RS,
                   n_jobs=1, verbosity=0, **params)
    if model == "et":
        cls = ExtraTreesClassifier if obj == "cls" else ExtraTreesRegressor
        return cls(n_estimators=200, max_features="sqrt", random_state=NEWS_RS, n_jobs=1, **params)
    if model == "lgbm":
        import lightgbm as lgb
        cls = lgb.LGBMClassifier if obj == "cls" else lgb.LGBMRegressor
        return cls(n_estimators=120, min_child_samples=10, subsample=0.8, subsample_freq=1, colsample_bytree=0.7, random_state=NEWS_RS,
                   n_jobs=1, verbose=-1, **params)
    raise ValueError(model)


def fit_scaler(train: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """학습 구간 평균·표준편차(표준편차 0이면 1)."""
    mu = train.mean()
    sd = train.std(ddof=0).replace(0, 1.0).fillna(1.0)
    return mu.fillna(0.0), sd


def apply_scaler(df: pd.DataFrame, mu: pd.Series, sd: pd.Series) -> pd.DataFrame:
    return ((df - mu) / sd).fillna(0.0)


def news_fit_predict(spec: dict, Xtr: pd.DataFrame, ytr, Xte: pd.DataFrame, obj: str) -> np.ndarray:
    """news_models.fit_predict(filt='none', scale z, 축소 없음, gamma 1)과 같은 계산."""
    ytr = np.asarray(ytr, float)
    if obj == "cls" and len(np.unique(ytr)) < 2:
        return np.full(len(Xte), float(ytr.mean()))
    mu, sd = fit_scaler(Xtr)
    A, B = apply_scaler(Xtr, mu, sd), apply_scaler(Xte, mu, sd)
    est = news_estimator(spec["model"], spec["params"], obj)
    est.fit(A.to_numpy(float), ytr)
    if obj == "cls":
        return est.predict_proba(B.to_numpy(float))[:, 1]
    return np.asarray(est.predict(B.to_numpy(float)), float)


# ---------------------------------------------------------------- 지표 (daily/kp/metrics.py)
def mcc_fast(y, label):
    y = np.asarray(y, bool); l = np.asarray(label, bool)
    tp = float((y & l).sum()); tn = float((~y & ~l).sum()); fp = float((~y & l).sum()); fn = float((y & ~l).sum())
    den = np.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    return (tp * tn - fp * fn) / den if den > 0 else 0.0


def mae_skill(y, pred):
    y, pred = np.asarray(y, float), np.asarray(pred, float)
    z = np.mean(np.abs(y))
    return 1 - np.mean(np.abs(y - pred)) / z if z > 0 else np.nan


def score(objective, y, pred):
    """주지표 하나(클수록 좋음): 분류 MCC(p>=0.5 상승), 회귀 0 예측 대비 MAE 개선율."""
    return mcc_fast(y, np.asarray(pred) >= 0.5) if objective == "cls" else mae_skill(y, pred)
