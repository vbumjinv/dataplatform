from __future__ import annotations

import threading
from typing import List, Literal, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class TimePoint(BaseModel):
    ds: str
    y: float


class ForecastRequest(BaseModel):
    series_id: str = Field(..., min_length=1)
    horizon_months: int = Field(12, ge=1, le=24)
    model_type: Literal["timesfm_2_5_200m"] = "timesfm_2_5_200m"
    data: List[TimePoint]


class ForecastPoint(BaseModel):
    ds: str
    yhat: float
    actual: Optional[float] = None
    yhatLower: Optional[float] = None
    yhatUpper: Optional[float] = None


class Metrics(BaseModel):
    mae: Optional[float] = None
    rmse: Optional[float] = None
    mape: Optional[float] = None


class ForecastResponse(BaseModel):
    model: str
    series_id: str
    horizon_months: int
    train_count: int
    test_count: int
    train_start: Optional[str] = None
    train_end: Optional[str] = None
    test_start: Optional[str] = None
    test_end: Optional[str] = None
    metrics: Metrics
    history: List[TimePoint]
    forecast: List[ForecastPoint]
    fallback_reason: Optional[str] = None


app = FastAPI(title="python-timesfm-api", version="0.1.0")
_TIMESFM_MODEL = None
_TIMESFM_DEVICE = None
_TIMESFM_LOCK = threading.Lock()


@app.get("/health")
def health():
    return {"ok": True}


def calc_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Metrics:
    mae = float(np.mean(np.abs(y_true - y_pred)))
    rmse = float(np.sqrt(np.mean((y_true - y_pred) ** 2)))
    mask = y_true != 0
    if mask.sum() == 0:
        mape = None
    else:
        mape = float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])) * 100)
    return Metrics(
        mae=round(mae, 4),
        rmse=round(rmse, 4),
        mape=round(mape, 4) if mape is not None else None,
    )


def run_linear_fallback(train_df: pd.DataFrame, test_df: pd.DataFrame):
    x_train = np.arange(len(train_df), dtype=float)
    y_train = train_df["y"].values.astype(float)
    slope, intercept = np.polyfit(x_train, y_train, 1)
    fitted_train = intercept + slope * x_train
    residual = y_train - fitted_train
    resid_std = float(np.std(residual))

    y_pred_list = []
    forecast_rows: List[ForecastPoint] = []
    for i, dt in enumerate(test_df["ds"].tolist()):
        idx = len(train_df) + i
        yhat = float(intercept + slope * idx)
        y_pred_list.append(yhat)
        forecast_rows.append(
            ForecastPoint(
                ds=dt.strftime("%Y-%m-%d"),
                yhat=yhat,
                actual=float(test_df.iloc[i]["y"]),
                yhatLower=float(yhat - 1.96 * resid_std),
                yhatUpper=float(yhat + 1.96 * resid_std),
            )
        )

    y_true = test_df["y"].values.astype(float)
    y_pred = np.array(y_pred_list, dtype=float)
    return calc_metrics(y_true, y_pred), forecast_rows


def get_timesfm_model():
    global _TIMESFM_MODEL, _TIMESFM_DEVICE
    try:
        import torch  # type: ignore
        from transformers import TimesFm2_5ModelForPrediction  # type: ignore
    except Exception as import_error:
        raise RuntimeError(
            "TimesFM 2.5 모델 클래스를 로드할 수 없습니다. "
            "transformers main 설치를 확인해주세요."
        ) from import_error

    with _TIMESFM_LOCK:
        if _TIMESFM_MODEL is None:
            try:
                model = TimesFm2_5ModelForPrediction.from_pretrained(
                    "google/timesfm-2.5-200m-transformers",
                    device_map="auto",
                )
                model.eval()
                _TIMESFM_MODEL = model
                _TIMESFM_DEVICE = next(model.parameters()).device
            except Exception as load_error:
                raise RuntimeError(
                    f"TimesFM 2.5 모델 로딩에 실패했습니다: {str(load_error)}"
                ) from load_error
    return _TIMESFM_MODEL, _TIMESFM_DEVICE, torch


