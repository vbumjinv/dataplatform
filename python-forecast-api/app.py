from __future__ import annotations

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
    model_type: Literal[
        "prophet",
        "arima",
        "sarima",
        "linear_trend",
        "chronos_bolt_base",
        "chronos_2",
    ] = "prophet"
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


app = FastAPI(title="python-forecast-api", version="0.2.1")


@app.get("/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# 데이터 가공(Transform): 운영자가 작성한 Python 코드를 실행해 시계열을 변환한다.
#   - 입력: df (pandas DataFrame, 컬럼 ds=날짜 / y=값, 날짜 오름차순)
#   - 출력: 코드가 result 변수에 담은 결과 (DataFrame(ds,y) / Series / 1차원 배열)
#   - 용도: HP 필터 등 SQL로 표현하기 어려운 가공. 운영자 전용(임의 코드 실행).
# ---------------------------------------------------------------------------
class TransformPoint(BaseModel):
    ds: str
    y: Optional[float] = None


class TransformRequest(BaseModel):
    code: str = Field(..., min_length=1)
    data: List[TransformPoint]
    data2: Optional[List[TransformPoint]] = None  # 보조 입력 시리즈(선택) → 코드에서 df2 로 제공


class TransformResponse(BaseModel):
    count: int
    result: List[TransformPoint]


def coerce_transform_result(result_obj, source_df: pd.DataFrame) -> pd.DataFrame:
    """사용자 코드의 result 를 ds/y 두 컬럼 DataFrame 으로 정규화한다."""
    # 1) DataFrame: ds 컬럼이 있으면 그대로, 없으면 길이가 같을 때 입력 ds 를 붙인다.
    if isinstance(result_obj, pd.DataFrame):
        out = result_obj.copy()
        if "y" not in out.columns:
            raise ValueError("result DataFrame에 'y' 컬럼이 필요합니다.")
        if "ds" not in out.columns:
            if len(out) != len(source_df):
                raise ValueError("result DataFrame에 'ds' 컬럼이 없고 행 수도 입력과 다릅니다.")
            out = out.reset_index(drop=True)
            out["ds"] = source_df["ds"].reset_index(drop=True)
        return out[["ds", "y"]]
    # 2) Series: 입력과 길이가 같아야 하며 입력 ds 를 사용한다.
    if isinstance(result_obj, pd.Series):
        if len(result_obj) != len(source_df):
            raise ValueError("result Series 길이가 입력 데이터와 다릅니다.")
        return pd.DataFrame(
            {
                "ds": source_df["ds"].reset_index(drop=True),
                "y": result_obj.reset_index(drop=True),
            }
        )
    # 3) list / tuple / ndarray: 1차원이고 길이가 같아야 한다.
    if isinstance(result_obj, (list, tuple, np.ndarray)):
        arr = np.asarray(result_obj, dtype=float)
        if arr.ndim == 1:
            if len(arr) != len(source_df):
                raise ValueError("result 배열 길이가 입력 데이터와 다릅니다.")
            return pd.DataFrame({"ds": source_df["ds"].reset_index(drop=True), "y": arr})
    raise ValueError("result는 DataFrame(ds,y) / Series / 1차원 배열 형식이어야 합니다.")


@app.post("/transform", response_model=TransformResponse)
def transform(payload: TransformRequest):
    if not payload.data:
        raise HTTPException(status_code=400, detail="입력 데이터가 비어 있습니다.")

    df = pd.DataFrame([{"ds": p.ds, "y": p.y} for p in payload.data])
    df["ds"] = pd.to_datetime(df["ds"], errors="coerce")
    df["y"] = pd.to_numeric(df["y"], errors="coerce")
    df = df.dropna(subset=["ds"]).sort_values("ds").reset_index(drop=True)
    if df.empty:
        raise HTTPException(status_code=400, detail="유효한 입력 데이터가 없습니다.")

    # 보조 입력(df2): 있으면 df 와 동일하게 정규화한다. 없으면 None.
    df2 = None
    if payload.data2:
        df2 = pd.DataFrame([{"ds": p.ds, "y": p.y} for p in payload.data2])
        df2["ds"] = pd.to_datetime(df2["ds"], errors="coerce")
        df2["y"] = pd.to_numeric(df2["y"], errors="coerce")
        df2 = df2.dropna(subset=["ds"]).sort_values("ds").reset_index(drop=True)

    # 운영자 전용 도구이므로 별도 샌드박스 없이 실행한다.
    # pd / np 와 입력 df(및 보조 df2)를 제공하고, 코드가 result 를 설정하도록 한다.
    # 단일 네임스페이스로 실행한다: globals 와 locals 를 분리하면 사용자가 정의한
    # 함수(def)나 컴프리헨션이 최상위 변수를 못 찾는다(name ... is not defined). 한 dict 로 통일.
    sandbox = {
        "pd": pd,
        "np": np,
        "__builtins__": __builtins__,
        "df": df.copy(),
        "df2": (df2.copy() if df2 is not None else None),
        "result": None,
    }
    try:
        exec(payload.code, sandbox)  # noqa: S102 - operator-only
    except Exception as exec_error:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Python 실행 오류: {exec_error}")

    result_obj = sandbox.get("result")
    if result_obj is None:
        raise HTTPException(status_code=400, detail="코드에서 result 변수를 설정해야 합니다.")

    try:
        out = coerce_transform_result(result_obj, df)
    except Exception as shape_error:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(shape_error))

    out = out.copy()
    out["ds"] = pd.to_datetime(out["ds"], errors="coerce")
    out["y"] = pd.to_numeric(out["y"], errors="coerce")
    out = out.dropna(subset=["ds", "y"]).sort_values("ds").reset_index(drop=True)

    rows = [
        TransformPoint(ds=row["ds"].strftime("%Y-%m-%d"), y=float(row["y"]))
        for _, row in out.iterrows()
    ]
    return TransformResponse(count=len(rows), result=rows)


