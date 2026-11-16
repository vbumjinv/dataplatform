"""[실사용 스크립트] 월간 재학습 실행 — 시점(T0·T1·T2)만 받아 그 시점 학습 방식으로 다음 달용 학습본을 새 자료로 다시 만들고 배포한다.

실행(service 폴더):
  python run_retrain.py --tp T1                          # dry-run: 학습·확인만(운영 슬롯·저장소를 바꾸지 않음), 대상월 기본 = 다음 달
  python run_retrain.py --tp T0 --month 2026-12 --write  # 학습 → model/artifacts/T0 배포 → 해설용 SHAP 배경
  python run_retrain.py --tp T2 --month 2026-12 --write  # 챔피언·챌린저 학습 → 등록부 → 챔피언 배포 → SHAP 배경
  --grid on|off        격자 주기 무시(on: 이번에 grid search, off: 직전 파라미터 고정). 기본 auto = 대상월 1·4·7·10월만 grid search
  T2 만: --no-deploy(학습·등록만), --deploy-only(이미 등록된 그달 챔피언 배포만), --objective cls|reg, --lines model_1 …, --force,
         --allow-missing-news(비교용, 배포 금지), --mode csv|db(저장소, 기본 .env KOSPI_MLOPS_MODE)
시점별 학습 방식(학습 코드는 train/):
  T0    = 정형 F0(구성 모델 평균) + 회귀 K1 → train/retrain_f0.py(f0_trainer.py), 운영 슬롯에 바로 배포, 이전 학습본은 백업(최근 3개)
  T1    = 정형 F0 + 뉴스 조건부 보정(방향 X4·수익률 gate) + 방향 맞춤 → train/retrain_t1.py(학습본 이력에 지난달 OOS·뉴스를 이어 붙임), 운영 슬롯 배포·백업(최근 3개)
  T2    = 정형 F0 + 뉴스 결합, 챔피언(model_1)·챌린저(model_2) 두 계열 → train/retrain_t2.py(trainer.py), 등록부(kospi_mlops_model),
          챔피언만 배포(승격·되돌리기는 run_promote.py)
공통 규칙(사용자 결정 2026-11-04): 매달 새 자료로 재학습하고 파라미터는 직전 학습본 값, grid search 는 대상월 1·4·7·10월에만(train/grid_schedule.py).
  자동화(run_automation.py t0|t1|t2)가 대상일이 그달 마지막 거래일인 예측 직후 다음 달용으로 부른다. 배포 뒤 해설용 SHAP 배경을 다시 만든다.
주별 모델을 더하면 그 시점의 학습 방식을 여기 METHOD 에 한 줄 더한다(일별 시점은 그대로).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

SERVICE = Path(__file__).resolve().parent
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import grid_schedule as G  # noqa: E402
from features import timepoints as TPR  # noqa: E402

METHOD = {"T0": "retrain_f0", "T1": "retrain_t1", "T2": "retrain_t2"}     # 시점 -> 학습 방식(train/ 모듈)
T2_ONLY = ("no_deploy", "deploy_only", "force", "allow_missing_news")


def main():
    ap = argparse.ArgumentParser(description="월간 재학습(시점만 받아 그 시점 학습 방식으로)")
    ap.add_argument("--tp", required=True, type=TPR.norm, choices=list(METHOD), help="재학습할 시점")
    ap.add_argument("--month", help="YYYY-MM 학습본을 쓸 대상월(기본: 다음 달)")
    ap.add_argument("--write", action="store_true", help="실제로 배포·저장(없으면 dry-run)")
    ap.add_argument("--mode", choices=("db", "csv"), help="T2 기록 저장소(주면 예측·해설·자동화 기록 모두 이 모드. 빼면 .env KOSPI_PRED_MODE(예측·해설)·KOSPI_MLOPS_MODE(자동화 기록), 없으면 csv)")
    G.add_args(ap)
    g = ap.add_argument_group("T2 만")
    g.add_argument("--no-deploy", action="store_true", help="학습·등록만 하고 챔피언을 배포하지 않음")
    g.add_argument("--deploy-only", action="store_true", help="학습 없이 등록부의 그달 챔피언을 배포")
    g.add_argument("--objective", choices=("cls", "reg", "both"), default="both")
    g.add_argument("--lines", nargs="+", default=["model_1", "model_2"])
    g.add_argument("--force", action="store_true", help="같은 계열·대상월 학습본이 있어도 다시 학습")
    g.add_argument("--allow-missing-news", action="store_true", help="뉴스 0건인 날이 있어도 진행(비교용, 배포 금지)")
    ap.add_argument("--retrain-manual", action="store_true", help="deploy_model.py 로 직접 넣은 학습본이어도 재학습해 덮어씀")
    a = ap.parse_args()
    manual = [o for o in ("cls", "reg") if "manual_deploy" in json.loads(
        (SERVICE / "model" / "artifacts" / a.tp / f"{o}_model_1_manifest.json").read_text(encoding="utf-8"))]
    if manual and not a.retrain_manual:            # 직접 교체한 새 구조 학습본은 월간 재학습이 덮어쓰지 않는다(지금 재학습 코드는 기존 구조만 앎)
        print(f"{a.tp}: {manual} 학습본이 deploy_model.py 로 직접 교체한 것이라 월간 재학습을 건너뜁니다"
              f"(새 학습본은 deploy_model.py 로, 덮어쓰려면 --retrain-manual).")
        return
    if METHOD[a.tp] != "retrain_t2":
        used = [o for o in T2_ONLY if getattr(a, o)] + (["objective"] if a.objective != "both" else [])
        if used:
            ap.error(f"{a.tp} 에는 T2 전용 옵션을 쓸 수 없습니다: {used}")
    a.month = a.month or (pd.Timestamp.now(tz=TPR.tz()).tz_localize(None).to_period("M") + 1).strftime("%Y-%m")
    a.deploy = a.write and not a.no_deploy and not a.allow_missing_news       # T2: --write 면 챔피언 배포(자동화와 같음)
    import importlib
    from deployment_guard import recover_files
    # 후처리까지 성공해야 새 슬롯을 유지한다. 실패 시 범위·배경·통합본도 복구한다.
    with recover_files(a.tp, enabled=a.deploy or (a.write and a.deploy_only)):
        importlib.import_module(METHOD[a.tp]).run(a)


if __name__ == "__main__":
    main()
