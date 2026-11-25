"""[실사용 모듈] 주별 1차 모델 학습본 — 구성 모델 여러 개와 결합 규칙을 한 객체로 묶어 joblib 하나에 담는다(manifest·해시 없음, 사용자 결정 2026-11-20).

학습본 dict(wk_models.load 형식)의 "model" 에 이 객체를 넣는다. 파일만 바꿔 넣으면 교체된다.
  components = {이름: {"model": 학습된 모델(kp.models), "features": [변수 순서], "kind": "s"(정형)|"n"(뉴스)}}
  combine    = 결합 규칙(아래 kind 별 값은 학습 때 2026-10 까지 이력으로 정해 고정)
    mean_groups  {"groups": [[[이름, ...], ...], ...]}  조합마다 (앙상블이면 구성원 먼저 평균한) 재료 평균 → 조합 평균   (W0 방향)
    logit        {"struct": [...], "news": [...], "w": 0.9}  sigmoid(w·logit 정형 평균 + (1−w)·logit 뉴스 평균)          (W2 방향)
    gate         {"struct": [...], "news": [...], "thr": q80}  |뉴스 평균| ≥ thr 인 날만 반반, 아니면 정형                 (W0 수익률)
    regime_conf  {"struct": [...], "news": [...], "med": m, "w_lo": a, "w_hi": b, "kw": {...} 또는 없음}               (W2 수익률)
                 |정형| > m 이면 비중 w_hi, 아니면 w_lo 로 w·정형 + (1−w)·뉴스. kw = 키워드 급증 보정
                 {"rules": [[변수 이름, 줄인 효과], ...], "lam": 0.25}: 켜진(1) 규칙 효과 평균 × lam 을 더함.
순환 신경망(GRU 등) 구성원은 직전 행이 필요하다: needs_rows_from(학습 대상 달 첫날)부터 기준일까지 행을 넣으면 마지막 행이 기준일 예측이다.
분류 결과는 predict_proba(X)[:, 1] = 상승 확률(classes_ = [0, 1]), 회귀는 predict(X) = 5거래일 수익률.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

EPS = 1e-4


def _lg(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def _sg(x):
    return 1.0 / (1.0 + np.exp(-x))


class CompositeModel:
    def __init__(self, slot: str, obj: str, components: dict, combine: dict, needs_rows_from: str | None = None):
        self.slot, self.obj, self.components, self.combine = slot, obj, components, combine
        self.needs_rows_from = needs_rows_from
        feats = []
        for c in components.values():
            feats += [f for f in c["features"] if f not in feats]
        for r, _ in (combine.get("kw") or {}).get("rules", []):
            if r not in feats:
                feats.append(r)
        self.features = feats
        if obj == "cls":
            self.classes_ = np.array([0, 1])

    # ------------------------------------------------------------ 구성 모델 예측
    def parts(self, X: pd.DataFrame) -> pd.DataFrame:
        """구성 모델마다 예측(분류 = 상승 확률, 회귀 = 수익률). X 행 순서 그대로."""
        out = {}
        for name, c in self.components.items():
            A = X[c["features"]]
            m = c["model"]
            out[name] = (m.predict_proba(A)[:, 1] if self.obj == "cls" and hasattr(m, "predict_proba") else np.asarray(m.predict(A), float))
        return pd.DataFrame(out, index=X.index)

    def _value(self, X: pd.DataFrame) -> np.ndarray:
        return self.combine_parts(self.parts(X), X)

    def combine_parts(self, P: pd.DataFrame, X: pd.DataFrame) -> np.ndarray:
        """구성 모델 예측 P(열 = 구성 이름)를 결합 규칙으로 합친다. X 는 키워드 규칙 열을 읽을 때만 쓴다(wk_shap 도 이 함수를 씀)."""
        cb = self.combine
        k = cb["kind"]
        mean = lambda names: P[names].mean(axis=1).to_numpy(float)  # noqa: E731
        if k == "mean_groups":
            return np.mean([np.mean([mean(item) for item in g], axis=0) for g in cb["groups"]], axis=0)
        b, n = mean(cb["struct"]), mean(cb["news"])
        if k == "logit":
            return np.clip(_sg(cb["w"] * _lg(b) + (1 - cb["w"]) * _lg(n)), EPS, 1 - EPS)
        if k == "gate":
            conf = np.abs(n - 0.5) if self.obj == "cls" else np.abs(n)
            return np.where(conf >= cb["thr"], 0.5 * b + 0.5 * n, b)
        if k == "regime_conf":
            w = np.where(np.abs(b) > cb["med"], cb["w_hi"], cb["w_lo"])
            v = w * b + (1 - w) * n
            kw = cb.get("kw")
            if kw:
                C = X[[r for r, _ in kw["rules"]]].to_numpy(float)
                e = np.array([e for _, e in kw["rules"]], float)
                on = C.sum(axis=1)
                v = v + kw["lam"] * np.divide(C @ e, on, out=np.zeros(len(v)), where=on > 0)
            return v
        raise ValueError(f"결합 규칙을 모름: {k}")

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return self._value(X)


class CompositeClassifier(CompositeModel):
    """방향: predict_proba(X)[:, 1] = 상승 확률."""

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        p = self._value(X)
        return np.c_[1 - p, p]

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        return (self._value(X) >= 0.5).astype(int)


class SeedBag:
    """같은 모델·파라미터를 난수 시드만 바꿔 여러 번 학습한 묶음 — 예측은 평균(2026-11-24 v3, 실험 seed_bag_20261124)."""

    def __init__(self, models: list):
        self.models = models
        if hasattr(models[0], "classes_"):
            self.classes_ = models[0].classes_

    def predict_proba(self, X):
        return np.mean([m.predict_proba(X) for m in self.models], axis=0)

    def predict(self, X):
        return np.mean([np.asarray(m.predict(X), float) for m in self.models], axis=0)


def make(slot: str, obj: str, components: dict, combine: dict, needs_rows_from: str | None = None) -> CompositeModel:
    cls = CompositeClassifier if obj == "cls" else CompositeModel   # 수익률 학습본에는 predict_proba 가 없어야 한다(wk_models.predict 가 hasattr 로 고름)
    return cls(slot, obj, components, combine, needs_rows_from)