# ---------------------------------------------------------------------------
# yfinance 수집: 큐레이션된 티커(예: ^GSPC, DX-Y.NYB)와 기간을 받아 일별 시세를 반환.
#   - 입력: ticker / start / end (YYYY-MM-DD) / interval (기본 1d)
#   - 출력: date, open/high/low/close/adj_close/volume, ticker 행 목록 (OHLCV 전체)
#   - 종가·수정종가를 "둘 다" 받기 위해 auto_adjust=False 로 둔다.
#     (auto_adjust=True 로 두면 Close 가 수정값으로 덮이고 Adj Close 컬럼이 사라진다)
#   - 참고: 지수·환율·금리류는 Adj Close 가 Close 와 동일하고 Volume 이 0 인 경우가 많다.
# ---------------------------------------------------------------------------
class YfinanceRequest(BaseModel):
    ticker: str = Field(..., min_length=1)
    start: str = Field(..., min_length=1)  # YYYY-MM-DD
    end: str = Field(..., min_length=1)  # YYYY-MM-DD (yfinance end 는 미포함이라 +1일 처리)
    interval: str = "1d"


class YfinanceRow(BaseModel):
    date: str  # YYYY-MM-DD
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    adj_close: Optional[float] = None
    volume: Optional[float] = None
    ticker: str


class YfinanceResponse(BaseModel):
    count: int
    rows: List[YfinanceRow]