def run_timesfm_2_5_200m(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon_months: int):
    model, model_device, torch = get_timesfm_model()

    values = train_df["y"].astype(float).values
    past_values = [torch.tensor(values, dtype=torch.float32, device=model_device)]

    with torch.no_grad():
        outputs = model(past_values=past_values, return_dict=True)

    mean_pred = outputs.mean_predictions
    quant_pred = outputs.full_predictions

    mean_arr = mean_pred.detach().cpu().numpy()
    quant_arr = quant_pred.detach().cpu().numpy()
    mean_arr = np.asarray(mean_arr, dtype=float)
    quant_arr = np.asarray(quant_arr, dtype=float)

    if mean_arr.ndim != 2 or quant_arr.ndim != 3:
        raise ValueError(
            f"unexpected TimesFM output shape: mean={mean_arr.shape}, quant={quant_arr.shape}"
        )
    if mean_arr.shape[1] < horizon_months or quant_arr.shape[1] < horizon_months:
        raise ValueError(
            f"TimesFM horizon mismatch: expected>={horizon_months}, "
            f"mean={mean_arr.shape[1]}, quant={quant_arr.shape[1]}"
        )

    # 일부 체크포인트는 quantile 차원이 9([0.1..0.9])이고,
    # 일부는 10([mean, 0.1..0.9]) 형태를 반환한다.
    q_dim = quant_arr.shape[2]
    if q_dim == 9:
        q10_idx = 0
        q90_idx = 8
    elif q_dim == 10:
        q10_idx = 1
        q90_idx = 9
    else:
        raise ValueError(
            f"TimesFM quantile dimension mismatch: expected in (9, 10), got={q_dim}"
        )

    y_pred = np.asarray(mean_arr[0, :horizon_months], dtype=float)
    lower = np.asarray(quant_arr[0, :horizon_months, q10_idx], dtype=float)
    upper = np.asarray(quant_arr[0, :horizon_months, q90_idx], dtype=float)
    y_true = test_df["y"].values.astype(float)
    metrics = calc_metrics(y_true, y_pred)

    forecast_rows: List[ForecastPoint] = []
    for i, dt in enumerate(test_df["ds"].tolist()):
        forecast_rows.append(
            ForecastPoint(
                ds=dt.strftime("%Y-%m-%d"),
                yhat=float(y_pred[i]),
                actual=float(y_true[i]),
                yhatLower=float(lower[i]),
                yhatUpper=float(upper[i]),
            )
        )
    return metrics, forecast_rows


@app.post("/forecast", response_model=ForecastResponse)
def forecast(payload: ForecastRequest):
    if len(payload.data) < 24:
        raise HTTPException(
            status_code=400,
            detail="at least 24 data points are required for holdout forecasting",
        )

    df = pd.DataFrame([{"ds": p.ds, "y": p.y} for p in payload.data])
    df["ds"] = pd.to_datetime(df["ds"], errors="coerce")
    df["y"] = pd.to_numeric(df["y"], errors="coerce")
    df = df.dropna(subset=["ds", "y"]).sort_values("ds").reset_index(drop=True)

    if df["ds"].duplicated().any():
        raise HTTPException(status_code=400, detail="duplicate ds values are not allowed")
    if len(df) <= payload.horizon_months:
        raise HTTPException(
            status_code=400,
            detail="not enough data: total length must be greater than horizon_months",
        )
    if len(df) - payload.horizon_months < 12:
        raise HTTPException(
            status_code=400,
            detail="not enough training data after holdout split",
        )

    train_df = df.iloc[:-payload.horizon_months].copy()
    test_df = df.iloc[-payload.horizon_months:].copy().reset_index(drop=True)
    model_name = "timesfm_2_5_200m"
    fallback_reason: Optional[str] = None

    try:
        metrics, forecast_rows = run_timesfm_2_5_200m(train_df, test_df, payload.horizon_months)
    except Exception as model_error:
        model_name = "linear_trend_fallback"
        fallback_reason = str(model_error)
        try:
            metrics, forecast_rows = run_linear_fallback(train_df, test_df)
        except Exception as fallback_error:
            raise HTTPException(
                status_code=500,
                detail=f"forecasting failed: {str(fallback_error)}",
            )

    history = [TimePoint(ds=row["ds"].strftime("%Y-%m-%d"), y=float(row["y"])) for _, row in df.iterrows()]
    return ForecastResponse(
        model=model_name,
        series_id=payload.series_id,
        horizon_months=payload.horizon_months,
        train_count=len(train_df),
        test_count=len(test_df),
        train_start=train_df["ds"].min().strftime("%Y-%m-%d") if not train_df.empty else None,
        train_end=train_df["ds"].max().strftime("%Y-%m-%d") if not train_df.empty else None,
        test_start=test_df["ds"].min().strftime("%Y-%m-%d") if not test_df.empty else None,
        test_end=test_df["ds"].max().strftime("%Y-%m-%d") if not test_df.empty else None,
        metrics=metrics,
        history=history,
        forecast=forecast_rows,
        fallback_reason=fallback_reason,
    )
