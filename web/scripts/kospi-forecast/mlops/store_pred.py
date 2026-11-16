"""[DB] 화면용 예측·해설 테이블 읽기·쓰기 — kospi_pred_cls·kospi_pred_reg·kospi_pred_explain 을 db·csv 두 모드에서 같은 방법으로 다룬다.

사용처: mlops/store.py 의 DbStore·store_csv.CsvStore 가 이 클래스를 함께 쓴다(st.pred_put 등). 저장소 열기는 store.open_store(write, mode).
규칙:
  - 예측 행 키 = (target_dd, time_point, model_version, prediction_at), 해설 키 = (target_dd, time_point, prediction_at).
    같은 키의 유효한 예측은 유지한다. 비어 있는 예측과 실패 해설은 재실행으로 채운다.
  - 주말·휴일에도 실행하므로 같은 대상일·시점에 실행일마다 행이 생긴다(금·토·일 T0 → 월요일). 분류·회귀·해설은 같은 prediction_at 으로 짝짓는다.
  - 모델 입력(model_input json)은 예측 행에 함께 둔다(따로 파일을 만들지 않음): {"features": {변수: 값}, "context": {...(T2 기사 참조 등)}}.
  - 범위(range_*)·SHAP(shap_result)은 나중 단계가 같은 행(prediction_at 포함 키)에 채운다(pred_update).
  - prediction_at = 실행일의 시점 시각(등록부 시각, features/timepoints.run_point). 대상일만 준 소급 실행은 등록부 기준 시각(cutoff).
  - 읽을 때 한 대상일에 여러 행이면 prediction_at 이 가장 늦은 행을 쓴다(pred_read 정렬, pred_latest).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

TABLE = {"cls": "pred_cls", "reg": "pred_reg"}
KEY = ["target_dd", "time_point", "model_version", "prediction_at"]
EXPLAIN_KEY = ["target_dd", "time_point", "prediction_at"]
VALUE = {"cls": "yhat_probability", "reg": "yhat_value"}
LEGACY = "legacy_unknown"                         # 운영 DB 의 옛 방식 T2 예측(2026-09, 20행, 열 추가 때 기본값). 학습본·입력이 없어 읽지 않는다(지우지 않음)
TOL_Y, TOL_X = 5.1e-7, 1e-12                     # 저장 값은 소수 6자리, 입력은 덧셈 순서 차이(1e-17 수준)만 허용


def _date(v):
    return pd.Timestamp(v).date()


def _stamp(v):
    t = pd.Timestamp(v)
    return (t.tz_localize("Asia/Seoul") if t.tzinfo is None else t).tz_convert("UTC").to_pydatetime()


def _json(v):
    return json.loads(v) if isinstance(v, str) and v else v


def _utc(v):
    """비교용 prediction_at(UTC Timestamp, 시간대 없으면 KST)."""
    return pd.Timestamp(_stamp(v))


class PredMixin:
    """DbStore·CsvStore 공통: 백엔드는 _select·_insert_new·_update 를 제공한다."""

    # ------------------------------------------------------------ 예측
    def pred_put(self, obj: str, rows: list[dict]) -> int:
        """예측 행을 넣고 값이 비어 있는 기존 행을 복구한다."""
        rows = [dict(r, target_dd=_date(r["target_dd"]), prediction_at=_stamp(r["prediction_at"]),
                     load_dtm=datetime.now(timezone.utc)) for r in rows]
        count = self._insert_new(TABLE[obj], rows, KEY)
        if not self.write or count == len(rows):
            return count
        for row in rows:
            if pd.isna(row.get(VALUE[obj])):
                continue
            key = {k: row[k] for k in KEY}
            key[VALUE[obj]] = None
            values = {k: v for k, v in row.items() if k not in KEY}
            count += self._update(TABLE[obj], key, values)
        return count

    def pred_read(self, obj: str, time_point: str | None = None, start=None, end=None, model_version: str | None = None) -> pd.DataFrame:
        """예측 행(json 열은 dict, prediction_at 은 UTC Timestamp)."""
        eq = {k: v for k, v in (("time_point", time_point), ("model_version", model_version)) if v is not None}
        df = self._select(TABLE[obj], eq, start, end)
        if len(df):
            df = df[df.model_version != LEGACY].reset_index(drop=True)
        if len(df):
            df["prediction_at"] = pd.to_datetime(df["prediction_at"], utc=True, format="ISO8601")
            df["load_dtm"] = pd.to_datetime(df["load_dtm"], utc=True, format="ISO8601")
            for c in ("model_input", "shap_result"):
                df[c] = df[c].map(_json)
        return df.sort_values(["time_point", "target_dd", "prediction_at", "load_dtm"]).reset_index(drop=True) if len(df) else df

    def pred_latest(self, time_point: str, start=None, end=None, versions=None, prediction_at=None) -> pd.DataFrame:
        """분류·회귀를 같은 (대상일, prediction_at) 으로 묶고 대상일마다 prediction_at 이 가장 늦은 행을 남긴다.
        versions 를 주면 그 모델 쌍만, prediction_at 을 주면 그 실행 행만 읽는다."""
        versions = versions or {}
        c, r = (self.pred_read(o, time_point, start, end, versions.get(o)) for o in ("cls", "reg"))
        if c.empty or r.empty:
            return pd.DataFrame()
        if prediction_at is not None:
            c, r = (x[x.prediction_at == _utc(prediction_at)] for x in (c, r))
        rng = ["range_lo80_pct", "range_hi80_pct", "range_lo95_pct", "range_hi95_pct", "range_regime"]
        c = c[["target_dd", "prediction_at", "load_dtm", "yhat_probability", "model_version"]].rename(
            columns={"yhat_probability": "p", "model_version": "model_version_cls"})
        r = r[["target_dd", "prediction_at", "load_dtm", "yhat_value", "yhat_raw_value", "model_version", *rng]].rename(
            columns={"yhat_value": "r", "yhat_raw_value": "r_raw", "model_version": "model_version_reg", "load_dtm": "load_dtm_reg"})
        out = c.merge(r, on=["target_dd", "prediction_at"]).sort_values(["target_dd", "prediction_at", "load_dtm", "load_dtm_reg"])
        if out.empty:
            return pd.DataFrame()
        out = out.drop_duplicates("target_dd", keep="last").set_index("target_dd").drop(columns="load_dtm_reg")
        out = out.astype({"p": float, "r": float, "r_raw": float})
        out["flip"] = np.sign(out.r) != np.sign(out.r_raw)
        return out.sort_index()

    def pred_update(self, obj: str, key: dict, values: dict) -> int:
        """이미 있는 예측 행에 범위·SHAP 등을 채운다(키 = target_dd, time_point, model_version, prediction_at)."""
        if "prediction_at" not in key:
            raise ValueError("pred_update 키에 prediction_at 이 필요합니다(같은 대상일에 실행일별 행이 있음).")
        key = dict(key, target_dd=_date(key["target_dd"]), prediction_at=_stamp(key["prediction_at"]))
        n = self._update(TABLE[obj], key, values)
        if self.write and n != 1:
            raise ValueError(f"{obj} {key}: 고칠 예측 행이 없습니다(먼저 예측을 저장하세요).")
        return n

    def pred_copy_from(self, src) -> dict:
        """다른 저장소(csv)의 예측·해설 행을 그대로 옮긴다(저장 시각 유지, 이미 있는 키는 그대로)."""
        out = {}
        for obj in ("cls", "reg"):
            df = src.pred_read(obj)
            rows = [dict(r, target_dd=_date(r["target_dd"]), prediction_at=_stamp(r["prediction_at"]),
                         load_dtm=pd.Timestamp(r["load_dtm"]).to_pydatetime()) for r in df.to_dict("records")]
            out[TABLE[obj]] = self._insert_new(TABLE[obj], [{k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in r.items()}
                                                            for r in rows], KEY)
        ex = src.explain_read()
        rows = [dict(r, target_dd=_date(r["target_dd"]), prediction_at=_stamp(r["prediction_at"]),
                     created_at=pd.Timestamp(r["created_at"]).to_pydatetime())
                for r in ex.to_dict("records") if pd.notna(r.get("prediction_at"))]
        out["kospi_pred_explain"] = self._insert_new("pred_explain", rows, EXPLAIN_KEY) if rows else 0
        return out

    # ------------------------------------------------------------ 해설
    def explain_put(self, row: dict) -> int:
        """해설 한 행(같은 대상일·시점·prediction_at 이 이미 있으면 건너뜀, 단 failed 행은 성공 해설로 덮어씀). 반환: 넣은/바꾼 행 수."""
        row = dict(row, target_dd=_date(row["target_dd"]), prediction_at=_stamp(row["prediction_at"]), created_at=datetime.now(timezone.utc))
        n = self._insert_new("pred_explain", [row], EXPLAIN_KEY)
        if n == 0 and (row.get("status") == "ok" or (row.get("conclusion") and row.get("detail_reason"))):
            key = {k: row[k] for k in EXPLAIN_KEY}
            n = self._update("pred_explain", dict(key, status="failed"), {k: v for k, v in row.items() if k not in key})
        return n

    def explain_read(self, time_point: str | None = None, start=None, end=None) -> pd.DataFrame:
        df = self._select("pred_explain", {"time_point": time_point} if time_point else None, start, end)
        if len(df):
            df["article_keys"] = df["article_keys"].map(_json)
            df["prediction_at"] = pd.to_datetime(df["prediction_at"], utc=True, format="ISO8601")
        return df
