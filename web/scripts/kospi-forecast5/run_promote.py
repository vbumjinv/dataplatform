"""[실사용 스크립트] 주별 학습본 상태·챌린저 등록·승격·되돌리기(일별 run_promote.py 와 같은 자리, 사람이 직접 실행). 학습본·역할은 DB kospi5_mlops_model(manifest·해시 없음).

챌린저는 자리만 있고 지금 등록된 것은 없다(2026-11-25). 등록하면 매 거래일 함께 예측·비교되고 월간 재학습 때 같이 다시 학습된다.
실행(service_5): python -B run_promote.py status
                     python -B run_promote.py upload <joblib> W0_cls challenger  # 챌린저 등록(학습 밖 예측 range_oos 포함 학습본)
                     python -B run_promote.py promote W0_cls [--force]          # 챌린저 → 운영(최근 비교 판정이 '승격 후보'일 때만), 이전 운영은 retired
                     python -B run_promote.py rollback W0_cls W0_cls_v3_202612   # retired 학습본을 운영 학습본으로
                     python -B run_promote.py upload <joblib> W0_cls champion    # 직접 만든 학습본을 운영 학습본으로(범위 OOS 정합 확인 뒤)
  이력은 kospi5_mlops_role_history.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "mlops"))
import wk_paths as P  # noqa: E402

P.add_paths()

if __name__ == "__main__":
    import wk_models
    from wk_lock import service_lock
    with service_lock():
        wk_models.main()