@app.post("/yfinance", response_model=YfinanceResponse)
def yfinance_collect(payload: YfinanceRequest):
    import yfinance as yf  # 지연 임포트: 서비스 기동 시 네트워크/의존성 부담 최소화

    ticker = payload.ticker.strip()
    interval = (payload.interval or "1d").strip() or "1d"
    start_ts = pd.to_datetime(payload.start, errors="coerce")
    end_ts = pd.to_datetime(payload.end, errors="coerce")
    if pd.isna(start_ts) or pd.isna(end_ts):
        raise HTTPException(status_code=400, detail="start/end 날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)")
    if end_ts < start_ts:
        raise HTTPException(status_code=400, detail="end 는 start 보다 빠를 수 없습니다.")
    # yfinance 의 end 는 미포함(exclusive)이라 사용자가 고른 종료일을 포함하도록 하루 더한다.
    end_exclusive = (end_ts + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    start_iso = start_ts.strftime("%Y-%m-%d")

    try:
        # yf.download 는 MultiIndex 컬럼(('Close','^GSPC'))을 주므로 다루기 번거롭다.
        # Ticker.history 는 단일 레벨 컬럼(Close/Adj Close/...)을 주므로 이쪽을 쓴다.
        frame = yf.Ticker(ticker).history(
            start=start_iso,
            end=end_exclusive,
            interval=interval,
            auto_adjust=False,
        )
    except Exception as fetch_error:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"yfinance 조회 실패: {fetch_error}")

    if frame is None or frame.empty:
        raise HTTPException(
            status_code=400,
            detail="해당 티커/기간에 조회된 데이터가 없습니다. (티커·기간·휴장일을 확인하세요)",
        )

    frame = frame.reset_index()
    # 날짜 컬럼 이름은 interval 에 따라 'Date' 또는 'Datetime' 로 온다.
    date_col = "Date" if "Date" in frame.columns else ("Datetime" if "Datetime" in frame.columns else None)
    if date_col is None:
        raise HTTPException(status_code=502, detail="yfinance 응답에 날짜 컬럼이 없습니다.")

    # yfinance 컬럼명 → 응답 필드명. 없는 컬럼은 None 으로 둔다.
    col_map = {
        "open": "Open",
        "high": "High",
        "low": "Low",
        "close": "Close",
        "adj_close": "Adj Close",
        "volume": "Volume",
    }
    series_map = {
        field: frame[col] if col in frame.columns else None
        for field, col in col_map.items()
    }

    def num_at(field: str, idx: int):
        series = series_map[field]
        if series is None:
            return None
        v = pd.to_numeric(series.iloc[idx], errors="coerce")
        return float(v) if pd.notna(v) else None

    rows: List[YfinanceRow] = []
    for idx in range(len(frame)):
        dt = pd.to_datetime(frame[date_col].iloc[idx], errors="coerce")
        if pd.isna(dt):
            continue
        rows.append(
            YfinanceRow(
                date=dt.strftime("%Y-%m-%d"),
                open=num_at("open", idx),
                high=num_at("high", idx),
                low=num_at("low", idx),
                close=num_at("close", idx),
                adj_close=num_at("adj_close", idx),
                volume=num_at("volume", idx),
                ticker=ticker,
            )
        )

    if not rows:
        raise HTTPException(status_code=400, detail="유효한 시세 데이터가 없습니다.")
    return YfinanceResponse(count=len(rows), rows=rows)


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

    future_dates = test_df["ds"].tolist()
    start_idx = len(train_df)
    y_pred_list = []
    forecast_rows = []
    for i, dt in enumerate(future_dates):
        idx = start_idx + i
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


def run_prophet(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon_months: int):
    from prophet import Prophet  # type: ignore

    model = Prophet(
        growth="linear",
        daily_seasonality=False,
        weekly_seasonality=False,
        yearly_seasonality=True,
    )
    model.fit(train_df)
    future = model.make_future_dataframe(periods=horizon_months, freq="MS")
    pred = model.predict(future)
    pred_tail = pred.tail(horizon_months).reset_index(drop=True)

    y_true = test_df["y"].values.astype(float)
    y_pred = pred_tail["yhat"].values.astype(float)
    metrics = calc_metrics(y_true, y_pred)
    forecast_rows = [
        ForecastPoint(
            ds=row_pred["ds"].strftime("%Y-%m-%d"),
            yhat=float(row_pred["yhat"]),
            actual=float(row_test["y"]),
            yhatLower=float(row_pred["yhat_lower"]) if pd.notna(row_pred["yhat_lower"]) else None,
            yhatUpper=float(row_pred["yhat_upper"]) if pd.notna(row_pred["yhat_upper"]) else None,
        )
        for (_, row_pred), (_, row_test) in zip(pred_tail.iterrows(), test_df.iterrows())
    ]
    return metrics, forecast_rows


