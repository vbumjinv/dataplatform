"""[실사용 모듈] 주별 학습본 관리 — 학습본과 역할(champion·challenger·retired)을 DB 테이블 kospi5_mlops_model 한 곳에 둔다(로컬 파일 없음, 2026-11-24).

행 = 슬롯(objective = W0_cls·W0_reg·W2_cls·W2_reg) x model_version, bundle = joblib bytes,
  role = champion(운영 예측)·challenger(비교용, 등록했을 때만)·retired(물러난 것, 되돌리기용).
학습본 dict = {"model": fit/predict(_proba) 가 있는 모델, "features": [변수 순서], "trained_for": "YYYYMM", "train_end": "YYYY-MM-DD"}.
manifest·해시는 쓰지 않는다(사용자 결정 2026-11-19). 슬롯마다 champion·challenger 는 1개까지, retired 는 최근 KEEP_RETIRED 개만 남긴다.
챌린저(2026-11-25, 일별 service_daily 와 같은 구조): 지금은 등록된 챌린저가 없다. 등록하면 매 거래일 함께 예측해 원장에 쌓고(predict.py),
  저녁에 비교하며(evaluate.py), 월간 재학습 때 자기 학습 정의(training_config)·자기 OOS line(v3_challenger)으로 따로 다시 학습한다(retrain.py).
  승격은 자동이 아니라 사람이 promote 로 하고, 지금 챌린저 버전의 판정만 본다. 되돌리기는 물러난 학습본의 대상월까지 자동 재학습을 멈춘다(hold_month).
챌린저 등록: python wk_models.py upload <joblib 파일> W0_cls challenger
승격:       python wk_models.py promote W0_cls [--force]   (최근 비교 판정이 '승격 후보'일 때만, --force 면 판정과 관계없이)
되돌리기:   python wk_models.py rollback W0_cls W0_cls_v3_202612   (retired 행을 운영 학습본으로, 이력은 kospi5_mlops_role_history)
운영 학습본 올리기: python wk_models.py upload <joblib 파일> W0_cls champion
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import argparse
import io
import re

import joblib
import numpy as np
import pandas as pd

import wk_paths as P

ROLES = ("champion", "challenger")
MODEL = "kospi5_mlops_model"
KEEP_RETIRED = 3                                                         # 되돌리기용으로 남기는 물러난 학습본 수(일별 slot 최근 3개와 같음)
_MEM: dict = {}                                                          # 한 실행 안에서 같은 학습본을 다시 받지 않게(메모리만, 파일 없음)


def _check_slot(slot: str):
    if slot not in P.SLOTS:
        raise ValueError(f"슬롯 이름: {slot} (가능: {P.SLOTS})")


def _validate(m, where: str) -> dict:
    if not isinstance(m, dict):
        raise ValueError(f"{where}: 학습본은 dict 여야 합니다.")
    missing = [k for k in ("model", "features", "trained_for") if k not in m]
    if missing:
        raise ValueError(f"{where}: 학습본 dict 에 {missing} 가 없습니다.")
    if not isinstance(m["features"], (list, tuple)) or not m["features"] or len(set(m["features"])) != len(m["features"]):
        raise ValueError(f"{where}: features 는 중복 없는 변수 목록이어야 합니다.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(m["trained_for"])):
        raise ValueError(f"{where}: trained_for 형식 오류")
    return m


def load(slot: str, role: str = "champion") -> dict | None:
    """그 역할의 학습본 dict 또는 None(행 없음)."""
    import wk_store
    _check_slot(slot)
    if role not in ROLES:
        raise ValueError(f"모델 역할: {role}")
    h = wk_store.read(MODEL, {"objective": slot, "role": role}, columns=["model_version"])
    if h.empty:
        return None
    return load_version(slot, h.model_version.iloc[0])


def load_version(slot: str, ver: str) -> dict | None:
    """저장된 예측 버전에 대응하는 학습본 또는 정형 fallback."""
    import wk_store
    _check_slot(slot)
    base = ver.removesuffix("_struct")
    if (slot, base) not in _MEM:
        rows = wk_store.read(MODEL, {"objective": slot, "model_version": base}, columns=["bundle"])
        if rows.empty:
            return None
        _MEM[(slot, base)] = _validate(joblib.load(io.BytesIO(bytes(rows.bundle.iloc[0]))), f"{MODEL} {base}")
    m = _MEM[(slot, base)]
    if base != ver and m.get("fallback"):
        m = {**m, **m["fallback"]}
    if version(slot, m) != ver:
        raise ValueError(f"{MODEL} {ver}: 학습본 안 버전 {version(slot, m)} 과 다릅니다.")
    return m


def role_month(slot: str, role: str = "champion"):
    import wk_store
    rows = wk_store.read(MODEL, {"objective": slot, "role": role}, columns=["target_month"])
    return str(rows.target_month.iloc[0]) if len(rows) else ""


def _require_current_model(slot, m):
    from wk_composite import CompositeModel
    if isinstance(m["model"], CompositeModel) and m.get("variant") != "v3":
        raise ValueError(f"{slot}: 운영에 등록할 결합 모델은 v3여야 합니다.")


def save(slot: str, role: str, m: dict, *, con=None) -> str:
    """학습본을 그 역할로 넣는다(그 역할의 기존 행은 retired, 같은 버전은 거절). 한 트랜잭션이라 실패하면 역할이 그대로다. 반환: model_version."""
    import wk_store
    from sqlalchemy import select, update
    _check_slot(slot)
    if role not in ROLES:
        raise ValueError(f"모델 역할: {role}")
    _validate(m, slot)
    _require_current_model(slot, m)
    ver = version(slot, m)
    if con is None:
        with wk_store.engine()[0].begin() as conn:
            return save(slot, role, m, con=conn)
    buf = io.BytesIO()
    joblib.dump(m, buf, compress=3)
    t = wk_store.table(MODEL)
    now = wk_store._value(t.c.deployed_at, wk_store.stamp_now())
    if con.execute(select(t.c.model_version).where(t.c.model_version == ver)).scalar_one_or_none() is not None:
        raise ValueError(f"{slot}: 이미 등록된 모델 버전 {ver}. 새 버전을 지정하세요.")
    con.execute(update(t).where(t.c.objective == slot, t.c.role == role).values(role="retired", deployed_at=now))
    con.execute(t.insert().values(model_version=ver, objective=slot, target_month=str(m["trained_for"]), bundle=buf.getvalue(),
                                  registered_at=now, deployed_at=now, role=role))
    _prune(con, t, slot)
    return ver


def _prune(con, t, slot):
    from sqlalchemy import delete, select
    old = con.execute(select(t.c.model_version).where(t.c.objective == slot, t.c.role == "retired").order_by(t.c.deployed_at.desc())).scalars().all()
    if len(old) > KEEP_RETIRED:
        con.execute(delete(t).where(t.c.model_version.in_(old[KEEP_RETIRED:])))


def _set_role(slot, m, role, action, *, detail="", **decision):
    """학습본 ver 를 role 로(그 역할의 기존 행은 retired)."""
    import wk_store
    from sqlalchemy import update
    _require_current_model(slot, m)
    ver = version(slot, m)
    current = load(slot, role)
    eng, _ = wk_store.engine()
    t = wk_store.table(MODEL)
    now = wk_store._value(t.c.deployed_at, wk_store.stamp_now())
    with eng.begin() as con:
        if current is None or calibration_id(slot, current) != calibration_id(slot, m):
            save_component_oos(slot, m, con=con, role=role)
        con.execute(update(t).where(t.c.objective == slot, t.c.role == role, t.c.model_version != ver).values(role="retired", deployed_at=now))
        n = con.execute(update(t).where(t.c.objective == slot, t.c.model_version == ver).values(role=role, deployed_at=now)).rowcount
        if n != 1:
            raise ValueError(f"{slot}: 학습본 {ver} 가 {MODEL} 에 없습니다.")
        _prune(con, t, slot)
        prev = version(slot, current) if current else ""
        wk_store.log_promotion(slot, action, prev, ver, detail=detail, decision=decision, con=con)


def save_component_oos(slot, m, *, con, role="champion"):
    """이 학습본의 구성 OOS를 다음 월간 재학습에 사용한다. line 은 역할별(운영 v3·챌린저 v3_challenger, 2026-11-25)."""
    if not m.get("component_oos"):
        return
    import wk_train
    line = wk_train.line_of(role, m["variant"])
    for comp, h in m["component_oos"].items():
        wk_train.oos_write(slot, comp, h.index, h.to_numpy(), line, "seed", con=con)


def version(slot: str, m: dict) -> str:
    """예측 기록에 남기는 모델 이름(예 W0_cls_202612)."""
    value = str(m.get("model_version", m["trained_for"]))
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("model_version 은 영문·숫자·밑줄·하이픈만 사용하세요.")
    return f"{slot}_{value}"


def calibration_id(slot: str, m: dict) -> str:
    """같은 모델 구성으로 하는 월간 재학습은 같은 오차 이력을 이어 쓴다."""
    ver = version(slot, m)
    base = ver.removesuffix("_struct")
    cohort = m.get("range_calibration", base)
    return cohort + "_struct" if ver != base else cohort


def range_oos(slot: str, m: dict) -> pd.Series:
    """학습본에 같이 저장한 학습 밖 점예측. 날짜는 기준일, 수익률은 K1 적용 전."""
    if str(m.get("model_version", "")).endswith("_struct"):
        h = m["fallback"].get("range_oos")
        if h is None:
            parts = pd.DataFrame({name: m["component_oos"][name] for name in m["model"].components}).dropna()
            parts = parts.loc[parts.index.isin(m["range_oos"].index)]
            h = pd.Series(m["model"].combine_parts(parts, parts), index=parts.index)
    else:
        h = m.get("range_oos")
    if not isinstance(h, pd.Series) or h.empty or not isinstance(h.index, pd.DatetimeIndex):
        raise ValueError(f"{version(slot, m)}: 날짜별 범위 보정용 OOS 예측이 필요합니다.")
    h = h.sort_index().astype(float)
    if h.index.has_duplicates or h.index.hasnans or not np.isfinite(h).all():
        raise ValueError(f"{version(slot, m)}: 범위 OOS 예측의 날짜·값을 확인하세요.")
    if slot.endswith("_cls") and not h.between(0., 1.).all():
        raise ValueError(f"{version(slot, m)}: 방향 OOS는 0~1 확률이어야 합니다.")
    return h


def predict(m: dict, X: pd.DataFrame) -> np.ndarray:
    """분류 = 상승 확률, 회귀 = 5거래일 수익률. X 에 학습본 변수가 모두 있어야 한다."""
    miss = [c for c in m["features"] if c not in X.columns]
    if miss:
        raise ValueError(f"변수 표에 없는 학습본 변수: {miss} (build_features.py·feature_sources.json 확인)")
    A = X[m["features"]]
    model = m["model"]
    if hasattr(model, "predict_proba"):
        classes = list(model.classes_)
        if set(classes) != {0, 1}:
            raise ValueError("방향 모델 classes_ 는 0(하락), 1(상승)이어야 합니다.")
        out = model.predict_proba(A)[:, classes.index(1)]
    else:
        out = model.predict(A)
    out = np.asarray(out, dtype=float)
    if out.shape != (len(A),) or not np.isfinite(out).all():
        raise ValueError("예측값의 길이 또는 NaN/inf 를 확인하세요.")
    return out


def save_challenger(slot: str, m: dict):
    return save(slot, "challenger", m)


def promote(slot: str, *, verify=False, detail="수동 승격", **decision):
    """챌린저 → 운영 학습본, 기존 운영 학습본 → retired(일별 run_promote.py 와 같은 자리)."""
    ch = load(slot, "challenger")
    if ch is None:
        raise FileNotFoundError(f"{slot}: 챌린저 학습본이 없습니다.")
    check_calibration_pair(slot, ch, verify=verify)
    _set_role(slot, ch, "champion", "promote", detail=detail, **decision)
    return version(slot, ch)


def last_decision(slot: str) -> str:
    """kospi5_mlops_compare 에서 이 슬롯의 지금 챌린저에 대한 최근 판정(없으면 ''). 예전 챌린저 판정은 쓰지 않는다(2026-11-25)."""
    import wk_store
    ch = load(slot, "challenger")
    if ch is None:
        return ""
    c = wk_store.read("kospi5_mlops_compare", {"objective": slot, "challenger": version(slot, ch)}, columns=["asof", "decision"])
    return str(c.sort_values("asof").decision.iloc[-1]) if len(c) else ""


def hold_month(slot: str) -> str:
    """되돌리기 뒤 자동 재학습을 멈출 마지막 대상월(없으면 ''). 슬롯의 마지막 운영 학습본 변경이 rollback 일 때만,
    되돌릴 때 물러난 학습본의 대상월까지 — 그 달은 되돌린 학습본으로 예측하고 다음 달부터 되돌린 학습본의 정의로 다시 학습한다(2026-11-25)."""
    import json
    import wk_store
    h = wk_store.read("kospi5_mlops_role_history", {"objective": slot}, columns=["id", "action", "decision"])
    h = h[h.action.isin(["retrain", "promote", "rollback"])]
    if h.empty:
        return ""
    r = h.sort_values("id").iloc[-1]
    if r.action != "rollback":
        return ""
    d = r.decision if isinstance(r.decision, dict) else json.loads(r.decision or "{}")
    return str(d.get("hold_month") or "")


def rollback(slot: str, ver: str, *, verify=False):
    """retired 행 ver 를 운영 학습본으로(지금 학습본은 retired)."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", ver):
        raise ValueError("model_version 형식 오류")
    ver = ver if ver.startswith(slot) else f"{slot}_{ver}"
    m = load_version(slot, ver)
    if m is None:
        raise ValueError(f"{slot}: {ver} 학습본이 없습니다.")
    check_calibration_pair(slot, m, verify=verify)
    cur = load(slot, "champion")
    _set_role(slot, m, "champion", "rollback", detail="수동 되돌리기",
              hold_month=str(cur["trained_for"]) if cur else str(m["trained_for"]))   # 이 달까지는 자동 재학습이 되돌린 학습본을 덮지 않음
    return ver


