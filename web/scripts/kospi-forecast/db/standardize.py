"""[실사용 모듈] 테이블 원본(열 이름이 제각각) -> 표준 열 Date / Open / High / Low / Close / Volume (문자열 그대로).
값 변환·결측 처리는 하지 않는다(프로젝트의 전처리 단계 몫). FRED처럼 값 하나뿐인 지표는 Close로 둔다."""
from __future__ import annotations
import pandas as pd

CANDIDATES = {
    "Date": ["date", "observation_date", "trd_dd", "bas_dd", "base_date", "trade_date", "trading_date",
             "datetime", "time", "tradedate", "dt_date", "ymd", "일자", "날짜"],
    "Open": ["open", "tdd_opnprc", "opnprc", "open_price", "opening_price"],
    "High": ["high", "tdd_hgprc", "hgprc", "high_price"],
    "Low": ["low", "tdd_lwprc", "lwprc", "low_price"],
    "Close": ["close", "tdd_clsprc", "clsprc", "close_price", "clpr", "value", "data_value", "index_value", "adj_close"],
    "Volume": ["volume", "acc_trdvol", "trdvol", "trade_volume", "vol"],
}


def resolve_columns(columns, override: dict | None = None) -> dict:
    """표준 열 -> 실제 열 이름. 못 찾으면 None."""
    low = {c.lower(): c for c in columns}
    out = {}
    for std, cands in CANDIDATES.items():
        if override and std in override:
            out[std] = override[std]; continue
        out[std] = next((low[c] for c in cands if c in low), None)
    return out


def standardize(raw: pd.DataFrame, override: dict | None = None) -> pd.DataFrame:
    m = resolve_columns(raw.columns, override)
    if m["Date"] is None or m["Close"] is None:
        raise ValueError(f"날짜/종가 열을 인식하지 못했습니다. 열: {list(raw.columns)} -> db/tables.py 에 cols 를 지정하세요.")
    out = pd.DataFrame({"Date": raw[m["Date"]]})
    for k in ("Open", "High", "Low", "Close", "Volume"):
        out[k] = raw[m[k]] if m[k] is not None else pd.NA
    out["Date"] = out["Date"].astype("string")
    d = out["Date"].str.strip()
    if d.str.fullmatch(r"\d{8}").fillna(False).all():           # 20260105 형식(ECOS 등)
        out["Date"] = pd.to_datetime(d, format="%Y%m%d").dt.strftime("%Y-%m-%d")
    elif d.str.fullmatch(r"\d{6}").fillna(False).all():         # 202601 형식(ECOS·KOSIS 월별) -> 그 달 마지막 날
        out["Date"] = (pd.to_datetime(d, format="%Y%m") + pd.offsets.MonthEnd(0)).dt.strftime("%Y-%m-%d")
    return out
