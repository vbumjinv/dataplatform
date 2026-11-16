"""[실사용 모듈] T1(유럽 장 마감) 월간 재학습 — 정형 F0 + 뉴스 조건부 보정(방향 X4, 수익률 gate) 학습본을 다음 달용으로 새 자료로 다시 만들어 운영 슬롯에 배포한다.

실행은 공통 입구 run_retrain.py 로 한다: python run_retrain.py --tp T1 [--month 2026-12] [--write] [--grid on|off]
모델 구조·계산: predict/t1_model.py. 학습본 이력(reg 학습본 history)에 거래일별 정답·F0 OOS·잔차 모델 OOS·뉴스 변수·조건 값을 이어 쌓는다.
순서: ① 지금 학습본 읽기 ② DB 정형 원천(대상월 직전 거래일까지)·dp.news_feature_orig 로 지난달 거래일의 뉴스 변수 계산
     ③ 지난달 거래일을 지금 학습본으로 예측해 OOS(F0·잔차 모델)를 이력에 붙임 ④ 정형 F0 재학습(train/f0_trainer.py)
     ⑤ 잔차 모델 8개(방향: rf·et·ridge·lgbm, 수익률: gb·hgb·xgb·ridge) 재학습 — 목표 = 정답 − F0 OOS, 입력 = 뉴스 10개, 학습본 OOS 이력부터 누적, 마지막 1거래일 gap
     ⑥ gate d(수익률 모델마다)를 과거 OOS 로 다시 고름 ⑦ 조건 분위 이력 갱신 ⑧ --write 면 배포(이전 학습본 백업 최근 3개) ⑨ mlops/post_deploy.after_deploy(T1): 예측 범위·해설용 SHAP 배경·통합본(T1 파일만 바꿈)
파라미터: 매달은 직전 학습본 값 고정, 대상월 1·4·7·10월이면 grid search(정형 F0 = inner 12개월, 잔차 모델 = 학습 끝 40거래일 블록 3개, train/grid_schedule.py).
      예외: 수익률 정형 F0(회귀 6개 평균)는 param_policy=fixed_no_grid 라 격자 달에도 고정(--grid on 이면 다시 고름, 2026-11-10 model_improve_20261110).
출력(--write): model/artifacts/T1/{cls,reg}_model_1.joblib·_manifest.json·range_history.parquet·range_config.json, mlops/paths.CACHE/slot_history/T1/<버전>/,
      outputs/explain/shap_background/T1/, model/artifacts/bundle/(통합본)
근거: experiments/daily/test/news_best_refit/(N3, 07·08), news_t1_window/06_fusion_late.py(X4·gate), 사용자 결정 2026-11-05(T1 서비스 모델 교체).
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import artifacts as A  # noqa: E402
import estimators as E  # noqa: E402
import grid_schedule as G  # noqa: E402
import t1_model as M  # noqa: E402
from news import t1_news as N  # noqa: E402

TP = "T1"
RM = {"cls": ["rf", "et", "ridge", "lgbm"], "reg": ["gb", "hgb", "xgb", "ridge"]}
LAM = 0.5
GATE_GRID = [0.25, 0.5, 1.0, 2.0]
MIN_TRAIN, MIN_META = 60, 20
COND = {"cls": dict(name=M.FLAG["cls"], column="sec_market", q=0.9, side="gt", min_hist=60,
                    label="시장 전체 업종 영향 점수가 어제까지 분포의 상위 10%"),
        "reg": dict(name=M.FLAG["reg"], column="rel_mid_share", q=0.3333, side="lt", min_hist=60,
                    label="시황 제외 기사 중 KOSPI 관련도 0.5 기사 비중이 어제까지 분포의 하위 1/3")}
HIST_COLS = (["y_direction", "y_return", "ps_cls", "ps_reg"] + [f"r_{o}_{m}" for o in RM for m in RM[o]]
             + N.SEM + ["sec_market", "rel_mid_share", "in_idx"])
KEEP_BACKUPS = 3


def _resid_fit(X, y, spec):
    mu, sd = E.fit_scaler(X)
    est = E.news_estimator(spec["model"], spec["params"], "reg")
    est.fit(E.apply_scaler(X, mu, sd).to_numpy(float), np.asarray(y, float))
    return {"estimator": est, "columns": list(X.columns), "mean": mu, "std": sd, "spec": spec}


def _select(X, y, model):
    """학습 끝 40거래일 블록 3개로 격자 선택(news_models.tune_predict_ts 와 같은 규칙, 주지표 = MAE 개선율)."""
    grid = E.grid_for(model)
    idx = X.index
    folds = [(idx[:lo - 1], idx[lo:lo + 40]) for k in range(3, 0, -1) for lo in [len(idx) - (k - 1) * 40 - 40] if lo - 1 >= 20]
    best = grid[len(grid) // 2]
    if folds:
        sc = []
        for spec in grid:
            vals = []
            for fit, val in folds:
                try:
                    vals.append(E.score("reg", y.loc[val].to_numpy(float), M.resid(_resid_fit(X.loc[fit], y.loc[fit], spec), X.loc[val])))
                except Exception:
                    vals.append(np.nan)
            sc.append(np.nanmean(vals) if not np.all(np.isnan(vals)) else np.nan)
        if not np.all(np.isnan(sc)):
            best = grid[int(np.nanargmax(sc))]
    return {**best, "filt": "none"}


def train_rows(H: pd.DataFrame, month: str, target: pd.Series) -> pd.DatetimeIndex:
    """대상월 이전 거래일에서 마지막 1거래일(gap)을 빼고, 정답·F0 OOS·뉴스가 있는 모든 이력 날짜를 쓴다."""
    before = H.index[H.index < pd.Period(month, "M").start_time]
    tr = before[:-1]
    ok = target.reindex(tr).notna() & H.loc[tr, N.SEM].notna().all(axis=1)
    return tr[ok.to_numpy()]


def fit_news(H: pd.DataFrame, month: str, specs: dict | None, grid: bool) -> dict:
    """잔차 모델 8개 + gate + 조건. specs: {obj: {모델: spec}}(직전 학습본 값) — grid 면 다시 고른다."""
    out = {}
    for obj in ("cls", "reg"):
        target = (H.y_direction - H.ps_cls) if obj == "cls" else (H.y_return - H.ps_reg)
        tr = train_rows(H, month, target)
        if len(tr) < MIN_TRAIN:
            raise ValueError(f"{obj}: 잔차 모델 학습 행 부족({len(tr)})")
        resid = {}
        for m in RM[obj]:
            spec = _select(H.loc[tr, N.SEM], target.loc[tr], m) if (grid or not specs or m not in specs.get(obj, {})) else specs[obj][m]
            resid[m] = _resid_fit(H.loc[tr, N.SEM], target.loc[tr], spec)
            print(f"  잔차 {obj}/{m}: {'선택' if grid else '사용'} {spec['params']} (학습 {len(tr)}행 {tr[0].date()}~{tr[-1].date()})", flush=True)
        news = {"columns": list(N.SEM), "resid": resid, "lam": LAM, "method": "X4" if obj == "cls" else "gate",
                "train_start": str(tr[0].date()), "train_end": str(tr[-1].date()), "train_rows": int(len(tr))}
        if obj == "reg":
            news["gate"] = fit_gate(H, month)
        hist_days = H.index[(H.index < pd.Period(month, "M").start_time) & H.in_idx.astype(bool).to_numpy()]
        cond = dict(COND[obj], history=H.loc[hist_days, COND[obj]["column"]].astype(float))
        out[obj] = {"news": news, "condition": cond}
    return out


def fit_gate(H: pd.DataFrame, month: str) -> dict:
    """수익률 모델마다 gate d 를 대상월 이전 OOS(F0·잔차 모델) 로 고른다(combine_extra.gate 와 같음): {모델: {d, scale, rows, score}}."""
    prev = H.index[H.index < pd.Period(month, "M").start_time]
    out = {}
    for m in RM["reg"]:
        ps, alt, y = H.ps_reg.loc[prev], H.ps_reg.loc[prev] + LAM * H[f"r_reg_{m}"].loc[prev], H.y_return.loc[prev]
        ok = ps.notna() & alt.notna() & y.notna()
        ps, alt, y = ps[ok], alt[ok], y[ok]
        if len(ps) < MIN_META:
            out[m] = {"d": 0.0, "scale": 0.0, "rows": int(len(ps)), "score": None}
            continue
        scale = float(ps.std() + 1e-12)
        sc = [E.score("reg", y.to_numpy(float), np.where(np.abs(ps.to_numpy()) < d * scale, alt.to_numpy(), ps.to_numpy())) for d in GATE_GRID]
        i = int(np.nanargmax(sc))
        out[m] = {"d": GATE_GRID[i], "scale": scale, "rows": int(len(ps)), "score": float(sc[i])}
    return out


def assemble(f0: dict, news: dict, H: pd.DataFrame, month: str) -> dict:
    """정형 F0 학습본(f0_trainer 형식) + 뉴스 부분 -> T1 학습본 두 개."""
    out = {}
    for obj in ("cls", "reg"):
        b = dict(f0[obj], format_version=2, model="N3", news=news[obj]["news"], condition=news[obj]["condition"])
        if obj == "reg":
            b["post_rule"] = {"name": "K1", "desc": "수익률 부호가 최종 방향과 다르면 부호만 방향에 맞춘다(크기 유지)"}
            b["history"] = H[H.index < pd.Period(month, "M").start_time][HIST_COLS].copy()
        out[obj] = b
    return out


def history_rows(bundles: dict, ds: pd.DataFrame, news: pd.DataFrame, days: pd.DatetimeIndex) -> pd.DataFrame:
    """days(지난달 거래일)를 그달 학습본으로 예측한 OOS 와 정답·뉴스 변수 -> 이력 행."""
    X = pd.concat([ds.loc[days], news.loc[days, N.SEM]], axis=1)
    out = pd.DataFrame(index=days)
    out["y_direction"], out["y_return"] = ds.loc[days, "y_direction"], ds.loc[days, "y_return"]
    out["ps_cls"], out["ps_reg"] = M.f0(bundles["cls"], X), M.f0(bundles["reg"], X)
    for obj in ("cls", "reg"):
        for m, fit in bundles[obj]["news"]["resid"].items():
            out[f"r_{obj}_{m}"] = M.resid(fit, X)
    out[N.SEM] = news.loc[days, N.SEM]
    out["sec_market"], out["rel_mid_share"] = news.loc[days, "sec_market"], news.loc[days, "rel_mid_share"]
    out["in_idx"] = out.y_return.notna() & out.ps_cls.notna()
    return out[HIST_COLS]


def refresh_targets(history: pd.DataFrame, ds: pd.DataFrame, month: str) -> pd.DataFrame:
    """월말 장 시작 전 미확정이던 정답을 다음 재학습 때 DB 스냅샷 값으로 갱신한다."""
    history = history.copy()
    before = history.index[history.index < pd.Period(month, 'M').start_time]
    targets = ds.reindex(before)[['y_direction', 'y_return']]
    history.loc[before, ['y_direction', 'y_return']] = targets
    # 조건 분포는 정답 확정된 뉴스 관측일을 사용한다. 2010년 조건 이력도 유지한다.
    history.loc[before, 'in_idx'] = targets.y_return.notna().to_numpy()
    return history


def manifest_for(bundle, month, artifact, previous, grid):
    sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
    man = {k: v for k, v in bundle.items() if k not in ("members", "news", "condition", "history")}
    nw, cd = bundle["news"], bundle["condition"]
    man.update(artifact=artifact.name, artifact_sha256=sha,
               members={n: {"params": v["params"], "inner_score": v.get("inner_score"), "tuned": v.get("tuned", True)} for n, v in bundle["members"].items()},
               news={"columns": nw["columns"], "method": nw["method"], "lam": nw["lam"], "train_start": nw["train_start"], "train_end": nw["train_end"],
                     "train_rows": nw["train_rows"], "resid": {m: f["spec"] for m, f in nw["resid"].items()}, **({"gate": nw["gate"]} if "gate" in nw else {})},
               condition={k: v for k, v in cd.items() if k != "history"} | {"history_rows": int(cd["history"].notna().sum()),
                                                                             "history_end": str(cd["history"].index.max().date())},
               input_columns=M.inputs(bundle), selection=previous.get("selection"), member_selection=previous.get("member_selection"),
               grid="service/train/estimators.py F0_GRID·SMALL_GRIDS", code="service/train/retrain_t1.py",
               grid_search=bool(grid) and any(v.get("tuned", True) for v in bundle["members"].values()), next_grid_month=G.next_grid_month(month), created=datetime.now(timezone.utc).isoformat(),
               model_version=f"model_1_t1_{bundle['objective']}_{month.replace('-', '_')}_{sha[:12]}",
               pipeline=f"predict/{A.PIPELINES[TP]}", pipeline_sha256=A.pipeline_hash(TP))
    if "history" in bundle:
        man["history"] = {"rows": int(len(bundle["history"])), "start": str(bundle["history"].index.min().date()), "end": str(bundle["history"].index.max().date())}
    return man


def write_slot(bundles: dict, month: str, previous: dict, grid: bool) -> dict:
    """운영 슬롯에 쓰고 해시·파이프라인·대상월을 다시 검사한다: {obj: model_version}."""
    versions = {}
    for o in ("cls", "reg"):
        art = A.ARTIFACTS / TP / f"{o}_model_1.joblib"
        joblib.dump(bundles[o], art)
        man = manifest_for(bundles[o], month, art, previous.get(o, {}), grid)
        A.manifest_path(TP, o).write_text(json.dumps(man, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        versions[o] = man["model_version"]
    for o in ("cls", "reg"):
        A.load_checked(TP, o, month)
    return versions


def run(a):
    """a: run_retrain.py 인자(tp·month·write·grid). --write 면 학습 → 운영 슬롯 배포 → SHAP 배경."""
    import db
    import paths
    import registry as R
    from inputs import last_session_before
    from features import dataset as D
    import f0_trainer as F
    import engine as P
    month = a.month
    loaded = {o: A.load_checked(TP, o) for o in ("cls", "reg")}
    current = {o: v[0] for o, v in loaded.items()}
    cman = {o: v[1] for o, v in loaded.items()}
    have = cman["cls"]["target_month"]
    if have == month:
        print(f"T1 {month} 학습본이 이미 배포되어 있습니다({cman['cls']['model_version']}).")
        return
    if have > month:
        raise SystemExit(f"운영 슬롯이 {have} 학습본이라 그보다 이른 {month} 학습본으로 바꾸지 않습니다.")
    if (pd.Period(have, "M") + 1).strftime("%Y-%m") != month:
        raise SystemExit(f"T1 학습본 이력은 한 달씩 이어 붙입니다: 지금 {have} 학습본 다음은 {(pd.Period(have, 'M') + 1).strftime('%Y-%m')} 입니다.")
    last = last_session_before(month)
    grid = G.grid_due(month, a.grid)
    import post_deploy as PD
    from store import open_store
    st = open_store(a.write, getattr(a, "mode", None))              # --write 면 배포 뒤 슬롯 백업(kospi_mlops_slot)도 씀
    close = PD.check_ready(TP, month, st) if a.write else None       # 배포 뒤 범위 이력에 붙일 예측이 다 있는지 학습 전에 확인
    print(f"T1 재학습 {month} | 자료 ~{last.date()}(gap) | {'grid search' if grid else f'파라미터 고정(다음 격자 {G.next_grid_month(month)})'}", flush=True)
    eng = db.get_engine()
    ds = P.build_features(TP, last, eng)
    days = ds.index[(ds.index >= pd.Period(have, "M").start_time) & (ds.index < pd.Period(month, "M").start_time)]
    prev = D.previous_trading_day_map(ds.index).reindex(days)
    with eng.connect() as con:
        news = N.build(con, days, ds.loc[days, "prediction_at"], prev)
    if (news.n_articles == 0).any():
        raise ValueError(f"뉴스 피처가 0건인 거래일이 있습니다({', '.join(d.strftime('%m-%d') for d in days[news.n_articles == 0][:8])}) — dp.news_feature_orig 처리 확인.")
    H = pd.concat([current["reg"]["history"], history_rows(current, ds, news, days)])
    H = refresh_targets(H, ds, month)
    if H.index.duplicated().any():
        raise ValueError("이력에 같은 거래일이 두 번 있습니다.")
    print(f"  이력 {len(H)}일(지난달 {len(days)}일 추가: OOS·뉴스)", flush=True)
    f0 = F.fit_point(ds, month, cman, grid=grid, force_grid=a.grid == "on")   # 수익률 F0 는 param_policy=fixed_no_grid(2026-11-10): 격자 달에도 고정
    specs = {o: {m: f["spec"] for m, f in current[o]["news"]["resid"].items()} for o in ("cls", "reg")}
    bundles = assemble(f0, fit_news(H, month, specs, grid), H, month)
    X = pd.concat([ds.iloc[-5:], H[N.SEM].reindex(ds.index[-5:])], axis=1).assign(**{M.FLAG["cls"]: 0.0, M.FLAG["reg"]: 0.0})
    p = M.predict(bundles, X, X)                                            # 계산 확인용(학습 구간 행이라 성능 정보는 아님)
    if not all(np.isfinite(v).all() for v in (p["prob_up"], p["ret"])):
        raise ValueError("새 학습본 예측에 NaN 또는 무한대 포함")
    if not a.write:
        print("dry-run: 운영 슬롯을 바꾸지 않았습니다(--write 로 배포).")
        return
    slot = A.ARTIFACTS / TP
    backup_dir = paths.CACHE / "slot_history" / TP / cman["cls"]["model_version"]
    backup_dir.mkdir(parents=True, exist_ok=True)
    files = [slot / f"{o}_model_1{s}" for o in ("cls", "reg") for s in (".joblib", "_manifest.json")]
    for f in files:
        shutil.copy2(f, backup_dir / f.name)
    try:
        versions = write_slot(bundles, month, cman, grid)
    except Exception:
        for f in files:
            shutil.copy2(backup_dir / f.name, f)
        raise
    print(f"[배포] T1 {month}: {versions['cls']} / {versions['reg']} (이전 학습본 백업 {backup_dir})")
    for d in sorted(backup_dir.parent.iterdir(), key=lambda d: d.stat().st_mtime)[:-KEEP_BACKUPS]:
        shutil.rmtree(d)
    PD.after_deploy(TP, st, close, month)                          # T1 예측 범위·SHAP 배경·통합본을 새 학습본에 맞춤