def run_arima(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon_months: int):
    from statsmodels.tsa.arima.model import ARIMA  # type: ignore

    y_train = train_df["y"].astype(float).values
    model = ARIMA(y_train, order=(1, 1, 1))
    fitted = model.fit()
    pred_obj = fitted.get_forecast(steps=horizon_months)
    y_pred = np.asarray(pred_obj.predicted_mean, dtype=float)
    conf = pred_obj.conf_int(alpha=0.05)
    conf_values = conf.to_numpy(dtype=float) if hasattr(conf, "to_numpy") else np.asarray(conf, dtype=float)

    y_true = test_df["y"].values.astype(float)
    metrics = calc_metrics(y_true, y_pred)
    forecast_rows: List[ForecastPoint] = []
    for i, dt in enumerate(test_df["ds"].tolist()):
        lower = None
        upper = None
        if conf_values is not None and len(conf_values) > i:
            row = conf_values[i]
            lower = float(row[0]) if len(row) > 0 else None
            upper = float(row[1]) if len(row) > 1 else None
        forecast_rows.append(
            ForecastPoint(
                ds=dt.strftime("%Y-%m-%d"),
                yhat=float(y_pred[i]),
                actual=float(y_true[i]),
                yhatLower=lower,
                yhatUpper=upper,
            )
        )
    return metrics, forecast_rows


def run_sarima(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon_months: int):
    from statsmodels.tsa.statespace.sarimax import SARIMAX  # type: ignore

    y_train = train_df["y"].astype(float).values
    model = SARIMAX(
        y_train,
        order=(1, 1, 1),
        seasonal_order=(1, 1, 1, 12),
        enforce_stationarity=False,
        enforce_invertibility=False,
    )
    fitted = model.fit(disp=False)
    pred_obj = fitted.get_forecast(steps=horizon_months)
    y_pred = np.asarray(pred_obj.predicted_mean, dtype=float)
    conf = pred_obj.conf_int(alpha=0.05)
    conf_values = conf.to_numpy(dtype=float) if hasattr(conf, "to_numpy") else np.asarray(conf, dtype=float)

    y_true = test_df["y"].values.astype(float)
    metrics = calc_metrics(y_true, y_pred)
    forecast_rows: List[ForecastPoint] = []
    for i, dt in enumerate(test_df["ds"].tolist()):
        lower = None
        upper = None
        if conf_values is not None and len(conf_values) > i:
            row = conf_values[i]
            lower = float(row[0]) if len(row) > 0 else None
            upper = float(row[1]) if len(row) > 1 else None
        forecast_rows.append(
            ForecastPoint(
                ds=dt.strftime("%Y-%m-%d"),
                yhat=float(y_pred[i]),
                actual=float(y_true[i]),
                yhatLower=lower,
                yhatUpper=upper,
            )
        )
    return metrics, forecast_rows


def chronos_pipeline_device_context():
    """Chronos `BaseChronosPipeline.from_pretrained`에 넘기는 device_map/dtype과 동일."""
    import torch  # type: ignore

    device_map = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device_map == "cuda" else torch.float32
    return device_map, dtype, torch


