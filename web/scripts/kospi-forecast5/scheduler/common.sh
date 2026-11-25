#!/usr/bin/env bash
# [실사용 스크립트] 주별 cron 작업 공통 준비 — service_5 폴더로 이동, 가상환경, 시간대·인코딩, 로그 폴더. w0·w2·evening.sh 가 source 한다.
# 일별 service_daily/scheduler/common.sh 와 같은 방식(같은 서버·같은 가상환경 KOSPI5_VENV 를 써도 됨). 작업 순서·휴장일 처리는 run_automation.py 가 한다.
set -euo pipefail
KOSPI5_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KOSPI5_DIR" || exit 1
export TZ=Asia/Seoul PYTHONIOENCODING=utf-8 PYTHONUTF8=1
if [ -n "${KOSPI5_VENV:-}" ]; then source "$KOSPI5_VENV/bin/activate"; fi
if [ -x "$KOSPI5_DIR/.venv/bin/python" ]; then
    DEFAULT_PY="$KOSPI5_DIR/.venv/bin/python"
else
    DEFAULT_PY=python3
fi
PY="${KOSPI5_PYTHON:-$DEFAULT_PY}"
LOG_DIR="$KOSPI5_DIR/outputs/logs"
mkdir -p "$LOG_DIR"
