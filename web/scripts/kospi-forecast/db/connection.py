"""[실사용 모듈] PostgreSQL 연결과 스키마 조회."""
from __future__ import annotations
import pandas as pd
from . import settings as S


def get_engine():
    from sqlalchemy import create_engine
    from sqlalchemy.engine import URL
    if not S.DB_PASSWORD:
        raise RuntimeError("DP_DB_PASSWORD가 비어 있습니다. 웹 .env 의 DB 접속 정보를 확인하세요.")
    url = URL.create("postgresql+psycopg2", username=S.DB_USER, password=S.DB_PASSWORD,
                     host=S.DB_HOST, port=S.DB_PORT, database=S.DB_NAME)
    return create_engine(url, pool_pre_ping=True, connect_args={"connect_timeout": 15})


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
