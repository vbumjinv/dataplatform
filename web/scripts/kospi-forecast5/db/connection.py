"""[실사용 모듈] (service_5 복사본, 원본: service_daily/db/connection.py) PostgreSQL 연결과 스키마 조회."""
from __future__ import annotations
import pandas as pd
from functools import lru_cache
from . import settings as S


@lru_cache(maxsize=1)
def get_engine():
    from sqlalchemy import create_engine
    from sqlalchemy.engine import URL
    required = {"DP_DB_URL 또는 DB_HOST": S.DB_HOST, "DP_DB_NAME 또는 URL의 DB 이름": S.DB_NAME,
                "DP_DB_USER": S.DB_USER, "DP_DB_PASSWORD": S.DB_PASSWORD}
    if missing := [name for name, value in required.items() if not value]:
        raise RuntimeError("PostgreSQL 연결 설정 누락: " + ", ".join(missing))
    url = URL.create("postgresql+psycopg2", username=S.DB_USER, password=S.DB_PASSWORD,
                     host=S.DB_HOST, port=S.DB_PORT, database=S.DB_NAME)
    return create_engine(url, pool_pre_ping=True, hide_parameters=True, connect_args={"connect_timeout": 15})


def list_tables(engine, schema: str | None = None) -> pd.DataFrame:
    """스키마 안의 테이블·열·타입 목록."""
    from sqlalchemy import inspect
    insp = inspect(engine)
    schema = schema or S.DB_SCHEMA
    rows = []
    for t in insp.get_table_names(schema=schema):
        for col in insp.get_columns(t, schema=schema):
            rows.append({"table": t, "column": col["name"], "type": str(col["type"])})
    return pd.DataFrame(rows)
