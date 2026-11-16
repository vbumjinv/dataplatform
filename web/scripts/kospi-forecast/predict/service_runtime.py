"""[실사용 모듈] T2 배포 학습본 검증·예측 함수 — 학습본·배경·전처리 코드 해시를 manifest 와 대조해 읽고, 예측·K1·자료 준비 점검 함수를 준다.

사용처: engine.py, explain/timepoint.py(SHAP 예측 함수), mlops/registry.py(배포 검사), train/trainer.py(K1 규칙).
예측 저장은 저장소(mlops/store.py 의 kospi_pred_* 테이블)가 한다. 이 파일은 학습본 파이프라인 해시 대상이므로(pipeline_hash) 고치면
예측이 같은지 확인한 뒤 manifest pipeline_sha256 을 갱신한다.
"""
from __future__ import annotations
import hashlib
import json
from decimal import Decimal
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent            # service/predict
SERVICE = HERE.parent                             # service
MODELS = SERVICE / 'model' / 'artifacts' / 'T2'   # joblib·manifest·SHAP 배경
DATA = SERVICE / 'model' / 'data'                 # cols.json·뉴스 누적 이력·변수 정의
OUTPUTS = SERVICE / 'outputs'                      # DB 에 아직 없는 파일 출력은 모두 여기(outputs/README.md)
BACKGROUND = OUTPUTS / 'explain' / 'shap_background'  # SHAP 배경(월간 재학습이 만들고 배포, manifest background.sha256 으로 검증)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def clean(value):
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [clean(v) for v in value]
    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (pd.Timestamp, date, datetime, Path)):
        return str(value)
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def encoded(value):
    return json.dumps(clean(value), ensure_ascii=False, sort_keys=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def pipeline_hash():
    import artifacts as A
    return A.pipeline_hash('T2')


def load_manifest(obj, target=None, local_assets=False):
    from features import config as C
    if C.MISSING_POLICY != "skip":
        raise ValueError("배포 모델의 결측 정책은 skip입니다. KOSPI_MISSING_POLICY 환경변수를 확인하세요.")
    manifest = json.loads((MODELS/f'{obj}_model_1_manifest.json').read_text(encoding='utf-8'))
    if sha(MODELS/manifest['artifact']) != manifest['artifact_sha256']:
        raise ValueError(f'{obj}: joblib 해시 불일치')
    return check_manifest(obj, manifest, target, local_assets=local_assets)


def check_manifest(obj, manifest, target=None, local_assets=False):
    """배경 해시·파이프라인 코드 해시·대상월을 확인한다(joblib 해시는 읽는 쪽에서 확인)."""
    from model import assets
    bg = assets.read('T2', f'integrity_{obj}_background.parquet', local=local_assets)
    if hashlib.sha256(bg).hexdigest() != manifest['background']['sha256']:
        raise ValueError(f'{obj}: 배경 데이터 해시 불일치')
    if pipeline_hash() != manifest['pipeline_sha256']:
        raise ValueError('전처리 코드가 배포 시점과 다릅니다. 검증 후 새 배포 버전을 만드세요.')
    import artifacts as A                            # 대상월 규칙: 같은 달 또는 재학습 전 직전 학습본(경고), 더 늦은 학습본은 멈춤
    A.check_month('T2', manifest, None if target is None else pd.Timestamp(target).strftime('%Y-%m'))
    return manifest


def load_models(target, source='files', local_assets=False):
    """T2 분류·회귀 학습본과 manifest: ({'cls','reg'}, {'cls','reg'}).
    source = files: model/artifacts/T2/ 시점별 원본, bundle: 통합본 model/artifacts/bundle/kospi_models_target_<YYYYMM>.joblib"""
    if source == 'bundle':
        import artifacts as A                        # 통합본 해시는 load_from_bundle 이 확인한다
        from features import config as C
        if C.MISSING_POLICY != "skip":
            raise ValueError("배포 모델의 결측 정책은 skip입니다. KOSPI_MISSING_POLICY 환경변수를 확인하세요.")
        bundles, manifests = A.load_from_bundle('T2', pd.Timestamp(target).strftime('%Y-%m'))
        return bundles, {o: check_manifest(o, m, target, local_assets=local_assets) for o, m in manifests.items()}
    import joblib
    manifests = {o: load_manifest(o, target, local_assets=local_assets) for o in ('cls', 'reg')}
    return {o: joblib.load(MODELS/manifests[o]['artifact']) for o in manifests}, manifests


K1_RULE = {'name': 'K1', 'desc': '수익률 예측의 부호가 방향 예측(상승확률 p > 0.5 상승)과 다르면 수익률의 부호만 방향에 맞춘다(크기 유지)',
           'evidence': 'T1 결과서 v3.7 2.8절 표 2-30(T2 서비스 짝 MAE 검증 +0.0037·홀드아웃 +0.0049%p), 사용자 결정 2026-11-03'}


def apply_k1(prob_up, ret):
    """회귀 후처리 K1: 반환 (최종 수익률, 부호를 바꾼 날 여부). 학습 없는 고정 규칙이며 분류 예측은 바꾸지 않는다."""
    p, r = np.asarray(prob_up, float), np.asarray(ret, float)
    flip = (p > .5) != (r > 0)
    return np.where(flip, -r, r), flip


def predict(bundle, frame):
    # CLI와 SHAP이 동일한 전체 결합 예측 함수를 사용한다.
    from t2_model import predict_structured, predict_news, fuse, REG_MODELS
    obj = bundle['objective']
    ps = predict_structured(bundle['structured'], frame, obj)
    if obj == 'cls':
        pn = predict_news(bundle['news']['rf'], frame, obj)
        return fuse(bundle, ps, pn)                    # 결합 비중은 학습본 fusion 값(t2_model.FUSION_WEIGHTS)
    return np.mean([bundle['meta'][n].predict(np.c_[ps, predict_news(bundle['news'][n], frame, obj)])
                    for n in REG_MODELS], axis=0)


def valid_url(url):
    try:
        p = urlsplit(url)
        return p.scheme in ('https', 'http') and bool(p.hostname) and not p.username and not p.password and not any(c.isspace() for c in url)
    except (ValueError, TypeError):
        return False


def require_ready(target, ready_through, now=None, cutoff=None):
    """오늘의 실시간 실행은 T2 시각(time_points.json) 도달 및 상위 수집/피처 처리 완료 확인을 요구한다.
    cutoff: 실행일 기준 시각(주말 실행, timepoints.run_point). 없으면 대상일 T2 시각."""
    from features import timepoints as TPR
    t2 = TPR.time_str('T2')
    cutoff = TPR.cutoff('T2', target) if cutoff is None else pd.Timestamp(cutoff).tz_convert('Asia/Seoul')
    now = pd.Timestamp.now(tz='Asia/Seoul') if now is None else pd.Timestamp(now).tz_convert('Asia/Seoul')
    if cutoff > now:
        raise ValueError(f'대상일 {t2} 이전입니다. 해당 시점까지의 자료가 준비된 뒤 실행하세요.')
    ready = pd.Timestamp(ready_through) if ready_through else None
    if ready is not None and (ready.tzinfo is None or ready < cutoff or ready > now):
        raise ValueError(f'ready-through는 시간대를 포함하고, {t2} 이상·현재 이하이어야 합니다.')
    if cutoff.date() == now.date() and ready is None:
        raise ValueError(f'상위 프레임워크에서 {t2}까지의 수집·뉴스 피처 완료를 확인한 후 --ready-through를 전달하세요.')
    return cutoff, ready


def source_readiness(ds, target, feature_columns, strict=False):
    """선택된 미국·유럽 지수의 최신 확정 거래일 누락을 실시간 실행에서 차단한다."""
    import exchange_calendars as xcals
    from features import config as C, dataset as D, missing as MS
    target = pd.Timestamp(target).normalize()
    row = ds.loc[target]
    cutoff = pd.Timestamp(row['prediction_at'])
    result = {}
    for name, spec in C.SOURCE_SPECS.items():
        if not name.startswith(('US_', 'EU_')) or not any(c.startswith(name+'_') for c in feature_columns):
            continue
        calendar = xcals.get_calendar(MS.CALENDAR_CODES[spec['market']])
        sessions = calendar.sessions_in_range(target-pd.Timedelta(days=30), target)
        available = D.assumed_available_at(sessions,spec['rule'],spec.get('lag_days',0))
        eligible = sessions[available < cutoff]
        expected = pd.Timestamp(eligible.max()).tz_localize(None).normalize()
        actual = pd.Timestamp(row[name+'_src_date'])
        okay = not pd.isna(actual) and actual >= expected
        result[name] = {'expected_source_date':str(expected.date()),
                        'actual_source_date':None if pd.isna(actual) else str(actual.date()), 'ready':okay}
    failed = [f"{k}: 필요 {v['expected_source_date']}, DB {v['actual_source_date']}" for k,v in result.items() if not v['ready']]
    if strict and failed:
        raise ValueError('해외 지표 최신 확정 자료 미준비. 예측을 저장하지 않습니다. '+ '; '.join(failed))
    return result
