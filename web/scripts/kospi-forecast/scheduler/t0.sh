#!/usr/bin/env bash
# [실사용 스크립트] cron: python run_automation.py t0 --write (설명은 scheduler/README.md)
source "$(dirname "$0")/common.sh"
"$PY" run_automation.py t0 --write "$@" >>"$LOG_DIR/t0.log" 2>&1
