"""[실사용 스크립트] 예측 범위 — 저장소에 저장된 시점별 서비스 예측(방향 상승확률·K1 수익률)에 오차 모델 80%·95% 범위를 붙이고, 급변 신호가 있을 때만 범위를 넓혀 같은 예측 행에 쓴다.

실행(service 폴더에서): python predict/predict_range.py --target 2026-10-30 [--from 2026-10-01] [--tps T0 T1 T2] [--write] [--mode csv|db]
입력: 저장소 kospi_pred_cls·kospi_pred_reg(그 시점 서비스 예측, run_predict.py 가 먼저 저장), DB KOSPI 종가(읽기 전용),
      model/artifacts/<T>/range_history.parquet·range_config.json(실험에서 고른 오차 모델·급변 신호 설정과 OOS 이력, 해시 검증,
      range_config 의 model_version 이 그 시점에 배포된 수익률 학습본과 같아야 함 — 재학습 배포 뒤 mlops/post_deploy.py 가 refresh 로 맞춤)
출력: --write 면 kospi_pred_reg 의 range_lo80_pct·range_hi80_pct·range_lo95_pct·range_hi95_pct(직전 종가 대비 %)·range_regime(급변 보정 여부).
      지수 값은 직전 종가 x (1 + %) 로 조회 때 계산한다(따로 저장하지 않음). 없으면 화면만.
계산(predict/range_model.py):
  1) 보통 모델 범위: 대상월 첫날 이전 OOS·서비스 예측과 정답(마지막 1거래일 gap)으로 E5 오차 모델을 맞춰 그 달 예측에 붙인다.
  2) 급변기 보정: 2019-09-02 부터 날짜순으로 최근 10거래일 범위 이탈 일수를 세어, 신호가 켜진 날만 ACI 배율로 넓힌다.
     대상일 실제값은 그날 범위에 쓰지 않는다(정답이 들어오면 다음 실행 때 신호·배율이 갱신된다).
근거: experiments/daily/test/pred_interval/(06·08 단계), 2026-11-03.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True

import pandas as pd

HERE = Path(__file__).resolve().parent             # service/predict
SERVICE = HERE.parent
sys.path[:0] = [str(HERE), str(SERVICE / 'mlops'), str(SERVICE)]
import range_model as RM  # noqa: E402
import artifacts as A  # noqa: E402
from features import timepoints as TPR  # noqa: E402


def _dir(tp):
    return A.ARTIFACTS / tp                                      # 시점별 폴더(재학습 점검은 임시 슬롯으로 바꿔 씀)


def deployed_version(tp):
    """시점 tp 에 지금 배포된 수익률 학습본 버전(범위는 이 학습본의 예측에 붙는다)."""
    return json.loads(A.manifest_path(tp, 'reg').read_text(encoding='utf-8'))['model_version']


def load_artifact(tp, check=True, local_assets=False):
    """(설정, 이력). check 면 범위 설정이 그 시점 배포 학습본과 짝인지 확인한다(다른 시점 학습본과 섞이지 않게)."""
    from model import assets
    import io
    cfg = assets.js(tp, 'range_config.json', local=local_assets)
    content = assets.read(tp, 'range_history.parquet', local=local_assets)
    if hashlib.sha256(content).hexdigest() != cfg['history_sha256']:
        raise ValueError(f'{tp}: range_history.parquet 해시가 range_config.json 과 다릅니다.')
    if cfg.get('time_point', tp) != tp:
        raise ValueError(f"{tp}: range_config.json 의 시점이 {cfg.get('time_point')} 입니다.")
    if check and cfg.get('model_version') != deployed_version(tp):
        raise ValueError(f"{tp}: 예측 범위가 {cfg.get('model_version')} 학습본용인데 배포 학습본은 {deployed_version(tp)} 입니다 — "
                         f"python mlops/post_deploy.py --tp {tp} --write 로 범위·SHAP 배경을 새 학습본에 맞추세요.")
    return cfg, pd.read_parquet(io.BytesIO(content))


def missing_days(tp, month, st, close):
    """범위 이력 끝 ~ 대상월 첫날 사이 코스피 거래일 중 저장소에 이 시점 서비스 예측이 없는 날."""
    _, hist = load_artifact(tp, check=False, local_assets=True)
    start = pd.Period(month, 'M').start_time
    need = close.index[(close.index > hist.index.max()) & (close.index < start)]
    return need.difference(service(st, tp).index)


def refresh(tp, month, st, close=None, write=True):
    """재학습 배포 뒤: 범위 이력 끝 ~ 대상월 첫날 사이의 실제 서비스 예측(그 달 학습본의 OOS)과 정답·보통 모델 범위를 이력에 붙이고,
    대상월 오차 모델을 맞춰 보고, range_config 에 새 학습본 버전·대상월을 적는다. 시점 tp 의 파일만 바꾼다."""
    from datetime import datetime, timezone
    close = kospi_close() if close is None else close
    cfg, hist = load_artifact(tp, check=False, local_assets=True)
    start = pd.Period(month, 'M').start_time
    miss = missing_days(tp, month, st, close)
    if len(miss):
        raise ValueError(f"{tp}: 범위 이력에 붙일 서비스 예측이 없는 거래일 {len(miss)}일({', '.join(d.strftime('%m-%d') for d in miss[:6])} ...) — "
                         f"그 날짜를 그 달 학습본으로 예측해 저장한 뒤(run_predict.py --tp {tp} --target … --write) 다시 하세요.")
    svc = service(st, tp)
    svc = svc[(svc.index > hist.index.max()) & (svc.index < start)]
    if len(svc):
        _, inputs, _, _ = RM.prepare_range(tp, hist, svc, close, cfg)
        # 실험 OOS의 F0 비교 열은 서비스 예측에 없으므로 새 행에서는 결측으로 보존한다.
        # 범위 적합에 필요한 열은 여전히 필수이며 누락 시 즉시 중단한다.
        inputs.loc[:, RM.PRED_COLS]
        add = inputs.loc[inputs.index < start].reindex(columns=hist.columns)
        hist = pd.concat([hist, add]).sort_index()
        hist.index.name = 'target_dd'
    em = RM.ErrorModel().fit(hist[RM.PRED_COLS][hist.index < start].iloc[:-1])     # 대상월 오차 모델(예측 때 같은 규칙으로 다시 맞춤)
    cfg.update(time_point=tp, model_version=deployed_version(tp), range_month=month, history_end=str(hist.index.max().date()),
               error_model_train_rows=int(em.n_train), refreshed_utc=datetime.now(timezone.utc).isoformat(),
               refreshed_by='mlops/post_deploy.py (재학습·승격 배포 뒤)')
    if write:
        f = _dir(tp) / 'range_history.parquet'
        tmp = f.with_suffix('.tmp')
        hist.to_parquet(tmp)
        cfg['history_sha256'] = hashlib.sha256(tmp.read_bytes()).hexdigest()
        tmp.replace(f)
        (_dir(tp) / 'range_config.json').write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding='utf-8')
    return {'time_point': tp, 'added_days': int(len(svc)), 'history_end': cfg['history_end'], 'error_model_train_rows': int(em.n_train),
            'model_version': cfg['model_version']}


def kospi_close():
    """DB KOSPI 종가와 동일 시장 근거 거래일(정형 입력의 skip 판정과 동일, 읽기 전용)."""
    import db
    from db.standardize import standardize
    from features import config as C, dataset as D, preprocess as PP, missing as MS, db_snapshot
    from sqlalchemy import text
    raw = {}
    with db.get_engine().connect().execution_options(isolation_level='REPEATABLE READ') as con:
        with con.begin():
            con.execute(text('SET TRANSACTION READ ONLY'))
            for key in D.needed_keys():
                if C.key_market()[key] == 'KR':
                    s = standardize(db.read_table(con, key).astype('string'), db.TABLES[key].get('cols'))
                    if key == C.KOSPI_KEY:                       # 예측 입력과 같은 KOSPI(krx_kospi_1001 우선)
                        s = db_snapshot.fill_kospi_today(con, s)
                    raw[key], _ = PP.clean_symbol_frame(s)
    lo = min(f.index.min() for f in raw.values())
    hi = max(f.index.max() for f in raw.values())
    opens = MS.open_days('KR', [f.Close.dropna().index for f in raw.values()], lo, hi)
    source = raw[C.KOSPI_KEY]
    labels = MS.classify_missing(source.Close, opens)
    clean = MS.apply_missing_policy(source, labels, 'skip', is_target=True)
    close = clean.Close.astype(float).rename('close')
    close.attrs['trading_days'] = opens.union(close.index)
    return close


def before(series, days):
    """공용 범위 모듈의 직전 거래일 값 조회."""
    return RM.previous_values(series, days)


def service(st, tp, start=None, end=None, versions=None, prediction_at=None):
    """과거 이력(대상일마다 가장 늦은 prediction_at)을 읽고, 범위를 붙일 구간은 지정한 분류·회귀 모델 쌍(·실행 시각)으로 고정한다."""
    if versions is None:
        s = st.pred_latest(tp, start, end)
    else:
        s = st.pred_latest(tp)
        selected = st.pred_latest(tp, start, end, versions, prediction_at)
        if not s.empty:
            s = s[(s.index < start) | (s.index > end)]
        s = pd.concat([s, selected]).sort_index()
    if s.empty:
        return pd.DataFrame(columns=['p', 'r', 'r_raw', 'flip'], index=pd.DatetimeIndex([], name='target_dd'))
    return s[['p', 'r', 'r_raw', 'flip']].astype({'p': float, 'r': float, 'r_raw': float, 'flip': bool})


def build(tp, svc, close):
    """실험 OOS 이력 + 서비스 예측으로 날짜순 범위를 계산한다: (표, 설정). 표의 source = backtest | service."""
    cfg, hist = load_artifact(tp)
    return RM.RangeRuntime(tp, hist, svc, close, cfg).table, cfg


def main() -> None:
    ap = argparse.ArgumentParser(description='시점별 예측 범위(오차 모델 + 급변 신호 때만 보정) → 저장소 예측 행')
    ap.add_argument('--target', required=True, help='예측 대상일 YYYY-MM-DD')
    ap.add_argument('--from', dest='start', default=None, help='이 날짜부터 --target 까지(기본: 대상일 하루)')
    ap.add_argument('--tps', nargs='+', default=list(TPR.TPS), choices=list(TPR.TPS))
    ap.add_argument('--source', choices=('files', 'bundle'), default='files', help='예측에 사용한 학습본 출처')
    ap.add_argument('--prediction-at', help='범위를 붙일 예측 행의 기준 시각(대상일 하루·시점 하나일 때). 빼면 대상일마다 가장 늦은 행')
    ap.add_argument('--write', action='store_true', help='kospi_pred_reg 범위 열에 쓴다(없으면 화면만)')
    ap.add_argument('--mode', choices=('csv', 'db'), help='저장소(주면 예측·해설·자동화 기록 모두 이 모드. 빼면 .env KOSPI_PRED_MODE(예측·해설)·KOSPI_MLOPS_MODE(자동화 기록), 없으면 csv)')
    a = ap.parse_args()
    from store import open_prediction_store
    st = open_prediction_store(a.write, a.mode)
    st.require_tables()
    start, end = pd.Timestamp(a.start or a.target), pd.Timestamp(a.target)
    if a.prediction_at and (start != end or len(a.tps) != 1):
        ap.error('--prediction-at 은 대상일 하루·시점 하나일 때만 씁니다.')
    from explain import timepoint as TPM
    close = kospi_close()
    for tp in a.tps:
        _, manifests = TPM.load(tp, end, a.source)
        versions = {o: m['model_version'] for o, m in manifests.items()}
        cfg, hist = load_artifact(tp)
        if cfg['model_version'] != versions['reg']:
            raise ValueError(f"{tp}: 범위 설정 {cfg['model_version']}은 선택한 회귀 학습본 {versions['reg']}과 다릅니다.")
        t = RM.RangeRuntime(tp, hist, service(st, tp, start, end, versions, a.prediction_at), close, cfg).table
        at = st.pred_latest(tp, start, end, versions, a.prediction_at)     # 범위를 쓸 행의 prediction_at(대상일별)
        at = at.prediction_at if len(at) else pd.Series(dtype=object)
        show = t[(t.source == 'service') & (t.index >= start) & (t.index <= end)]
        print(f"== {tp} ({cfg['config_name']}, 이력 ~{cfg['history_end']})")
        if show.empty:
            message = f'{start.date()}~{end.date()}에 {tp} 선택 모델 쌍으로 범위를 계산할 저장 예측이 없습니다.'
            if a.write:
                raise ValueError(message)
            print(message)
            continue
        pd.set_option('display.width', 220)
        view = show.assign(r_pct=show.r * 100, actual_pct=show.y * 100,
                           lo80_close=show.prev_close * (1 + show.range_lo80_pct / 100), hi80_close=show.prev_close * (1 + show.range_hi80_pct / 100))
        print(view[['p', 'r_pct', 'range_lo80_pct', 'range_hi80_pct', 'range_lo95_pct', 'range_hi95_pct', 'lo80_close', 'hi80_close',
                    'range_regime', 'actual_pct']].round(3).to_string())
        k = show.dropna(subset=['y'])
        if len(k):
            c80 = ((k.y * 100 >= k.range_lo80_pct) & (k.y * 100 <= k.range_hi80_pct)).mean() * 100
            print(f'   정답 있는 {len(k)}일: 80% 범위 적중 {c80:.0f}%')
        if not a.write:
            continue
        explanations = st.explain_read(tp, start, end)
        if not explanations.empty:
            matched = ((explanations.status == 'ok')
                       & (explanations.cls_model_version == versions['cls'])
                       & (explanations.reg_model_version == versions['reg']))
            ex = explanations.loc[matched]
            done = set(zip(pd.to_datetime(ex.target_dd), ex.prediction_at))          # 같은 실행(prediction_at)의 해설만
            explained = pd.DatetimeIndex([d for d in show.index if (d, at.get(d)) in done])
            if len(explained):
                # 이미 공개한 해설의 범위는 보정 설정이 바뀌어도 함께 보존한다.
                show = show.drop(explained)
                print(f'   기존 해설과 연결된 저장 범위 {len(explained)}일 유지')
        for d, r in show.iterrows():
            st.pred_update('reg', {'target_dd': d, 'time_point': tp, 'model_version': versions['reg'], 'prediction_at': at[d]},
                           {**{c: float(r[c]) for c in ('range_lo80_pct', 'range_hi80_pct', 'range_lo95_pct', 'range_hi95_pct')},
                            'range_regime': bool(r.range_regime)})
        print(f'   저장: kospi_pred_reg 범위 {len(show)}일 -> {st.describe()}')
    if not a.write:
        print('저장하지 않았습니다(--write 로 kospi_pred_reg 에 씀).')


if __name__ == '__main__':
    main()
