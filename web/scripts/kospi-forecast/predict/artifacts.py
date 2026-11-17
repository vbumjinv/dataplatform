"""[실사용 모듈] 시점별(T0·T1·T2) 학습본 위치·검증·통합본 읽기 — 시점별 joblib 이 원본이고 통합본(bundle)은 거기서 만든다.

구조: model/artifacts/<T0|T1|T2>/{cls,reg}_model_1.joblib + *_manifest.json  (원본, 시점마다 따로 재학습·승격·되돌리기)
      model/artifacts/bundle/kospi_models_target_<YYYYMM>.joblib + _manifest.json  (서비스용 통합본, model/build_bundle.py 가 만듦)
사용처: engine.py, service_runtime.load_models(T2 --source bundle), model/install_artifact.py, model/build_bundle.py.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent            # service/predict
SERVICE = HERE.parent
ARTIFACTS = SERVICE / 'model' / 'artifacts'
BUNDLE_DIR = ARTIFACTS / 'bundle'
import sys  # noqa: E402
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))
from features import timepoints as TPR  # noqa: E402
CHECKPOINTS = {tp: TPR.checkpoint_id(tp) for tp in TPR.TPS}   # 시점(폴더 이름) -> 학습본 안 이름표(service/time_points.json)
PIPELINES = {'T0': 'engine.py', 'T1': 'engine.py'}  # 실행은 공통, 수식은 모델별 모듈


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pipeline_hash(tp):
    """시점 tp 의 예측 코드·변수 생성 코드 해시. 코드가 바뀌면 manifest 와 달라져 예측을 멈춘다."""
    paths = [HERE / 'engine.py', HERE / 'artifacts.py', SERVICE / 'model' / 'assets.py', SERVICE / 'news' / 'timepoint_inputs.py',
             SERVICE / 'news' / 'source.py', SERVICE / 'news' / 'settings.py']
    if tp == 'T1':
        paths += [HERE / 't1_model.py', SERVICE / 'news' / 't1_news.py']
    if tp == 'T2':
        paths += [HERE / 't2_model.py', HERE / 'service_runtime.py']
    paths += sorted((SERVICE / 'features').glob('*.py'))
    paths += [SERVICE / 'db' / n for n in ('extract.py', 'standardize.py', 'tables.py')]
    # 줄바꿈은 LF 로 맞춰 해시한다: PC(CRLF)·서버(LF) 어디서 받아도 같은 값(2026-11-17)
    body = json.dumps({p.relative_to(SERVICE).as_posix(): hashlib.sha256(p.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
                       for p in paths}, sort_keys=True)
    return hashlib.sha256(body.encode()).hexdigest()


_WARNED = set()


def check_month(label, man, target_month):
    """학습본 대상월 규칙(사용자 결정 2026-11-03): 대상월 학습본이 있으면 그것, 아직 재학습 전이면 직전 학습본을 경고와 함께 임시로 쓴다.
    학습본 대상월이 예측 대상월보다 늦으면 그 달 자료까지 학습했을 수 있어(미래 정보) 멈춘다."""
    if target_month is None or man['target_month'] == target_month:
        return
    if man['target_month'] > target_month:
        raise ValueError(f"{label}: {man['target_month']}용 학습본은 {target_month} 자료까지 학습했을 수 있어 {target_month} 예측에 쓸 수 없습니다"
                         f"(과거 달은 그 달 이전 자료로 학습한 결과로만 봅니다).")
    end = man.get('train_end') or (man.get('structured_train') or {}).get('train_end')
    msg = (f"[주의] {label}: {target_month} 학습본이 아직 없어 {man['target_month']} 학습본(학습 끝 {end})으로 예측합니다. "
           f"그달 월간 재학습·배포(run_automation.py 가 그달 마지막 예측 직후 실행) 뒤에는 새 학습본을 씁니다.")
    if msg not in _WARNED:
        _WARNED.add(msg)
        print(msg, flush=True)


def manifest_path(tp, obj):
    return ARTIFACTS / tp / f'{obj}_model_1_manifest.json'


def load_checked(tp, obj, target_month=None):
    """시점별 원본 학습본을 해시·파이프라인·대상월 확인 뒤 읽는다: (학습본, manifest)."""
    man = json.loads(manifest_path(tp, obj).read_text(encoding='utf-8'))
    path = ARTIFACTS / tp / man['artifact']
    if sha(path) != man['artifact_sha256']:
        raise ValueError(f'{tp}/{obj}: joblib 해시 불일치')
    if tp in PIPELINES and pipeline_hash(tp) != man['pipeline_sha256']:
        raise ValueError(f'{tp}: 예측·전처리 코드가 배포 때와 다릅니다. 예측이 같은지 확인한 뒤 manifest 를 다시 만드세요.')
    check_month(tp, man, target_month)
    return joblib.load(path), man


def load_from_bundle(tp, target_month):
    """통합본에서 시점 tp 의 분류·회귀 학습본을 읽는다: ({'cls':…, 'reg':…}, {'cls': manifest, 'reg': manifest}).
    대상월 통합본이 없으면 tp 가 들어 있는 직전 통합본을 쓴다(check_month 규칙)."""
    cand = []
    for f in BUNDLE_DIR.glob('kospi_models_target_*.joblib'):
        m = json.loads(f.with_name(f.stem + '_manifest.json').read_text(encoding='utf-8'))
        if m['target_month'] <= target_month and tp in m['checkpoints']:
            cand.append((m['target_month'], f, m))
    if not cand:
        raise ValueError(f'{target_month} 이하 대상월의 {tp} 통합본이 없습니다({BUNDLE_DIR}).')
    _, path, man = max(cand, key=lambda c: c[0])
    if sha(path) != man['bundle_sha256']:
        raise ValueError('통합본 해시 불일치')
    if tp not in man['checkpoints']:
        raise ValueError(f'통합본에 {tp} 가 없습니다(있는 시점: {list(man["checkpoints"])}).')
    if tp in PIPELINES and pipeline_hash(tp) != man['checkpoints'][tp]['cls']['pipeline_sha256']:
        raise ValueError(f'{tp}: 예측·전처리 코드가 통합본을 만들 때와 다릅니다.')
    b = joblib.load(path)[tp]
    check_month(tp, b['cls']['manifest'], target_month)          # 경고는 시점별 원본과 같은 문구(한 번만)
    return {o: b[o]['bundle'] for o in ('cls', 'reg')}, {o: b[o]['manifest'] for o in ('cls', 'reg')}


def predict_f0(bundles, X):
    """T0 정형 F0 학습본(구성 모델 평균) 예측 + 회귀 후처리(K1이면 회귀 부호를 분류 방향에 맞춤).

    반환: prob_up, direction(1/-1), ret_raw, ret, k1_applied (numpy 배열 dict)
    """
    def member_mean(b, obj):
        Xo = X[b['features']]
        outs = [v['model'].predict_proba(Xo)[:, 1] if obj == 'cls' else np.asarray(v['model'].predict(Xo), float)
                for v in b['members'].values()]
        return np.mean(outs, axis=0)
    pc, pr = member_mean(bundles['cls'], 'cls'), member_mean(bundles['reg'], 'reg')
    up = pc > bundles['cls']['threshold']
    flip = up != (pr > 0)
    rule = (bundles['reg'].get('post_rule') or {}).get('name')
    ret = np.where(flip, -pr, pr) if rule == 'K1' else pr
    return {'prob_up': pc, 'direction': np.where(up, 1, -1), 'ret_raw': pr, 'ret': ret,
            'k1_applied': flip if rule == 'K1' else np.zeros(len(pc), bool)}
