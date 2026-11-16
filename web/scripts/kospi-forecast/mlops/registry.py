"""[실사용 모듈] 학습본 등록부 — 저장소(kospi_mlops_model)에 학습본 파일·manifest 를 두고, 쓸 때 해시를 확인해 불러온다. 운영 슬롯 배포도 여기서 한다.

사용처: train/retrain_t2.py·retrain_f0.py(run_retrain.py), run_record_predictions.py, run_promote.py, run_mlops_setup.py
저장소(mlops/store.py): db 모드 = 테이블의 bytea 를 캐시 mlops/paths.MODELS/<model_version>/ 로 내려받아 씀,
                      csv 모드 = outputs/tables/models/<model_version>/ 파일을 그대로 씀(따로 캐시하지 않음, 최근 2개 대상월만 남김)
운영 슬롯: model/artifacts/T2/<obj>_model_1.joblib·_manifest.json, outputs/explain/shap_background/<obj>_background.parquet
배포 후 predict/service_runtime.load_manifest 로 해시·전처리 버전을 다시 검사하고, 실패하면 이전 파일로 되돌린다.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import joblib

SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]
import paths  # noqa: E402

SLOT = SERVICE / "model" / "artifacts" / "T2"
BACKGROUND = SERVICE / "outputs" / "explain" / "shap_background"


def _sha(path):
    from service_runtime import sha
    return sha(path)


def folder_for(st, model_version: str) -> Path:
    return st.model_dir(model_version) if st.mode == "csv" else paths.MODELS / model_version


def versions(st, objective: str) -> list[dict]:
    """등록부의 manifest 목록(파일은 아직 내려받지 않음)."""
    df = st.model_list(objective)
    out = []
    for r in df.itertuples():
        man = dict(r.manifest)
        man.update(_folder=folder_for(st, r.model_version), _deployed_at=r.deployed_at, _mlflow_version=r.mlflow_version)
        out.append(man)
    return out


def find(st, objective: str, line: str, month: str, *, exact: bool = False) -> dict | None:
    """그 계열의 대상월 학습본(여러 개면 가장 늦게 만든 것). 대상월 학습본이 아직 없으면(재학습 전) 직전 대상월 학습본을 쓴다
    (사용자 결정 2026-11-03, predict/artifacts.check_month 와 같은 규칙). 더 늦은 대상월 학습본은 쓰지 않는다(미래 정보)."""
    # exact=True: 재학습 완료·배포 확인에는 이전 달 대체를 허용하지 않는다.
    cand = [m for m in versions(st, objective) if m.get("line", "model_1") == line and (m["target_month"] == month if exact else m["target_month"] <= month)]
    return max(cand, key=lambda m: (m["target_month"], m["created_utc"])) if cand else None


def materialize(st, manifest: dict) -> Path:
    """학습본 파일을 쓸 수 있게 둔다(db: 캐시로 내려받기, 이미 있고 해시가 맞으면 그대로). 해시가 다르면 멈춘다."""
    folder = manifest["_folder"]
    art, bg = folder / manifest["artifact"], folder / manifest["background"]["artifact"]
    if st.mode == "db" and not (art.exists() and _sha(art) == manifest["artifact_sha256"] and bg.exists()):
        folder.mkdir(parents=True, exist_ok=True)
        bundle, background = st.model_files(manifest["model_version"])
        art.write_bytes(bundle)
        bg.write_bytes(background)
    if not (folder / "manifest.json").exists():
        (folder / "manifest.json").write_text(json.dumps({k: v for k, v in manifest.items() if not k.startswith("_")},
                                                         ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    if _sha(art) != manifest["artifact_sha256"] or _sha(bg) != manifest["background"]["sha256"]:
        raise ValueError(f"{manifest['model_version']}: 학습본 해시 불일치")
    return folder


def load(st, manifest: dict):
    folder = materialize(st, manifest)
    return joblib.load(folder / manifest["artifact"])   # 해시를 확인한 자기 등록부 파일만 읽는다


def register(st, folder: Path, mlflow_version: str | None = None) -> dict:
    """학습 직후 폴더(staging)를 등록부에 올린다. 반환: manifest(_folder = 이후에 쓸 폴더)."""
    man = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    added = st.model_put(man, folder, mlflow_version)
    print(f"등록부: {man['model_version']} {'추가' if added else ('이미 있음' if st.write else '(dry-run, 저장 안 함)')}", flush=True)
    if not st.write:
        return dict(man, _folder=folder)            # dry-run: 임시 폴더 그대로 쓴다
    dest = folder_for(st, man["model_version"])
    staged = paths.STAGING in folder.parents
    if st.mode == "csv":                            # 파일은 model_put 이 outputs/tables/models 로 복사했다
        (dest / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
        if staged:
            shutil.rmtree(folder)
    elif folder != dest:
        if dest.exists():
            if staged:
                shutil.rmtree(folder)
        elif staged:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(folder), str(dest))
        else:                                       # 다른 곳의 폴더는 지우지 않고 복사만 한다
            shutil.copytree(folder, dest)
    return dict(man, _folder=dest)


def prune_files(st, keep_months: int = 2) -> list[str]:
    """등록부 학습본 파일은 최근 keep_months 개 대상월만 남긴다(행·manifest 는 남김, 운영 슬롯에 배포된 것은 지우지 않음).
    매달 계열·목적마다 수십 MB 라 서버에 계속 쌓이지 않게 한다. 지운 버전 목록을 돌려준다."""
    rows = st.model_list()
    if rows.empty:
        return []
    months = sorted(rows.target_month.unique())[-keep_months:]
    live = {deployed(o).get("model_version") for o in ("cls", "reg")}
    drop = [v for v, m in zip(rows.model_version, rows.target_month) if m not in months and v not in live]
    for v in drop:
        st.model_drop_files(v)
        if st.write and st.mode == "db":
            cached = folder_for(st, v).resolve()
            if cached.parent != paths.MODELS.resolve():
                raise ValueError("학습본 캐시 정리 경로가 models 바깥입니다.")
            if cached.exists():
                shutil.rmtree(cached)
    return drop


def deployed(objective: str) -> dict:
    return json.loads((SLOT / f"{objective}_model_1_manifest.json").read_text(encoding="utf-8"))


def slot_folder(objective: str) -> Path:
    """지금 운영 슬롯의 학습본을 등록부 형식 폴더(staging)로 만든다(처음 한 번, 2026-10 챔피언)."""
    man = deployed(objective)
    dest = paths.STAGING / man["model_version"]
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SLOT / man["artifact"], dest / "bundle.joblib")
    shutil.copy2(BACKGROUND / man["background"]["artifact"], dest / "background.parquet")
    man = dict(man, artifact="bundle.joblib", line=man.get("line", "model_1"), grid=man.get("grid", "small"),
               background=dict(man["background"], artifact="background.parquet"),
               imported_from="model/artifacts/T2 (2026-11-02 등록부 도입 전 배포본)")
    (dest / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
    return dest


def deploy(st, manifest: dict) -> dict:
    """등록부 학습본을 운영 슬롯에 넣는다. 검사 실패 시 이전 파일로 되돌리고 오류를 낸다."""
    from service_runtime import load_manifest, pipeline_hash
    obj = manifest["objective"]
    if manifest.get("pipeline_sha256") != pipeline_hash():
        raise ValueError("학습본의 pipeline_sha256 이 지금 운영 전처리 코드와 다릅니다. 배포하지 않습니다.")
    folder = materialize(st, manifest)
    targets = {SLOT / f"{obj}_model_1.joblib": folder / manifest["artifact"],
               BACKGROUND / f"{obj}_background.parquet": folder / manifest["background"]["artifact"]}
    slot_manifest = SLOT / f"{obj}_model_1_manifest.json"
    if deployed(obj).get("model_version") == manifest["model_version"]:
        print(f"{obj}: 이미 배포됨 {manifest['model_version']}", flush=True)
        return deployed(obj)
    if not st.write:
        print(f"[dry-run] {obj}: {manifest['model_version']} 를 운영 슬롯에 배포할 예정(파일 바꾸지 않음)", flush=True)
        return manifest
    backup = {p: p.read_bytes() for p in list(targets) + [slot_manifest] if p.exists()}
    man = {k: v for k, v in manifest.items() if not k.startswith("_")}
    man.pop("drift_reference", None)
    man.update(artifact=f"{obj}_model_1.joblib", background=dict(man["background"], artifact=f"{obj}_background.parquet"),
               registry="db:kospi_mlops_model")
    try:
        for dst, src in targets.items():
            shutil.copy2(src, dst)
        slot_manifest.write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
        load_manifest(obj, local_assets=True)
    except Exception:
        for p, b in backup.items():
            p.write_bytes(b)
        raise
    from datetime import datetime, timezone
    st.model_set(manifest["model_version"], deployed_at=datetime.now(timezone.utc))
    return man
