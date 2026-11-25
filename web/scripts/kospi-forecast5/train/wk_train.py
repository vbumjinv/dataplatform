"""[실사용 스크립트] 5거래일 운영 모델 v3의 초기 학습과 월간 재학습.

DB 원천으로 방향·수익률 모델 4개 및 범위 보정용 학습 밖 예측을 만든다.
실행: python -B train/wk_train.py --variant v3 --export-joblib <폴더>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE.parent / "mlops") not in sys.path:                   # 직접 실행·병렬 작업 프로세스에서도 모듈 폴더를 찾게(2026-11-23 폴더 구조)
    sys.path.insert(0, str(HERE.parent / "mlops"))
import wk_paths as P  # noqa: E402
P.add_paths()
for _k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_k, "1")

import numpy as np
import pandas as pd

CFG = P.CONFIG
FIRST_PRED = pd.Timestamp("2026-11-02")   # 운영 학습본: 2026-11 첫 기준일 전 정답까지
LAST_BASE = pd.Timestamp("2026-10-30")                                                  # 평가 자료 마지막 기준일(홀드아웃 끝)
PERIODS = [(f"{2017 + k}-10-01", f"{2018 + k}-09-30") for k in range(1, 8)] + [("2025-10-01", "2026-10-31")]
START = {k: pd.Timestamp(s) for k, (s, _) in enumerate(PERIODS, 1)}
INNER0 = START[1] - pd.DateOffset(years=1)
SEQ = ("LSTM", "GRU")
CW_PARAM = {b: {"class_weight": "balanced"} for b in ("LogisticL1", "LogisticL2", "RollingLogisticL1", "HistGradientBoosting", "LightGBM")}
CW_PARAM["CatBoost"] = {"auto_class_weights": "Balanced"}
CW_MODELS = set(CW_PARAM) | {"XGBoost", "GradientBoosting"}
WGRID = np.round(np.arange(0.5, 1.001, 0.05), 2)
EPS = 1e-4
_DS = {}
_OOS_ADD: dict = {}                # 이번 실행에서 이어 붙인 OOS(시험 실행에서도 결합 값 계산에 씀)
_OOS_REPLACED: set = set()         # 처음부터 재계산한 이력에는 DB의 옛 행을 섞지 않는다.


PARAMS_OF = {"v1": "v1", "v2": "v2", "v3": "v3"}   # 판 → 파라미터 판(config/<것>_params.json)·결과 폴더(<data>/train_<것>)
def set_variant(variant):
    os.environ["KOSPI5_TRAIN_TAG"] = PARAMS_OF[variant]       # 환경 변수로 둬야 병렬 작업 프로세스(Windows spawn)에도 전해진다


OOS = "kospi5_mlops_oos"


def tag():
    return os.environ.get("KOSPI5_TRAIN_TAG", "v3")                  # 구성 모델 OOS 의 line(파라미터 판)


def line_of(role: str, variant: str = "v3") -> str:
    """구성 OOS line: 운영 = 판 이름(v3), 챌린저 = v3_challenger — 챌린저가 운영 이력을 덮어쓰지 않게(2026-11-25)."""
    return PARAMS_OF[variant] if role == "champion" else f"{PARAMS_OF[variant]}_challenger"


def fold_of(idx) -> np.ndarray:
    """기준일 → 구간(0 = fold 1 앞 inner, 1~8 = 평가 구간, 9 = 홀드아웃 뒤 월간 이어 붙임). 저장하지 않고 날짜로 정한다."""
    idx = pd.DatetimeIndex(idx)
    f = np.zeros(len(idx), int)
    for k, (s_, e_) in enumerate(PERIODS, 1):
        f[(idx >= pd.Timestamp(s_)) & (idx <= pd.Timestamp(e_))] = k
    f[idx > pd.Timestamp(PERIODS[-1][1])] = 9
    return f


def oos_read(slot, component, line=None) -> pd.DataFrame:
    """저장소 OOS(+ 이번 실행에서 이어 붙인 것) → index = 기준일(date), 열 pred·fold. 없으면 빈 표."""
    import wk_data
    import wk_store
    key = (slot, component, line or tag())
    add = _OOS_ADD.get(key)
    if key in _OOS_REPLACED:
        pred = add
    else:
        d = wk_store.read(OOS, {"objective": slot, "component": component, "line": key[2]}, columns=["target_dd", "yhat"])
        idx = wk_data.to_base(d.target_dd) if len(d) else pd.DatetimeIndex([])
        pred = pd.Series(d.yhat.to_numpy(float), index=pd.DatetimeIndex(idx))
        if add is not None:
            pred = pd.concat([pred[~pred.index.isin(add.index)], add])
    pred = pred.sort_index()
    return pd.DataFrame({"pred": pred.to_numpy(float), "fold": fold_of(pred.index)}, index=pd.DatetimeIndex(pred.index, name="date"))


def oos_write(slot, component, dates, pred, line, source, replace_all=True, *, con=None):
    """OOS 저장(replace_all = 그 구성·판 전체를 바꿈, 아니면 새 날짜만 더함)."""
    import wk_data
    import wk_store
    rows = pd.DataFrame({"target_dd": wk_data.to_target(dates), "objective": slot, "component": component, "line": line,
                         "yhat": np.asarray(pred, float), "source": source})
    if rows.empty:
        return
    if replace_all:
        wk_store.replace(OOS, rows, ["objective", "component", "line"], con=con)
    else:
        wk_store.append(OOS, rows, con=con)


# ================================================================== 설정
def combined(slot, variant) -> pd.DataFrame:
    """결합 예측 OOS(DB, component = combined, line = 판) + 정답 y. index = 기준일, 열 pred·fold·y."""
    R = oos_read(slot, "combined", line=variant)
    D = load_data(slot[:2])
    R["y"] = (D.y_direction if slot.endswith("cls") else D.y_return).reindex(R.index).to_numpy(float)
    return R


def used(cb):
    """결합 규칙이 쓰는 구성 모델 이름."""
    names = [c for g in cb["groups"] for it in g for c in it] if cb["kind"] == "mean_groups" else cb["struct"] + cb["news"]
    return list(dict.fromkeys(names))


def config(variant="v3", *, adopted=True):
    if variant != "v3":
        raise ValueError("배포본은 v3 정의만 둔다(model/configs).")
    config_dir = CFG
    comps = pd.DataFrame(json.loads((CFG / "v1_components.json").read_text(encoding="utf-8")))
    feats = pd.DataFrame(json.loads((CFG / "v1_features.json").read_text(encoding="utf-8"))).sort_values(["slot", "component", "order"])
    F = {(s, c): g.feature.tolist() for (s, c), g in feats.groupby(["slot", "component"], sort=False)}
    pf = config_dir / f"{PARAMS_OF[variant]}_params.json"
    params = json.loads(pf.read_text(encoding="utf-8")) if pf.exists() else {}
    comb = {k: v for k, v in json.loads((config_dir / f"{variant}_combine.json").read_text(encoding="utf-8")).items() if not k.startswith("_")}
    for x in (adopted_params(PARAMS_OF[variant]) if adopted else []):   # 분기 재탐색에서 채택한 값(DB 승격 이력) → 새 구간 키(last() 가 씀)
        pp = params.get(x["slot"], {}).get(x["component"])
        if pp is not None:
            pp[str(max(int(k) for k in pp) + 1)] = x["params"]
    comps = comps[[r.component in used(comb[r.slot]) for r in comps.itertuples()]].reset_index(drop=True)   # 판에서 쓰는 구성 모델만
    seeds = comps.seeds.fillna(1).astype(int) if "seeds" in comps else pd.Series(1, index=comps.index)
    for r, n in zip(comps.itertuples(), seeds):                  # 시드 묶음(v3): 구간마다 파라미터에 n_seeds 를 넣어 fit() 이 n 번 학습해 평균
        if n > 1:
            for pp in params[r.slot][r.component].values():
                pp["n_seeds"] = n
    for r in comps.itertuples():
        assert (r.slot, r.component) in F, (r.slot, r.component)
        assert not params or all(str(k) in params[r.slot][r.component] for k in range(1, 9)), r.component   # 비어 있으면 --tune 으로 만든다
    return comps, F, params, comb


def config_of(bundles: dict):
    """학습본마다 저장한 학습 정의(training_config)로 재학습 설정을 만든다 {슬롯: 학습본} → (comps, F, params, comb).
    학습 정의가 없는 학습본(2026-11 첫 학습본)은 설정 파일의 첫 값(채택 이력 없이)을 쓴다 — 그 학습본들이 그 값으로 학습됐다.
    그래서 되돌린 학습본으로 다시 학습하면 파라미터도 그 학습본 것으로 돌아간다(2026-11-25)."""
    import copy
    rows, F, params, comb = [], {}, {}, {}
    files = None
    for slot, m in bundles.items():
        tc = m.get("training_config")
        if tc is None:
            files = files or config(adopted=False)
            fc, fF, fp, fcb = files
            tc = {"components": fc[fc.slot == slot].to_dict("records"),
                  "features": {c: fF[(slot, c)] for c in fc[fc.slot == slot].component},
                  "params": {c: fp[slot][c] for c in fc[fc.slot == slot].component}, "combine": fcb[slot]}
        tc = copy.deepcopy(tc)
        rows += tc["components"]
        F.update({(slot, c): list(v) for c, v in tc["features"].items()})
        params[slot] = tc["params"]
        comb[slot] = tc["combine"]
    return pd.DataFrame(rows), F, params, comb


def adopted_params(ptag) -> list[dict]:
    """kospi5_mlops_role_history 의 retune_adopt 행(오래된 순) → [{slot, component, params}]. 파라미터 파일은 첫 값으로 고정하고 바뀐 값은 DB 에만 둔다."""
    import wk_store
    h = wk_store.read("kospi5_mlops_role_history", {"action": "retune_adopt"}, columns=["id", "objective", "decision"])
    out = []
    for r in h.sort_values("id").itertuples():
        d = r.decision if isinstance(r.decision, dict) else json.loads(r.decision or "{}")
        if d.get("params_tag") == ptag and d.get("params") is not None:
            out.append({"slot": r.objective, "component": d["component"], "params": d["params"]})
    return out


def last(pp):
    """운영 학습본·월간 재학습 파라미터 = 가장 늦은 구간 값(v2: 9 = 2025-11~2026-10 inner 로 고른 값, v1: 8)."""
    return pp[str(max(int(k) for k in pp))]


# ================================================================== 1 자료
def build_data(tp: str, *, write=False) -> pd.DataFrame:
    """정형 + VKOSPI + 뉴스(전 기간) + 정답. index = 기준일."""
    import build_features
    import wk_data
    import wk_news
    import wk_vkospi
    import wk_relation
    X = build_features.build(tp)
    X = wk_vkospi.attach(X)
    X = wk_relation.attach(X)
    X = pd.concat([X, wk_news.build(tp, X, lookback=len(X), rules=[], write=write)], axis=1)
    A = wk_data.answers(X.index)
    D = X.join(A).sort_index()
    _DS[tp] = D
    return D


def load_data(tp):
    """이번 실행에 만든 자료 표(없으면 DB 에서 만든다). 병렬 작업 프로세스는 _init_worker 로 받은 것을 쓴다."""
    if tp not in _DS:
        build_data(tp)
    return _DS[tp]


def _init_worker(ds):
    _DS.update(ds)


def pool(workers):
    """자료 표를 메모리로 넘긴 병렬 작업 프로세스(파일 없음)."""
    return ProcessPoolExecutor(workers, initializer=_init_worker, initargs=({tp: load_data(tp) for tp in ("W0", "W2")},))


# ================================================================== 2 구성 모델 학습
def make_model(name, params):
    from kp import models as M
    p = dict(params)
    if name.startswith(("LightGBM", "XGBoost")):
        p["n_jobs"] = 1
    if name.startswith("CatBoost"):
        p["thread_count"] = 1
    m = M.make_model(name, p)
    if name.startswith(("RandomForest", "ExtraTrees")):
        m.set_params(model__n_jobs=1)
    return m


def fit(ds, model, obj, params, feats, cw, tr, te_first):
    """실험 run_single.fit_pred 와 같은 학습. 반환: 학습된 모델.
    params 에 n_seeds(> 1)가 있으면 난수 시드 RS, RS+1, … 로 n 번 학습해 wk_composite.SeedBag(예측 평균)으로 묶는다(v3, 실험 seed_bag_20261124 와 같음)."""
    from kp import models as M
    n = int(params.get("n_seeds", 1))
    params = {k: v for k, v in params.items() if k != "n_seeds"}
    if n > 1:
        import wk_composite
        rs, ms = M.RS, []
        try:
            for i in range(n):
                M.RS = rs + i
                ms.append(fit(ds, model, obj, params, feats, cw, tr, te_first))
        finally:
            M.RS = rs
        return wk_composite.SeedBag(ms)
    y = tr["y_direction" if obj == "cls" else "y_return"].to_numpy(int if obj == "cls" else float)
    b = model.split("_")[0]
    cwb = cw and obj == "cls" and b in CW_MODELS
    if cwb:
        params = {**params, **CW_PARAM.get(b, {})}
        if b == "XGBoost":
            Xf, yf, Xv, _ = M._val_tail(tr[feats], y)
            if Xv is not None:
                yf = yf[(tr.target_dd.reindex(Xf.index) < Xv.index.min()).to_numpy()]
            params["scale_pos_weight"] = float((yf == 0).sum() / max((yf == 1).sum(), 1))
    m = make_model(model, params)
    if cwb and b == "GradientBoosting":
        from sklearn.utils.class_weight import compute_sample_weight
        m.fit(tr[feats], y, model__sample_weight=compute_sample_weight("balanced", y))
    elif b in SEQ:
        m.fit(tr[feats], y, target_dates=tr.target_dd)
    else:
        M.fit_model(m, tr[feats], y, model, target_dates=tr.target_dd)
    if hasattr(m, "history_"):
        m.history_ = ds.loc[ds.index < te_first, feats].sort_index().iloc[-max(0, m.lookback - 1):].copy()
    return m


def predict(m, X, obj):
    from kp import models as M
    return np.asarray(M.predict(m, X, obj), float)


def purge(ds, first):
    return ds[(pd.DatetimeIndex(ds["target_dd"]) < pd.Timestamp(first)) & ds["y_return"].notna()]


def comp_job(a):
    """구성 모델 하나: inner(fold 1 앞 12개월) + fold 1~8 월별 재학습 예측 → 메모리의 구성 OOS."""
    slot, name, model, kind, cw, start, feats, params = a
    tp, obj = slot.split("_")
    t0 = time.time()
    ds = load_data(tp)
    ds = ds[(ds.index <= LAST_BASE)]
    base = ds[ds.index >= pd.Timestamp(start)] if kind == "n" else ds
    rows = []
    tr = purge(base[base.index < INNER0], INNER0)
    iv = purge(ds[(ds.index >= INNER0) & (ds.index < START[1])], START[1])
    m = fit(ds, model, obj, params["1"], feats, cw, tr, iv.index.min())
    rows.append(pd.DataFrame({"date": iv.index, "fold": 0, "pred": predict(m, iv[feats], obj)}))
    for k, (s, e) in enumerate(PERIODS, 1):
        for per in pd.period_range(s, e, freq="M"):
            te = ds[(ds.index >= per.start_time) & (ds.index <= per.end_time)]
            if k < 8:
                te = purge(te, START[k + 1])
            if te.empty:
                continue
            trm = purge(base[base.index < te.index.min()], te.index.min())
            m = fit(ds, model, obj, params[str(k)], feats, cw, trm, te.index.min())
            rows.append(pd.DataFrame({"date": te.index, "fold": k, "pred": predict(m, te[feats], obj)}))
    O = pd.concat(rows, ignore_index=True)
    return f"{slot} {name}: {len(O)}행, {time.time() - t0:.0f}s", (slot, name, O)


# ================================================================== 2b Optuna 튜닝(--tune)
N_TRIALS = {"seq": 15, "one": 12, "default": 30}          # 실험 run_single(experiments/5/test/single_models_td5_20261113)과 같은 설정


def space(name, t):
    """Optuna 탐색 범위(실험 run_single.space 와 같음)."""
    b = name.split("_")[0]
    f, i, c = t.suggest_float, t.suggest_int, t.suggest_categorical
    if b in ("LogisticL1", "LogisticL2"):
        return {"C": f("C", 1e-3, 30, log=True)}
    if b == "RollingLogisticL1":
        return {"C": f("C", 1e-2, 3, log=True), "window": i("window", 250, 1500, step=250)}
    if b == "SVC":
        return {"C": f("C", 1e-3, 3, log=True)}
    if b == "LASSO":
        return {"alpha": f("alpha", 1e-5, 1e-2, log=True)}
    if b == "Ridge":
        return {"alpha": f("alpha", 1e-2, 1e4, log=True)}
    if b == "ElasticNet":
        return {"alpha": f("alpha", 1e-5, 1e-1, log=True), "l1_ratio": f("l1_ratio", 0.05, 0.95)}
    if b in ("RandomForest", "ExtraTrees"):
        d = c("max_depth", [3, 5, 8, 12, 0])
        return {"n_estimators": 400, "max_depth": d or None, "min_samples_leaf": i("min_samples_leaf", 1, 60, log=True),
                "max_features": f("max_features", 0.3, 1.0)}
    if b == "GradientBoosting":
        return {"n_estimators": 1000, "max_depth": i("max_depth", 2, 4), "learning_rate": f("learning_rate", 3e-3, 0.1, log=True)}
    if b == "XGBoost":
        return {"n_estimators": 1000, "max_depth": i("max_depth", 2, 7), "learning_rate": f("learning_rate", 5e-3, 0.1, log=True),
                "min_child_weight": f("min_child_weight", 1, 20, log=True), "colsample_bytree": f("colsample_bytree", 0.5, 1.0)}
    if b == "LightGBM":
        return {"n_estimators": 1000, "num_leaves": i("num_leaves", 4, 63, log=True), "learning_rate": f("learning_rate", 5e-3, 0.1, log=True),
                "min_child_samples": i("min_child_samples", 10, 100, log=True), "colsample_bytree": f("colsample_bytree", 0.5, 1.0),
                "reg_lambda": f("reg_lambda", 1e-3, 10, log=True)}
    if b in SEQ:
        return {"hidden_size": c("hidden_size", [16, 32, 64]), "num_layers": c("num_layers", [1, 2]),
                "lookback": c("lookback", [5, 10, 20, 40]), "lr": f("lr", 3e-4, 3e-3, log=True),
                "dropout": f("dropout", 0.0, 0.3), "epochs": 300}
    raise ValueError(f"Optuna 범위가 없는 모델: {name}")


def n_trials(name):
    b = name.split("_")[0]
    return N_TRIALS["seq"] if b in SEQ else N_TRIALS["one"] if b in ("LogisticL1", "LogisticL2", "SVC", "LASSO", "Ridge") else N_TRIALS["default"]


def tune_job(a):
    """구성 모델 하나: 구간 k(1~8 = 평가 구간, 9 = 운영 학습본)마다 그 구간 첫 기준일 앞 12개월(inner)에서 Optuna TPE(seed 42)로 파라미터를 고른다.
    학습 = inner 앞 자료(정답 겹침 purge, 뉴스 모델은 train_start 부터), 목표 = MCC(0.5)·MAE 개선율, 직전 구간 최적값을 첫 시도로. → tune/<슬롯>__<구성>.json"""
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    slot, name, model, kind, cw, start, feats = a
    tp, obj = slot.split("_")
    t0 = time.time()
    done = {}                                                            # 중간 결과 파일 없음(한 번 실행 안에서 끝냄)
    ds = load_data(tp)
    ds = ds[ds.index <= LAST_BASE]
    base = ds[ds.index >= pd.Timestamp(start)] if kind == "n" else ds
    firsts = {**START, 9: FIRST_PRED}
    warm = None
    for k in range(1, 10):
        s_ = firsts[k]
        i0 = s_ - pd.DateOffset(years=1)
        tr = purge(base[base.index < i0], i0)
        iv = purge(ds[(ds.index >= i0) & (ds.index < s_)], s_)
        y = iv["y_direction" if obj == "cls" else "y_return"].to_numpy(float)
        got = {}

        def objective(t):
            p = space(model, t)
            try:
                pr = predict(fit(ds, model, obj, p, feats, cw, tr, iv.index.min()), iv[feats], obj)
            except Exception as e:                               # 실패 시도는 기록만
                t.set_user_attr("error", repr(e)[:200])
                return float("nan")
            got[t.number] = p
            return sc(obj, y, pr)

        st = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=42, multivariate=True))
        if warm:
            st.enqueue_trial(warm, skip_if_exists=True)
        st.optimize(objective, n_trials=n_trials(model), n_jobs=1)
        ok = [t for t in st.trials if t.value is not None and not np.isnan(t.value)]
        if not ok:
            raise RuntimeError(f"{slot} {name} 구간 {k}: Optuna 시도가 모두 실패")
        best = max(ok, key=lambda t: t.value)
        warm = best.params
        done[str(k)] = {"params": got[best.number], "search_params": best.params, "inner_best": float(best.value),
                        "inner": [str(iv.index.min().date()), str(iv.index.max().date())], "n_train": len(tr), "n_trials": len(st.trials)}
    return f"{slot} {name}: 튜닝 {time.time() - t0:.0f}s", (slot, name, done)


def tune_all(comps, F, workers, variant):
    """모든 구성 모델 Optuna → config/<판>_params.json({슬롯: {구성: {"1".."9": 파라미터}}}, 코드와 함께 배포하는 첫 파라미터 — 개발 PC 에서 만든다)."""
    jobs = [(r.slot, r.component, r.model, r.kind, bool(r.cw), r.train_start, F[(r.slot, r.component)]) for r in comps.itertuples()]
    slow = {"RandomForest": 9, "GRU": 8, "GradientBoosting": 7, "ExtraTrees": 6, "XGBoost": 5}
    order = sorted(jobs, key=lambda j: -slow.get(j[2].split("_")[0], 0))   # 오래 걸리는 모델부터
    out = {}
    with pool(workers) as ex:
        for fu in as_completed([ex.submit(tune_job, j) for j in order]):
            msg, (slot, name, t) = fu.result()
            print(msg, flush=True)
            out.setdefault(slot, {})[name] = {k: v["params"] for k, v in sorted(t.items(), key=lambda kv: int(kv[0]))}
    (CFG / f"{PARAMS_OF[variant]}_params.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    return out


# ================================================================== 3 결합
def sc(obj, y, p):
    from kp.metrics import mae_skill, mcc_fast
    return mcc_fast(y, p >= 0.5) if obj == "cls" else mae_skill(y, p)


def lg(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def best_w(obj, y, b, n):
    s = np.array([sc(obj, y, w * b + (1 - w) * n) for w in WGRID])
    return float(WGRID[np.flatnonzero(np.isclose(s, np.nanmax(s)))[-1]]) if np.isfinite(s).any() else 1.0


def oos(slot, name):
    return oos_read(slot, name)


def mean_of(slot, names):
    P = pd.concat([oos(slot, n).pred.rename(n) for n in names], axis=1)
    f = oos(slot, names[0]).fold
    return P.mean(axis=1), f


def kw_conditions(tp, D, kw):
    """키워드 급증 조건 행렬(기준일 x 규칙, 0/1) — 어휘 단어 전부 + 상위 n_pair 단어 쌍, 창 1·5·20, 직전 250일 평균 + z 표준편차."""
    import scipy.sparse as sp
    import wk_news
    vocab = json.loads(wk_news.VOCAB.read_text(encoding="utf-8"))
    col = {w: i for i, w in enumerate(vocab)}
    idx = D.index
    lo, hi = wk_news.windows(tp, idx, pd.Timestamp(D.prediction_at.iloc[-1]))
    T = wk_news.tokens(idx[0].year, idx[-1].year, refresh=False)                 # 자료 만들 때 받은 기사만(DB 다시 읽지 않음)
    ind = [[col[w] for w in s.split() if w in col] for s in T.toks]
    A = sp.csr_matrix((np.ones(sum(map(len, ind)), np.float32), np.concatenate([np.array(i, int) for i in ind] + [np.array([], int)]),
                       np.r_[0, np.cumsum(list(map(len, ind)))]), shape=(len(T), len(vocab)))
    t = T.t_ns.to_numpy()
    day = np.searchsorted(hi, t, "right")
    ok = (t >= lo[0]) & (day < len(idx))
    M = sp.csr_matrix((np.ones(ok.sum(), np.float32), (day[ok], np.flatnonzero(ok))), shape=(len(idx), len(T)))
    n = pd.Series(np.asarray(M.sum(axis=1)).ravel(), index=idx)
    single = pd.DataFrame((M @ A).toarray(), index=idx, columns=vocab)
    npair = kw["n_pair"]
    At = A[:, :npair].tocsr()
    iu = np.triu_indices(npair, 1)
    pair = np.zeros((len(idx), len(iu[0])), np.float32)
    for i in range(len(idx)):
        r = M.indices[M.indptr[i]:M.indptr[i + 1]]
        if len(r):
            pair[i] = (At[r].T @ At[r]).toarray()[iu]
    pair = pd.DataFrame(pair, index=idx, columns=[f"{vocab[a]}+{vocab[b]}" for a, b in zip(*iu)])
    conds, names = [], []
    for k in kw["windows"]:
        nk = wk_news.roll_k(n.to_frame("n"), k)["n"].clip(lower=1)
        for Xc in (single, pair):
            for j in range(0, Xc.shape[1], 2000):
                blk = wk_news.roll_k(Xc.iloc[:, j:j + 2000], k).div(nk, axis=0)
                conds.append(sp.csr_matrix(wk_news.spike(blk, z=kw["cond_z"]).to_numpy()))
                names += [f"w{k}:{c}" for c in blk.columns]
    return sp.hstack(conds).tocsr(), names


def kw_select(C, names, D, cutoff, kw):
    """정답일 < cutoff, 기준일 ≥ train_start 행으로 규칙별 (켜진 날, 효과, z) → |z| ≥ z_min·켜진 날 ≥ min_on 중 |z| 큰 순 top 개(축소한 효과)."""
    td = pd.DatetimeIndex(D.target_dd)
    rows = np.where((td < cutoff) & (D.index >= pd.Timestamp(kw["train_start"])))[0]
    yv = D.y_return.to_numpy(float)[rows]
    Ch = C[rows]
    n_on = np.asarray(Ch.sum(axis=0)).ravel()
    with np.errstate(divide="ignore", invalid="ignore"):
        eff = np.asarray(Ch.T @ yv).ravel() / n_on - yv.mean()
        z = eff / (yv.std() / np.sqrt(np.maximum(n_on, 1) / 5.0))
    eff, z = np.nan_to_num(eff), np.where(np.isfinite(z), z, 0.0)
    ok = (n_on >= kw["min_on"]) & (np.abs(z) >= kw["z_min"])
    if kw["side"] == "down":
        ok &= eff < 0
    g = np.flatnonzero(ok)
    g = g[np.argsort(-np.abs(z[g]))][:kw["top"]]
    e = eff[g] * (n_on[g] / (n_on[g] + kw["shrink"]) if kw["shrink"] else 1.0)
    return g, e, pd.DataFrame({"rule": [names[j] for j in g], "days_on": n_on[g], "effect": eff[g], "effect_shrunk": e, "z": z[g]})


def combine_fold(slot, cb, D, kw_mat=None):
    """결합 예측(평가 행: fold 1~8) — fold 마다 그 fold 시작 전에 정답이 난 이력(inner + 앞 fold 예측)으로 규칙 값을 정한다."""
    tp, obj = slot.split("_")
    k_ = cb["kind"]
    if k_ == "mean_groups":
        parts = []
        for g in cb["groups"]:
            parts.append(pd.concat([mean_of(slot, item)[0] for item in g], axis=1).mean(axis=1))
        p = pd.concat(parts, axis=1).mean(axis=1)
        return p, oos(slot, cb["groups"][0][0][0]).fold
    b, f = mean_of(slot, cb["struct"])
    n, _ = mean_of(slot, cb["news"])
    n = n.reindex(b.index)
    if k_ == "logit":
        return pd.Series(np.clip(1 / (1 + np.exp(-(cb["w"] * lg(b) + (1 - cb["w"]) * lg(n)))), EPS, 1 - EPS), index=b.index), f
    td = pd.DatetimeIndex(D.target_dd.reindex(b.index))
    yy = D.y_return.reindex(b.index).to_numpy(float)
    out = pd.Series(np.nan, index=b.index)
    months = b.index.to_period("M")
    windows = [(START[k], (f == k).to_numpy()) for k in range(1, 9)]
    windows += [(month.start_time, (f == 9).to_numpy() & (months == month)) for month in months[f == 9].unique()]
    for cutoff, e in windows:
        if not e.any():
            continue
        m = (td < cutoff) & np.isfinite(yy) & b.notna().to_numpy() & n.notna().to_numpy()
        if not m.any():
            continue
        if k_ == "gate":
            on = np.abs(n[e]) >= np.quantile(np.abs(n[m]), cb["gate_q"])
            out[e] = np.where(on, 0.5 * b[e] + 0.5 * n[e], b[e])
        elif k_ == "regime_conf":
            hv, ev = np.abs(b[m].to_numpy()), np.abs(b[e].to_numpy())
            med = np.nanmedian(hv)
            pe = np.empty(e.sum())
            for hi in (False, True):
                hh, he = (hv > med) == hi, (ev > med) == hi
                w = best_w(obj, yy[m][hh], b[m].to_numpy()[hh], n[m].to_numpy()[hh]) if hh.sum() >= cb["min_cell"] else \
                    best_w(obj, yy[m], b[m].to_numpy(), n[m].to_numpy())
                pe[he] = w * b[e].to_numpy()[he] + (1 - w) * n[e].to_numpy()[he]
            out[e] = pe
    if cb.get("kw"):
        C, names = kw_mat
        pos = D.index.get_indexer(out.index)
        for cutoff, e in windows:
            if not e.any():
                continue
            g, eff, tab = kw_select(C, names, D, cutoff, cb["kw"])
            if not len(g):
                continue
            Am = C[pos[e]][:, g].toarray()
            na = Am.sum(axis=1)
            out[e] = out[e].to_numpy() + cb["kw"]["lam"] * np.divide(Am @ eff, na, out=np.zeros(e.sum()), where=na > 0)
    return out, f


def evaluate(obj, y, fold, p):
    from kp.metrics import mae_skill, mcc_fast
    res = {}
    for k in range(1, 9):
        mk = fold == k
        if obj == "cls":
            lab = p[mk] >= 0.5
            res[k] = (mcc_fast(y[mk], lab), float((lab == (y[mk] == 1)).mean()))
        else:
            res[k] = (mae_skill(y[mk], p[mk]), np.nan)
    return {"dev": float(np.mean([res[k][0] for k in range(1, 8)])), "hold": res[8][0],
            "dev_acc": float(np.mean([res[k][1] for k in range(1, 8)])), "hold_acc": res[8][1]}


# ================================================================== 5 학습본
def struct_fallback(slot, cb, comps_kind):
    """뉴스 없이 쓸 정형만 결합(같은 학습된 정형 구성 모델 재사용): W0 방향은 정형 재료(앙상블은 구성원 먼저 평균) 평균, 그 밖은 정형 구성 모델 평균."""
    if cb["kind"] == "mean_groups":
        items = []
        for g in cb["groups"]:
            for it in g:
                if all(comps_kind[c] == "s" for c in it) and it not in items:
                    items.append(it)
        return {"kind": "mean_groups", "groups": [items]}
    return {"kind": "mean_groups", "groups": [[[c] for c in cb["struct"]]]}


def build_models(comps, F, params, comb, first_pred=FIRST_PRED, slots=None, variant="v3",
                 *, target_month=None, feature_start=None):
    """정답일 < first_pred 인 행 전부로 구성 모델을 다시 학습하고, 결합 값은 같은 조건의 OOS 이력으로 정한다.
    반환 {슬롯: 학습본 dict}. 학습본에는 뉴스 장애 때 쓸 정형만 모델(fallback)도 같은 객체로 함께 넣는다."""
    import wk_composite
    first_pred = pd.Timestamp(first_pred)
    stamp = pd.Timestamp.now(tz="UTC").strftime("%Y%m%d%H%M%S%f")
    month = target_month or first_pred.strftime("%Y%m")
    feature_start = first_pred if feature_start is None else pd.Timestamp(feature_start)
    model_version = f"{variant}_{month}_{stamp}"
    made = {}
    for slot, g in comps.groupby("slot", sort=False):
        if slots and slot not in slots:
            continue
        tp, obj = slot.split("_")
        ds = load_data(tp)
        cs = {}
        for r in g.itertuples():
            base = ds[ds.index >= pd.Timestamp(r.train_start)] if r.kind == "n" else ds
            tr = purge(base[base.index < first_pred], first_pred)
            tr = tr[tr.target_dd.notna()]
            m = fit(ds, r.model, obj, last(params[slot][r.component]), F[(slot, r.component)], bool(r.cw), tr, feature_start)
            cs[r.component] = {"model": m, "features": F[(slot, r.component)], "kind": r.kind, "train_end": str(tr.index.max().date()), "n_train": len(tr)}
        cb = dict(comb[slot])
        hist = None
        if cb["kind"] in ("gate", "regime_conf"):
            b, _ = mean_of(slot, cb["struct"])
            n, _ = mean_of(slot, cb["news"])
            n = n.reindex(b.index)
            m = (pd.DatetimeIndex(ds.target_dd.reindex(b.index)) < first_pred) & b.notna().to_numpy() & n.notna().to_numpy()
            if cb["kind"] == "gate":
                cb["thr"] = float(np.quantile(np.abs(n[m]), cb["gate_q"]))
            else:
                yy = ds.y_return.reindex(b.index).to_numpy(float)
                hv = np.abs(b[m].to_numpy())
                med = float(np.nanmedian(hv))
                ws = {}
                for hi in (False, True):
                    hh = (hv > med) == hi
                    ws[hi] = best_w(obj, yy[m][hh], b[m].to_numpy()[hh], n[m].to_numpy()[hh]) if hh.sum() >= cb["min_cell"] else \
                        best_w(obj, yy[m], b[m].to_numpy(), n[m].to_numpy())
                cb.update(med=med, w_lo=ws[False], w_hi=ws[True])
                if cb.get("kw"):
                    D = ds[ds.index < first_pred]
                    C, names = kw_conditions(tp, D, cb["kw"])
                    gsel, eff, tab = kw_select(C, names, D, first_pred, cb["kw"])
                    cb["kw"] = {"rules": [[f"KWR_{r}", float(e)] for r, e in zip(tab.rule, tab.effect_shrunk)], "lam": cb["kw"]["lam"]}
                    hist = tab
        seq = any(hasattr(c["model"], "history_") for c in cs.values())
        since = str(feature_start.date()) if seq else None
        model = wk_composite.make(slot, obj, {k: {x: v[x] for x in ("model", "features", "kind")} for k, v in cs.items()},
                                  {k: v for k, v in cb.items() if k not in ("gate_q", "min_cell")}, needs_rows_from=since)
        fb_cb = struct_fallback(slot, comb[slot], {k: v["kind"] for k, v in cs.items()})
        fb_names = set(used(fb_cb))
        fb = wk_composite.make(slot, obj, {k: {x: v[x] for x in ("model", "features", "kind")} for k, v in cs.items() if k in fb_names}, fb_cb,
                               needs_rows_from=since if any(hasattr(cs[c]["model"], "history_") for c in fb_names) else None)
        import copy
        made[slot] = {"model": model, "features": model.features, "trained_for": month, "model_version": model_version, "variant": variant,
                      "training_config": copy.deepcopy({"components": g.to_dict("records"),          # 이 학습본을 다시 만드는 정의(재학습·되돌리기·챌린저, 2026-11-25)
                                                        "features": {r.component: F[(slot, r.component)] for r in g.itertuples()},
                                                        "params": {r.component: params[slot][r.component] for r in g.itertuples()},
                                                        "combine": comb[slot]}),
                      "training_definition": {"combine": comb[slot], "features": {r.component: F[(slot, r.component)]
                                              for r in comps.itertuples() if r.slot == slot}},
                      "train_end": max(c["train_end"] for c in cs.values()),
                      "components": {k: {"train_end": v["train_end"], "n_train": v["n_train"], "kind": v["kind"]} for k, v in cs.items()},
                      "fallback": {"model": fb, "features": fb.features, "model_version": model_version + "_struct"},
                      "note": f"KOSPI 영업일 +5일 예측 1차 모델({variant}). service_5/wk_train.py 로 DB 자료로 학습(정답일 < {first_pred.date()}), 결합 값은 같은 이력으로 고정. "
                              "fallback = 뉴스 변수를 쓸 수 없는 날 쓰는 정형만 모델(같은 학습된 정형 구성 모델)."}
        print(f"{slot}: 학습본 변수 {len(model.features)}개(정형만 {len(fb.features)}개), 결합 "
              f"{json.dumps({k: v for k, v in model.combine.items() if k not in ('kw', 'groups')}, ensure_ascii=False)}"
              + (f", 키워드 규칙 {len(hist)}개" if hist is not None else ""), flush=True)
    return made


def save_champions(made):
    """DB 학습본 테이블에 champion 으로 저장(기존 챔피언은 retired)."""
    import wk_models
    import wk_range
    import wk_store
    for tp in {slot[:2] for slot in made}:
        wk_range.verify_oos(tp, *(wk_models.range_oos(f"{tp}_{obj}", made[f"{tp}_{obj}"]) for obj in ("cls", "reg")))
    with wk_store.engine()[0].begin() as con:
        for slot, m in made.items():
            wk_models.save_component_oos(slot, m, con=con)
            print("saved", wk_models.save(slot, "champion", m, con=con), flush=True)


def attach_oos(made, variant, components):
    """현재 학습 실행의 예측으로 처음 배포할 학습본을 준비한다."""
    stamp = pd.Timestamp.now(tz="UTC").strftime("%Y%m%d%H%M%S%f")
    for slot, m in made.items():
        m["model_version"] = f"{m['trained_for']}_{stamp}"
        if m.get("fallback"):
            m["fallback"]["model_version"] = m["model_version"] + "_struct"
        set_model_oos(slot, m, oos_read(slot, "combined", line=variant).pred, variant, components)


def set_model_oos(slot, m, history, variant, components):
    import wk_models
    m["range_oos"] = history
    wk_models.range_oos(slot, m)
    m["component_oos"] = {r.component: oos_read(slot, r.component).pred           # 이번 재학습 line(tag(), 운영 v3·챌린저 v3_challenger)
                          for r in components.itertuples() if r.slot == slot}


def final_models(comps, F, params, comb, write, variant="v3"):
    made = build_models(comps, F, params, comb, FIRST_PRED, variant=variant)
    attach_oos(made, variant, comps)
    if write:
        save_champions(made)
    return made


# ================================================================== 6 월간 재학습
def extend_oos(comps, F, params, tp, until, *, pending):
    """구성 모델의 마지막 예측 이후부터 until 앞까지 월별 학습 밖 예측을 이어 붙인다.
    결합 규칙 값(gate·regime·키워드)이 실험과 같은 방식으로 최신 이력을 쓰게 한다."""
    ds = load_data(tp)
    until = pd.Timestamp(until)
    for r in comps[comps.slot.str.startswith(tp)].itertuples():
        O = oos_read(r.slot, r.component)
        if O.empty:
            raise RuntimeError(f"{r.slot} {r.component}: {OOS} 에 OOS 이력이 없습니다(첫 학습 결과를 먼저 올리세요).")
        last_base = pd.Timestamp(O.index.max())
        tp_, obj = r.slot.split("_")
        base = ds[ds.index >= pd.Timestamp(r.train_start)] if r.kind == "n" else ds
        add = []
        for per in pd.period_range(last_base + pd.Timedelta(days=1), until - pd.Timedelta(days=1), freq="M"):
            month_rows = ds[(ds.index >= per.start_time) & (ds.index <= per.end_time) & (ds.index < until)]
            if month_rows.empty or month_rows.index.max() <= last_base:
                continue
            te = month_rows
            if te.empty:
                continue
            trm = purge(base[base.index < te.index.min()], te.index.min())
            m = fit(ds, r.model, obj, last(params[r.slot][r.component]), F[(r.slot, r.component)], bool(r.cw), trm, te.index.min())
            result = pd.DataFrame({"date": te.index, "pred": predict(m, te[F[(r.slot, r.component)]], obj)})
            add.append(result[result.date > last_base])
        if add:
            A = pd.concat(add, ignore_index=True)
            pending.append((r.slot, r.component, A.date, A.pred, tag(), f"retrain_{pd.Timestamp(until):%Y%m}"))
            _OOS_ADD[(r.slot, r.component, tag())] = A.set_index("date").pred   # --write 없는 시험도 이번 실행 안에서는 이어 붙인 이력을 쓴다
            print(f"{r.slot} {r.component}: OOS {len(A)}일 이어 붙임(~{A.date.max():%Y-%m-%d})", flush=True)


RETUNE_MONTHS = (1, 4, 7, 10)                              # 분기 파라미터 재탐색 달(일별 grid_schedule 과 같은 달, 사용자 결정 2026-11-23)
FIXED_MODELS = {"LightGBMHuber_reg"}                       # 분기 재탐색에서 빼는 파라미터 고정 모델(v3 W0 수익률, 실험 robust_objectives_20261124 값)
RETUNE_CHECK_MONTHS = 3                                    # 채택 확인 = 직전 3개월 학습 밖 월별 재학습 예측


def _warm(p: dict) -> dict:
    """학습본 파라미터 → Optuna 탐색 이름(max_depth None ↔ 0)."""
    return {k: (0 if k == "max_depth" and v is None else v) for k, v in p.items()}


def _months_oos(ds, base, model, obj, params, feats, cw, months):
    """months(Period 목록)마다 그달 첫날 전 정답만으로 학습 → 그달 예측(extend_oos 와 같은 월별 재학습). 반환 Series(date → 예측)."""
    out = []
    for per in months:
        te = ds[(ds.index >= per.start_time) & (ds.index <= per.end_time)]
        if te.empty:
            continue
        trm = purge(base[base.index < te.index.min()], te.index.min())
        m = fit(ds, model, obj, params, feats, cw, trm, te.index.min())
        out.append(pd.Series(predict(m, te[feats], obj), index=te.index))
    return pd.concat(out) if out else pd.Series(dtype=float)


def quarterly_retune(tp: str, first_pred, write: bool, variant="v3", cfg=None) -> list:
    """분기 파라미터 재탐색(1·4·7·10월 재학습 때) — 구성 모델마다 tune_job 과 같은 방법(Optuna TPE seed 42 multivariate, 같은 탐색 범위·시도 수,
    점수 = MCC(0.5)·MAE 개선율, inner = first_pred 앞 12개월, 학습 = inner 앞 자료 purge, 뉴스 모델은 train_start 부터, 현재 파라미터를 첫 시도로)으로 고르고,
    채택 = ① inner 점수가 현재 파라미터보다 높고 ② 직전 3개월 학습 밖 월별 재학습 예측 점수가 현재(운영 OOS 이력)보다 낮지 않을 때만(사용자 결정 2026-11-23).
    채택한 값은 kospi5_mlops_role_history(action retune_adopt, decision.params)에 남기고 config() 가 새 구간 키로 겹쳐 읽는다(last() 가 그 값을 씀)."""
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    first_pred = pd.Timestamp(first_pred)
    comps, F, params, _ = cfg or config(variant)
    ds = purge(load_data(tp), first_pred)
    i0 = first_pred - pd.DateOffset(years=1)
    months = list(pd.period_range(first_pred - pd.DateOffset(months=RETUNE_CHECK_MONTHS), first_pred - pd.Timedelta(days=1), freq="M"))
    rows = []
    for r in comps[comps.slot.str.startswith(tp)].itertuples():
        slot, name, obj = r.slot, r.component, r.slot.split("_")[1]
        if r.model in FIXED_MODELS:                                     # 파라미터 고정 모델(실험에서 정한 값, 탐색 범위 없음)
            continue
        feats, cw = F[(slot, name)], bool(r.cw)
        cur = last(params[slot][name])
        keep = {"n_seeds": cur["n_seeds"]} if "n_seeds" in cur else {}  # 시드 묶음은 같은 시드 수로 탐색(현재 값과 같은 조건 비교)
        base = ds[ds.index >= pd.Timestamp(r.train_start)] if r.kind == "n" else ds
        tr = purge(base[base.index < i0], i0)
        iv = purge(ds[(ds.index >= i0) & (ds.index < first_pred)], first_pred)
        y = iv["y_direction" if obj == "cls" else "y_return"].to_numpy(float)
        cur_inner = sc(obj, y, predict(fit(ds, r.model, obj, cur, feats, cw, tr, iv.index.min()), iv[feats], obj))
        got = {}

        def objective(t):
            p = {**space(r.model, t), **keep}
            try:
                pr = predict(fit(ds, r.model, obj, p, feats, cw, tr, iv.index.min()), iv[feats], obj)
            except Exception as e:
                t.set_user_attr("error", repr(e)[:200])
                return float("nan")
            got[t.number] = p
            return sc(obj, y, pr)
        st = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=42, multivariate=True))
        st.enqueue_trial(_warm({k: v for k, v in cur.items() if k != "n_seeds"}), skip_if_exists=True)
        st.optimize(objective, n_trials=n_trials(r.model), n_jobs=1)
        ok_t = [t for t in st.trials if t.value is not None and not np.isnan(t.value)]
        best = max(ok_t, key=lambda t: t.value) if ok_t else None
        row = {"slot": slot, "component": name, "params_tag": tag(), "inner": f"{iv.index.min().date()}~{iv.index.max().date()}", "cur_inner": cur_inner,
               "new_inner": float(best.value) if best else np.nan, "adopted": False}
        if best and best.value > cur_inner + 1e-9:
            new = got[best.number]
            h = oos(slot, name).pred                                         # 현재 파라미터의 운영 OOS 이력(월별 재학습, 학습 밖)
            pn = _months_oos(ds, base, r.model, obj, new, feats, cw, months)
            pc = h.reindex(pn.index).dropna()
            yy = ds["y_direction" if obj == "cls" else "y_return"].reindex(pc.index).to_numpy(float)
            ok = ~np.isnan(yy)
            row.update(cur_recent=sc(obj, yy[ok], pc.to_numpy(float)[ok]) if ok.sum() else np.nan,
                       new_recent=sc(obj, yy[ok], pn.reindex(pc.index).to_numpy(float)[ok]) if ok.sum() else np.nan, recent_days=int(ok.sum()))
            if ok.sum() and row["new_recent"] >= row["cur_recent"]:
                row["adopted"] = True
                row["params"] = new
                params[slot][name][str(max(int(k) for k in params[slot][name]) + 1)] = new
        rows.append(row)
        print(f"{slot} {name}: inner {row['cur_inner']:.4f} → {row['new_inner']:.4f}"
              + (f", 직전 {RETUNE_CHECK_MONTHS}개월 {row.get('cur_recent', np.nan):.4f} → {row.get('new_recent', np.nan):.4f}" if "cur_recent" in row else "")
              + f" → {'채택' if row['adopted'] else '유지'}", flush=True)
    if write:
        import wk_store
        with wk_store.engine()[0].begin() as con:
            save_retune(rows, first_pred, variant, con)
    return rows


def save_retune(rows, first_pred, variant, con):
    import wk_store
    first_pred = pd.Timestamp(first_pred)
    for x in rows:
        wk_store.log_promotion(x["slot"], "retune_adopt" if x["adopted"] else "retune_keep", None, None,
                                   detail=f"분기 재탐색 {first_pred:%Y%m} {x['component']}",
                                   decision={"current_score": f"{x['cur_inner']:.4f}", "new_score": f"{x['new_inner']:.4f}", "component": x["component"], "params_tag": x.get("params_tag", PARAMS_OF[variant]), "params": x.get("params"),
                                             **{k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in x.items() if k != "params"}}, con=con)


def retrain(tp: str, first_pred, write: bool, *, target_month=None, feature_start=None, lines=None) -> tuple:
    """대상월에 사용할 v3를 확정된 정답과 현재 OOS 이력으로 다시 학습한다.
    lines = {OOS line: {슬롯: 지금 학습본}} — 역할마다(운영 v3·챌린저 v3_challenger) 그 학습본의 학습 정의와 구성 OOS 이력으로 따로 학습한다.
    None 이면 설정 파일 정의로 운영 line 만. 반환 ({line: {슬롯: 새 학습본}}, 이어 붙일 OOS, 분기 재탐색 행)."""
    first_pred = pd.Timestamp(first_pred)
    month = target_month or first_pred.strftime("%Y%m")
    feature_start = first_pred if feature_start is None else pd.Timestamp(feature_start)
    _DS.pop(tp, None)
    _OOS_ADD.clear()
    _OOS_REPLACED.clear()
    build_data(tp, write=write)
    out, pending, retuned = {}, [], []
    try:
        for line, bundles in (lines or {"v3": None}).items():
            os.environ["KOSPI5_TRAIN_TAG"] = line                    # 이 line 의 구성 OOS 를 읽고 이어 쓴다
            cfg = config_of(bundles) if bundles else config()
            comps, features, params, combine = cfg
            comps = comps[comps.slot.str.startswith(tp)].reset_index(drop=True)
            cfg = (comps, features, params, combine)
            extend_oos(comps, features, params, tp, feature_start, pending=pending)
            rt = quarterly_retune(tp, first_pred, False, cfg=cfg) if int(month[-2:]) in RETUNE_MONTHS else []
            for row in rt:
                if row["adopted"]:
                    values = params[row["slot"]][row["component"]]
                    values[str(max(map(int, values)) + 1)] = row["params"]
            retuned += rt
            models = build_models(comps, features, params, combine, first_pred, slots=list(comps.slot.unique()),
                                  target_month=month, feature_start=feature_start)
            D = load_data(tp).loc[lambda d: d.index < first_pred]
            for slot, model in models.items():
                rule = combine[slot]
                kw_mat = kw_conditions(tp, D, rule["kw"]) if rule.get("kw") else None
                p, folds = combine_fold(slot, rule, D, kw_mat)
                history = p[(folds.reindex(p.index) >= 1) & (p.index < feature_start)].dropna()
                set_model_oos(slot, model, history, "v3", comps)
            out[line] = models
    finally:
        set_variant("v3")
    return out, pending, retuned


# ================================================================== 실행
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--skip-components", action="store_true", help="구성 모델 예측이 DB(kospi5_mlops_oos)에 있으면 다시 학습하지 않는다(결합·대조·학습본부터)")
    ap.add_argument("--write", action="store_true", help="OOS·학습본을 DB 저장소에 쓴다(없으면 출력만)")
    ap.add_argument("--variant", choices=("v3",), default="v3", help="운영 모델 v3")
    ap.add_argument("--tune", action="store_true", help="구성 모델 파라미터를 Optuna 로 고른다(v3_params.json을 만듦)")
    ap.add_argument("--export-joblib", type=Path, help="범위 OOS를 포함한 학습본을 이 폴더에 내보냅니다")
    a = ap.parse_args()
    if a.export_joblib and a.skip_components:
        ap.error("새 학습본을 내보낼 때는 변경된 정의로 구성 OOS를 다시 계산해야 합니다.")
    sys.path.insert(0, str(HERE))
    set_variant(a.variant)
    comps, F, params, comb = config(a.variant)
    t0 = time.time()
    import extract_db
    extract_db.main()
    print(f"DB 원천 받기 {time.time() - t0:.0f}s", flush=True)
    for tp in ("W0", "W2"):
        D = build_data(tp)
        print(f"{tp} 자료 {D.shape}, 기준일 {D.index.min().date()}~{D.index.max().date()}, {time.time() - t0:.0f}s", flush=True)
    if a.tune:
        tune_all(comps, F, a.workers, a.variant)
        comps, F, params, comb = config(a.variant)
        print(f"튜닝 끝 {time.time() - t0:.0f}s", flush=True)
    jobs = [(r.slot, r.component, r.model, r.kind, bool(r.cw), r.train_start, F[(r.slot, r.component)], params[r.slot][r.component])
            for r in comps.itertuples()]
    if a.skip_components and all(len(oos_read(j[0], j[1])) for j in jobs):
        print("구성 모델 예측은 이미 DB 에 있음 — 다시 학습하지 않음", flush=True)
    else:
        with pool(a.workers) as ex:
            for fu in as_completed([ex.submit(comp_job, j) for j in jobs]):
                msg, (slot, name, O) = fu.result()
                print(msg, flush=True)
                key = (slot, name, tag())
                _OOS_ADD[key] = O.set_index("date").pred
                _OOS_REPLACED.add(key)
    print(f"구성 모델 학습 끝 {time.time() - t0:.0f}s", flush=True)
    rows = []
    for slot in comps.slot.unique():
        tp, obj = slot.split("_")
        D = load_data(tp)
        D = D[D.index <= LAST_BASE]
        kw_mat = kw_conditions(tp, D, comb[slot]["kw"]) if comb[slot].get("kw") else None
        p, f = combine_fold(slot, comb[slot], D, kw_mat)
        y = D.y_direction.reindex(p.index) if obj == "cls" else D.y_return.reindex(p.index)
        ev = f >= 1
        key = (slot, "combined", a.variant)
        _OOS_ADD[key] = p[ev]
        _OOS_REPLACED.add(key)
        r = evaluate(obj, y[ev].to_numpy(float), f[ev].to_numpy(), p[ev].to_numpy(float))
        rows.append({"slot": slot, **r})
    S = pd.DataFrame(rows)
    with pd.option_context("display.width", 200, "display.float_format", "{:.4f}".format):
        print(S.to_string(index=False))
    k1_scores()
    made = final_models(comps, F, params, comb, a.write, a.variant)
    if a.export_joblib:
        export_joblibs(made, a.export_joblib)
    print(f"끝 {time.time() - t0:.0f}s", flush=True)


def export_joblibs(made, dest):
    import joblib
    for slot, m in made.items():
        path = dest / "artifacts" / slot / "champion.joblib"
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(m, path, compress=3)


def fold_scores(obj, y, fold, p):
    from kp.metrics import mae_skill, mcc_fast
    return np.array([mcc_fast(y[fold == k], p[fold == k] >= 0.5) if obj == "cls" else mae_skill(y[fold == k], p[fold == k]) for k in range(1, 9)])


def k1_scores():
    """K1(수익률 = |수익률| × 같은 시점 방향 확률 ≥ 0.5 이면 +, 아니면 −)을 수익률 슬롯마다 결합 예측(DB combined)에 적용한 점수(표준 출력).
    판정 규칙(사용자 기준 2026-11-19): 검증·홀드아웃 MAE 개선율이 둘 다 좋아지면 적용(apply). 실제 적용 여부는 config/v1_postprocess.json."""
    pp = json.loads((CFG / "v1_postprocess.json").read_text(encoding="utf-8")) if (CFG / "v1_postprocess.json").exists() else {}
    rows = []
    for tp in ("W0", "W2"):
        slot, cslot = f"{tp}_reg", f"{tp}_cls"
        R = combined(slot, PARAMS_OF.get(tag(), tag()))
        if R.empty:
            continue
        Cp = oos_read(cslot, "combined", line=PARAMS_OF.get(tag(), tag())).pred.reindex(R.index)
        assert Cp.notna().all(), "방향·수익률 예측 날짜가 다름"
        pk = np.abs(R.pred) * np.where(Cp >= 0.5, 1.0, -1.0)
        f = R.fold.to_numpy()
        r0 = evaluate("reg", R.y.to_numpy(float), f, R.pred.to_numpy(float))
        r1 = evaluate("reg", R.y.to_numpy(float), f, pk.to_numpy(float))
        from kp.metrics import mae_skill
        wins = sum(mae_skill(R.y[f == k], pk[f == k]) > mae_skill(R.y[f == k], R.pred[f == k]) for k in range(1, 8))
        rows.append({"slot": slot, "dev": r0["dev"], "hold": r0["hold"], "dev_k1": r1["dev"], "hold_k1": r1["hold"], "fold_wins": int(wins),
                     "flip_dev": int(((np.sign(pk) != np.sign(R.pred)) & (f <= 7)).sum()), "flip_hold": int(((np.sign(pk) != np.sign(R.pred)) & (f == 8)).sum()),
                     "apply_rule": bool(r1["dev"] > r0["dev"] and r1["hold"] > r0["hold"]), "applied_in_config": bool(pp.get(slot, {}).get("k1"))})
    K = pd.DataFrame(rows)
    if len(K):
        with pd.option_context("display.width", 200, "display.float_format", "{:.4f}".format):
            print(K.to_string(index=False))
    return K


def check_period(start=FIRST_PRED, end=None):
    """DB 챔피언 학습본으로 start 이후 기준일을 예측하고 정답이 난 날로 채점(표준 출력, 파일 없음).
    예측 뒤 처리(config/v1_postprocess.json, K1)를 운영 predict.py 와 같게 적용한다. 새 학습 없음."""
    import wk_data
    import wk_models
    import wk_news
    from kp.metrics import mae_skill, mcc_fast
    pp = json.loads((CFG / "v1_postprocess.json").read_text(encoding="utf-8")) if (CFG / "v1_postprocess.json").exists() else {}
    rows, preds = [], []
    for tp in ("W0", "W2"):
        D = load_data(tp)
        A = wk_data.answers(D.index)
        idx = D.index[(D.index >= pd.Timestamp(start)) & ((D.index <= pd.Timestamp(end)) if end else True)]
        out = {}
        for obj in ("cls", "reg"):
            m = wk_models.load(f"{tp}_{obj}")
            X = D.copy()
            kr = [f for f in m["features"] if f.startswith("KWR_")]
            if kr:                                                  # 키워드 규칙 조건(받아 둔 기사로)
                sub = X.index[-wk_news.LOOKBACK:]
                lo, hi = wk_news.windows(tp, sub, pd.Timestamp(X.prediction_at.iloc[-1]))
                T = wk_news.tokens(sub[0].year, sub[-1].year, refresh=False)
                X = X.join(wk_news.keywords(T, sub, lo, hi, kr)[kr])
            since = getattr(m["model"], "needs_rows_from", None)
            v = []
            for b in idx:
                xin = X.loc[(X.index >= pd.Timestamp(since)) & (X.index <= b)] if since else X.loc[[b]]
                v.append(float(wk_models.predict(m, xin)[-1]))
            out[obj] = np.array(v)
        k1 = pp.get(f"{tp}_reg", {}).get("k1")
        if k1:
            out["reg_raw"] = out["reg"]
            out["reg"] = np.abs(out["reg"]) * np.where(out["cls"] >= k1["threshold"], 1.0, -1.0)
        y = A.reindex(idx)
        ok = y.y_return.notna().to_numpy()
        lab = out["cls"] >= 0.5
        rows.append({"tp": tp, "obj": "cls", "n": int(ok.sum()), "hit": int((lab[ok] == (y.y_direction.to_numpy()[ok] == 1)).sum()),
                     "mcc": mcc_fast(y.y_direction.to_numpy()[ok], lab[ok]), "up_share": float(lab[ok].mean())})
        rows.append({"tp": tp, "obj": "reg", "n": int(ok.sum()), "mae_skill": float(mae_skill(y.y_return.to_numpy()[ok], out["reg"][ok])),
                     "sign_hit": int(((out["reg"][ok] > 0) == (y.y_return.to_numpy()[ok] > 0)).sum()), "k1": bool(k1)})
        preds.append(pd.DataFrame({"tp": tp, "date": idx, "p_cls": out["cls"], "r_reg": out["reg"], "r_reg_raw": out.get("reg_raw", out["reg"]),
                                   "target_dd": y.target_dd.to_numpy(), "y_return": y.y_return.to_numpy()}))
    Cx = pd.DataFrame(rows)
    print(Cx.to_string(index=False))
    return Cx


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock("--write" in sys.argv[1:]):
        main()
