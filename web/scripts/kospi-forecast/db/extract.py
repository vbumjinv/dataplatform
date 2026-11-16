"""[실사용 모듈] 테이블 읽기와 원본 캐시(db/raw/<key>.parquet). 원본은 값 변환 없이 문자열로 저장해 '.' 같은 표기를 보존한다."""
from __future__ import annotations
import pandas as pd
from . import settings as S
from .tables import T
from .standardize import standardize


def read_table(engine, key: str, start: str | None = None, end: str | None = None) -> pd.DataFrame:
    """등록부의 key 테이블을 모든 열 그대로 읽는다. start/end는 날짜 열이 인식될 때만 적용(문자열 비교)."""
    from sqlalchemy import text
    spec = T[key]
    q = engine.dialect.identifier_preparer.quote
    sql = f"SELECT * FROM {q(S.DB_SCHEMA)}.{q(spec['table'])}"
    conds, params = [], {}
    for i, (col, val) in enumerate((spec.get("where") or {}).items()):
        vals = val if isinstance(val, (list, tuple)) else [val]
        names = []
        for j, v in enumerate(vals):
            p = f"w{i}_{j}"; params[p] = v; names.append(f":{p}")
        conds.append(f"{q(col)} IN ({', '.join(names)})")
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    df = pd.read_sql(text(sql), engine, params=params)
    if (start or end) and len(df):
        try:
            dcol = standardize(df, spec.get("cols"))["Date"]
            dd = pd.to_datetime(dcol, errors="coerce")
            keep = pd.Series(True, index=df.index)
            if start: keep &= dd >= pd.Timestamp(start)
            if end: keep &= dd <= pd.Timestamp(end)
            df = df[keep.fillna(True)]
        except ValueError:
            pass
    return df


def raw_path(key: str):
    return S.RAW_DIR / f"{key}.parquet"


def save_raw(key: str, df: pd.DataFrame):
    out = df.copy()
    for c in out.columns:
        out[c] = out[c].astype("string")
    out.to_parquet(raw_path(key), index=False)


def load_raw(key: str) -> pd.DataFrame | None:
    p = raw_path(key)
    return pd.read_parquet(p) if p.exists() else None


def load_standardized(key: str) -> pd.DataFrame | None:
    """캐시를 읽어 Date/Open/High/Low/Close/Volume 열로 맞춘다(문자열 그대로)."""
    raw = load_raw(key)
    return None if raw is None else standardize(raw, T[key].get("cols"))


def extract(engine, keys=None, start=None, end=None, skip_existing=False) -> pd.DataFrame:
    rows = []
    for key in (keys or list(T)):
        if skip_existing and raw_path(key).exists():
            continue
        try:
            df = read_table(engine, key, start, end)
        except Exception as exc:
            rows.append({"key": key, "table": T[key]["table"], "rows": 0, "note": f"{type(exc).__name__}: {str(exc)[:100]}"})
            continue
        if len(df):
            save_raw(key, df)
        rows.append({"key": key, "table": T[key]["table"], "rows": len(df), "note": "" if len(df) else "행 없음"})
    return pd.DataFrame(rows)
