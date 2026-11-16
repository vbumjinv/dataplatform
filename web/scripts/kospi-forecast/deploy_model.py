"""[실사용 스크립트] 학습본 직접 교체 — 새로 만든 joblib(새 모델 구조 포함)을 시점(T0·T1·T2) 운영 슬롯에 넣고, 그 버전으로 예측·저장되게 한다.

실행(service 폴더에서):
  python deploy_model.py --tp T0 --cls 새분류.joblib --reg 새회귀.joblib            # 확인만(형식 점검 + 복사본에서 시험 예측, 운영 파일 안 바꿈)
  python deploy_model.py --tp T0 --cls 새분류.joblib --reg 새회귀.joblib --write    # 실제 교체
  --cls 또는 --reg 하나만 줘도 된다(나머지는 지금 학습본 유지). --month YYYY-MM(기본 지금 학습본 대상월), --test-date, --note "설명"
순서:
  ① 형식 점검: joblib 을 열어 목적(cls/reg)·지금 학습본과 같은 키(구조)인지 본다. 다르면 경고(예측 코드도 바꿨다면 정상) — 실제 판정은 ②.
  ② 시험: service 폴더를 임시 복사(큰 산출물 제외)해 새 joblib·manifest 를 넣고, 그 시점 예측 스크립트(predict/predict_<tp>.py, 저장 없음)와
     SHAP 배경 만들기를 실제로 돌린다. 운영 파일·DB 는 바꾸지 않는다. 실패하면 여기서 멈춘다.
  ③ (--write) 지금 슬롯 백업(<CACHE>/slot_history/<시점>/<이전 버전>, 최근 3개) → joblib·manifest 교체 → 해시 검사.
  ④ (--write) mlops/post_deploy.after_deploy: 예측 범위 설정·SHAP 배경·통합본을 새 학습본에 맞추고 슬롯 백업(kospi_mlops_slot).
     ③④ 중 하나라도 실패하면 deployment_guard 가 슬롯·범위·배경·통합본을 실행 전 파일로 되돌린다.
manifest: 지금 manifest 를 바탕으로 artifact_sha256·model_version(model_1_<시점>_<목적>_<YYYY_MM>_manual_<해시12>)·pipeline_sha256(지금 코드)·
  대상월을 새로 쓰고, joblib 안에 같은 이름의 정보(features·train_end 등)가 있으면 옮긴다. manual_deploy 에 교체 기록(파일·시각·이전 버전·메모).
교체 뒤: 예측은 새 model_version 으로 DB(dp.kospi_pred_*)에 쌓인다(이전 버전 행은 그대로). 월간 재학습(run_retrain.py)은 manual_deploy 학습본을
  덮어쓰지 않고 건너뛴다(덮어쓰려면 run_retrain.py --retrain-manual). 되돌리기: python mlops/post_deploy.py --tp <시점> --restore <이전 수익률 버전> --write
  (kospi_mlops_slot 백업) 또는 slot_history 폴더 파일을 슬롯에 복사.
주의: 예측 계산 방식이 지금 코드와 다르면 predict/ 코드도 함께 고쳐야 한다. 공통 코드(predict_f0.py·artifacts.py·features/·db/)를 고치면 다른 시점의
  pipeline_sha256 도 맞지 않게 되므로, 이 스크립트는 다른 시점 해시가 깨져 있으면 교체하지 않는다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd

SERVICE = Path(__file__).resolve().parent
sys.path[:0] = [str(SERVICE / "predict"), str(SERVICE / "mlops"), str(SERVICE / "explain"), str(SERVICE)]

import artifacts as A  # noqa: E402
import paths  # noqa: E402
from features import timepoints as TPR  # noqa: E402

KEEP_BACKUPS = 3
SKIP_COPY = {"outputs/tables", "outputs/mlops", "model/artifacts/bundle", "db/raw", ".runtime_cache"}   # 시험 복사에서 뺄 큰 폴더
META_SKIP = {"members", "news", "condition", "structured", "meta", "model", "models", "history"}         # manifest 로 옮기지 않는 joblib 키(모델 객체·큰 표)


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pipeline_hash(tp: str, root: Path = SERVICE) -> str:
    """시점 tp 의 예측 코드 해시(root 폴더 기준). T0·T1 = predict/artifacts.py, T2 = predict/service_runtime.py 와 같은 계산."""
    code = (f"import sys; sys.path[:0]=['predict','.']; import artifacts as A, service_runtime as R; "
            f"print(R.pipeline_hash() if '{tp}'=='T2' else A.pipeline_hash('{tp}'))")
    r = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, env=_env())
    if r.returncode:
        raise RuntimeError(f"{tp} 코드 해시 계산 실패: {r.stderr[-500:]}")
    return r.stdout.strip().splitlines()[-1]


def _env() -> dict:
    return dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1",
                KOSPI_CSV_DIR=os.environ.get("KOSPI_CSV_DIR", "").strip() or str(SERVICE / "outputs" / "tables"))


def _json_ok(v) -> bool:
    try:
        json.dumps(v)
        return True
    except (TypeError, ValueError):
        return False


def check_others(tp: str) -> None:
    """다른 시점의 학습본이 지금 코드로 읽히는지(공통 코드를 바꿔 다른 시점 해시가 깨졌는지) 확인한다."""
    bad = []
    for o in TPR.TPS:
        if o == tp:
            continue
        man = json.loads(A.manifest_path(o, "cls").read_text(encoding="utf-8"))
        if pipeline_hash(o) != man["pipeline_sha256"]:
            bad.append(o)
    if bad:
        raise SystemExit(f"다른 시점 {bad} 의 예측 코드 해시가 manifest 와 다릅니다(공통 코드가 바뀜). 그 시점 예측이 같은지 확인하고 "
                         f"manifest 를 맞춘 뒤 교체하세요. 교체하지 않았습니다.")


def inspect(tp: str, obj: str, path: Path) -> object:
    """새 joblib 을 열어 목적·구조를 지금 학습본과 비교한다(다르면 경고만, 판정은 시험 예측)."""
    new = joblib.load(path)
    cur = joblib.load(A.ARTIFACTS / tp / f"{obj}_model_1.joblib")
    if isinstance(new, dict) and new.get("objective") not in (None, obj):
        raise SystemExit(f"{path.name}: objective 가 '{new.get('objective')}' 입니다({obj} 자리에 넣을 수 없음).")
    if isinstance(new, dict) and isinstance(cur, dict):
        miss, extra = sorted(set(cur) - set(new)), sorted(set(new) - set(cur))
        print(f"  {obj}: 키 {len(new)}개" + (f" | 지금 학습본에 있고 새것에 없는 키 {miss}" if miss else "")
              + (f" | 새 키 {extra}" if extra else "") + ("" if miss or extra else " (지금 학습본과 같은 구조)"))
    else:
        print(f"  {obj}: {type(new).__name__} (지금 학습본 {type(cur).__name__}) — 구조가 다르면 predict/ 코드도 맞춰야 합니다.")
    return new


def new_manifest(tp: str, obj: str, art: Path, bundle, month: str, pipe: str, source: Path, note: str | None) -> dict:
    old = json.loads(A.manifest_path(tp, obj).read_text(encoding="utf-8"))
    digest = sha(art)
    man = dict(old)
    if isinstance(bundle, dict):                                   # joblib 안의 같은 이름 정보(features·train_end·threshold 등)를 옮긴다
        for k, v in bundle.items():
            if k in old and k not in META_SKIP and _json_ok(v):
                man[k] = v
        if isinstance(bundle.get("members"), dict) and "members" in old:
            man["members"] = {n: ({k: v.get(k) for k in ("params", "inner_score", "tuned") if _json_ok(v.get(k))} if isinstance(v, dict) else {})
                              for n, v in bundle["members"].items()}
    now = datetime.now(timezone.utc).isoformat()
    man.update(artifact=f"{obj}_model_1.joblib", artifact_sha256=digest, target_month=month, pipeline_sha256=pipe,
               model_version=f"model_1_{tp.lower()}_{obj}_{month.replace('-', '_')}_manual_{digest[:12]}",
               manual_deploy={"by": "service/deploy_model.py", "at": now, "source": str(source), "note": note,
                              "previous": old["model_version"]})
    man["created_utc" if tp == "T2" else "created"] = now
    return man


def default_test_date(tp: str, month: str) -> pd.Timestamp:
    """대상월 안에서 오늘보다 앞선 가장 최근 거래일(오늘 대상일은 당일 자료 준비 검사가 엄격해 시험에 쓰지 않음)."""
    import exchange_calendars as xcals
    cal = xcals.get_calendar("XKRX")
    now = pd.Timestamp.now(tz=TPR.tz())
    today = now.tz_localize(None).normalize()
    p = pd.Period(month, "M")
    days = [pd.Timestamp(d) for d in cal.sessions_in_range(p.start_time, min(p.end_time.normalize(), today))]
    days = [d for d in days if d < today and TPR.cutoff(tp, d) <= now]
    if not days:
        raise SystemExit(f"{month} 안에 시험할 거래일이 아직 없습니다. --test-date 로 지정하세요.")
    return days[-1]


def write_slot(root: Path, tp: str, files: dict, manifests: dict) -> None:
    for obj, src in files.items():
        shutil.copy2(src, root / "model" / "artifacts" / tp / f"{obj}_model_1.joblib")
        (root / "model" / "artifacts" / tp / f"{obj}_model_1_manifest.json").write_text(
            json.dumps(manifests[obj], ensure_ascii=False, indent=1, default=str), encoding="utf-8")


def run(root: Path, args: list, what: str) -> str:
    env = _env()
    if root.resolve() != SERVICE.resolve():
        env['KOSPI_ASSET_MODE'] = 'local'  # 배포 전 복사본 시험에만 명시적 로컬 자산 사용
    r = subprocess.run([sys.executable, "-B", *map(str, args)], cwd=root, capture_output=True, text=True, env=env)
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode:
        raise SystemExit(f"[시험 실패] {what}\n{out[-3000:]}")
    return out


def trial(tp: str, files: dict, manifests_for, test_date: pd.Timestamp) -> dict:
    """service 복사본에 새 학습본을 넣고 예측·SHAP 배경 만들기를 실제로 돌린다(운영 파일·DB 는 안 바꿈)."""
    with tempfile.TemporaryDirectory(prefix="kospi_deploy_trial_") as tmp:
        root = Path(tmp) / "service"
        shutil.copytree(SERVICE, root, ignore=lambda d, names: [n for n in names if n == "__pycache__"
                        or (Path(d) / n).relative_to(SERVICE).as_posix() in SKIP_COPY])
        pipe = pipeline_hash(tp, root)
        manifests = manifests_for(pipe)
        write_slot(root, tp, files, manifests)
        out = run(root, ["predict/engine.py", "--tp", tp, "--target", test_date.date()], f"{tp} 예측 {test_date.date()}")
        print("\n".join("   " + s for s in out.strip().splitlines()[-4:]))
        run(root, ["explain/build_shap_background.py", "--tp", tp, "--write", "--no-publish"], f"{tp} SHAP 배경")
        print(f"   SHAP 배경: 새 학습본으로 만들기 성공(복사본)")
        return manifests


def backup(tp: str) -> Path:
    cur = json.loads(A.manifest_path(tp, "reg").read_text(encoding="utf-8"))["model_version"]
    d = paths.CACHE / "slot_history" / tp / cur
    d.mkdir(parents=True, exist_ok=True)
    for o in ("cls", "reg"):
        for s in (".joblib", "_manifest.json"):
            shutil.copy2(A.ARTIFACTS / tp / f"{o}_model_1{s}", d / f"{o}_model_1{s}")
    for old in sorted(d.parent.iterdir(), key=lambda p: p.stat().st_mtime)[:-KEEP_BACKUPS]:
        shutil.rmtree(old)
    return d


def main():
    ap = argparse.ArgumentParser(description="새 joblib 을 시점 운영 슬롯에 교체(시험 → 백업 → 교체 → 범위·SHAP 배경·통합본 맞춤)")
    ap.add_argument("--tp", required=True, type=TPR.norm, choices=list(TPR.TPS))
    ap.add_argument("--cls", type=Path, help="새 방향(분류) joblib")
    ap.add_argument("--reg", type=Path, help="새 수익률(회귀) joblib")
    ap.add_argument("--month", help="학습본 대상월 YYYY-MM(기본: 지금 학습본 대상월)")
    ap.add_argument("--test-date", help="시험 예측 대상일(기본: 대상월 안 가장 최근 거래일)")
    ap.add_argument("--note", help="교체 메모(manifest manual_deploy.note)")
    ap.add_argument("--write", action="store_true", help="실제로 교체(없으면 형식 점검·시험만)")
    a = ap.parse_args()
    files = {o: p.resolve() for o, p in (("cls", a.cls), ("reg", a.reg)) if p}
    if not files:
        ap.error("--cls 또는 --reg 중 하나 이상을 주세요.")
    for o, p in files.items():
        if not p.exists():
            ap.error(f"--{o} 파일이 없습니다: {p}")
    tp = a.tp
    cur_month = json.loads(A.manifest_path(tp, "cls").read_text(encoding="utf-8"))["target_month"]
    month = a.month or cur_month
    now_month = pd.Timestamp.now(tz=TPR.tz()).strftime("%Y-%m")
    if month > now_month:
        raise SystemExit(f"대상월 {month} 은 아직 오지 않았습니다(다음 달 학습본은 월간 재학습으로). 직접 교체는 {now_month} 이전 대상월만.")
    test_date = pd.Timestamp(a.test_date) if a.test_date else default_test_date(tp, month)
    print(f"[교체] {tp} 대상월 {month} | {', '.join(f'{o}={p.name}' for o, p in files.items())} | 시험일 {test_date.date()}")

    print("① 형식 점검")
    bundles = {o: inspect(tp, o, p) for o, p in files.items()}
    check_others(tp)

    print("② 시험(복사본에서 예측·SHAP 배경)")
    make = lambda pipe: {o: new_manifest(tp, o, files[o], bundles[o], month, pipe, files[o], a.note) for o in files}
    manifests = trial(tp, files, make, test_date)
    for o, m in manifests.items():
        print(f"   {o}: 새 버전 {m['model_version']}")
    if not a.write:
        print("확인만 했습니다(운영 파일·DB 안 바꿈). --write 로 교체합니다.")
        return

    print("③ 교체")
    import post_deploy as PD
    from deployment_guard import recover_files
    from store import open_store
    st = open_store(True)
    close = PD.check_ready(tp, month, st)
    with recover_files(tp):
        bk = backup(tp)
        manifests = make(pipeline_hash(tp))
        write_slot(SERVICE, tp, files, manifests)
        if tp == "T2":
            from service_runtime import load_manifest
            for o in ("cls", "reg"):
                load_manifest(o, local_assets=True)
        else:
            for o in ("cls", "reg"):
                A.load_checked(tp, o, month)
        print(f"   슬롯 교체, 이전 학습본 백업 {bk}")
        print("④ 범위·SHAP 배경·통합본 맞추기")
        PD.after_deploy(tp, st, close, month)
        run(SERVICE, ["predict/engine.py", "--tp", tp, "--target", test_date.date()], f"{tp} 교체 뒤 예측")
    print(f"[완료] {tp}: {', '.join(m['model_version'] for m in manifests.values())} — 다음 예측부터 이 버전으로 DB 에 저장됩니다.")


if __name__ == "__main__":
    main()
