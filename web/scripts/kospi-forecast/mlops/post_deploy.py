"""[실사용 모듈] 학습본 배포 뒤 짝 맞추기 — 시점 하나(T0·T1·T2)의 학습본을 바꾼 뒤 그 시점의 예측 범위·SHAP 배경을 새 학습본에 맞추고 통합본을 다시 만든다.

사용처: train/retrain_f0.py(T0)·retrain_t1.py(T1)·retrain_t2.py(T2) 배포 직후, run_promote.py(T2 승격·되돌리기) 배포 직후.
        매달 파라미터 고정 재학습이든 1·4·7·10월 grid search 든 학습본이 바뀌면 같은 순서로 부른다.
실행(직접, service 폴더): python mlops/post_deploy.py --tp T1            # 확인만(범위 이력에 붙일 예측이 다 있는지)
                          python mlops/post_deploy.py --tp T1 --write    # 범위·SHAP 배경·통합본을 지금 배포 학습본에 맞춤
순서: ① 범위(predict/predict_range.refresh): 범위 이력 끝 ~ 대상월 첫날의 실제 서비스 예측·정답을 이력에 붙이고, 대상월 오차 모델을 맞춰 보고,
        range_config.json 에 배포 학습본 버전을 적는다(예측 때 버전이 다르면 범위 계산을 멈춤).
     ② SHAP 배경(explain/build_shap_background.py --tp <시점>): 새 학습본의 학습 구간에서 200행.
     ③ 통합본(model/build_bundle.py): 그 대상월 학습본이 있는 시점만 묶는다(다른 시점 원본은 읽기만).
     ④ 다른 두 시점의 학습본·범위·SHAP 배경 파일이 바뀌지 않았는지 해시로 확인(시점끼리 섞이지 않게).
     ⑤ 저장소 kospi_mlops_slot 에 이 시점 배포 슬롯을 백업(T0·T1 = 학습본·manifest·범위 파일, T2 = manifest·범위 파일 — T2 학습본은 kospi_mlops_model 에 있음),
        시점마다 최근 3번 배포만 파일을 남긴다. 되살리기: python mlops/post_deploy.py --tp T1 --restore <수익률 학습본 버전> --write
check_ready 는 학습 전에 불러, 범위 이력에 붙일 서비스 예측이 저장소에 다 있는지 먼저 확인한다(배포 뒤 실패를 막음).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
for _p in (SERVICE / "predict", SERVICE / "mlops", SERVICE / "explain", SERVICE):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import artifacts as A  # noqa: E402
import predict_range as PR  # noqa: E402
from features import timepoints as TPR  # noqa: E402

BG_DIR = SERVICE / "outputs" / "explain" / "shap_background"


def _hashes(tp) -> dict:
    """시점 tp 의 학습본·범위·SHAP 배경 파일 해시(다른 시점이 바뀌지 않았는지 확인용)."""
    out = {}
    for d in (A.ARTIFACTS / tp, BG_DIR / tp):
        if d.exists():
            for f in sorted(d.iterdir()):
                if f.is_file():
                    out[f"{d.name}/{f.name}"] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def check_ready(tp, month, st, close=None):
    """학습 전 확인: 범위 이력에 붙일 날(이력 끝 ~ 대상월 첫날)의 이 시점 서비스 예측이 저장소에 다 있는지."""
    close = PR.kospi_close() if close is None else close
    miss = PR.missing_days(tp, month, st, close)
    if len(miss):
        raise SystemExit(f"{tp}: 예측 범위 이력에 붙일 서비스 예측이 없는 거래일 {len(miss)}일({', '.join(d.strftime('%Y-%m-%d') for d in miss[:6])} ...). "
                         f"재학습 전에 지금 학습본으로 그 날짜를 예측해 저장하세요: python predict/engine.py --tp {tp} --from {miss[0].date()} --target {miss[-1].date()} --write")
    return close


def rebuild_shap(tp):
    rc = subprocess.run([sys.executable, str(SERVICE / "explain" / "build_shap_background.py"), "--tp", tp, "--write", "--no-publish"], cwd=SERVICE).returncode
    if rc:
        raise RuntimeError(f"{tp} SHAP 배경 다시 만들기 실패(종료 코드 {rc}).")


def rebuild_bundle(month):
    rc = subprocess.run([sys.executable, str(SERVICE / "model" / "build_bundle.py"), "--target-month", month, "--confirmed"], cwd=SERVICE).returncode
    if rc:
        raise RuntimeError(f"{month} 통합본 다시 만들기 실패(종료 코드 {rc}).")


def slot_files(tp) -> dict:
    """시점 tp 배포 슬롯에서 백업할 파일 {이름: 경로}. T2 학습본(joblib)은 등록부(kospi_mlops_model)에 있어 뺀다."""
    d = A.ARTIFACTS / tp
    from model import assets
    return {**assets.files(tp), **{f'{o}_model_1.joblib': d / f'{o}_model_1.joblib' for o in ('cls', 'reg')}}


def backup_slot(tp, st, keep=3) -> dict:
    """배포 슬롯을 저장소 kospi_mlops_slot 에 백업하고 시점별 최근 keep 번만 파일을 남긴다(st 가 쓰기 모드일 때만)."""
    if st is None or not getattr(st, "write", False):
        return {"backup": "건너뜀(저장소 쓰기 모드 아님)"}
    man = json.loads(A.manifest_path(tp, "reg").read_text(encoding="utf-8"))
    n = st.slot_put(tp, man["model_version"], man["target_month"], slot_files(tp))
    return {"backup": f"{n}개 파일", "model_version": man["model_version"], "pruned": st.slot_prune(tp, keep)}


def restore(tp, model_version, st) -> None:
    """kospi_mlops_slot 백업으로 시점 tp 슬롯을 되살린 뒤 SHAP 배경·통합본을 맞춘다(범위 파일도 함께 되살아남)."""
    files = st.slot_files(tp, model_version)
    if not files or any(c is None for _, c in files.values()):
        raise SystemExit(f"{tp} {model_version} 백업 파일이 없습니다(시점마다 최근 3번만 보관).")
    for name, (sha, content) in files.items():
        if hashlib.sha256(content).hexdigest() != sha:
            raise SystemExit(f"{tp} {model_version} {name}: 백업 해시 불일치")
    from model import assets
    destinations = slot_files(tp)
    if not set(files).issubset(destinations):
        raise ValueError('슬롯 백업에 허용되지 않은 파일 이름이 있습니다.')
    from deployment_guard import recover_files
    with recover_files(tp):
        for name, (_, content) in files.items():
            destinations[name].write_bytes(content)
        # 옛 T2 백업은 joblib이 등록부에만 있으므로 등록부에서 함께 복구한다.
        if tp == 'T2' and any(f'{o}_model_1.joblib' not in files for o in ('cls', 'reg')):
            import registry as R
            for obj in ('cls', 'reg'):
                man = assets.js(tp, f'{obj}_model_1_manifest.json', local=True)
                folder = R.materialize(st, man)
                import shutil
                shutil.copy2(folder / man['artifact'], A.ARTIFACTS / tp / f'{obj}_model_1.joblib')
        for o in ('cls', 'reg'):
            A.load_checked(tp, o)
        PR.load_artifact(tp, local_assets=True)
        rebuild_shap(tp)
        rebuild_bundle(json.loads(A.manifest_path(tp, 'reg').read_text(encoding='utf-8'))['target_month'])
        assets.publish(tp)
    print(f"[되살림] {tp} {model_version}: 슬롯·범위 파일, SHAP 배경·통합본 다시 맞춤")


def after_deploy(tp, st, close=None, month=None) -> dict:
    """시점 tp 의 배포 학습본에 범위·SHAP 배경·통합본을 맞춘다. 다른 시점 파일은 바꾸지 않는다."""
    tp = TPR.norm(tp)
    month = month or json.loads(A.manifest_path(tp, "reg").read_text(encoding="utf-8"))["target_month"]
    others = {o: _hashes(o) for o in TPR.TPS if o != tp}
    rng = PR.refresh(tp, month, st, close)
    print(f"[범위] {tp} {month}: 이력 +{rng['added_days']}일(~{rng['history_end']}), 오차 모델 학습 {rng['error_model_train_rows']}행, 학습본 {rng['model_version']}", flush=True)
    rebuild_shap(tp)
    print(f"[SHAP 배경] {tp}: 새 학습본으로 다시 만듦", flush=True)
    rebuild_bundle(month)
    print(f"[통합본] {month}: 다시 만듦", flush=True)
    changed = [o for o, h in others.items() if _hashes(o) != h]
    if changed:
        raise RuntimeError(f"{tp} 배포 후처리 중 다른 시점 파일이 바뀌었습니다: {changed}")
    PR.load_artifact(tp, local_assets=True)
    bk = backup_slot(tp, st)
    from model import assets
    published = assets.publish(tp)
    PR.load_artifact(tp)                                          # 등록 DB 버전까지 검증
    print(f"[슬롯 백업] {tp}: {bk}", flush=True)
    return {"time_point": tp, "month": month, "range": rng, "slot_backup": bk, "published_assets": published}


def main():
    ap = argparse.ArgumentParser(description="배포 학습본에 범위·SHAP 배경·통합본 맞추기(시점 하나)")
    ap.add_argument("--tp", required=True, type=TPR.norm, choices=list(TPR.TPS))
    ap.add_argument("--mode", choices=("csv", "db"))
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--restore", metavar="MODEL_VERSION", help="kospi_mlops_slot 백업(수익률 학습본 버전)으로 이 시점 슬롯을 되살림")
    a = ap.parse_args()
    from store import open_store
    st = open_store(a.write, a.mode)
    if a.restore:
        if not a.write:
            print(st.slot_list(a.tp).to_string() if len(st.slot_list(a.tp)) else "백업 없음")
            return
        restore(a.tp, a.restore, st)
        return
    month = json.loads(A.manifest_path(a.tp, "reg").read_text(encoding="utf-8"))["target_month"]
    close = check_ready(a.tp, month, st)
    if not a.write:
        print(f"{a.tp} {month}: 범위 이력에 붙일 예측이 모두 있습니다. --write 로 범위·SHAP 배경·통합본을 맞춥니다.")
        return
    print(json.dumps(after_deploy(a.tp, st, close, month), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
