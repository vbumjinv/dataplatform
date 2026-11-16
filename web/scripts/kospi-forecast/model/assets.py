"""[실사용 모듈] 모델 버전별 부속 자산 등록·조회 — 배경·범위·뉴스 상태를 같은 슬롯 저장소에서 관리한다.

DB 모드에서는 kospi_mlops_slot만 사용한다. 누락·해시 불일치 시 로컬 파일로 대체하지 않는다.
모델 joblib은 로컬에서 읽는다. 배포 준비 중에는 local=True로 새 배포 파일을 명시적으로 읽는다.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import pandas as pd

SERVICE = Path(__file__).resolve().parents[1]


def store(write=False, mode=None):
    import sys
    if str(SERVICE / 'mlops') not in sys.path:
        sys.path.insert(0, str(SERVICE / 'mlops'))
    from store import DbStore
    mode = mode or os.getenv('KOSPI_ASSET_MODE', 'db')
    if mode == 'db':
        return DbStore(write, only=('slot',))
    if mode != 'csv':
        raise ValueError(f'자산 저장 모드 오류: {mode}')
    from store_csv import CsvStore
    return CsvStore(write)


def path(tp, name):
    if name.startswith('shap_'):
        return SERVICE / 'outputs/explain/shap_background' / tp / name[5:]
    if name.startswith('integrity_'):
        return SERVICE / 'outputs/explain/shap_background' / name[10:]
    if name in ('news_daily_history.parquet', 'cols.json'):
        return SERVICE / 'model/data' / name
    import sys
    module = sys.modules.get('artifacts')
    root = module.ARTIFACTS if module is not None else SERVICE / 'model/artifacts'
    return root / tp / name


def version(tp):
    return json.loads(path(tp, 'reg_model_1_manifest.json').read_text(encoding='utf-8'))['model_version']


def read(tp, name, local=False, st=None, model_version=None):
    if local or os.getenv('KOSPI_ASSET_MODE') == 'local':
        return path(tp, name).read_bytes()
    st = st or store()
    mv = model_version or version(tp)
    if st.mode == 'db':
        from sqlalchemy import select
        table = st.t['slot']
        with st.engine.connect() as con:
            row = con.execute(select(table.c.sha256, table.c.content).where(
                table.c.time_point == tp, table.c.model_version == mv, table.c.file_name == name)).first()
        result = None if row is None else (row[0], row[1])
    else:
        result = st.slot_files(tp, mv).get(name)
    if result is None or result[1] is None:
        raise ValueError(f'{tp}/{mv}/{name}: 등록 자산 없음. 배포 후 model/assets.py --publish를 실행하세요.')
    digest, data = result
    data = bytes(data)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f'{tp}/{mv}/{name}: 등록 자산 해시 불일치')
    return data


def js(tp, name, **kwargs):
    return json.loads(read(tp, name, **kwargs).decode('utf-8'))


def parquet(tp, name, **kwargs):
    return pd.read_parquet(io.BytesIO(read(tp, name, **kwargs)))


def files(tp):
    names = ['cls_model_1_manifest.json', 'reg_model_1_manifest.json', 'range_config.json', 'range_history.parquet']
    names += [f'shap_{o}_background.{ext}' for o in ('cls', 'reg') for ext in ('json', 'parquet')]
    if tp == 'T2':
        names += ['news_daily_history.parquet', 'cols.json'] + [f'integrity_{o}_background.parquet' for o in ('cls', 'reg')]
    return {n: path(tp, n) for n in names}


def publish(tp, st=None):
    """호출 전에 배포 모델·배경·범위 검증을 끝내야 한다. 저장소의 한 트랜잭션으로 파일 묶음을 등록한다."""
    st = st or store(True)
    st.require_tables()
    man = js(tp, 'reg_model_1_manifest.json', local=True)
    selected = files(tp)
    for obj in ('cls', 'reg'):
        model = js(tp, f'{obj}_model_1_manifest.json', local=True)
        meta = js(tp, f'shap_{obj}_background.json', local=True)
        if meta['model_version'] != model['model_version']:
            raise ValueError(f'{tp}/{obj}: 배경·학습본 버전 불일치')
        if hashlib.sha256(selected[f'shap_{obj}_background.parquet'].read_bytes()).hexdigest() != meta['sha256']:
            raise ValueError(f'{tp}/{obj}: 배경 해시 불일치')
    cfg = js(tp, 'range_config.json', local=True)
    if cfg['model_version'] != man['model_version'] or hashlib.sha256(selected['range_history.parquet'].read_bytes()).hexdigest() != cfg['history_sha256']:
        raise ValueError(f'{tp}: 범위·학습본 버전/해시 불일치')
    return st.slot_put(tp, man['model_version'], man['target_month'], selected)


if __name__ == '__main__':
    import argparse
    import sys
    sys.path[:0] = [str(SERVICE), str(SERVICE / 'predict')]
    ap = argparse.ArgumentParser(description='검증된 배포 부속 자산을 DB/CSV 슬롯에 등록')
    ap.add_argument('--publish', action='store_true', required=True)
    ap.add_argument('--tp', nargs='+', choices=('T0', 'T1', 'T2'), default=['T0', 'T1', 'T2'])
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()
    for tp in args.tp:
        print(tp, publish(tp, store(args.write)))
