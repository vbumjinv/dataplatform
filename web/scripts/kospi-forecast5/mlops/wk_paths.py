"""[실사용 모듈] 주별(+5영업일) 서비스 경로·설정 — 코드·설정 경로와 시점·슬롯 이름을 한곳에서 정한다.

폴더(2026-11-23, service_daily 와 같은 구조): db/(DB 연결) · features/(변수·자료: build_features·extract_db·wk_data·timepoints·kw·kp) · news/(뉴스 변수) ·
  model/(학습본 관리 wk_models·wk_composite, configs/ 설정) · train/(월간 재학습) · predict/(예측·범위) ·
  explain/(SHAP·근거 기사·LLM 해설, prompts/) · mlops/(저장소·모니터링·비교·알림·잠금·경로) · scheduler/ · outputs/logs/(실행 로그·잠금 파일)
  루트 = 실행 스크립트(run_*.py)·time_points.json. 각 실행 스크립트는 add_paths 와 같은 목록을 sys.path 에 넣고, 모듈은 이름만으로 불러온다.
- 자료는 로컬 캐시 없이 실행마다 DB 에서 읽고(원천·뉴스, 메모리에만 둠), 결과·학습본·이력은 DB 저장소(wk_store, 정의서 4장)에만 쓴다(2026-11-24, 다른 서버 운영).
- 독립 실행(2026-11-19): 접속 정보 service_5/.env, DB 모듈 db/, 계산 모듈 features/kp·kw 가 모두 이 폴더 안에 있다.
  service_daily·experiments 를 지우거나 고쳐도 운영 경로는 이 폴더와 PostgreSQL만 사용한다.
- kp·kw·db 는 실험·일별 원본의 복사본이다. 원본 계산식을 고치면 여기는 자동으로 바뀌지 않으므로, 반영할 때 다시 복사하고 --verify 로 확인한다.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]                  # service_5
ROOT = HERE.parent
DIRS = ("mlops", "features", "news", "model", "train", "predict", "explain")   # 모듈 폴더(실행 스크립트가 sys.path 에 넣는 목록)


def add_paths():
    """이 폴더의 모듈 폴더들과 루트를 sys.path 앞에 넣는다(이미 있으면 그대로). 실험 스크립트도 service_5/mlops 를 넣은 뒤 이 함수를 부른다."""
    for d in (*[str(HERE / x) for x in DIRS], str(HERE))[::-1]:
        if d not in sys.path:
            sys.path.insert(0, d)


SOURCES_CONFIG = HERE / "features" / "feature_sources.json"
CONFIG = HERE / "model" / "configs"                           # 모델·범위·SHAP JSON 설정
PROMPTS = HERE / "explain" / "prompts"
LOGS = HERE / "outputs" / "logs"                             # 예약 실행 로그(scheduler/*.sh)·잠금 파일 — 자료는 두지 않는다
TPS = ("W0", "W2")
OBJS = ("cls", "reg")
SLOTS = tuple(f"{tp}_{o}" for tp in TPS for o in OBJS)
MIN_COMPARE_DAYS = 60      # 챔피언/챌린저 판정에 필요한 공통 정답 일수(일별 champion_challenger.MIN_DAYS 와 같음, 2026-11-25). 승격은 사람이 run_promote.py


def setup(tp="W2"):
    """시점을 정하고 이 폴더의 계산 모듈(kw·kp·db)을 불러온다. 반환: (kw.sources, db 모듈)."""
    if tp not in ("W0", "W2"):
        raise ValueError(tp)
    os.environ["KOSPI5_TP"] = tp                             # kw.config 가 import 때 읽음
    add_paths()
    from db import settings as S
    import db
    from kw import sources as SRC
    from kw import config as WC
    WC.TP, WC.CP = tp, WC.TPS[tp]
    for m in (S, SRC, db):                                    # 다른 폴더의 같은 이름 모듈을 잡지 않았는지
        assert Path(m.__file__).resolve().is_relative_to(HERE), m.__file__
    return SRC, db
