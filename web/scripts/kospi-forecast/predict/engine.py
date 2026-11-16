"""[실사용 모듈] 공통 예측 실행 — time_point 하나로 DB 조회·입력 구성·모델 실행·결과 저장을 처리한다.

실행: python predict/engine.py --tp T0|T1|T2 --target YYYY-MM-DD [--prediction-at 2026-11-14T16:00:00+09:00] [--write]
--prediction-at: 실행일 기준 시각(주말·휴일 실행, features/timepoints.run_point). 빼면 대상일의 등록부 시각(소급 실행).
정형·뉴스는 같은 읽기 스냅샷, 부속 자산은 슬롯 저장소, joblib은 로컬 배포본이다. 원천·예측 캐시는 사용하지 않는다.
"""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / p) for p in ('predict', 'explain', 'mlops')] + [str(SERVICE)]
import numpy as np
import pandas as pd
from sqlalchemy import text
import db
from features import db_snapshot, timepoints as TPR
from news import timepoint_inputs
import timepoint as TPM
from service_runtime import source_readiness, require_ready, apply_k1


def build_features(tp, target, eng=None):
    return db_snapshot.load(tp, target, eng, target_date=pd.Timestamp(target))


def predict(tp, target, start=None, source='files', ready_through=None, write=False, mode=None, prediction_at=None):
    tp, target = TPR.norm(tp), pd.Timestamp(target)
    start = pd.Timestamp(start) if start else target
    if start > target or start.strftime('%Y-%m') != target.strftime('%Y-%m'):
        raise ValueError('예측 범위는 대상월 안에서 시작일<=종료일이어야 합니다.')
    if prediction_at is None:
        cutoff = TPR.cutoff(tp, target)
    else:
        cutoff = pd.Timestamp(prediction_at).tz_convert(TPR.tz())
        if start != target or TPR.run_point(tp, cutoff.tz_localize(None).normalize()) != (target, cutoff):
            raise ValueError(f'{tp}: prediction_at {cutoff} 은 실행일 시점 시각이 아니거나 대상일 {target.date()} 과 맞지 않습니다(--from 과 함께 쓸 수 없음).')
    now = pd.Timestamp.now(tz=TPR.tz())
    if cutoff > now:
        raise ValueError(f'{tp}: 예측 기준 시각 이전입니다.')
    if tp == 'T2':
        require_ready(target, ready_through, cutoff=cutoff)
    bundles, manifests = TPM.load(tp, target, source)
    with db.get_engine().connect().execution_options(isolation_level='REPEATABLE READ') as con:
        with con.begin():
            con.execute(text('SET TRANSACTION READ ONLY'))
            snapshot = str(con.execute(text('SELECT transaction_timestamp()')).scalar())
            ds = db_snapshot.build(con, tp, target, target_date=target, prediction_at=cutoff)
            if target not in ds.index:
                raise ValueError('거래일 행을 만들 수 없습니다.')
            allcols = list(dict.fromkeys(c for o in bundles for c in TPM.columns(tp, bundles[o], manifests[o])))
            audit = source_readiness(ds, target, allcols, strict=cutoff.date() == now.date())
            frames, news = timepoint_inputs.build(tp, bundles, manifests, ds, target, con)
    days = frames['cls'].index[(frames['cls'].index >= start) & (frames['cls'].index <= target)]
    frames = {o: x.loc[days] for o, x in frames.items()}
    if len(days) == 0 or target not in days:
        raise ValueError('예측 대상 행이 없습니다.')
    p, raw = (TPM.model_fn(tp, bundles[o])(frames[o]) for o in ('cls', 'reg'))
    k1 = tp == 'T1' or (bundles['reg'].get('post_rule') or {}).get('name') == 'K1'
    ret, flip = apply_k1(p, raw) if k1 else (raw, np.zeros(len(raw), bool))
    if not all(np.isfinite(x).all() for x in (p, raw, ret)):
        raise ValueError('모델 출력에 NaN 또는 무한대 포함')
    rows = {o: [] for o in ('cls', 'reg')}
    for i, day in enumerate(days):
        context = {'source_snapshot_at': snapshot, 'input_source': 'fresh_db_snapshot', 'prediction_cache_used': False,
                   'execution_kind': 'historical_replay' if target.date() < now.date() else 'live',
                   'source_readiness': audit, 'kospi_source_date': str(ds.loc[day, 'KOSPI_src_date'])}
        if news is not None:
            from news.source import FEATURE_READ_TABLE
            context['news_feature_source'] = FEATURE_READ_TABLE
            context['aggregated_article_count'] = int(news.loc[day, 'n_articles'])
            if context['aggregated_article_count'] == 0:
                print(f'[주의] {tp} {day.date()}: 뉴스 0건', flush=True)
        for obj in rows:
            features = {c: None if pd.isna(v) else float(v) for c, v in frames[obj].loc[day].items()}
            mi = {'features': features, 'context': context}
            if tp == 'T1':
                cd = bundles[obj]['condition']
                mi['news'] = {'n_articles': int(news.loc[day, 'n_articles']), 'condition': cd['name'],
                              'value': None if pd.isna(news.loc[day, cd['column']]) else float(news.loc[day, cd['column']]),
                              'threshold': None if pd.isna(news.loc[day, f'{cd["name"]}_threshold']) else float(news.loc[day, f'{cd["name"]}_threshold'])}
            row = {'target_dd': day, 'time_point': tp, 'prediction_at': ds.loc[day, 'prediction_at'],
                   'objective': TPR.objective(tp, obj), 'model_version': manifests[obj]['model_version'], 'model_input': mi}
            if obj == 'cls':
                row.update(yhat_probability=round(float(p[i]), 6), yhat_direction='UP' if p[i] > .5 else 'DOWN')
            else:
                row.update(yhat_value=round(float(ret[i]), 6), yhat_pct=round(float(ret[i])*100, 6),
                           yhat_raw_value=round(float(raw[i]), 6), yhat_direction='UP' if ret[i] > 0 else 'DOWN')
            rows[obj].append(row)
    result = pd.DataFrame({'target_dd': days, 'prob_up': p, 'return_pct': ret * 100, 'raw_pct': raw * 100, 'k1_applied': flip})
    print(tp, 'DB snapshot', snapshot, flush=True)
    print(result.to_string(index=False), flush=True)
    if write:
        from store import open_prediction_store
        st = open_prediction_store(True, mode)
        st.require_tables()
        print('저장', {o: st.pred_put(o, rows[o]) for o in rows}, flush=True)
    return result, rows


def main():
    import argparse
    ap = argparse.ArgumentParser(description='time_point 공통 DB 예측')
    ap.add_argument('--tp', required=True, type=TPR.norm, choices=TPR.TPS)
    ap.add_argument('--target', required=True)
    ap.add_argument('--from', dest='start')
    ap.add_argument('--source', choices=('files', 'bundle'), default='files')
    ap.add_argument('--ready-through')
    ap.add_argument('--prediction-at', help='실행일 기준 시각(시간대 포함). 빼면 대상일 등록부 시각')
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--mode', choices=('csv', 'db'))
    a = ap.parse_args()
    if a.mode:
        from store import open_prediction_store
        open_prediction_store(False, a.mode)
    predict(a.tp, a.target, a.start, a.source, a.ready_through, a.write, a.mode, a.prediction_at)


if __name__ == '__main__':
    main()
