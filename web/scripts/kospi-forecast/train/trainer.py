"""[실사용 모듈] T2 월간 재학습 — 대상월 컷오프로 정형 F0·뉴스 모델·결합기를 다시 적합해 배포 형식 학습본을 만든다.

사용처: train/retrain_t2.py(run_retrain.py --tp T2)
입력: 정형 데이터셋 ds(train/inputs.load_snapshot), 뉴스 일별 변수(DB kospi_mlops_news_daily),
      회귀 OOS 구성요소 예측(DB kospi_mlops_oos), 정형 F0 설정(model/configs/f0_T2.json) — 호출자가 DataFrame 으로 넘긴다
출력: 임시 폴더 mlops/paths.STAGING/<model_version>/{bundle.joblib, manifest.json, background.parquet}
      → 호출자(train/retrain_t2.py)가 mlops/registry.register 로 DB 등록부에 올린다

규칙(model/daily/TRAINING_PROTOCOL.md 3절, model/train_monthly_t2.py 를 옮김):
- 대상월 첫 거래일보다 앞선 거래일만 쓰고 그중 마지막 1일은 gap으로 뺀다.
- 정형 F0: f0_T2.json 의 구성 모델, 남은 전체 과거로 매달 재적합 후 단순 평균. 파라미터는 T0·T1 과 같은 규칙(세 시점 통일, 사용자 결정 2026-11-04):
  격자 달(1·4·7·10월 대상월)에는 train/f0_trainer.fit_member 의 inner 12개월 grid search 로 다시 고르고, 다른 달은 그 계열 직전 학습본의
  structured_params(없으면 f0_T2.json params = 실험 f0_fixed_params 가 검증·홀드아웃으로 고른 첫 파라미터)를 그대로 쓴다. 모델마다 스레드 1개.
- 뉴스 모델: news_start 이후 전체로 매달 재적합(기존 학습본 2017년, DB 전체 기간 확장본 2010년). 파라미터는 격자 달(train/grid_schedule.GRID_MONTHS, 1·4·7·10월 대상월)에만
  학습 구간 끝 40거래일 블록 3개(각 블록 앞 1일 gap)로 다시 고르고, 다른 달은 그 계열 직전 학습본의 selected_spec 을
  그대로 쓴다(사용자 결정 2026-11-04, 호출자가 fixed_specs 로 넘김).
  계열(line) model_1 = 작은 격자(프로토콜 기본, 챔피언 계열), model_2 = 확장 격자(챌린저 계열).
- 방향 = sigmoid(w logit(F0) + (1-w) logit(뉴스 RF)), w = 학습본 fusion(2026-11-09 재선정부터 0.8, 이전 0.7), 수익률 = F0·뉴스 4모델 각각 Ridge(1e-4) X3 스태킹 평균.
- 회귀 학습본에는 후처리 K1(post_rule)을 함께 적는다: 예측 때 수익률 부호를 방향 예측에 맞춘다(학습 없음, 2026-11-03 사용자 결정).
  스태킹은 과거 OOS 예측(그 계열 기록이 없으면 시드)만 쓴다.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.linear_model import Ridge

SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE / "model"), str(SERVICE)]

import estimators as E  # noqa: E402
import paths  # noqa: E402
from features import config as C  # noqa: E402
from t2_model import CLS_COLS, REG_MODELS, FUSION_SERVICE, fuse  # noqa: E402
from select_features import structured_selection  # noqa: E402

from features import timepoints as TPR  # noqa: E402
CP = TPR.checkpoint_id("T2")   # 학습본 안 이름표(시각과 무관, service/time_points.json)
F0_CONFIG = SERVICE / "model" / "configs" / "f0_T2.json"
REG_COLS = ["t1_no_news", "t1_impact", "t1_impact_std", "t1_pos_share", "t1_neg_share", "t1_mix_share", "t1_strength",
            "t1_log_n", "t1_recap_share", "t1_log_recap_n", "t1_impact_kor", "t1_impact_usa", "t1_surprise", "t1_unexpected"]
LINES = {"model_1": "small", "model_2": "big"}
BACKGROUND_SEED = 20261029


def sha256(path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def cutoff_index(index, month: str):
    start = pd.Period(month, freq="M").start_time
    prior = pd.DatetimeIndex(index[index < start]).sort_values()
    if len(prior) < 2:
        raise ValueError(f"{month}: gap 적용 전 거래일이 부족합니다")
    return prior[:-1], prior[-1]


# ---------------------------------------------------------------- 뉴스 모델
def select_spec(X, y, model, obj, size):
    """학습 구간 내부 ts3 x 40일 검증으로 격자 하나를 고른다(model/train_monthly_t2.select_spec)."""
    grid = E.grid_for(model, size=size)
    idx = X.index
    folds = []
    for k in range(3, 0, -1):
        hi = len(idx) - (k - 1) * 40
        lo = hi - 40
        if lo - 1 >= 20:
            folds.append((idx[:lo - 1], idx[lo:hi]))
    if not folds:
        raise ValueError(f"{model}: 내부 검증 표본 부족")
    scores = []
    for spec in grid:
        result = [E.score(obj, y.loc[val].to_numpy(float),
                          E.news_fit_predict(spec, X.loc[fit], y.loc[fit].to_numpy(), X.loc[val], obj)) for fit, val in folds]
        scores.append(float(np.nanmean(result)))
    if np.all(np.isnan(scores)):
        raise ValueError(f"{model}: 내부 검증 점수 없음")
    best = int(np.nanargmax(scores))
    return {**grid[best], "filt": "none"}, {"grid_size": len(grid), "best_inner_score": scores[best],
                                             "inner_scores": scores, "folds": len(folds)}


def fit_news(X, y, spec):
    mu, sd = E.fit_scaler(X)
    est = E.news_estimator(spec["model"], spec["params"], "cls" if spec["model"] == "rf" else "reg")
    est.fit(E.apply_scaler(X, mu, sd).to_numpy(float), y.to_numpy(float))
    return {"estimator": est, "columns": list(X.columns), "mean": mu, "std": sd, "spec": spec}


def predict_news(fitted, X, objective):
    cols = fitted["columns"]
    missing = sorted(set(cols) - set(X.columns))
    if missing:
        raise ValueError(f"뉴스 변수 누락: {missing}")
    A = E.apply_scaler(X[cols], fitted["mean"], fitted["std"]).to_numpy(float)
    est = fitted["estimator"]
    return est.predict_proba(A)[:, 1] if objective == "cls" else np.asarray(est.predict(A), float)


# ---------------------------------------------------------------- 정형 F0
def fit_structured(ds, train_idx, objective, cfg, month=None, grid=False, fixed_params=None):
    """정형 F0 구성 모델 학습. grid=True 면 f0_trainer.fit_member 로 inner 12개월 격자 선택, 아니면 fixed_params(직전 학습본) 또는 cfg params."""
    import f0_trainer as F
    feats = structured_selection(CP, objective, union=True)     # 변수세트 B(세 시점 합집합)
    tr = ds.loc[train_idx].dropna(subset=[C.TARGET[objective]])
    if tr.empty:
        raise ValueError("정형 학습 행 없음")
    y = tr[C.TARGET[objective]].to_numpy(float)
    result, chosen, inner = {}, {}, {}
    for name in cfg["members"]:
        if grid:
            print(f"  정형 {objective}: {name}, {len(tr)}행 - 격자 {len(E.F0_GRID[name])}개(inner 12개월)", flush=True)
            model, best, sc, idx_, _ = F.fit_member(ds, feats, objective, name, month)
            if not idx_.equals(tr.index):
                raise ValueError(f"{name}: 격자 학습 행이 대상월 컷오프와 다릅니다.")
            result[name], chosen[name], inner[name] = model, best, sc
            print(f"    선택 {best} (inner {sc:.4f})", flush=True)
            continue
        p = dict((fixed_params or {}).get(name) or cfg["params"][name])
        print(f"  정형 {objective}: {name}, {len(tr)}행 - 파라미터 고정 {p}", flush=True)
        model = E.fit_model(F._model(name, p), tr[feats], y, name)
        if isinstance(model, E.RollingWindowModel):
            model = model.model_
        result[name], chosen[name] = model, p
    return {"models": result, "columns": feats, "train_start": str(tr.index.min().date()),
            "train_end": str(tr.index.max().date()), "train_rows": len(tr), "params": chosen, "grid": bool(grid), "inner_scores": inner}


def predict_structured(fitted, X, objective):
    cols = fitted["columns"]
    missing = sorted(set(cols) - set(X.columns))
    if missing:
        raise ValueError(f"정형 변수 누락: {missing}")
    return np.mean([E.predict_model(m, X[cols], objective) for m in fitted["models"].values()], axis=0)


# ---------------------------------------------------------------- 결합
def read_oos(oos, line):
    """회귀 구성요소 OOS 예측(component x 날짜). 그 계열 기록이 없는 날은 시드(실험 OOS)로 채운다."""
    df = oos[oos.objective == "reg"].copy()
    if "line" not in df:
        df["line"] = "seed"
    own = df[df.line == line]
    seed = df[df.line == "seed"]
    both = pd.concat([own, seed[~seed.set_index(["component", "target_dd"]).index.isin(
        own.set_index(["component", "target_dd"]).index)]])
    return both.pivot_table(index="target_dd", columns="component", values="yhat", aggfunc="first").sort_index()


def fit_regression_meta(ds, excluded_gap, line, oos):
    wide = read_oos(oos, line)
    y = ds["y_return"]
    fitted, rows = {}, {}
    for name in REG_MODELS:
        hist = pd.concat([wide["F0"], wide[name], y], axis=1, join="inner").dropna()
        hist = hist[hist.index < excluded_gap]
        if len(hist) < 20:
            raise ValueError(f"{name}: OOS 메타 학습 20일 미만")
        if hist.index.max() < excluded_gap - pd.Timedelta(days=14):
            raise ValueError(f"{name}: 최신 OOS 메타 예측이 없습니다 ({hist.index.max().date()}). 직전 달 구성요소 예측을 먼저 이어 붙이세요.")
        fitted[name] = Ridge(alpha=1e-4).fit(hist.iloc[:, :2].to_numpy(float), hist.iloc[:, 2].to_numpy(float))
        rows[name] = {"rows": len(hist), "start": str(hist.index.min().date()), "end": str(hist.index.max().date())}
    return fitted, rows


def predict_parts(bundle, frame):
    """최종 예측과 구성요소 예측(정형 F0, 뉴스 모델별). frame 은 정형+뉴스 열을 모두 가진 표."""
    obj = bundle["objective"]
    parts = {"F0": predict_structured(bundle["structured"], frame, obj)}
    if obj == "cls":
        parts["rf"] = predict_news(bundle["news"]["rf"], frame, obj)
        return fuse(bundle, parts["F0"], parts["rf"]), parts          # 비중은 학습본 fusion 값(t2_model.FUSION_WEIGHTS)
    preds = []
    for name in REG_MODELS:
        parts[name] = predict_news(bundle["news"][name], frame, obj)
        preds.append(bundle["meta"][name].predict(np.c_[parts["F0"], parts[name]]))
    return np.mean(preds, axis=0), parts


def feature_columns(bundle):
    news_cols = list(dict.fromkeys(c for m in bundle["news"].values() for c in m["columns"]))
    return bundle["structured"]["columns"] + [c for c in news_cols if c not in bundle["structured"]["columns"]]


def drift_reference(pool: pd.DataFrame) -> dict:
    """입력 변수별 학습 구간 10분위 경계·비율(PSI 계산용, mlops/monitor.py)."""
    ref = {}
    for c in pool.columns:
        v = pool[c].dropna().to_numpy(float)
        if len(v) < 50:
            continue
        edges = np.unique(np.quantile(v, np.linspace(0, 1, 11))[1:-1])
        counts = np.bincount(np.searchsorted(edges, v, side="right"), minlength=len(edges) + 1)
        ref[c] = {"edges": edges.tolist(), "share": (counts / counts.sum()).tolist()}
    return ref


# ---------------------------------------------------------------- 학습 한 건
def fit_one(month, objective, ds, news, oos=None, line="model_1", pipeline_sha256=None, feature_version=None, fixed_specs=None, fixed_from=None,
            structured_grid=False, structured_fixed=None, news_start="2017-01-01", fusion=None):
    """news: 날짜 x (CLS_COLS + REG_COLS) 일별 뉴스 변수, oos: kospi_mlops_oos 표(회귀만). 반환: 임시 폴더 경로.

    fixed_specs: {뉴스 모델: selected_spec}(직전 학습본 값) — 있는 모델은 격자 없이 그 설정으로 재적합, fixed_from: 그 학습본 model_version.
    structured_grid: 정형 F0 를 격자로 다시 고를지(격자 달), structured_fixed: {구성 모델: params}(직전 학습본 structured_params, 없으면 f0_T2.json).
    news_start: 뉴스 누적 학습 시작(기존 학습본은 2017년, 전체 뉴스 재학습본은 그 학습본의 실제 시작일을 이어 받음).
    fusion: 방향 로짓융합 방식(직전 학습본 manifest fusion 을 이어 받음, 없으면 t2_model.FUSION_SERVICE).
    """
    size = LINES[line]
    conf = json.loads(F0_CONFIG.read_text(encoding="utf-8"))
    idx, excluded = cutoff_index(ds.index, month)
    target = C.TARGET[objective]
    structured = fit_structured(ds, idx, objective, conf["ensembles"][f"{CP}/{objective}"], month, structured_grid, structured_fixed)
    news_idx = idx[(idx >= pd.Timestamp(news_start)) & ds[target].reindex(idx).notna()]
    if len(news_idx.difference(news.index)):
        raise ValueError("뉴스 누적 학습 기간에 일별 입력이 없는 날이 있습니다.")
    if len(news_idx) < 60:
        raise ValueError("뉴스 학습일 60일 미만")
    cols = CLS_COLS if objective == "cls" else REG_COLS
    fitted_news, chosen, tuning = {}, {}, {}
    for name in (["rf"] if objective == "cls" else REG_MODELS):
        X, y = news.loc[news_idx, cols], ds.loc[news_idx, target]
        if fixed_specs and name in fixed_specs:
            spec, info = dict(fixed_specs[name]), {"grid_size": 0, "fixed_from": fixed_from}
            print(f"  뉴스 {objective}: {name}, {len(X)}행, {len(cols)}열 - 직전 파라미터 고정 {spec['params']}", flush=True)
        else:
            print(f"  뉴스 {objective}: {name}, {len(X)}행, {len(cols)}열 - 내부 검증({size} 격자)", flush=True)
            spec, info = select_spec(X, y, name, objective, size)
            print(f"    선택 {spec['params']} (내부 점수 {info['best_inner_score']:.4f})", flush=True)
        fitted_news[name], chosen[name], tuning[name] = fit_news(X, y, spec), spec, info
    meta, meta_rows = fit_regression_meta(ds, excluded, line, oos) if objective == "reg" else ({}, {})
    bundle = {"format_version": 1, "objective": objective, "target_month": month, "checkpoint": CP, "line": line,
              "excluded_gap_date": str(excluded.date()), "structured": structured, "news": fitted_news, "meta": meta,
              "fusion": (fusion or FUSION_SERVICE) if objective == "cls" else "mean_four_x3"}
    if objective == "reg":
        from service_runtime import K1_RULE
        bundle["post_rule"] = dict(K1_RULE)

    stage = paths.STAGING / f"_stage_{objective}_{line}_{month}"
    stage.mkdir(parents=True, exist_ok=True)
    art = stage / "bundle.joblib"
    joblib.dump(bundle, art, compress=3)
    loaded = joblib.load(art)
    fcols = feature_columns(bundle)
    frame = pd.concat([ds.loc[news_idx, structured["columns"]], news.loc[news_idx, [c for c in fcols if c not in structured["columns"]]]], axis=1)[fcols]
    a, _ = predict_parts(bundle, frame.iloc[-5:])
    b, _ = predict_parts(loaded, frame.iloc[-5:])
    if not np.allclose(a, b, atol=1e-12) or not np.all(np.isfinite(b)):
        raise RuntimeError("저장 후 재로딩 예측 불일치")

    pool = frame
    bg = pool.sample(n=32, replace=False, random_state=BACKGROUND_SEED).sort_index()
    bg.to_parquet(stage / "background.parquet")
    art_sha = sha256(art)
    model_version = f"{line}_{objective}_{month.replace('-', '_')}_v3_{art_sha[:12]}"
    manifest = {
        "created_utc": datetime.now(timezone.utc).isoformat(), "objective": objective, "target_month": month,
        "checkpoint": CP, "line": line, "grid": size, "grid_search": any(v.get("grid_size", 0) for v in tuning.values()), "protocol": "model/daily/TRAINING_PROTOCOL.md",
        "trainer": "service/train/trainer.py", "artifact": "bundle.joblib", "artifact_sha256": art_sha,
        "excluded_gap_date": str(excluded.date()),
        "structured_train": {k: structured[k] for k in ("train_start", "train_end", "train_rows")},
        "structured_features": structured["columns"], "structured_models": list(structured["models"]),
        "structured_params": structured["params"], "structured_grid": structured["grid"], "structured_inner_scores": structured["inner_scores"],
        "structured_param_source": ("grid search(inner 12개월)" if structured["grid"] else
                                    ("직전 학습본" if structured_fixed else "model/configs/f0_T2.json (실험 f0_fixed_params 검증·홀드아웃 선택)")),
        "news_train": {"rows": len(news_idx), "start": str(news_idx.min().date()), "end": str(news_idx.max().date()),
                       "features": {n: f["columns"] for n, f in fitted_news.items()}, "selected_spec": chosen},
        "inner_tuning": tuning, "meta_oos_train": meta_rows, "fusion": bundle["fusion"], "post_rule": bundle.get("post_rule"),
        "smoke_test": "joblib reload and equal finite prediction; not an accuracy estimate",
        "model_version": model_version,
        "feature_version": feature_version or f"t2_features_v4_{hashlib.sha256(json.dumps(fcols).encode()).hexdigest()[:12]}",
        "pipeline_sha256": pipeline_sha256, "feature_columns": fcols,
        "background": {"artifact": "background.parquet", "rows": len(bg), "pool_rows": len(pool),
                       "pool_start": str(pool.index.min().date()), "pool_end": str(pool.index.max().date()),
                       "sample_dates": [str(d.date()) for d in bg.index], "method": "uniform_without_replacement",
                       "random_state": BACKGROUND_SEED, "input_space": "raw_engineered_features_before_joblib_internal_preprocessing",
                       "sha256": sha256(stage / "background.parquet")},
        "drift_reference": drift_reference(pool),
        "inputs_sha256": {"news_daily": hashlib.sha256(pd.util.hash_pandas_object(news.loc[news_idx]).values.tobytes()).hexdigest(),
                          "structured": hashlib.sha256(pd.util.hash_pandas_object(ds.loc[idx, structured["columns"] + [target]]).values.tobytes()).hexdigest(),
                          "f0_config": sha256(F0_CONFIG),
                          "oos_components": (hashlib.sha256(pd.util.hash_pandas_object(oos.sort_values(["line", "component", "target_dd"]),
                                             index=False).values.tobytes()).hexdigest() if oos is not None and len(oos) else None)},
        "deployment_release": "v3",
        "runtime_versions": {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
                             "scikit_learn": sklearn.__version__, "joblib": joblib.__version__},
        "runtime_policy": {"missing_policy": C.MISSING_POLICY},
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    dest = paths.STAGING / model_version
    if dest.exists():
        import shutil
        shutil.rmtree(dest)
    stage.rename(dest)
    print(f"학습본: {model_version} ({(dest / 'bundle.joblib').stat().st_size:,} bytes)", flush=True)
    return dest
