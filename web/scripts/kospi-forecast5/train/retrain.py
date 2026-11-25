"""[실사용 스크립트] 5거래일 월간 재학습 — 그달 마지막 예측 직후(run_automation.retrain_next) 같은 모델 구조를 다음 대상월용으로 학습한다.

학습 행: 기준일 변수 + 정답, 대상월 첫 예측 시점까지 실제 종가가 확정된 정답만 사용. 방향 = y_direction, 수익률 = y_return.
모델: sklearn.base.clone(운영 모델) — 파라미터를 따로 적어 두지 않고 운영 학습본에서 그대로 가져온다.
  shortcut: clone 이 안 되는 모델(직접 만든 앙상블 등)은 멈춘다. 그런 모델을 쓰게 되면 학습본 dict 에 "fit_fn" 같은 학습 방법을 넣는다.
배포(일별 service_daily run_retrain.py 와 같은 규칙, 2026-11-25): 운영 학습본(champion)은 점검(예측 숫자·범위 OOS 정합)을 통과하면 바로 배포하고
  이전 것은 retired(되돌리기용, run_promote.py rollback). 챌린저가 등록되어 있으면 같이 다시 학습해 챌린저 자리에 둔다(승격은 사람이 run_promote.py promote).
  예측 범위·SHAP 은 학습본 안 학습 밖 예측(range_oos)·묶음 신뢰도로 다음 예측부터 새 학습본 기준.
결합 학습본(wk_composite)은 run_composite: v3 정의대로 다시 학습해 바꿔 넣는다.
실행(service_5): python retrain.py --tp W0 --base 2026-11-30 [--write]
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import argparse

import numpy as np
import pandas as pd
from sklearn.base import clone

import wk_data
import wk_models
import wk_paths as P
import wk_store


def run(tp: str, b, X: pd.DataFrame, write: bool, *, run_day=None) -> dict:
    """b에서 5거래일 뒤가 속한 달의 모델을 예측 전에 준비한다."""
    b = pd.Timestamp(b).normalize()
    month = wk_data.model_month(b)
    first_base = wk_data.first_base_in(month)
    run_day = run_day if run_day is not None else (b if tp == "W0" else wk_data.next_session(b))
    first = wk_data.training_cutoff(tp, run_day, month)
    print(f"{tp} 대상월 {month}, 첫 기준일 {first_base.date()}, 학습 정답일 < {first.date()}", flush=True)
    import wk_composite
    champs = {o: wk_models.load(f"{tp}_{o}", "champion") for o in ("cls", "reg")}
    for obj, champ in champs.items():
        if champ is None:
            raise FileNotFoundError(f"{tp}_{obj}: 첫 운영 학습본을 먼저 등록하세요.")
    composite = {obj for obj, m in champs.items() if isinstance(m["model"], wk_composite.CompositeModel)}
    out = run_composite(tp, b, first, month, write, first_base=first_base) if composite else {}
    for obj, champ in champs.items():
        if obj in composite:
            continue
        slot = f"{tp}_{obj}"
        for role in wk_models.ROLES:
            cur = champ if role == "champion" else wk_models.load(slot, role)
            if cur is None:                                            # 챌린저는 등록했을 때만
                continue
            if str(cur["trained_for"]) >= month:
                print(f"{slot} {role}: {month} 학습본이 이미 있어 건너뜁니다.")
                continue
            if role == "champion" and wk_models.hold_month(slot) >= month:
                print(f"{slot}: 되돌린 학습본 유지({wk_models.hold_month(slot)}까지) — {month} 재학습 건너뜀")
                continue
            if not write:
                print(f"[dry-run] {slot} {role}: {month} 재학습 예정(학습하지 않음)")
                continue
            new, n_rows = _refit_standalone(tp, slot, obj, cur, b, first, month, X, check_pair=(role == "champion"))
            key = slot if role == "champion" else f"{slot}_{role}"
            out[key] = {"version": wk_models.version(slot, new), "train_rows": n_rows, "train_end": new["train_end"]}
            print(f"{key}: {out[key]}")
            with wk_store.engine()[0].begin() as con:
                wk_models.save(slot, role, new, con=con)
                wk_store.log_promotion(slot, "retrain" if role == "champion" else "retrain_challenger", wk_models.version(slot, cur), wk_models.version(slot, new),
                                       detail=f"재학습 {n_rows}행, 학습 끝 {new['train_end']}", con=con)
    return out


def _refit_standalone(tp, slot, obj, cur, b, first, month, X, *, check_pair):
    """단일 모델(clone 가능) 학습본을 정답일 < first 자료로 다시 학습하고 범위용 OOS·기본 점검까지."""
    D = candidate_data(tp, cur["features"])
    ds = D.loc[:b]
    ds = ds[(ds.target_dd < first) & (ds.target_dd <= b)].dropna(subset=["y_return"])
    if ds.empty:
        raise ValueError(f"{slot}: 학습 가능한 정답이 없습니다.")
    y = ds["y_direction"] if obj == "cls" else ds["y_return"]
    try:
        model = clone(cur["model"])
    except TypeError as e:
        raise TypeError(f"{slot}: 모델을 clone 할 수 없습니다({e}).") from e
    model.fit(ds[cur["features"]], y)
    variant = cur.get("variant", "standalone")                          # 버전 이름 = <판>_<대상월>_<학습 시각 UTC>(1차 학습 wk_train.build_models 와 같은 규칙)
    new = {"model": model, "features": list(cur["features"]), "trained_for": month, "variant": variant,
           "model_version": f"{variant}_{month}_{pd.Timestamp.now(tz='UTC'):%Y%m%d%H%M%S%f}",
           "train_end": str(ds.index.max().date()), "train_rows": len(ds)}
    new["range_oos"] = replay_oos(slot, new, D, first)
    if check_pair:
        wk_models.check_calibration_pair(slot, new)
    check = wk_models.predict(new, X.loc[:b].tail(20))                 # 대체 전 기본 점검: 최근 20개 기준일 예측이 모두 숫자인지
    if not np.isfinite(check).all():
        raise ValueError(f"{slot}: 새 모델 예측에 NaN/inf 가 있습니다. 저장하지 않습니다.")
    return new, len(ds)


def candidate_data(tp, features):
    import wk_train
    D = wk_train.load_data(tp)
    rules = [f for f in features if f.startswith("KWR_")]
    if rules:
        import wk_news
        D = D.join(wk_news.build(tp, D, lookback=len(D), rules=rules)[rules])
    return D


def replay_oos(slot, bundle, data, first):
    """고정 모델 설정을 각 월의 당시 확정된 정답으로만 다시 학습한다."""
    import wk_range
    first = pd.Timestamp(first)
    obj = slot.split("_")[1]
    feats = list(bundle["features"])
    y = "y_direction" if obj == "cls" else "y_return"
    data = data.loc[data.index < first].sort_index().dropna(subset=[y])
    months = data.index.to_period("M")
    min_rows = wk_range.config()["min_fit_rows"]
    rows = []
    for month in months.unique():
        train = data[(data.index < month.start_time) & (data.target_dd < month.start_time)]
        if len(train) < min_rows or (obj == "cls" and train[y].nunique() < 2):
            continue
        test = data.loc[months == month, feats]
        model = clone(bundle["model"]).fit(train[feats], train[y])
        rows.append(pd.Series(wk_models.predict({**bundle, "model": model}, test), index=test.index))
    if not rows:
        raise ValueError(f"{slot}: 순차 검증에 필요한 과거 입력과 확정 정답이 부족합니다.")
    return pd.concat(rows)


def prepare_uploaded_oos(slot, bundle):
    from wk_composite import CompositeModel
    if isinstance(bundle["model"], CompositeModel):
        raise ValueError(f"{slot}: 결합 모델은 학습 정의로 순차 검증해야 합니다. train/wk_train.py --export-joblib을 사용하세요.")
    # 업로드 시점 이후의 자료를 사용하거나 이번 달 중간을 첫 달로 취급하지 않는다.
    first = pd.to_datetime(str(bundle["trained_for"]), format="%Y%m")
    wk_data.refresh()
    bundle["range_oos"] = replay_oos(slot, bundle, candidate_data(slot[:2], bundle["features"]), first)


def run_composite(tp: str, b, first, month: str, write: bool, *, first_base) -> dict:
    """1차 학습본(wk_composite, 구성 모델 여러 개 + 결합 규칙): 역할별 v3 구성으로
    wk_train.retrain 으로 다시 학습해 같은 자리에 바꿔 넣는다(물러난 것은 DB 에 retired).
    자료를 새로 만들고(뉴스 전 기간), 구성 모델 OOS 이력을 지난달까지 이어 붙인 뒤 정답일 < 다음 달 첫 기준일로 학습한다(수 분)."""
    import wk_composite
    todo = {}
    for o in ("cls", "reg"):
        slot = f"{tp}_{o}"
        for role in wk_models.ROLES:
            m = wk_models.load(slot, role)
            if m and isinstance(m["model"], wk_composite.CompositeModel):
                if m.get("variant") != "v3":
                    raise ValueError(f"{slot} {role}: 운영 재학습에는 v3 학습본이 필요합니다.")
                if str(m["trained_for"]) >= month:
                    continue
                if role == "champion" and wk_models.hold_month(slot) >= month:   # 되돌린 달은 다시 학습하지 않는다(2026-11-25)
                    print(f"{slot}: 되돌린 학습본 유지({wk_models.hold_month(slot)}까지) — {month} 재학습 건너뜀")
                    continue
                todo[(slot, role)] = m                                   # 챌린저도 자기 학습 정의로 따로 다시 학습(2026-11-25)
    if not todo:
        print(f"{tp}: {month} 학습본이 이미 있어 건너뜁니다.")
        return {}
    if not write:
        print(f"[dry-run] {list(todo)}: {month} 재학습 예정(구성 모델별 재학습 + 결합 값 다시 정하기, 학습하지 않음)")
        return {}
    import wk_train
    lines = {}
    for (slot, role), m in todo.items():
        lines.setdefault(wk_train.line_of(role), {})[slot] = m
    built, pending, retuned = wk_train.retrain(tp, first, write, target_month=month, feature_start=first_base, lines=lines)
    made = {(slot, role): built[wk_train.line_of(role)][slot] for slot, role in todo}
    X = wk_train.load_data(tp).loc[:b]
    rules = sorted({f for key in todo
                    for f in made[key]["features"] if f.startswith("KWR_")})
    if rules:
        import wk_news
        X = X.join(wk_news.build(tp, X, rules=rules, write=write)[rules])
    out = {}
    for (slot, role), old in todo.items():                               # ① 바꿔 넣기 전에 모두 점검(하나라도 이상하면 아무것도 바꾸지 않음)
        new = made[(slot, role)]
        if new.get("training_definition") != old.get("training_definition"):
            raise ValueError(f"{slot}: 모델 정의가 바뀌었습니다. 새 모델의 OOS와 함께 다시 배포하세요.")
        wk_models.range_oos(slot, new)
        since = getattr(new["model"], "needs_rows_from", None)
        xin = X.loc[pd.Timestamp(since):] if since else X.tail(20)
        check = wk_models.predict(new, xin.tail(40) if len(xin) else X.tail(20))       # 대체 전 기본 점검: 예측이 모두 숫자인지
        if not np.isfinite(check).all():
            raise ValueError(f"{slot} {role}: 새 모델 예측에 NaN/inf 가 있습니다. 저장하지 않습니다.")
    new_champs = {obj: made[(f"{tp}_{obj}", "champion")]
                  if (f"{tp}_{obj}", "champion") in todo else wk_models.load(f"{tp}_{obj}")
                  for obj in ("cls", "reg")}
    import wk_range
    wk_range.verify_oos(tp, *(wk_models.range_oos(f"{tp}_{obj}", new_champs[obj]) for obj in ("cls", "reg")))
    with wk_store.engine()[0].begin() as con:
        for item in pending:
            wk_train.oos_write(*item, replace_all=False, con=con)
        wk_train.save_retune(retuned, first, "v3", con)
        for (slot, role), old in todo.items():
            new = made[(slot, role)]
            if old.get("shap_reliability") and old.get("variant") == new.get("variant"):   # 같은 구조의 SHAP 묶음 신뢰도(학습 밖 13개월 계산 값)를 이어 쓴다
                new["shap_reliability"] = old["shap_reliability"]
            ver = wk_models.save(slot, role, new, con=con)
            wk_store.log_promotion(slot, "retrain" if role == "champion" else "retrain_challenger", wk_models.version(slot, old), ver,
                                   detail=f"v3 월간 재학습(구성 {len(new['components'])}개), 학습 끝 {new['train_end']}", con=con)
            out[slot if role == "champion" else f"{slot}_{role}"] = {"version": ver, "train_end": new["train_end"]}
    for key, result in out.items():
        print(f"{key}: {result}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    ap.add_argument("--base", required=True, help="예측 기준일 b (YYYY-MM-DD). b + 5거래일의 달을 학습")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    base = pd.Timestamp(a.base).normalize()
    if a.write:
        day = base if a.tp == "W0" else wk_data.next_session(base)
        if pd.Timestamp.now(tz="UTC") < wk_data.run_time(a.tp, day) or not wk_data.close_ready(base):
            raise ValueError(f"{a.tp} {base.date()}: 해당 실행 시각과 기준일 종가를 확인하세요.")
    wk_data.refresh()
    run(a.tp, base, wk_data.features(a.tp, write=a.write), a.write)                  # 실행마다 DB 에서 다시 만든다(캐시 없음)


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
