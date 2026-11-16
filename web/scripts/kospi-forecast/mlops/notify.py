"""[실사용 모듈] 알림 보내기 자리 — 경고·실패를 한 함수로 모은다. 지금은 로그 파일에만 쓰고, 알림 채널이 생기면 여기만 고친다.

사용처: run_monitor_daily.py(경고), train/retrain_t2.py(T2 재학습 실패·배포), scheduler/*.sh(스크립트 실패)
기록: <상태 폴더>/logs/notifications.jsonl (한 줄 = 알림 하나)
채널: .env 의 NOTIFY_WEBHOOK_URL 이 있으면 JSON {"title","level","lines"} 를 POST 한다(슬랙·팀즈 등 웹훅). 비우면 보내지 않는다.
실행: python mlops/notify.py "제목" "본문"    (셸 스크립트 실패 알림용)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths  # noqa: E402


def send(title: str, lines: list[str] | str, level: str = "warn") -> None:
    lines = [lines] if isinstance(lines, str) else list(lines)
    rec = {"at": datetime.now().isoformat(timespec="seconds"), "level": level, "title": title, "lines": lines}
    paths.LOGS.mkdir(parents=True, exist_ok=True)
    with (paths.LOGS / "notifications.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    url = os.environ.get("NOTIFY_WEBHOOK_URL", "").strip()
    if not url:
        return
    try:
        import requests
        requests.post(url, json={"title": title, "level": level, "lines": lines,
                                 "text": f"[{level}] {title}\n" + "\n".join(lines)}, timeout=10)
    except Exception as e:      # 알림 실패가 예측·학습을 멈추지 않게 한다
        print(f"[알림 실패] {type(e).__name__}: {e}", file=sys.stderr)


if __name__ == "__main__":
    send(sys.argv[1] if len(sys.argv) > 1 else "알림", sys.argv[2:] or [""], level="error")
