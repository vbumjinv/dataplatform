"""[실사용 스크립트] 주별 DB 원천 받기 — 최종 주별 모델 변수(feature_sources.json)에 필요한 DB 원천을 한 읽기 전용 트랜잭션에서 이번 실행 메모리로 받는다.

입력: DB(dp.*, 읽기만)  |  출력: 메모리(db.MEM = 등록부 테이블, kw.sources.SQL_MEM = SQL 원천·공휴일) — 파일 없음(2026-11-24, 다른 서버 운영)
      표준 출력(받은 시각·원천별 행 수·마지막 날짜)
실행(service_5): python -B extract_db.py   (받기만 확인. 예측·재학습은 wk_data.refresh() 가 같은 일을 한다)
"""
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import json

import pandas as pd

import wk_paths as P

HOLIDAY_SQL = ("select locdate as date, 1 as close from dp.datagokr_restdeinfo where isholiday = 'Y' "
               "union select locdate as date, 1 as close from dp.datagokr_restdeinfo_lrd where isholiday = 'Y'")   # kw.sources.kr_holidays 와 같음


def source_config():
    return pd.DataFrame(json.loads(P.SOURCES_CONFIG.read_text(encoding="utf-8")))


def sql_sources():
    """{캐시 이름: SQL}. feature_sources.json 의 SQL 원천(VKOSPI 는 KR_VKOSPI_DB) + 공휴일."""
    F = source_config()
    out = {("KR_VKOSPI_DB" if r.source_id == "KR_VKOSPI" else r.source_id): r.sql for r in F[F.sql.notna()].drop_duplicates("source_id").itertuples()}
    return out | {"KR_HOLIDAY_DB": HOLIDAY_SQL}


def _extract():
    SRC, db = P.setup()
    from kp.dataset import needed_keys
    from sqlalchemy import text
    taken = pd.Timestamp.now(tz="Asia/Seoul").isoformat()
    with db.get_engine().connect() as conn:
        conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        F = source_config()
        cache_keys = {part.split("=")[0] for v in F.db for part in str(v).split(";") if "=" in part}   # 등록부 테이블 원천(us_nasdaq 등)
        res = db.extract(conn, sorted(set(needed_keys()) | cache_keys))
        sql = {n: SRC.read_db_sql(q, n, refresh=True, conn=conn) for n, q in sql_sources().items()}
    bad = res[res.rows == 0]
    if len(bad):
        raise RuntimeError("받지 못한 DB 원천: " + "; ".join(f"{r.key} ({r.table}): {r.note}" for r in bad.itertuples()))
    empty_sql = [name for name, frame in sql.items() if SRC.series_from_frame(frame).empty]
    if empty_sql:
        raise ValueError(f"빈 SQL 원천: {empty_sql}")
    man = {"taken_at": taken, "tables": {r.key: {"table": r.table, "rows": int(r.rows)} for r in res.itertuples()},
           "sql": {n: {"rows": len(d), "last": str(SRC.series_from_frame(d).index.max().date())} for n, d in sql.items()}}
    print(f"추출 시각: {taken}")
    print(f"받음: 테이블 {len(res)}, SQL 원천 {len(sql)}(메모리)")
    for n, v in man["sql"].items():
        print(f"  {n}: {v['rows']}행, 마지막 {v['last']}")


def main():
    """이전에 받은 것을 비우고 새로 받는다. 받기가 실패하면 비운 채로 멈춘다(지난 자료로 예측하지 않음)."""
    SRC, db = P.setup()
    db.MEM.clear()
    SRC.SQL_MEM.clear()
    SRC._CALS.pop("KR", None)
    try:
        _extract()
    except Exception:
        db.MEM.clear()
        SRC.SQL_MEM.clear()
        raise


if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock(write=False):
        main()
