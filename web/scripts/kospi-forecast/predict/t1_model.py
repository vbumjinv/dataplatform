"""[실사용 모듈] T1(유럽 장 마감) 서비스 모델 계산 — 정형 F0 + 뉴스 조건부 보정(방향 잔차 보정 X4, 수익률 gate) + 방향 맞춤.

사용처: predict/engine.py --tp T1(예측), train/retrain_t1.py(재학습 확인), explain/timepoint.py(SHAP·해설 재계산), predict/predict_manual.py
학습본(model/artifacts/T1/{cls,reg}_model_1.joblib, train/retrain_t1.py 가 만듦):
  공통  features(정형 변수)·members(정형 F0 구성 모델) — 정형 F0 = 구성 모델 평균
        news.columns(뉴스 10개)·news.resid{모델: 학습된 잔차 모델}·news.lam(0.5)
        condition{name, column, q, side, min_hist, history(조건 값 이력, 대상월 이전 거래일)}
  방향  최종 확률 = 조건(시장 전체 업종 영향 점수가 어제까지 분포 상위 10%)이 켜진 날 X4, 아니면 F0.
        X4 = 잔차 모델(정답 방향 − F0 확률을 뉴스로 학습) 4개마다 clip(F0 + 0.5 x 잔차 예측, 1e-4, 1-1e-4) 의 평균.
  수익률 방향 맞춤 전 값 = 조건(시황 제외 기사 중 관련도 0.5 비중이 어제까지 하위 1/3)이 켜지고 gate 평균이 F0 와 다른 날 gate, 아니면 F0.
        gate(모델마다) = |F0 수익률| < d x scale 인 날 F0 + 0.5 x 잔차 예측(정답 수익률 − F0 를 뉴스로 학습), 아니면 F0. d·scale 은 학습 때 과거 OOS 로 정함.
        최종 수익률 = 방향 맞춤(부호가 최종 방향과 다르면 부호만 바꿈, post_rule K1).
근거: experiments/daily/test/news_best_refit/07_t1_combo.py(N3), 08_t1_service_seed.py, 2026-11-05 사용자 결정(T1 서비스 모델 교체).
이 파일은 T1 파이프라인 해시 대상이다(predict/artifacts.pipeline_hash).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

EPS = 1e-4
FLAG = {'cls': 'cond_sector_hi10', 'reg': 'cond_relevance_lo3'}


def inputs(bundle) -> list[str]:
    """목적별 모델 입력 열(순서 고정): 정형 변수 + 뉴스 10개 + 조건 0/1."""
    return list(bundle['features']) + list(bundle['news']['columns']) + [bundle['condition']['name']]


def f0(bundle, X: pd.DataFrame) -> np.ndarray:
    Xo = X[bundle['features']]
    if bundle['objective'] == 'cls':
        outs = [v['model'].predict_proba(Xo)[:, 1] for v in bundle['members'].values()]
    else:
        outs = [np.asarray(v['model'].predict(Xo), float) for v in bundle['members'].values()]
    return np.mean(outs, axis=0)


def resid(fitted, X: pd.DataFrame) -> np.ndarray:
    A = ((X[fitted['columns']] - fitted['mean']) / fitted['std']).fillna(0.0).to_numpy(float)
    return np.asarray(fitted['estimator'].predict(A), float)


def parts(bundle, X: pd.DataFrame) -> dict:
    """구성요소: f0, 잔차 예측(모델별), 조건, 결합값(분류 X4 / 회귀 gate 평균), 최종(분류 확률 / 회귀 방향 맞춤 전)."""
    p0 = f0(bundle, X)
    nw = bundle['news']
    flag = X[bundle['condition']['name']].to_numpy(float) > 0.5
    r = {m: resid(fit, X) for m, fit in nw['resid'].items()}
    if bundle['objective'] == 'cls':
        comb = np.mean([np.clip(p0 + nw['lam'] * r[m], EPS, 1 - EPS) for m in r], axis=0)
        use = flag
    else:
        g = []
        for m in r:
            d, scale = nw['gate'][m]['d'], nw['gate'][m]['scale']
            g.append(np.where(np.abs(p0) < d * scale, p0 + nw['lam'] * r[m], p0))
        comb = np.mean(g, axis=0)
        use = flag & (np.abs(comb - p0) > 1e-8)
    return {'f0': p0, 'resid': r, 'flag': flag, 'combined': comb, 'use': use, 'final': np.where(use, comb, p0)}


def model_fn(bundle):
    """DataFrame -> 최종(분류 상승확률 / 회귀 방향 맞춤 전 수익률). SHAP·해설이 쓰는 함수."""
    return lambda frame: parts(bundle, frame)['final']


def predict(bundles, Xc: pd.DataFrame, Xr: pd.DataFrame) -> dict:
    """반환: prob_up, direction(1/-1), ret_raw, ret(방향 맞춤), k1_applied, f0_prob, f0_ret, news_cls_used, news_reg_used."""
    pc, pr = parts(bundles['cls'], Xc), parts(bundles['reg'], Xr)
    up = pc['final'] > bundles['cls']['threshold']
    flip = up != (pr['final'] > 0)
    ret = np.where(flip, -pr['final'], pr['final'])
    return {'prob_up': pc['final'], 'direction': np.where(up, 1, -1), 'ret_raw': pr['final'], 'ret': ret, 'k1_applied': flip,
            'f0_prob': pc['f0'], 'f0_ret': pr['f0'], 'news_cls_used': pc['use'], 'news_reg_used': pr['use']}


def condition_flags(cond: dict, values: pd.Series, known: pd.Series) -> tuple[pd.Series, pd.Series]:
    """조건 0/1 과 그날 기준 분위수. 기준 = 학습본 이력(대상월 이전) + 대상월 안 그날 이전 거래일(정답이 있는 날) 값의 분위수(최소 min_hist 개).
    values·known: 대상월 날짜 x 조건 값 / 정답 확정 여부(같은 index, 시간순)."""
    hist = cond['history'].dropna()
    flags, thrs = [], []
    for d in values.index:
        before = values[(values.index < d) & known.reindex(values.index).fillna(False).to_numpy()].dropna()
        x = pd.concat([hist, before])
        thr = float(x.quantile(cond['q'])) if len(x) >= cond['min_hist'] else np.nan
        v = values[d]
        ok = (not np.isnan(thr)) and (not pd.isna(v)) and ((v > thr) if cond['side'] == 'gt' else (v < thr))
        flags.append(1.0 if ok else 0.0)
        thrs.append(thr)
    return pd.Series(flags, index=values.index), pd.Series(thrs, index=values.index)


def history_flags(cond: dict, H: pd.DataFrame) -> pd.Series:
    """학습본 이력 거래일의 조건 0/1(그날 이전 이력 값의 분위수 기준, rule_atoms.expanding_flags 와 같음). 이력에 없는 날은 0."""
    x = H.loc[H['in_idx'].astype(bool), cond['column']].astype(float)
    thr = x.expanding(min_periods=cond['min_hist']).quantile(cond['q']).shift(1)
    f = ((x > thr) if cond['side'] == 'gt' else (x < thr)) & thr.notna()
    return f.astype(float).reindex(H.index, fill_value=0.0)
