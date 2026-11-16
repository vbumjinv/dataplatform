"""[실사용 모듈] 자동화 로컬 작업 폴더 위치 — 상태는 모두 DB(mlops/store.py)에 있고, 여기는 내려받은 학습본 캐시·로그만 둔다.

사용처: mlops/*.py, train/*.py, run_*.py
환경변수 KOSPI_CACHE_DIR(.env 가능)를 주면 그 아래, 비우면 service/outputs/mlops/tracking 아래(2026-11-03 outputs 로 모음):
  models/<model_version>/   DB(kospi_mlops_model)에서 내려받은 bundle.joblib·background.parquet·manifest.json (지워도 다시 받음)
  staging/                  학습 직후 DB에 올리기 전 임시 폴더
  logs/                     실행 로그·알림 기록(notifications.jsonl)
TRAIN_SEED: 실험 캐시에서 만든 학습 시드 파일 위치(train/build_seed.py 출력, run_mlops_setup.py 가 DB로 올림. 노트북에서만 필요)
"""
from __future__ import annotations

import os
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
try:
    from dotenv import load_dotenv
    load_dotenv(SERVICE / ".env")
except ImportError:
    pass

_cache = os.environ.get("KOSPI_CACHE_DIR", "").strip()
CACHE = Path(_cache).expanduser().resolve() if _cache else SERVICE / "outputs" / "mlops" / "tracking"
MODELS = CACHE / "models"
STAGING = CACHE / "staging"
LOGS = CACHE / "logs"
TRAIN_SEED = SERVICE / "train" / "data"
DEFAULT_ROLES = {"cls": {"champion": "model_1", "challenger": "model_2"},
                 "reg": {"champion": "model_1", "challenger": "model_2"}}
