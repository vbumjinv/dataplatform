"""[실사용 모듈] (service_5 복사본, 원본: service_daily/db/extract.py) 테이블 읽기와 이번 실행의 원본 보관(메모리, 파일 없음 — 2026-11-24). 원본은 값 변환 없이 문자열로 두어 '.' 같은 표기를 보존한다."""
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


MEM: dict[str, pd.DataFrame] = {}                                        # 이번 실행에 받은 원본(프로세스가 끝나면 사라짐)


def with_today(engine, df: pd.DataFrame) -> pd.DataFrame:
    """kospi 원본에 당일 테이블(krx_kospi_1001)을 합친다: 1001에 있는 날짜는 1001 값, 나머지는 krx_kospi_dd_trd(일별 service_daily db_snapshot.read_kospi 와 같은 규칙, 2026-11-25).
    1001 열은 등록부 cols 로 dd_trd 열 이름에 맞춘다(그 밖의 열은 비움). 같은 날짜가 여러 행이면 load_dtm 이 가장 늦은 행."""
    today = read_table(engine, "kospi_today")
    if "load_dtm" in today:
        today = today.sort_values("load_dtm", kind="stable", na_position="first")
    src, dst = T["kospi_today"]["cols"], T["kospi"]["cols"]
    today = today.dropna(subset=[src["Date"], src["Close"]]).drop_duplicates(src["Date"], keep="last")
    if today.empty:
        return df
    add = pd.DataFrame({dst[k]: today[src[k]].to_numpy() for k in src if k in dst})
    add[dst["Date"]] = pd.to_datetime(add[dst["Date"]].astype(str)).dt.strftime("%Y-%m-%d")
    for col, val in (T["kospi"].get("where") or {}).items():
        add[col] = val
    df = df.assign(**{dst["Date"]: pd.to_datetime(df[dst["Date"]].astype(str)).dt.strftime("%Y-%m-%d")})   # 날짜 표기를 같게(원본은 save_raw 에서 어차피 문자열)
    return pd.concat([df[~df[dst["Date"]].isin(add[dst["Date"]])], add], ignore_index=True).sort_values(dst["Date"], kind="stable").reset_index(drop=True)


def save_raw(key: str, df: pd.DataFrame):
    out = df.copy()
    for c in out.columns:
        out[c] = out[c].astype("string")
    MEM[key] = out


def load_raw(key: str) -> pd.DataFrame | None:
    """이번 실행에 받은 원본. 아직 안 받았으면 DB 에서 바로 읽는다(읽기 전용)."""
    if key not in MEM:
        from sqlalchemy import text
        from .connection import get_engine
        with get_engine().connect() as conn:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            df = read_table(conn, key)
            if key == "kospi":
                df = with_today(conn, df)
        if df.empty:
            return None
        save_raw(key, df)
    return MEM[key]


def load_standardized(key: str) -> pd.DataFrame | None:
    """캐시를 읽어 Date/Open/High/Low/Close/Volume 열로 맞춘다(문자열 그대로)."""
    raw = load_raw(key)
    return None if raw is None else standardize(raw, T[key].get("cols"))


def extract(engine, keys=None, start=None, end=None, skip_existing=False) -> pd.DataFrame:
    rows = []
    for key in (keys or list(T)):
        if skip_existing and key in MEM:
            continue
        try:
            df = read_table(engine, key, start, end)
            if key == "kospi":
                df = with_today(engine, df)
        except Exception as exc:
            rows.append({"key": key, "table": T[key]["table"], "rows": 0, "note": f"{type(exc).__name__}: {str(exc)[:100]}"})
            continue
        if len(df):
            save_raw(key, df)
        rows.append({"key": key, "table": T[key]["table"], "rows": len(df), "note": "" if len(df) else "행 없음"})
    return pd.DataFrame(rows)
