"""[실사용 스크립트] T2 챌린저 예측 원장 기록 — 챔피언과 같은 입력으로 챌린저 계열을 예측해 저장소 kospi_mlops_ledger 에 쌓는다(챔피언 예측은 kospi_pred_* 에 있어 다시 쓰지 않음).

저장소: --mode db(dp.kospi_mlops_* 테이블) | csv(outputs/tables/kospi_mlops_*.csv), 빼면 .env KOSPI_MLOPS_MODE(기본 csv) — mlops/store.py.
        아래 kospi_mlops_* 는 두 모드에서 같은 이름·열이다. 정형 원천·dp.news_feature_orig 는 모드와 관계없이 운영 DB에서 읽기만 한다.
실행(service 폴더): python run_record_predictions.py --write              # 오늘(대상일) 08:30 이후, 장 시작 09:00 전에 실행
                   python run_record_predictions.py --target 2026-10-30 --from 2026-10-01 --write   # 소급 기록(prospective=False)
                   (--write 없으면 예측만 출력하고 DB에 쓰지 않는다)
입력: 정형 원천·dp.news_feature_orig(읽기 전용), kospi_mlops_model(대상월 학습본), kospi_mlops_role, 뉴스 이력 model/data/news_daily_history.parquet
출력(저장소): kospi_mlops_ledger — 한 행 = 대상일 x 목적 x 챌린저 학습본. 같은 키는 덮어쓰지 않는다(먼저 기록한 값 유지).
         열: line, role(기록 당시), model_version, yhat(상승확률/수익률), components(정형 F0·뉴스 모델 예측),
         inputs(모델 입력값), news_articles, prediction_at, recorded_at, prospective(09:00 전 기록), source_snapshot_at, host

입력 변수는 predict/engine.py --tp T2 와 같은 함수·같은 뉴스 이력으로 만든다(챔피언 값이 run_predict.py 출력과 같아야 한다).
서비스 화면·DB 저장·SHAP·해설은 지금처럼 run_predict.py 가 챔피언만 한다. 이 스크립트는 비교용 기록만 남긴다.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

SERVICE = Path(__file__).resolve().parent
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import inputs as I  # noqa: E402
import registry as R  # noqa: E402
import trainer as T  # noqa: E402
from store import add_args, open_store  # noqa: E402

HIST = SERVICE / "model" / "data" / "news_daily_history.parquet"
KST = "Asia/Seoul"


def main():
    ap = argparse.ArgumentParser(description="챔피언·챌린저 예측을 원장에 기록")
    ap.add_argument("--target", help="대상일 YYYY-MM-DD(기본: 오늘)")
    ap.add_argument("--from", dest="start", help="이 날짜부터 --target 까지 매 거래일(소급 기록)")
    ap.add_argument("--objective", choices=("cls", "reg", "both"), default="both")
    add_args(ap)
    a = ap.parse_args()
    st = open_store(a.write, a.mode)
    st.require_tables()
    now = pd.Timestamp.now(tz=KST)
    target = pd.Timestamp(a.target) if a.target else now.tz_localize(None).normalize()
    start = pd.Timestamp(a.start) if a.start else target
    objs = ("cls", "reg") if a.objective == "both" else (a.objective,)

    hist = pd.read_parquet(HIST)
    ds, news, meta = I.load_snapshot(target, target_date=target, news_after=hist.index.max(), news_hist=hist)
    days = ds.index[(ds.index >= start) & (ds.index <= target)].intersection(news["cls"].index)
    lines = st.roles()
    rows, notes = [], []
    for obj in objs:
        for role in ("challenger",):                                     # 챔피언은 run_predict.py 가 kospi_pred_* 에 저장
            line = lines[obj].get(role)
            if not line:
                continue
            for month, md in pd.Series(days, index=days).groupby(days.strftime("%Y-%m")):
                man = R.find(st, obj, line, month)
                if man is None:
                    notes.append(f"{obj}/{role}({line}) {month}: 학습본 없음")
                    continue
                if man["target_month"] != month:
                    notes.append(f"{obj}/{role}({line}) {month}: 재학습 전이라 {man['target_month']} 학습본으로 임시 예측")
                bundle = R.load(st, man)
                cols = T.feature_columns(bundle)
                mdays = pd.DatetimeIndex(md.values)
                frame = pd.concat([ds.loc[mdays], news[obj].loc[mdays]], axis=1)[cols]
                yhat, parts = T.predict_parts(bundle, frame)
                if not np.isfinite(yhat).all():
                    raise ValueError(f"{man['model_version']}: 예측에 NaN/무한대")
                for i, d in enumerate(mdays):
                    open_at = pd.Timestamp(d).tz_localize(KST) + pd.Timedelta(hours=9)
                    rows.append({"target_dd": d, "objective": obj, "line": line, "role": role,
                                 "model_version": man["model_version"], "target_month": month, "yhat": float(yhat[i]),
                                 "components": json.dumps({k: float(v[i]) for k, v in parts.items()}),
                                 "inputs": json.dumps({c: (None if pd.isna(x) else float(x)) for c, x in frame.loc[d].items()}),
                                 "news_articles": int(news["articles_per_day"].get(d, 0)),
                                 "prediction_at": str(ds.loc[d, "prediction_at"]), "recorded_at": str(now),
                                 "prospective": bool(now < open_at), "source_snapshot_at": meta["source_snapshot_at"]})
    added = st.ledger_append(pd.DataFrame(rows)) if rows else 0
    for n in notes:
        print("[주의]", n)
    print(f"원장 기록: {added}행 추가 (후보 {len(rows)}행, 대상 {len(days)}거래일) -> {st.describe()}")
    if rows:
        show = pd.DataFrame(rows)[["target_dd", "objective", "role", "line", "yhat", "prospective"]]
        print(show.tail(8).to_string(index=False))


if __name__ == "__main__":
    main()
