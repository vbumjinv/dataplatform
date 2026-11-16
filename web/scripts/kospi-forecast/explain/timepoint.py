"""[실사용 모듈] 시점(T0·T1·T2)별 해설 준비 — 최종 학습본 읽기, 대상일 입력 1행, 예측 함수(분류 상승확률·회귀 K1 전 수익률), 방향 맞춤(K1).

사용처: explain/explain_timepoint.py(SHAP·LLM 해설), explain/build_shap_background.py(SHAP 배경, 시점별 행 수는 shap_config.json)
T0: 정형 F0(구성 모델 평균), T1: 정형 F0 + 뉴스 조건부 보정(predict/t1_model.py), T2: 정형 F0 + 뉴스 결합(service_runtime.predict).
입력: 세 시점 모두 예측 때 저장소 예측 행에 함께 저장한 모델 입력(model_input.features)을 그대로 쓰고, 다시 계산한 예측이 저장값과 같은지 확인한다.
회귀 SHAP 은 K1(수익률 부호를 방향에 맞춤) 전 수익률 모델 출력을 설명한다. K1 은 학습된 관계가 아닌 규칙이라 해설 입력에 따로 넣는다.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent            # service/explain
SERVICE = HERE.parent
for p in (str(HERE), str(SERVICE / 'predict'), str(SERVICE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import artifacts as A  # noqa: E402
from features import timepoints as TPR  # noqa: E402

TPS = TPR.TPS
NAME = {tp: TPR.label(tp) for tp in TPS}      # 예: 코스피 장 마감(예측 전날 16:00) — 시각은 service/time_points.json
USES_NEWS = {'T0': False, 'T1': True, 'T2': True}
BG_DIR = SERVICE / 'outputs' / 'explain' / 'shap_background'
CONFIG = HERE / 'shap_config.json'                # 시점별 SHAP 배경 행 수(실험 shap_background_size 로 고른 값)


def bg_rows(tp):
    """시점 tp 의 SHAP 배경 행 수(explain/shap_config.json)."""
    return int(json.loads(CONFIG.read_text(encoding='utf-8'))['background_rows'][tp])


def load(tp, target, source='files', local_assets=False):
    """최종 학습본: (bundles {'cls','reg'}, manifests {'cls','reg'}). 대상월 규칙(artifacts.check_month)을 따른다."""
    month = pd.Timestamp(target).strftime('%Y-%m')
    if tp == 'T2':
        from service_runtime import load_models
        return load_models(pd.Timestamp(target).date(), source, local_assets=local_assets)
    if source == 'bundle':
        return A.load_from_bundle(tp, month)
    loaded = {o: A.load_checked(tp, o, month) for o in ('cls', 'reg')}
    return {o: v[0] for o, v in loaded.items()}, {o: v[1] for o, v in loaded.items()}


def columns(tp, bundle, manifest):
    """목적별 모델 입력 열(순서 고정)."""
    if tp == 'T2':
        return list(manifest['feature_columns'])
    if tp == 'T1':
        import t1_model
        return t1_model.inputs(bundle)
    return list(bundle['features'])


def model_fn(tp, bundle):
    """DataFrame -> 예측(분류 상승확률, 회귀 K1 전 수익률). 예측 스크립트와 같은 계산."""
    if tp == 'T2':
        from service_runtime import predict
        return lambda frame: predict(bundle, frame)
    if tp == 'T1':
        import t1_model
        return t1_model.model_fn(bundle)
    obj = bundle['objective']

    def fn(frame):
        X = frame[bundle['features']]
        outs = [v['model'].predict_proba(X)[:, 1] if obj == 'cls' else np.asarray(v['model'].predict(X), float)
                for v in bundle['members'].values()]
        return np.mean(outs, axis=0)
    return fn


def k1(prob_up, ret_raw):
    """방향 맞춤: (최종 수익률, 적용 여부)."""
    flip = (prob_up > 0.5) != (ret_raw > 0)
    return (-ret_raw if flip else ret_raw), bool(flip)


def background(tp, obj, manifest, local_assets=False):
    """SHAP 배경(build_shap_background.py 가 만든 것). 학습본 버전·행 수(shap_config.json)가 다르면 멈춘다: (DataFrame, 설명 dict)."""
    from model import assets
    import hashlib
    meta = assets.js(tp, f'shap_{obj}_background.json', local=local_assets)
    if meta['model_version'] != manifest['model_version']:
        raise ValueError(f'{tp}/{obj}: 배경은 {meta["model_version"]}용, 학습본은 {manifest["model_version"]} — 배경을 다시 만드세요.')
    if meta['rows'] != bg_rows(tp):
        raise ValueError(f'{tp}/{obj}: 배경 {meta["rows"]}행, 설정은 {bg_rows(tp)}행(shap_config.json) — 배경을 다시 만드세요.')
    content = assets.read(tp, f'shap_{obj}_background.parquet', local=local_assets)
    if hashlib.sha256(content).hexdigest() != meta['sha256']:
        raise ValueError(f'{tp}/{obj}: 배경 파일 해시 불일치')
    import io
    frame = pd.read_parquet(io.BytesIO(content))
    if list(frame.columns) != meta['columns'] or len(frame) != meta['rows']:
        raise ValueError(f'{tp}/{obj}: 배경 열·행 수 불일치')
    return frame, meta


def dataset_f0(tp, target, eng):
    """T0·T1 예측 스크립트와 같은 방법으로 대상일 행까지 정형 데이터셋을 만든다(DB 읽기 전용, T1 뉴스 변수는 따로)."""
    from engine import build_features
    return build_features(tp, pd.Timestamp(target), eng)


def inputs(tp, target, bundles, manifests, st, prediction_at=None):
    """저장소에 저장된 그날 예측 행의 모델 입력으로 예측을 다시 계산해 확인한다(세 시점 같은 방법, DB 원천을 다시 읽지 않음).
    prediction_at: 그 실행 행(없으면 가장 늦은 행). 회귀 행은 분류 행과 같은 prediction_at.
    반환: {'x': {obj: 1행 DataFrame}, 'prediction_at': Timestamp(KST), 'p', 'r_raw', 'r', 'k1_applied', 'rows': {obj: 저장 행 dict}}"""
    target = pd.Timestamp(target)
    at = None if prediction_at is None else pd.Timestamp(prediction_at)
    at = None if at is None else (at.tz_localize(TPR.tz()) if at.tzinfo is None else at).tz_convert('UTC')
    rows = {}
    for o in ('cls', 'reg'):
        df = st.pred_read(o, tp, target, target, manifests[o]['model_version'])
        if at is not None and len(df):
            df = df[df.prediction_at == at]
        if df.empty:
            raise ValueError(f'{tp} {target.date()} {o} 예측({manifests[o]["model_version"]}, prediction_at {at})이 저장소에 없습니다 — run_predict.py --tp {tp} --write 먼저.')
        rows[o] = df.iloc[-1].to_dict()
        at = rows[o]['prediction_at']
    x = {o: pd.DataFrame([rows[o]['model_input']['features']], columns=columns(tp, bundles[o], manifests[o]), dtype=float) for o in rows}
    p = float(model_fn(tp, bundles['cls'])(x['cls'])[0])
    r_raw = float(model_fn(tp, bundles['reg'])(x['reg'])[0])
    r, applied = k1(p, r_raw)
    if (abs(p - float(rows['cls']['yhat_probability'])) > 5.1e-7 or abs(r_raw - float(rows['reg']['yhat_raw_value'])) > 5.1e-7
            or abs(r - float(rows['reg']['yhat_value'])) > 5.1e-7):
        raise ValueError(f'{tp} {target.date()}: 저장된 입력으로 다시 계산한 예측이 저장된 예측과 다릅니다(학습본·코드 확인).')
    stamp = pd.Timestamp(rows['cls']['prediction_at']).tz_convert(TPR.tz())
    return {'x': x, 'prediction_at': stamp, 'p': p, 'r_raw': r_raw, 'r': r, 'k1_applied': applied, 'rows': rows}


# 변수 쉬운 이름(해설 입력용, 결과서 3장 변수표와 같은 이름): 변수 -> (구분, 이름)
NAMES = {
    'K_ret_1d': ('국내', '코스피 수익률'), 'K_open_gap': ('국내', '코스피 시가 갭'), 'K_range': ('국내', '코스피 하루 변동 폭'),
    'K_intraday': ('국내', '코스피 장중 등락'), 'K_close_location': ('국내', '코스피 종가 위치'), 'K_log_volume_change': ('국내', '코스피 거래량 변화'),
    'TA_SMA10_gap': ('국내', '코스피 10일 이동평균 괴리'), 'SECTOR_AUTO_ma_gap_20': ('국내 업종', '자동차 업종 20일 이동평균 괴리'),
    'SECTOR_FASHION_ret_20d': ('국내 업종', '패션 업종 20일 수익률'), 'SECTOR_INTERNET_ma_gap_5': ('국내 업종', '인터넷 업종 5일 이동평균 괴리'),
    'SECTOR_LIVING_ma_gap_5': ('국내 업종', '생활용품 업종 5일 이동평균 괴리'),
    'EU_DAX_ret_5d': ('유럽', '독일 DAX 5일 수익률'), 'EU_DAX_ma_gap_20': ('유럽', '독일 DAX 20일 이동평균 괴리'),
    'EU_STOXX600_ret_1d': ('유럽', '유럽 STOXX 600 하루 수익률'),
    'US_SOX_ret_1d': ('미국', '미국 반도체지수 하루 수익률'), 'US_SOX_ret_3d': ('미국', '미국 반도체지수 3일 수익률'),
    'US_SP500_ret_1d': ('미국', '미국 S&P 500 하루 수익률'),
    'MACRO_DXY_ret_1d': ('환율·원자재', '달러지수 하루 수익률'), 'MACRO_DXY_ret_10d': ('환율·원자재', '달러지수 10일 수익률'),
    'MACRO_DXY_ma_gap_20': ('환율·원자재', '달러지수 20일 이동평균 괴리'), 'MACRO_GOLD_ret_3d': ('환율·원자재', '금 3일 수익률'),
    'MACRO_OIL_ret_1d': ('환율·원자재', 'WTI 유가 하루 변화'),
    'core_mean_s': ('뉴스', '뉴스 방향 점수 평균'), 'core_wmean_s': ('뉴스', '강도로 가중한 뉴스 방향 점수'), 'core_mean_sw': ('뉴스', '뉴스 방향 세기 평균'),
    'core_pos': ('뉴스', '상승 뉴스 확률 평균'), 'core_neg': ('뉴스', '하락 뉴스 확률 평균'), 'core_mix': ('뉴스', '혼재 뉴스 확률 평균'),
    'core_mean_w': ('뉴스', '뉴스 강도 평균'), 'core_std_s': ('뉴스', '뉴스 방향 점수의 흩어짐'),
    'ctx_wmean_s_ew3': ('뉴스', '최근 3일 뉴스 방향 흐름'), 'ctx_mean_sw_ew3': ('뉴스', '최근 3일 뉴스 방향 세기 흐름'),
    'ctx_wmean_s_ew5': ('뉴스', '최근 5일 뉴스 방향 흐름'), 'ctx_mean_sw_ew5': ('뉴스', '최근 5일 뉴스 방향 세기 흐름'),
    't1_no_news': ('뉴스', '뉴스 없음 표시'), 't1_impact': ('뉴스', '뉴스 영향 점수'), 't1_impact_std': ('뉴스', '뉴스 영향 점수의 흩어짐'),
    't1_pos_share': ('뉴스', '긍정 영향 뉴스 비중'), 't1_neg_share': ('뉴스', '부정 영향 뉴스 비중'), 't1_mix_share': ('뉴스', '혼재 영향 뉴스 비중'),
    't1_strength': ('뉴스', '뉴스 영향 강도 평균'), 't1_log_n': ('뉴스', '기사 수'), 't1_recap_share': ('뉴스', '시황 기사 비중'),
    't1_log_recap_n': ('뉴스', '시황 기사 수'), 't1_impact_kor': ('뉴스', '국내발 뉴스 영향 점수'), 't1_impact_usa': ('뉴스', '미국발 뉴스 영향 점수'),
    't1_surprise': ('뉴스', '기대 대비 서프라이즈'), 't1_unexpected': ('뉴스', '예상 밖 뉴스 비중'),
    'cond_sector_hi10': ('뉴스', '시장 전체 업종 뉴스 영향이 큰 날'), 'cond_relevance_lo3': ('뉴스', '코스피 관련도 중간 기사가 적은 날'),
}


def show_value(var, x):
    """해설 입력용 변수 값 표기(수익률·괴리는 %, 유가는 달러 차분, 뉴스·위치는 숫자)."""
    if x is None or not np.isfinite(x):
        return '없음'
    if var == 'MACRO_OIL_ret_1d':
        return f'{x:+.2f}달러'
    if var.startswith(('K_ret', 'K_open', 'K_range', 'K_intraday', 'EU_', 'US_', 'MACRO_', 'SECTOR_', 'TA_')):
        return f'{x * 100:+.2f}%'
    if var.startswith('cond_'):                                     # T1 조건(0/1): 그날 뉴스가 보정 조건에 들었는지
        return '해당' if x > 0.5 else '해당 없음'
    if var == 't1_log_n' or var == 't1_log_recap_n':
        return f'{np.expm1(x):.0f}건'
    return f'{x:.3f}'