@app.get("/diagnostics/chronos-device")
def diagnostics_chronos_device():
    """Chronos 모델이 GPU(cuda) 경로를 탈지 여부를 이 프로세스 기준으로 확인한다."""
    try:
        device_map, _dtype, torch = chronos_pipeline_device_context()
    except Exception as exc:
        return {
            "pipeline_device_map": None,
            "pipeline_dtype": None,
            "cuda_available": False,
            "cuda_device_name": None,
            "cuda_device_count": 0,
            "error": str(exc),
        }
    cuda_ok = device_map == "cuda"
    return {
        "pipeline_device_map": device_map,
        "pipeline_dtype": "bfloat16" if cuda_ok else "float32",
        "cuda_available": cuda_ok,
        "cuda_device_name": torch.cuda.get_device_name(0) if cuda_ok else None,
        "cuda_device_count": torch.cuda.device_count() if cuda_ok else 0,
    }


def run_chronos_bolt_base(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon_months: int):
    try:
        from chronos import BaseChronosPipeline  # type: ignore
    except Exception as import_error:
        raise RuntimeError(
            "Chronos 실행 라이브러리가 없습니다. requirements 재설치가 필요합니다 "
            "(chronos-forecasting / transformers / accelerate)."
        ) from import_error

    device_map, dtype, torch = chronos_pipeline_device_context()
    context = torch.tensor(train_df["y"].astype(float).values, dtype=torch.float32)
    try:
        pipeline = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-bolt-base",
            device_map=device_map,
            dtype=dtype,
        )
    except TypeError as config_error:
        if "input_patch_size" in str(config_error):
            raise RuntimeError(
                "Chronos-Bolt Base 로딩에 실패했습니다. "
                "ChronosPipeline 대신 BaseChronosPipeline이 필요하며, "
                "chronos-forecasting 최신 버전인지 확인해주세요."
            ) from config_error
        raise

    quantile_pred = pipeline.predict(inputs=context, prediction_length=horizon_months)
    if hasattr(quantile_pred, "detach"):
        quantile_arr = quantile_pred.detach().cpu().numpy()
    else:
        quantile_arr = np.asarray(quantile_pred)
    quantile_arr = np.asarray(quantile_arr, dtype=float)
    if quantile_arr.ndim != 3:
        raise ValueError(f"unexpected Chronos-Bolt output shape: {quantile_arr.shape}")

    quantiles = list(getattr(pipeline, "quantiles", []))
    if not quantiles:
        raise ValueError("Chronos-Bolt quantiles metadata is missing")
    if quantile_arr.shape[1] != len(quantiles):
        raise ValueError(
            f"quantile dimension mismatch: output={quantile_arr.shape[1]}, meta={len(quantiles)}"
        )
    if quantile_arr.shape[2] != horizon_months:
        raise ValueError(
            f"Chronos-Bolt prediction length mismatch: expected={horizon_months}, got={quantile_arr.shape[2]}"
        )

    # [batch=1, quantile, horizon] 형태에서 0.1/0.5/0.9 분위수를 추출한다.
    series_quantiles = quantile_arr[0]
    q10_idx = min(range(len(quantiles)), key=lambda i: abs(quantiles[i] - 0.1))
    q50_idx = min(range(len(quantiles)), key=lambda i: abs(quantiles[i] - 0.5))
    q90_idx = min(range(len(quantiles)), key=lambda i: abs(quantiles[i] - 0.9))

    lower = np.asarray(series_quantiles[q10_idx], dtype=float)
    y_pred = np.asarray(series_quantiles[q50_idx], dtype=float)
    upper = np.asarray(series_quantiles[q90_idx], dtype=float)

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


