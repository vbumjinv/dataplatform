#!/usr/bin/env bash
# [실사용 스크립트] cron 작업 공통 준비 — service 폴더로 이동, 가상환경, 시간대·인코딩, 로그 파일. 다른 sh 파일이 source 한다.
# 작업 순서·휴장일·중복 실행 잠금·DB 기록·실패 알림은 run_automation.py 가 한다. 스위치는 service/.env(KOSPI_*)에 둔다.
set -uo pipefail
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SERVICE_DIR" || exit 1
export TZ=Asia/Seoul PYTHONIOENCODING=utf-8 PYTHONUTF8=1
if [ -n "${KOSPI_VENV:-}" ]; then source "$KOSPI_VENV/bin/activate"; fi
PY="${KOSPI_PYTHON:-python3}"
LOG_DIR="${KOSPI_CACHE_DIR:-$SERVICE_DIR/outputs/mlops/tracking}/logs"
mkdir -p "$LOG_DIR"
