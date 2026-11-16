"""[실사용 스크립트] 서비스용 통합 학습본 만들기 — 시점별 원본(model/artifacts/<T0|T1|T2>/)을 검증해 대상월 하나의 joblib 으로 묶는다.

실행(service 폴더에서): python model/build_bundle.py --target-month 2026-10 [--confirmed]
입력: model/artifacts/<시점>/{cls,reg}_model_1.joblib·manifest (있는 시점만; 대상월이 다른 시점은 빼고 알린다)
출력: model/artifacts/bundle/kospi_models_target_<YYYYMM>.joblib = {시점: {cls|reg: {'bundle': 학습본, 'manifest': manifest}}}
      model/artifacts/bundle/kospi_models_target_<YYYYMM>_manifest.json (통합본 해시, 시점별 원본 파일 해시·model_version·pipeline_sha256)
원본이 기준이다: 시점 하나를 재학습·승격하면 이 스크립트로 통합본을 다시 만든다. 통합본을 직접 고치지 않는다.
"""
import argparse
import json
import sys
from pathlib import Path

import joblib
import pandas as pd

SERVICE = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(SERVICE / 'predict'), str(SERVICE)]
import artifacts as A  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--target-month', required=True)
ap.add_argument('--confirmed', action='store_true')
a = ap.parse_args()
packed, man = {}, {'target_month': a.target_month, 'checkpoints': {}, 'skipped': {}}
for tp in A.CHECKPOINTS:
    if not all(A.manifest_path(tp, o).exists() for o in ('cls', 'reg')):
        man['skipped'][tp] = '학습본 없음'
        continue
    m0 = json.loads(A.manifest_path(tp, 'cls').read_text(encoding='utf-8'))
    if m0['target_month'] != a.target_month:
        man['skipped'][tp] = f"대상월 {m0['target_month']}"
        continue
    if tp not in A.PIPELINES:          # T2 는 service_runtime.load_manifest 가 검증한다(배경·파이프라인 해시 포함)
        import service_runtime as R
        pair = {o: (joblib.load(A.ARTIFACTS / tp / f'{o}_model_1.joblib'), R.load_manifest(o, local_assets=True)) for o in ('cls', 'reg')}
    else:
        pair = {o: A.load_checked(tp, o, a.target_month) for o in ('cls', 'reg')}
    packed[tp] = {o: {'bundle': b, 'manifest': m} for o, (b, m) in pair.items()}
    man['checkpoints'][tp] = {o: {'artifact': f'{tp}/{m["artifact"]}', 'artifact_sha256': m['artifact_sha256'],
                                  'model_version': m['model_version'], 'pipeline_sha256': m.get('pipeline_sha256')}
                              for o, (b, m) in pair.items()}
print('담을 시점:', list(packed), '/ 뺀 시점:', man['skipped'])
if not packed:
    raise SystemExit('담을 학습본이 없습니다.')
if not a.confirmed:
    raise SystemExit('--confirmed 가 없어 만들지 않았습니다.')
A.BUNDLE_DIR.mkdir(parents=True, exist_ok=True)
out = A.BUNDLE_DIR / f"kospi_models_target_{a.target_month.replace('-', '')}.joblib"
joblib.dump(packed, out)
re_ = joblib.load(out)
assert set(re_) == set(packed) and all(set(re_[t]) == {'cls', 'reg'} for t in re_)
man.update(bundle=out.name, bundle_sha256=A.sha(out), code='model/build_bundle.py', created=str(pd.Timestamp.now(tz='Asia/Seoul')))
out.with_name(out.stem + '_manifest.json').write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding='utf-8')
print(f'통합본 {out} ({out.stat().st_size / 1e6:.1f} MB)')