def run_chronos_2(train_df: pd.DataFrame, test_df: pd.DataFrame, horizon_months: int):
    try:
        from chronos import BaseChronosPipeline  # type: ignore
    except Exception as import_error:
        raise RuntimeError(
            "Chronos-2 실행 라이브러리가 없습니다. requirements 재설치가 필요합니다 "
            "(chronos-forecasting / transformers / accelerate)."
        ) from import_error

    device_map, dtype, torch = chronos_pipeline_device_context()
    # Chronos-2는 (n_series, n_variates, history_length) 형태 입력을 사용한다.
    history_values = train_df["y"].astype(float).values
    context = torch.tensor(history_values, dtype=torch.float32).unsqueeze(0).unsqueeze(0)
    try:
        pipeline = BaseChronosPipeline.from_pretrained(
            "amazon/chronos-2",
            device_map=device_map,
            dtype=dtype,
        )
        quantiles_req = [0.1, 0.5, 0.9]
        quantile_pred, mean_pred = pipeline.predict_quantiles(
            inputs=context,
            prediction_length=horizon_months,
            quantile_levels=quantiles_req,
        )
    except Exception as chronos_error:
        raise RuntimeError(
            "Chronos-2 실행에 실패했습니다. 모델 다운로드/메모리/라이브러리 상태를 확인해주세요."
        ) from chronos_error

    # Chronos-2는 list[tensor] 형태를 반환할 수 있으므로 첫 시계열/변수를 추출한다.
    q_tensor = quantile_pred[0] if isinstance(quantile_pred, list) else quantile_pred
    m_tensor = mean_pred[0] if isinstance(mean_pred, list) else mean_pred
    q_arr = (
        q_tensor.detach().cpu().numpy()
        if hasattr(q_tensor, "detach")
        else np.asarray(q_tensor, dtype=float)
    )
    m_arr = (
        m_tensor.detach().cpu().numpy()
        if hasattr(m_tensor, "detach")
        else np.asarray(m_tensor, dtype=float)
    )

    q_arr = np.asarray(q_arr, dtype=float)
    m_arr = np.asarray(m_arr, dtype=float)
    if q_arr.ndim != 3:
        raise ValueError(f"unexpected Chronos-2 quantile shape: {q_arr.shape}")
    if q_arr.shape[1] != horizon_months:
        raise ValueError(
            f"Chronos-2 prediction length mismatch: expected={horizon_months}, got={q_arr.shape[1]}"
        )
    if q_arr.shape[2] != 3:
        raise ValueError(f"unexpected Chronos-2 quantile level shape: {q_arr.shape}")

    # shape: [n_variates, horizon, n_quantiles], 여기서는 첫 변수만 사용
    var0 = q_arr[0]
    lower = np.asarray(var0[:, 0], dtype=float)
    y_pred = np.asarray(var0[:, 1], dtype=float)
    upper = np.asarray(var0[:, 2], dtype=float)
    if m_arr.ndim == 2 and m_arr.shape[0] > 0 and m_arr.shape[1] == horizon_months:
        y_pred = np.asarray(m_arr[0], dtype=float)

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
    selected_model = payload.model_type
    model_name = selected_model
    fallback_reason: Optional[str] = None

    if selected_model == "linear_trend":
        try:
            metrics, forecast_rows = run_linear_fallback(train_df, test_df)
        except Exception as fallback_error:
            raise HTTPException(
                status_code=500,
                detail=f"forecasting failed: {str(fallback_error)}",
            )
    else:
        try:
            if selected_model == "prophet":
                metrics, forecast_rows = run_prophet(train_df, test_df, payload.horizon_months)
            elif selected_model == "arima":
                metrics, forecast_rows = run_arima(train_df, test_df, payload.horizon_months)
            elif selected_model == "sarima":
                metrics, forecast_rows = run_sarima(train_df, test_df, payload.horizon_months)
            elif selected_model == "chronos_bolt_base":
                metrics, forecast_rows = run_chronos_bolt_base(
                    train_df, test_df, payload.horizon_months
                )
            elif selected_model == "chronos_2":
                metrics, forecast_rows = run_chronos_2(train_df, test_df, payload.horizon_months)
            else:
                raise ValueError(f"unsupported model_type: {selected_model}")
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

    history = [
        TimePoint(ds=row["ds"].strftime("%Y-%m-%d"), y=float(row["y"]))
        for _, row in df.iterrows()
    ]
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