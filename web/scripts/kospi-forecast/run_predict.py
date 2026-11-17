"""[실사용 스크립트] KOSPI 예측 실행 — 시점(T0·T1·T2)만 받아 예측 → 예측 범위 → SHAP·해설을 순서대로 실행한다. 시각은 service/time_points.json.

실행(service 폴더에서):
      python run_predict.py --tp T0                                    가장 최근 T0 시각 기준 대상일 예측(화면만, 저장 없음)
      python run_predict.py --tp T1 --target 2026-10-30                대상일 지정
      python run_predict.py --tp T2 --target 2026-10-30 --write        예측·범위·SHAP 을 저장소에 저장(--llm 이면 GPT 해설도, 유료)
      --mode csv|db     저장소(주면 예측·해설·자동화 기록 모두 이 모드. 빼면 .env KOSPI_PRED_MODE(예측·해설)·KOSPI_MLOPS_MODE(자동화 기록), 없으면 csv): csv = outputs/tables/<테이블>.csv, db = dp.kospi_pred_* 테이블
      --source bundle   통합본(model/artifacts/bundle/)으로 예측, 기본 files = 시점별 원본
      --ready-through 2026-10-01T08:30:00+09:00   (T2 당일 실행, 선택) 자료 기준 시각. 빼면 실행 시각 — 그때까지 DB 에 적재된 뉴스 피처로 예측
      --prediction-at 2026-11-14T16:00:00+09:00   실행일 기준 시각(run_automation.py 가 넘김). --target 과 함께
대상일·기준 시각 기본값(--target 없을 때): 지금 시각 이전 가장 최근 시점 시각의 실행일(주말·휴일 포함) 기준
  — prediction_at = 실행일 시점 시각, 대상일 = T0 는 실행일 다음 첫 거래일, T1·T2 는 실행일 포함 첫 거래일(토·일 실행 → 월요일).
  --target 만 주면(소급) prediction_at = 대상일의 등록부 시각. 저장 키는 (대상일, 시점, prediction_at) 이라 실행일마다 행이 쌓인다.
  --write 때 (대상일, 시점, prediction_at) 예측이 이미 있으면 예측·범위·SHAP 을, 해설이 있으면 GPT 해설을 실행하지 않는다(예측만 있으면 빠진 해설만 만듦).
단계: predict/engine.py --tp <tp> → (저장할 때) predict/predict_range.py --tps <tp> --write → explain/explain_timepoint.py --tp <tp> --write
입력: DB 정형 원천(db/tables.py), T2 는 dp.news_feature_orig, model/artifacts/<T>/(또는 bundle/), service/time_points.json
출력: 화면 / 저장소 kospi_pred_cls·kospi_pred_reg(예측·모델 입력·범위·SHAP)·kospi_pred_explain(해설) — mlops/store.py
순서: run_news_crawl.py(또는 서버 크롤러) → run_news_features.py → run_predict.py --tp T2
"""
import sys
sys.dont_write_bytecode = True
import argparse
import subprocess
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
PREDICT = HERE / "predict"
EXPLAIN = HERE / "explain"
sys.path.insert(0, str(HERE))
from features import timepoints as TPR  # noqa: E402


def saved(tp, target, at, mode=None):
    """Return completion flags for prediction, range, SHAP and explanation."""
    sys.path.insert(0, str(HERE / 'mlops'))
    from store import RANGE_COLS, open_prediction_store
    from store_pred import VALUE

    st = open_prediction_store(False, mode)
    at = pd.Timestamp(at)
    rows = {}
    for obj in ('cls', 'reg'):
        frame = st.pred_read(obj, tp, target, target)
        rows[obj] = frame[(frame.prediction_at == at) & frame[VALUE[obj]].notna()] if len(frame) else frame
    have_pred = all(len(frame) for frame in rows.values())
    have_range = bool(have_pred and rows['reg'][list(RANGE_COLS)].notna().all(axis=1).any())
    have_shap = bool(have_pred and all(frame.shap_result.map(bool).any() for frame in rows.values()))
    ex = st.explain_read(tp, target, target)
    have_explain = bool(len(ex) and ((ex.prediction_at == at) & (ex.status == 'ok')).any())
    return have_pred, have_range, have_shap, have_explain


