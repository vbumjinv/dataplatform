"""[실사용 스크립트] 주별 예측 — 기준일 b 의 시점 변수로 운영 학습본 예측을 내고 저장한다.

입력: DB 원천·기사(실행마다 변수 계산, 캐시 없음), DB 학습본 kospi5_mlops_model(champion, 등록했으면 challenger)
출력: kospi5_pred_cls·reg(운영 예측, 일별 kospi_pred_cls·reg 와 같은 열: reg 에 80%·95% 범위 range_*_pct·range_regime — wk_range),
      kospi5_mlops_ledger(챌린저가 있을 때만, 거래일만) — wk_store, --write 일 때만
실행(service_5): python predict.py --tp W0 --base 2026-11-18 [--write]
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

import wk_data
import wk_models
import wk_store

import timepoints as _TPR  # noqa: E402
OBJECTIVE = _TPR.objectives()                                         # time_points.json({"cls": "DIR_5D", "reg": "RET_5D"})
# 예측 뒤 처리(config/v1_postprocess.json): W0·W2 수익률 K1(부호를 같은 시점 방향 확률 ≥ 0.5 이면 +, 아니면 −) — 운영 모델 판정 2026-11-20
#   (W0 검증 MAE 개선율 1.40% → 2.34%, 홀드아웃 0.13% → 2.72%; W2 4.81% → 4.86%, 2.10% → 3.95%). 학습본은 그대로, 설정 파일만 바꾸면 켜고 끈다.
import json as _json
from pathlib import Path as _Path
_PP = _Path(__file__).resolve().parents[1] / "model" / "configs" / "v1_postprocess.json"
POST = _json.loads(_PP.read_text(encoding="utf-8")) if _PP.exists() else {}


def range_of(tp: str, b, p: float, r: float, *, versions=None) -> dict:
    """수익률의 80%·95% 범위(%, wk_range). 범위 계산이 실패해도 예측은 저장하고 범위만 비운다(경고 출력)."""
    import wk_range
    try:
        return wk_range.predict_range(tp, b, p, r, versions=versions)
    except Exception as ex:
        print(f"[주의] {tp} {pd.Timestamp(b).date()}: 예측 범위 계산 실패 — 범위 없이 저장합니다: {ex!r}", flush=True)
        return {**{c: np.nan for c in wk_range.COLS}, "range_regime": None}   # 열은 항상 같게(일별 kospi_pred_reg 열)


def row_of(X: pd.DataFrame, tp: str, b: pd.Timestamp) -> pd.DataFrame:
    """기준일 b 행. 없으면 그 시점 자료가 아직 DB 에 없다는 뜻이라 멈춘다."""
    if b not in X.index:
        raise RuntimeError(f"{tp}: 기준일 {b.date()} 변수 행이 없습니다(변수 마지막 기준일 {X.index.max().date()}). "
                           "DB 원천 적재(특히 krx_kospi_dd_trd 의 그날 종가)를 확인하세요.")
    return X.loc[[b]]


def _point(slot, obj, m, X, x, b, news_ok):
    """학습본 m 의 기준일 b 예측값(K1 전). 뉴스 장애면 학습본 안 정형만 모델(fallback). 반환 (실제로 쓴 학습본, 값)."""
    if not news_ok and m.get("fallback"):
        m = {**m, "model": m["fallback"]["model"], "features": m["fallback"]["features"], "model_version": m["fallback"]["model_version"]}
    if obj == "cls" and not hasattr(m["model"], "predict_proba"):
        raise ValueError(f"{slot}: 방향 모델에는 predict_proba 가 필요합니다.")
    since = getattr(m["model"], "needs_rows_from", None)       # 순환 신경망 구성원이 있는 학습본: 그 날짜부터 b 까지 행을 넣고 마지막 값(wk_composite)
    if since and b < pd.Timestamp(since):                      # 학습 대상 달 전 기준일(예: 11-02 예측의 기준일 10-30): 직전 40행으로 창을 만든다(wk_shap 과 같음)
        xin = X.loc[:b].tail(40)
    else:
        xin = X.loc[(X.index >= pd.Timestamp(since)) & (X.index <= b)] if since else x
    v = float(wk_models.predict(m, xin)[-1])
    return m, v


def run(tp: str, b, X: pd.DataFrame, write: bool, trading: bool = True, *, with_range=True, staged=False):
    """반환 {obj: {role: (예측값, 모델 버전)}}. 운영 학습본이 없으면 멈춘다(서비스 값이 없으므로).
    X = 실행 입력(wk_data.run_inputs: b 행 prediction_at = 실행 시각). 챌린저가 등록되어 있으면 거래일 실행(trading)에서만 같은 입력으로 예측해
    원장 kospi5_mlops_ledger 에 쌓는다(일별 run_record_predictions.py 와 같은 자리, 주말·휴일 실행은 원장 없음)."""
    b = pd.Timestamp(b).normalize()
    x = row_of(X, tp, b)
    at = pd.Timestamp(x["prediction_at"].iloc[0]).isoformat()
    tgt = wk_data.target_day(b)
    res, raw, inputs, ledger = {}, {}, {}, []
    news_ok = int(x["NEWS_OK"].iloc[0]) if "NEWS_OK" in x.columns else 1   # 뉴스 장애(DB 읽기·계산 실패)면 학습본의 정형만 모델(fallback)로 예측
    news_n = int(round(float(np.expm1(x["NEWS_w1_t1_log_n"].iloc[0])))) if news_ok and "NEWS_w1_t1_log_n" in x and pd.notna(x["NEWS_w1_t1_log_n"].iloc[0]) else None
    if not news_ok:
        print(f"[주의] {tp} {b.date()}: 뉴스 변수를 쓸 수 없어 정형만 모델(fallback)로 예측합니다.", flush=True)
    if not news_ok or news_n == 0:                                     # 기록만(예측은 계속): 뉴스 장애·기사 0건
        import wk_notify
        wk_notify.send(f"KOSPI 주별 {tp} {b.date()} 뉴스 {'장애(정형만 예측)' if not news_ok else '기사 0건으로 예측'}",
                       ["dp.news_feature_orig 처리(일별 서버 뉴스 단계) 확인"], level="warn")
    for obj in ("cls", "reg"):
        slot = f"{tp}_{obj}"
        res[obj] = {}
        m = wk_models.load(slot)
        if m is None:
            raise FileNotFoundError(f"{slot}: 운영 학습본이 없습니다({wk_models.MODEL}).")
        m, v = _point(slot, obj, m, X, x, b, news_ok)
        raw[obj] = v                                               # 일별 model_input: 예측에 쓴 입력 한 행(json), raw = K1 전 값
        mi = {k: (None if pd.isna(x_) else float(x_)) for k, x_ in x[m["features"]].iloc[0].items()}
        mi["_news_ok"] = bool(news_ok)
        mi["_news_articles_1d"] = news_n                          # 직전 1거래일 창 유효 기사 수(시황 제외, 저녁 '뉴스 0건 예측' 경고용 — 일별 model_input 의 기사 수와 같은 자리)
        mi["_range_calibration"] = wk_models.calibration_id(slot, m)
        inputs[obj] = mi
        if obj == "cls" and not 0 <= v <= 1:
            raise ValueError(f"{slot}: 상승 확률은 0~1 이어야 합니다.")
        if not np.isfinite(v):
            raise ValueError(f"{slot}: 예측값이 {v} 입니다(변수 결측 확인).")
        k1 = POST.get(slot, {}).get("k1")                          # 방향 맞춤(K1): 수익률 부호를 같은 시점 방향 확률에 맞춤(크기 유지)
        if k1:
            pc = res[k1["direction_slot"].split("_")[1]]["champion"]
            v = abs(v) * (1.0 if pc[0] >= k1["threshold"] else -1.0)
        res[obj]["champion"] = (v, wk_models.version(slot, m))
    for obj in ("cls", "reg") if trading else ():                     # 챌린저(등록했을 때만): 같은 입력
        slot = f"{tp}_{obj}"
        ch = wk_models.load(slot, "challenger")
        if ch is None:
            continue
        ch, v = _point(slot, obj, ch, X, x, b, news_ok)
        if not np.isfinite(v):
            raise ValueError(f"{slot} challenger: 예측값이 {v} 입니다(변수 결측 확인).")
        k1 = POST.get(slot, {}).get("k1")                              # 방향 맞춤은 운영 방향으로: 두 수익률이 같은 방향을 써야 크기 차이만 비교된다(사용자 결정 2026-11-20)
        if k1:
            pc = res[k1["direction_slot"].split("_")[1]]["champion"]
            v = abs(v) * (1.0 if pc[0] >= k1["threshold"] else -1.0)
        res[obj]["challenger"] = (v, wk_models.version(slot, ch))
        ledger.append({"target_dd": tgt.date(), "objective": slot, "model_version": wk_models.version(slot, ch), "prediction_at": at, "yhat": v})
    # yhat_value·yhat_raw_value는 K1 뒤·전 수익률 소수다. 화면의 백분율은 yhat_value × 100으로 계산한다.
    # 방향 판정은 주별 규칙(상승 확률 ≥ 0.5 = UP, K1 과 같은 문턱; 일별은 > 0.5). shap_result 는 wk_shap 이 뒤에 채운다.
    p, cls_ver = res["cls"]["champion"]
    key = {"target_dd": tgt.date(), "time_point": tp, "prediction_at": at}
    cls = pd.DataFrame([{"objective": OBJECTIVE["cls"], **key, "model_version": cls_ver, "yhat_probability": round(p, 6),
                                                            "yhat_direction": "UP" if p >= 0.5 else "DOWN", "model_input": inputs["cls"], "shap_result": None}])
    r, ver = res["reg"]["champion"]
    rng = range_of(tp, b, p, r, versions=(cls_ver, ver)) if with_range else {}
    reg = pd.DataFrame([{"objective": OBJECTIVE["reg"], **key, "model_version": ver,
                                                            "yhat_value": round(r, 8), "yhat_direction": "UP" if r > 0 else "DOWN",
                                                            "yhat_raw_value": round(raw["reg"], 6), **rng,
                                                            "model_input": inputs["reg"], "shap_result": None}])
    tables = [("kospi5_pred_cls", cls), ("kospi5_pred_reg", reg)]
    if ledger:
        tables.append(("kospi5_mlops_ledger", pd.DataFrame(ledger)))
    if staged:
        return res, tables
    from contextlib import nullcontext
    with (wk_store.engine()[0].begin() if write else nullcontext()) as con:
        for name, rows in tables:
            wk_store.upsert(name, rows, write, con=con)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    ap.add_argument("--base", required=True, help="기준일 b(YYYY-MM-DD)")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    if a.write:
        ap.error("서비스 저장은 run_predict.py --write를 사용하세요.")
    wk_data.refresh()
    print(run(a.tp, a.base, wk_data.features(a.tp, write=a.write), a.write))          # 실행마다 DB 에서 변수를 만든다(캐시 없음)


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock():
        main()
