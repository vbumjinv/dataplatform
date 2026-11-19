"""[실사용 스크립트] 예측·해설 단계별 소요 시간 측정 — 캐시 없이 DB에서 원천(정형+뉴스)을 읽어 예측 → 예측 범위 → SHAP → 근거 기사 → LLM 해설까지 단계마다 시간을 잰다.

실행(service 폴더에서): python explain/time_pipeline.py --targets 2026-10-02 2026-10-06 [--tps T0 T1 T2]
입력: DB(읽기 전용: 정형 원천·dp.news_feature_orig·KOSPI 종가), model/artifacts/<T>/(학습본·범위 이력), outputs/explain/shap_background/<T>/(200행 배경),
      explain/prompts/v12, OPENAI_API_KEY(service/.env, 유료 호출 시점·대상일마다 1번)
출력: outputs/explain/time_pipeline_timings.csv — 행 = (target_dd, time_point, step): 단계 이름·초. DB 에는 쓰지 않는다.
측정 방법:
  - 캐시를 쓰지 않는다: 저장된 SHAP·LLM 응답·예측 입력을 읽지 않고 매번 새로 계산·호출한다(LLM 응답은 저장하지 않아 서비스 결과를 바꾸지 않음).
  - 예측 단계는 공통 engine.predict의 DB 조회·입력 구성·모델 계산·임시 CSV 저장을 합쳐 잰다. 해설은 그 행을 읽는다.
  - 예측 범위는 DB 종가 읽기와 범위 계산·저장(predict_range.build)을 잰다. 서비스 저장소(outputs/tables)는 바꾸지 않는다.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True
from pathlib import Path as _P
_H = _P(__file__).resolve().parent
sys.path[:0] = [str(_H), str(_H.parent / 'predict'), str(_H.parent / 'mlops'), str(_H.parent)]

import argparse  # noqa: E402
import contextlib  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
from contextlib import contextmanager  # noqa: E402

import pandas as pd  # noqa: E402

import timepoint as TPM  # noqa: E402
import explain_timepoint as E  # noqa: E402
from service_runtime import OUTPUTS  # noqa: E402

OUT = OUTPUTS / 'explain' / 'time_pipeline_timings.csv'
STEP = {'load': '학습본 읽기', 'predict_stage': 'DB 조회·입력 구성·모델 예측·임시 저장',
        'range': '예측 범위(DB 종가·범위 계산)',
        'shap': 'SHAP(방향·수익률, 200행 배경)', 'news_pick': '근거 기사 고르기(DB)', 'llm': 'LLM 해설(GPT 5.6 sol)', 'total': '전체'}


class Clock:
    """감싼 함수의 실행 시간을 이름별로 더한다. 감싼 함수 안에서 또 불린 감싼 함수(예: DB 읽기 안의 read_sql)는 바깥 것에만 센다."""
    def __init__(self):
        self.sec = {}
        self.depth = 0

    @contextmanager
    def wrap(self, obj, attr, name):
        orig = getattr(obj, attr)

        def timed(*a, **k):
            if self.depth:
                return orig(*a, **k)
            self.depth += 1
            t = time.perf_counter()
            try:
                return orig(*a, **k)
            finally:
                self.depth -= 1
                self.sec[name] = self.sec.get(name, 0.0) + time.perf_counter() - t
        setattr(obj, attr, timed)
        try:
            yield
        finally:
            setattr(obj, attr, orig)


def predict_stage(tp, target, st, clock):
    """Run the shared DB pipeline into the isolated output store."""
    import engine
    t = time.perf_counter()
    engine.predict(tp, target, write=True, mode='csv')
    clock.sec['predict_stage'] = time.perf_counter() - t


def run(tp, target, eng, st):
    import news_pick
    import predict_range as PR
    clock = Clock()
    t0 = time.perf_counter()
    t = time.perf_counter()
    bundles, manifests = TPM.load(tp, target)
    clock.sec['load'] = time.perf_counter() - t
    for name in ('pred_cls', 'pred_reg'):                   # 사본 저장소에 그날 예측이 있으면 지워 예측 단계를 처음부터 잰다
        df = st._load(name)
        st._save(name, df[~((df.time_point == tp) & (df.target_dd == target))])
    predict_stage(tp, target, st, clock)
    t = time.perf_counter()
    close = PR.kospi_close()
    rt, _ = PR.build(tp, PR.service(st, tp), close)
    reg = st.pred_latest(tp, target, target)
    st.pred_update('reg', {'target_dd': target, 'time_point': tp, 'model_version': reg.loc[target, 'model_version_reg'],
                           'prediction_at': reg.loc[target, 'prediction_at']},
                   {**{c: float(rt.loc[target, c]) for c in ('range_lo80_pct', 'range_hi80_pct', 'range_lo95_pct', 'range_hi95_pct')},
                    'range_regime': bool(rt.loc[target, 'range_regime'])})
    clock.sec['range'] = time.perf_counter() - t
    inp = TPM.inputs(tp, target, bundles, manifests, st)
    rng = E.range_info(st, tp, target, inp)             # 해설 입력용 평소 대비 폭(저장된 범위와 같은지 확인)
    t = time.perf_counter()
    shap = E.run_shap(tp, bundles, manifests, inp, 8)
    clock.sec['shap'] = time.perf_counter() - t
    t = time.perf_counter()
    factors = [{'variable': f['variable'], 'name': TPM.NAMES.get(f['variable'], ('', f['variable']))[1], 'pp': f['contribution_pp'] / (1 if o == 'cls' else 0.1)}
               for o in ('cls', 'reg') for f in shap[o]['features'][:8]]
    with eng.connect() as con:
        news = news_pick.pick(con, inp['prediction_at'], factors, inp['p'])
    clock.sec['news_pick'] = time.perf_counter() - t
    payload = E.llm_input(tp, target, inp, shap, news, 8, rng)
    t = time.perf_counter()
    E.call_llm(payload, news['links'], shap, None, 'v12', use_cache=False)
    clock.sec['llm'] = time.perf_counter() - t
    clock.sec['total'] = time.perf_counter() - t0
    return [{'target_dd': str(target.date()), 'time_point': tp, 'step': k, 'step_name': STEP[k], 'seconds': round(clock.sec[k], 2)}
            for k in STEP if k in clock.sec]


def main():
    ap = argparse.ArgumentParser(description='캐시 없이 DB→예측→범위→SHAP→근거 기사→LLM 단계별 소요 시간')
    ap.add_argument('--targets', nargs='+', required=True)
    ap.add_argument('--tps', nargs='+', default=TPM.TPS, choices=TPM.TPS)
    a = ap.parse_args()
    import db
    eng = db.get_engine()
    rows = []
    with tempfile.TemporaryDirectory() as tmp:                 # 서비스 저장소를 바꾸지 않게 CSV 저장소 사본에서 실행
        from store import open_store
        src = open_store(False, 'csv')
        for f in src.dir.glob('*.csv'):
            shutil.copy2(f, tmp)
        os.environ['KOSPI_CSV_DIR'] = tmp
        st = open_store(True, 'csv')
        st.create_tables()
        for d in a.targets:
            for tp in a.tps:
                r = run(tp, pd.Timestamp(d), eng, st)
                rows += r
                print(f'{tp} {d}: ' + ', '.join(f"{x['step_name']} {x['seconds']:.1f}초" for x in r), flush=True)
    new = pd.DataFrame(rows)
    if OUT.exists():
        old = pd.read_csv(OUT, dtype={'target_dd': str})
        old = old[~old.set_index(['target_dd', 'time_point']).index.isin(new.set_index(['target_dd', 'time_point']).index)]
        new = pd.concat([old, new], ignore_index=True)
    new.to_csv(OUT, index=False, encoding='utf-8-sig')
    print('저장:', OUT)


if __name__ == '__main__':
    main()