def main():
    ap = argparse.ArgumentParser(description="시점(T0·T1·T2)만 받아 예측 → 범위 → SHAP·해설")
    ap.add_argument('--tp', required=True, type=TPR.norm, choices=list(TPR.TPS), help='시점 T0·T1·T2(소문자도 됨)')
    ap.add_argument('--target', help='예측 대상일 YYYY-MM-DD(빼면 지금 시각 기준 가장 최근 대상일)')
    ap.add_argument('--write', action='store_true', help='예측·범위·SHAP(·해설)을 저장소에 저장(없으면 예측만 화면에)')
    ap.add_argument('--mode', choices=('csv', 'db'), help='저장소(주면 예측·해설·자동화 기록 모두 이 모드. 빼면 .env KOSPI_PRED_MODE(예측·해설)·KOSPI_MLOPS_MODE(자동화 기록), 없으면 csv)')
    ap.add_argument('--llm', action='store_true', help='GPT 해설(유료). --write 와 함께')
    ap.add_argument('--source', choices=('files', 'bundle'), default='files', help='학습본: 시점별 원본(files) 또는 통합본(bundle)')
    ap.add_argument('--ready-through', help='T2 당일(선택): 자료 기준 시각(시간대 포함). 빼면 실행 시각')
    ap.add_argument('--prediction-at', help='실행일 기준 시각(시간대 포함, --target 과 함께). 빼면 위 기본값')
    ap.add_argument('--explain-only', action='store_true', help='저장된 입력으로 SHAP·해설만 실행')
    ap.add_argument('--refresh-shap', action='store_true', help='SHAP을 새로 계산')
    a = ap.parse_args()
    tp = a.tp
    if a.llm and not a.write:
        ap.error('--llm 은 --write 와 함께 사용하세요(해설을 저장소에 남김).')
    if a.explain_only and not a.write:
        ap.error('--explain-only는 --write와 함께 사용하세요.')
    if a.prediction_at and not a.target:
        ap.error('--prediction-at 은 --target 과 함께 주세요.')
    if a.target:
        target = pd.Timestamp(a.target)
        at = pd.Timestamp(a.prediction_at) if a.prediction_at else TPR.cutoff(tp, target)
    else:
        target, at = TPR.run_point(tp, TPR.run_day(tp))
    target, at = str(target.date()), at.isoformat()
    src = ['--source', a.source]
    store = ['--write'] + (['--mode', a.mode] if a.mode else [])
    pa = ['--prediction-at', at]
    pred = [PREDICT / 'engine.py', '--tp', tp, '--target', target] + pa + src + (store if a.write else [])
    if tp == 'T2':      # 뉴스 처리 완료를 기다리지 않고 실행 시각까지 DB 에 적재된 피처로 예측한다(사용자 결정 2026-11-12)
        ready = a.ready_through or pd.Timestamp.now(tz=TPR.tz()).isoformat(timespec='seconds')
        pred += ['--ready-through', ready]
    # (대상일, 시점, prediction_at) 예측·해설이 이미 있으면 그 단계는 건너뛰고 한 줄로 알린다(사용자 결정 2026-11-13, 안내 문구 2026-11-16)
    have_pred, have_range, have_shap, have_explain = saved(tp, target, at, a.mode) if a.write else (False,) * 4
    commands = [] if a.explain_only or have_pred else [pred]
    if a.write:
        if not a.explain_only and not have_range:
            commands.append([PREDICT / 'predict_range.py', '--target', target, '--tps', tp] + pa + src + store)
        if not have_shap or not have_range or a.explain_only or a.refresh_shap or (a.llm and not have_explain):
            commands.append([EXPLAIN / 'explain_timepoint.py', '--tp', tp, '--target', target] + pa + src + store
                            + (['--llm'] if a.llm else []) + (['--refresh-shap'] if a.refresh_shap else []))
        done = [n for n, h in zip(('예측', '범위', 'SHAP', '해설'), (have_pred, have_range, have_shap, have_explain)) if h]
        if not commands:
            print(f"이미 실행해 저장된 예측입니다({tp}, 대상일 {target}). 다시 실행하지 않습니다.", flush=True)
            return
    print(f"시점 {tp} ({TPR.label(tp)}), 대상일 {target}, 기준 시각 {at}, 학습본 {a.source}", flush=True)
    if a.write:
        if done and not a.explain_only:
            print(f"이미 저장됨: {'·'.join(done)} → 건너뛰고 빠진 단계만 실행합니다.", flush=True)
    for command in commands:
        result = subprocess.run([sys.executable, '-B', *map(str, command)], cwd=HERE)
        if result.returncode:
            raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