def check_calibration_pair(slot, m, *, verify=False):
    import wk_range
    tp, obj = slot.split("_")
    other = f"{tp}_{'reg' if obj == 'cls' else 'cls'}"
    seed = range_oos(slot, m)
    existing = load(other)
    if existing is not None:
        other_seed = range_oos(other, existing)
        cls, reg = (seed, other_seed) if obj == "cls" else (other_seed, seed)
        if verify:
            wk_range.verify_oos(tp, cls, reg)
        else:
            wk_range.align_seeds(cls, reg)


def status() -> pd.DataFrame:
    rows = []
    for s in P.SLOTS:
        for r in ROLES:
            m = load(s, r)
            rows.append({"slot": s, "role": r, "version": version(s, m) if m else "", "n_features": len(m["features"]) if m else 0,
                         "train_end": m.get("train_end", "") if m else ""})
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser(description="주별 학습본 상태·되돌리기·올리기")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    pr = sub.add_parser("promote")
    pr.add_argument("slot")
    pr.add_argument("--force", action="store_true", help="비교 판정이 '승격 후보'가 아니어도 승격")
    rb = sub.add_parser("rollback")
    rb.add_argument("slot")
    rb.add_argument("month", help="되돌릴 model_version(예 W0_cls_v3_202612, status 의 retired 목록)")
    up = sub.add_parser("upload")
    up.add_argument("file")
    up.add_argument("slot")
    up.add_argument("role", choices=ROLES)
    a = ap.parse_args()
    if a.cmd == "status":
        import wk_store
        print(status().to_string(index=False))
        print(wk_store.read(MODEL, columns=["objective", "model_version", "role", "target_month", "deployed_at"]).sort_values(["objective", "role"]).to_string(index=False))
        return
    if a.cmd == "upload":                                                # 개발 PC 학습본 → DB(처음 한 번)
        m = _validate(joblib.load(a.file), a.slot)
        version(a.slot, m)
        if "range_oos" not in m:
            from retrain import prepare_uploaded_oos
            prepare_uploaded_oos(a.slot, m)
        elif a.role == "champion":
            import wk_data
            wk_data.refresh()
        m.pop("range_calibration", None)
        range_oos(a.slot, m)
        if a.role == "champion":
            check_calibration_pair(a.slot, m, verify=True)
        import wk_store
        with wk_store.engine()[0].begin() as con:
            save_component_oos(a.slot, m, con=con, role=a.role)         # 월간 재학습이 이어 쓰는 구성 OOS(챌린저는 v3_challenger line 이라 운영 이력을 덮지 않음)
            ver = save(a.slot, a.role, m, con=con)
            if a.role == "challenger":
                wk_store.log_promotion(a.slot, "challenger_new", "", ver, detail="챌린저 등록", con=con)
        print(f"{a.slot} {a.role} = {ver}")
        return
    import wk_data
    wk_data.refresh()
    if a.cmd == "promote":
        d = last_decision(a.slot)
        if d != "승격 후보" and not a.force:
            raise SystemExit(f"{a.slot}: 최근 비교 판정이 '{d or '없음'}'이라 승격하지 않습니다(evaluate.py 결과 확인, 그래도 하려면 --force).")
        print(f"{a.slot}: 운영 학습본 = {promote(a.slot, verify=True, decision_seen=d)}")
        return
    print(f"{a.slot}: 운영 학습본 = {rollback(a.slot, a.month, verify=True)}")


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
