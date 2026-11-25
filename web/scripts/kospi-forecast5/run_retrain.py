"""[실사용 스크립트] 주별 월간 재학습 — 시점(W0·W2) 학습본을 다음 달용으로 다시 학습해 같은 자리에 바꿔 넣는다(일별 run_retrain.py 와 같은 자리).

실행(service_5): python -B run_retrain.py --tp W0 --base 2026-11-30 [--write]   (자료는 실행마다 DB 에서)
  --base = 예측 기준일. 그날의 +5거래일 대상월 모델을 준비한다. 1·4·7·10월용 재학습은 분기 파라미터 재탐색을 먼저 한다(train/wk_train.quarterly_retune).
  --write 없으면 계획만 출력(학습 안 함). 예약 실행은 run_automation.py w0·w2가 새 대상월 첫 예측 전에 부른다. 배포 실패면 이전 학습본으로 되돌린다.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "mlops"))
import wk_paths as P  # noqa: E402

P.add_paths()

if __name__ == "__main__":
    import retrain
    from wk_lock import service_lock
    import run_automation
    def train():
        with service_lock("--write" in sys.argv[1:]):
            return retrain.main()

    run_automation.quiet_write(train, job="kospi5_retrain")
