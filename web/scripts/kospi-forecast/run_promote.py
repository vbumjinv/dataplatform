"""[실사용 스크립트] 챌린저 승격(사람이 직접 실행) — DB 역할(kospi_mlops_role)의 champion/challenger 계열을 맞바꾸고 운영 슬롯을 바꾼다.

저장소: --mode db(dp.kospi_mlops_* 테이블) | csv(outputs/tables/kospi_mlops_*.csv), 빼면 .env KOSPI_MLOPS_MODE(기본 csv) — mlops/store.py.
        아래 kospi_mlops_* 는 두 모드에서 같은 이름·열이다. 정형 원천·dp.news_feature_orig 는 모드와 관계없이 운영 DB에서 읽기만 한다.
실행(service 폴더): python run_promote.py --objective cls                     # 최근 판정과 바뀔 내용만 보여 줌
                   python run_promote.py --objective cls --write          # 승격 실행
                   python run_promote.py --objective cls --rollback --write   # 직전 승격 되돌리기
입력: kospi_mlops_compare(최근 판정), kospi_mlops_role, kospi_mlops_role_history, kospi_mlops_model
출력(저장소): kospi_mlops_role·role_history(날짜·사유·판정), model/artifacts/T2/<obj>_model_1.* (이번 달 학습본이 있으면)

판정이 '승격 후보'가 아니면 --force 없이는 바꾸지 않는다. 이전 챔피언 학습본은 DB 등록부에 남아 --rollback 으로 돌아갈 수 있다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

SERVICE = Path(__file__).resolve().parent
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import registry as R  # noqa: E402
from store import add_args, open_store  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="챌린저 승격 / 되돌리기")
    ap.add_argument("--objective", choices=("cls", "reg"), required=True)
    add_args(ap)
    ap.add_argument("--rollback", action="store_true")
    ap.add_argument("--force", action="store_true", help="판정이 승격 후보가 아니어도 바꾼다")
    ap.add_argument("--reason", default="")
    a = ap.parse_args()
    obj = a.objective
    st = open_store(a.write, a.mode)
    st.require_tables()
    cur = st.roles()[obj]
    decision = st.compare_latest(obj)
    print(f"현재 {obj}: champion={cur['champion']}, challenger={cur.get('challenger')}")
    print(f"최근 판정({pd.Timestamp(decision['asof']).date() if decision else '-'}): {decision['decision'] if decision else '없음'}")
    if a.rollback:
        hist = st.role_history(obj)
        last = hist[hist.action == "promote"].tail(1)
        if last.empty:
            raise SystemExit("되돌릴 승격 기록이 없습니다.")
        new = {"champion": last.from_champion.iloc[0], "challenger": last.from_challenger.iloc[0]}
    else:
        if not a.force and (decision is None or decision["decision"] != "승격 후보"):
            raise SystemExit("판정이 '승격 후보'가 아니라 바꾸지 않습니다(--force 로 강제).")
        new = {"champion": cur["challenger"], "challenger": cur["champion"]}
    month = pd.Timestamp.now(tz="Asia/Seoul").strftime("%Y-%m")
    champ = R.find(st, obj, new["champion"], month, exact=True)
    print(f"변경 후: champion={new['champion']}, challenger={new['challenger']}")
    print(f"이번 달({month}) 새 챔피언 학습본: {champ['model_version'] if champ else '없음(다음 재학습 때 배포)'}")
    if not a.write:
        print("확인만 했습니다. 바꾸려면 --write 를 붙이세요.")
        return
    import post_deploy as PD
    from deployment_guard import recover_files
    close = PD.check_ready('T2', month, st) if champ is not None else None
    with recover_files('T2', enabled=champ is not None):
        if champ is not None:
            R.deploy(st, champ)
            PD.after_deploy('T2', st, close, month)
            print(f"배포: {champ['model_version']}")
        # 배경·범위·DB 자산 등록이 성공한 뒤에만 운영 역할을 바꾼다.
        next_roles = {**st.roles(), obj: new}
        st.set_roles(obj, new['champion'], new['challenger'], action='rollback' if a.rollback else 'promote',
                     reason=a.reason, decision=dict(decision or {}))
    print("완료. run_predict.py 는 다음 실행부터 새 챔피언을 쓴다.")


if __name__ == "__main__":
    main()
