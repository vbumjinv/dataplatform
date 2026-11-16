"""[실사용 모듈] 정형 F0 시점(T0·T1) 월간 재학습 — 지금 시점 학습본과 같은 구성(정형 F0 + 회귀 K1)으로 다음 달용 학습본을 새 자료로 다시 만들어 운영 슬롯에 배포한다.

실행은 공통 입구 run_retrain.py 로 한다: python run_retrain.py --tp T0|T1 [--month 2026-12] [--write] [--grid on|off]
파라미터: 매달은 지금 학습본 파라미터 고정 재학습, 대상월이 1·4·7·10월이면 grid search 로 다시 고른다(train/grid_schedule.py, 사용자 결정 2026-11-04).
  첫 파라미터(2026-10 학습본)는 세 시점 공통으로 실험(experiments/daily/test/f0_fixed_params)이 검증·홀드아웃으로 고른 값이다(2026-11-04).
입력: DB 정형 원천(읽기 전용, predict/engine.build_features — 대상월 직전 거래일 행까지), model/artifacts/<T>/{cls,reg}_model_1(구성 모델·변수)
출력(--write): model/artifacts/<T>/{cls,reg}_model_1.joblib·_manifest.json,
      이전 학습본 백업 mlops/paths.CACHE/slot_history/<T>/<model_version>/ (최근 3개만, 되돌리기: 이 폴더 파일을 슬롯에 다시 복사),
      배포 뒤 mlops/post_deploy.after_deploy(T0): 예측 범위(range_history·range_config 를 새 학습본에 맞춤)·해설용 SHAP 배경·통합본(T0 파일만 바꿈)
규칙: train/f0_trainer.py. 자동화(run_automation.py t0|t1)는 대상일이 그달 마지막 거래일인 예측 직후 다음 달용으로 부른다(놓치면 다음 거래일부터 그달용).
배포 뒤 predict/artifacts.load_checked 로 해시·파이프라인·대상월을 다시 검사하고, 실패하면 이전 파일로 되돌린다.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np

SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import artifacts as A  # noqa: E402
import db  # noqa: E402
import f0_trainer as F  # noqa: E402
import grid_schedule as G  # noqa: E402
import paths  # noqa: E402
import registry as R  # noqa: E402
from inputs import last_session_before  # noqa: E402


KEEP_BACKUPS = 3


def manifest_for(bundle, month, artifact, previous, TP):
    sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
    tuned = any(v.get("tuned", True) for v in bundle["members"].values())
    man = {k: v for k, v in bundle.items() if k != "members"}
    man.update(artifact=artifact.name, artifact_sha256=sha,
               members={n: {"params": v["params"], "inner_score": v["inner_score"], "tuned": v.get("tuned", True)} for n, v in bundle["members"].items()},
               selection=previous.get("selection"), member_selection=previous.get("member_selection"), grid="service/train/estimators.py F0_GRID", code="service/train/f0_trainer.py",
               grid_search=tuned, next_grid_month=None if bundle.get("param_policy") == F.FIXED_POLICY else G.next_grid_month(month),
               created=datetime.now(timezone.utc).isoformat(), model_version=f"model_1_{TP.lower()}_{bundle['objective']}_{month.replace('-', '_')}_{sha[:12]}",
               pipeline=f"predict/{A.PIPELINES[TP]}", pipeline_sha256=A.pipeline_hash(TP))
    return man


def run(a):
    """a: run_retrain.py 인자(tp·month·write·grid). --write 면 학습 → 운영 슬롯 배포 → SHAP 배경."""
    TP = a.tp
    from engine import build_features
    month = a.month
    current = {o: A.load_checked(TP, o)[1] for o in ("cls", "reg")}
    have = current["cls"]["target_month"]
    if have == month:
        print(f"{TP} {month} 학습본이 이미 배포되어 있습니다({current['cls']['model_version']}).")
        return
    if have > month:
        raise SystemExit(f"운영 슬롯이 {have} 학습본이라 그보다 이른 {month} 학습본으로 바꾸지 않습니다.")
    last = last_session_before(month)
    grid = G.grid_due(month, a.grid)
    if a.grid == "auto" and all(current[o].get("param_policy") == F.FIXED_POLICY for o in ("cls", "reg")):
        grid = False                                                 # 파라미터 고정 학습본(T0, 2026-11-09 재선정): 격자 달에도 재적합만(목적별 처리는 fit_point)
    import post_deploy as PD
    from store import open_store
    st = open_store(a.write, getattr(a, "mode", None))              # --write 면 배포 뒤 슬롯 백업(kospi_mlops_slot)도 씀
    close = PD.check_ready(TP, month, st) if a.write else None       # 배포 뒤 범위 이력에 붙일 예측이 다 있는지 학습 전에 확인
    print(f"{TP} 재학습 {month} | 자료 ~{last.date()}(gap) | 구성 cls {list(current['cls']['members'])}, reg {list(current['reg']['members'])}"
          f" | {'grid search' if grid else f'파라미터 고정(다음 격자 {G.next_grid_month(month)})'}", flush=True)
    ds = build_features(TP, last, db.get_engine())
    bundles = F.fit_point(ds, month, current, grid=grid, force_grid=a.grid == "on")
    p = A.predict_f0(bundles, ds.iloc[-5:])                                    # 계산 확인용(학습 구간 행이라 성능 정보는 아님)
    if not all(np.isfinite(v).all() for v in (p["prob_up"], p["ret"])):
        raise ValueError("새 학습본 예측에 NaN 또는 무한대 포함")
    if not a.write:
        print("dry-run: 운영 슬롯을 바꾸지 않았습니다(--write 로 배포).")
        return
    slot = A.ARTIFACTS / TP
    backup_dir = paths.CACHE / "slot_history" / TP / current["cls"]["model_version"]
    backup_dir.mkdir(parents=True, exist_ok=True)
    files = [slot / f"{o}_model_1{s}" for o in ("cls", "reg") for s in (".joblib", "_manifest.json")]
    for f in files:
        shutil.copy2(f, backup_dir / f.name)
    versions = {}
    try:
        for o in ("cls", "reg"):
            art = slot / f"{o}_model_1.joblib"
            joblib.dump(bundles[o], art)
            man = manifest_for(bundles[o], month, art, current[o], TP)
            A.manifest_path(TP, o).write_text(json.dumps(man, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
            versions[o] = man["model_version"]
        for o in ("cls", "reg"):
            A.load_checked(TP, o, month)
    except Exception:
        for f in files:
            shutil.copy2(backup_dir / f.name, f)
        raise
    print(f"[배포] {TP} {month}: {versions['cls']} / {versions['reg']} (이전 학습본 백업 {backup_dir})")
    old = sorted(backup_dir.parent.iterdir(), key=lambda d: d.stat().st_mtime)[:-KEEP_BACKUPS]   # 백업은 최근 몇 개만(서버에 쌓이지 않게)
    for d in old:
        shutil.rmtree(d)
    PD.after_deploy(TP, st, close, month)                          # 이 시점의 예측 범위·SHAP 배경·통합본을 새 학습본에 맞춤

