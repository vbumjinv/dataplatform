#!/usr/bin/env bash
# [실사용 스크립트] cron: python run_automation.py w0 --scheduled --write (설명은 service_5/README.md)
source "$(dirname "$0")/common.sh"
"$PY" -B run_automation.py w0 --scheduled --write --wait-minutes 90 "$@" >>"$LOG_DIR/w0.log" 2>&1
