"""[실사용 스크립트] SHAP 배경 만들기 — 시점(T0·T1·T2)별 최종 학습본의 학습 구간에서 '평범한 거래일'을 골라 SHAP 기준 상태로 쓴다.

행 수: 시점마다 explain/shap_config.json(실험 experiments/daily/test/shap_background_size 로 고른 값, 1,000행 대비 안정성 기준).

실행(service 폴더에서): python explain/build_shap_background.py --tp all            # 계획만 출력(파일 안 씀)
                        python explain/build_shap_background.py --tp T1 --write     # outputs/explain/shap_background/T1/ 에 저장
입력: DB(읽기 전용) 정형 원천, T2 는 뉴스 일별 변수 저장소(mlops store news_daily), T1 은 학습본 이력(reg history)의 뉴스 변수·조건, model/artifacts/<T>/{cls,reg}_model_1 manifest
출력(--write): outputs/explain/shap_background/<T>/{cls,reg}_background.parquet(모델 입력 열 그대로) + _background.json(학습본 버전·해시·뽑은 날짜·방법)
뽑는 법(코스피 일별 예측에 맞춤): 학습본에 기록한 실제 누적 학습 구간에서 입력 변수에 결측이 없는 날을 모으고,
  '연도 x 그날 코스피 상승/하락'으로 칸을 나눠 칸 크기에 비례해 정해진 행 수만큼 뽑는다(난수 20261104). 시장 국면(연도)과 상승·하락 비율이 학습 자료와 같아진다.
  학습 끝 날짜 이후 자료는 쓰지 않는다. 월간 재학습으로 학습본이 바뀌면 다시 만든다(explain_timepoint.py 가 학습본 버전을 대조해 멈춘다).
T2 예측 무결성 검사(service_runtime.check_manifest)가 쓰는 32행 배경(outputs/explain/shap_background/{cls,reg}_background.parquet)과는 별개 파일이다.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path[:0] = [str(HERE), str(SERVICE / 'predict'), str(SERVICE / 'train'), str(SERVICE / 'mlops'), str(SERVICE)]
import timepoint as TPM  # noqa: E402
import artifacts as A  # noqa: E402

SEED, POOL_START = 20261104, '2017-01-01'


def stratified(pool: pd.DataFrame, up: pd.Series, n: int, seed: int) -> pd.DataFrame:
    """연도 x 상승/하락 칸에 비례 배분(최대 나머지 방식)해 비복원 추출한다."""
    key = pd.Series([f'{d.year}_{int(u)}' for d, u in zip(pool.index, up.reindex(pool.index).fillna(0) > 0)], index=pool.index)
    size = key.value_counts().sort_index()
    quota = size / size.sum() * n
    take = np.floor(quota).astype(int)
    for k in (quota - take).sort_values(ascending=False).index[: n - int(take.sum())]:
        take[k] += 1
    rng = np.random.default_rng(seed)
    picked = []
    for k, m in take.items():
        idx = key.index[key == k]
        picked += list(rng.choice(idx, size=min(m, len(idx)), replace=False))
    return pool.loc[sorted(picked)]


def pool_frame(tp, manifests, bundles):
    """학습본의 실제 누적 구간 모델 입력 표: ({obj: DataFrame}, 실제 수익률 Series)."""
    import db
    end = pd.Timestamp(manifests['cls'].get('train_end') or manifests['cls']['structured_train']['train_end'])
    if tp == 'T2':
        import inputs as I
        from store import open_store
        ds, _, _ = I.load_snapshot(end, target_date=end)
        news = open_store(write=False).news_daily_read()
        out = {}
        for o in ('cls', 'reg'):
            cols = TPM.columns(tp, bundles[o], manifests[o])
            sc = [c for c in cols if c in ds.columns]
            f = pd.concat([ds[sc], news.reindex(ds.index)[[c for c in cols if c not in sc]]], axis=1)[cols]
            out[o] = f
    elif tp == 'T1':                                                   # 정형 + 학습본 이력의 뉴스 10개 + 그날 조건 0/1(어제까지 분포 기준)
        import t1_model
        ds = TPM.dataset_f0(tp, end, db.get_engine())
        H = bundles['reg']['history']
        out = {}
        for o in ('cls', 'reg'):
            cd = bundles[o]['condition']
            news = H[bundles[o]['news']['columns']].assign(**{cd['name']: t1_model.history_flags(cd, H)})
            f = pd.concat([ds[bundles[o]['features']], news.reindex(ds.index)], axis=1)
            out[o] = f[TPM.columns(tp, bundles[o], manifests[o])]
    else:
        ds = TPM.dataset_f0(tp, end, db.get_engine())
        out = {o: ds[TPM.columns(tp, bundles[o], manifests[o])] for o in ('cls', 'reg')}
    from features import config as C
    y = ds[C.TARGET['reg']]                                            # 그날(대상일) 실제 수익률
    def pool_start(obj):
        man = manifests[obj]
        # 다음 달 재학습본에서도 확장한 실제 뉴스 학습 시작일을 이어 쓴다.
        return (man.get('shap_pool_start') or (man.get('news_train') or {}).get('start')
                or (man.get('news') or {}).get('train_start') or man.get('train_start') or POOL_START)
    out = {o: f[(f.index >= pool_start(o)) & (f.index <= end)].dropna(how='any') for o, f in out.items()}
    return out, y, end


def main():
    ap = argparse.ArgumentParser(description='SHAP 배경 만들기(시점별 최종 학습본 기준, 행 수는 shap_config.json)')
    ap.add_argument('--tp', choices=('T0', 'T1', 'T2', 'all'), required=True)
    ap.add_argument('--rows', type=int, help='행 수(기본: shap_config.json 의 시점별 값)')
    ap.add_argument('--target', help='학습본 대상월을 고를 날짜(기본: 학습본 그대로)')
    ap.add_argument('--write', action='store_true', help='파일 저장(없으면 계획만 출력)')
    ap.add_argument('--no-publish', action='store_true', help='배포 내부용: 전체 후처리 성공 뒤 별도로 DB 등록')
    a = ap.parse_args()
    for tp in (TPM.TPS if a.tp == 'all' else (a.tp,)):
        target = a.target or json.loads(A.manifest_path(tp, 'cls').read_text(encoding='utf-8'))['target_month'] + '-15'
        bundles, manifests = TPM.load(tp, target, local_assets=True)
        pools, y, end = pool_frame(tp, manifests, bundles)
        for o in ('cls', 'reg'):
            pool = pools[o]
            n = a.rows or TPM.bg_rows(tp)
            if len(pool) < n:
                raise ValueError(f'{tp}/{o}: 결측 없는 학습일 {len(pool)}일 < {n}')
            bg = stratified(pool, y, n, SEED)
            up = (y.reindex(bg.index) > 0).mean() * 100
            print(f'{tp}/{o}: 후보 {len(pool):,}일({pool.index.min().date()}~{pool.index.max().date()}) → {len(bg)}일, '
                  f'변수 {bg.shape[1]}개, 상승일 {up:.0f}% (후보 {(y.reindex(pool.index) > 0).mean() * 100:.0f}%)', flush=True)
            if not a.write:
                continue
            d = TPM.BG_DIR / tp
            d.mkdir(parents=True, exist_ok=True)
            art = f'{o}_background.parquet'
            bg.to_parquet(d / art)
            meta = {'time_point': tp, 'objective': o, 'model_version': manifests[o]['model_version'], 'artifact': art,
                    'sha256': A.sha(d / art), 'rows': len(bg), 'columns': list(bg.columns),
                    'pool_rows': len(pool), 'pool_start': str(pool.index.min().date()), 'pool_end': str(pool.index.max().date()),
                    'train_end': str(end.date()), 'method': 'stratified_year_x_updown_proportional_without_replacement',
                    'random_state': SEED, 'sample_dates': [str(x.date()) for x in bg.index],
                    'created_utc': datetime.now(timezone.utc).isoformat(), 'script': 'service/explain/build_shap_background.py'}
            (d / f'{o}_background.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
            print(f'  저장 {d / art}', flush=True)
        if a.write and not a.no_publish:
            from model import assets
            print(f'  부속 자산 등록: {assets.publish(tp)}개', flush=True)
    if not a.write:
        print('계획만 출력했습니다(--write 로 저장).')


if __name__ == '__main__':
    main()
