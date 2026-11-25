"""[실사용 스크립트] 5거래일 저장소 점검 및 PostgreSQL 초기 모델 등록.

원천 점검: python -B run_mlops_setup.py --check-sources
운영 서버: python -B run_mlops_setup.py --bootstrap          # 구조·권한·파일만 확인
           python -B run_mlops_setup.py --bootstrap --write  # v3와 구성 OOS 최초 등록
           python -B run_mlops_setup.py --status             # 운영 모델·OOS 조회
DBA용 SQL 출력: python -B run_mlops_setup.py --sql
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parent / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import argparse
from pathlib import Path


def ddl() -> str:
    """PostgreSQL CREATE 문(스키마 dp)."""
    from sqlalchemy import MetaData
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.schema import CreateIndex, CreateTable
    import wk_store
    T = wk_store._defs(MetaData(schema="dp"))
    out = []
    for t in T.values():
        out.append(str(CreateTable(t).compile(dialect=postgresql.dialect())).strip() + ";")
        out += [str(CreateIndex(i).compile(dialect=postgresql.dialect())).strip() + ";" for i in t.indexes]
    return "\n\n".join(out)


def upload_seed(src: Path):
    """슬롯별 운영 학습본과 재학습용 구성 OOS를 처음 한 번 등록한다."""
    import joblib
    import wk_data
    import wk_models
    import wk_range
    import wk_store

    if wk_data._holidays().empty:
        raise RuntimeError("PostgreSQL 공휴일 원천이 비어 있습니다. 초기 OOS를 등록하기 전에 --check-sources로 확인하세요.")
    files = {slot: src / "artifacts" / slot / "champion.joblib" for slot in _WP.SLOTS}
    missing = [str(f) for f in files.values() if not f.is_file()]
    if missing:
        raise FileNotFoundError("초기 학습본 누락: " + ", ".join(missing))
    active = {slot: wk_models.load(slot) for slot in files}
    models = {slot: active[slot] or joblib.load(f) for slot, f in files.items()}
    seeds = {slot: wk_models.range_oos(slot, m) for slot, m in models.items()}
    for tp in ("W0", "W2"):
        wk_range.align_seeds(seeds[f"{tp}_cls"], seeds[f"{tp}_reg"])
    eng, _ = wk_store.engine()
    with eng.begin() as con:
        for slot, m in models.items():
            if active[slot] is not None:
                continue
            wk_models.save_component_oos(slot, m, con=con)
            print(f"학습본 {slot}: {wk_models.save(slot, 'champion', m, con=con)}")


def check_server(src: Path, *, require_seed_files=True):
    """운영 계정으로 신규 DB 구조와 권한을 읽기 전용으로 검사한다."""
    from sqlalchemy import inspect, text
    import wk_store

    eng, tables = wk_store.require_server_db()
    with eng.begin() as con:
        con.exec_driver_sql("SET TRANSACTION READ ONLY")
        db = inspect(con)
        existing = set(db.get_table_names(schema="dp"))
        missing = sorted(set(tables) - existing)
        if missing:
            raise RuntimeError(f"DBA가 먼저 생성해야 할 테이블: {missing}")
        errors = []
        for name, table in tables.items():
            args = {"table": f"dp.{name}"}
            rights = con.execute(text(
                "SELECT has_table_privilege(:table, 'SELECT'), has_table_privilege(:table, 'INSERT'), "
                "has_table_privilege(:table, 'UPDATE'), has_table_privilege(:table, 'DELETE')"), args).one()
            denied = [p for p, allowed in zip(("SELECT", "INSERT", "UPDATE", "DELETE"), rights) if not allowed]
            if denied:
                errors.append(f"dp.{name}: 권한 부족 {', '.join(denied)}")
            columns = {c["name"] for c in db.get_columns(name, schema="dp")}
            if absent := sorted(set(table.c.keys()) - columns):
                errors.append(f"dp.{name}: 누락 컬럼 {absent}")
            primary_key = db.get_pk_constraint(name, schema="dp")["constrained_columns"]
            if list(primary_key) != wk_store.KEYS[name]:
                errors.append(f"dp.{name}: 기본 키 불일치")
            if "id" in table.c and not con.scalar(text(
                "SELECT has_sequence_privilege(pg_get_serial_sequence(:table, 'id'), 'USAGE')"), args):
                errors.append(f"dp.{name}.id: 시퀀스 USAGE 또는 자동 번호 연결 확인")
        idx = next((i for i in db.get_indexes("kospi5_mlops_model", schema="dp")
                    if i["name"] == "kospi5_mlops_model_role"), None)
        if not (idx and idx["unique"] and idx["column_names"] == ["objective", "role"]
                and idx.get("dialect_options", {}).get("postgresql_where")):
            errors.append("dp.kospi5_mlops_model: 모델 역할 부분 UNIQUE 인덱스 확인")
        for name in ("krx_kospi_dd_trd", "news_stock_article", "news_feature_orig"):
            if not con.scalar(text("SELECT has_table_privilege(:table, 'SELECT')"), {"table": f"dp.{name}"}):
                errors.append(f"dp.{name}: 원천 SELECT 권한 확인")
        if errors:
            raise RuntimeError("운영 DB 점검 실패\n" + "\n".join(errors))
    if require_seed_files:
        validate_seed_files(src)
    print("운영 DB 점검 통과: dp 테이블 12개·컬럼·키·역할 인덱스·권한")


def validate_seed_files(src: Path):
    """동봉한 v3 학습본 4개의 모델 정의와 구성·범위 OOS를 점검한다."""
    import joblib
    import numpy as np
    import pandas as pd
    import wk_models
    import wk_range

    seeds = {}
    for slot in _WP.SLOTS:
        path = src / "artifacts" / slot / "champion.joblib"
        m = wk_models._validate(joblib.load(path), slot)
        if m.get("variant") != "v3" or getattr(m["model"], "slot", None) != slot:
            raise ValueError(f"{slot}: 동봉한 v3 슬롯 학습본을 확인하세요.")
        series = m.get("component_oos", {})
        if not series or set(series) != set(m["training_definition"]["features"]):
            raise ValueError(f"{slot}: 구성 OOS가 학습 정의와 다릅니다.")
        for component, h in series.items():
            if (not isinstance(h, pd.Series) or not isinstance(h.index, pd.DatetimeIndex)
                    or h.empty or not h.index.is_unique or h.index.hasnans or not np.isfinite(h.to_numpy()).all()):
                raise ValueError(f"{slot}/{component}: 구성 OOS 날짜·값을 확인하세요.")
        seeds[slot] = wk_models.range_oos(slot, m)
    for tp in _WP.TPS:
        wk_range.align_seeds(seeds[f"{tp}_cls"], seeds[f"{tp}_reg"])
    print("초기 v3 학습본 4개·구성 OOS·범위 OOS 점검 통과")


def check_sources():
    """운영 계정으로 예측 원천 행과 뉴스·해설 조회 권한을 검사한다."""
    from datetime import date, timedelta
    from sqlalchemy import text
    import extract_db
    import wk_explain
    import wk_news
    import wk_store
    from wk_news_pick import SQL as evidence_sql

    eng, _ = wk_store.require_server_db()
    extract_db.main()
    day = date.today()
    end = day + timedelta(days=1)
    query_set = [
        (wk_news.SCORE_SQL, {"s": day, "e": end, "as_of": None}),
        (wk_news.TOKEN_FEATURE_SQL, {"s": day, "e": end, "as_of": None}),
        (wk_news.TOKEN_ARTICLE_SQL, {"k": [], "as_of": None}),
        (evidence_sql, {"lo": day, "hi": end, "as_of": None}),
    ]
    query_set.extend(wk_explain._sql(kind, table, condition)
                     for kind, table, condition, _, _ in wk_explain.SERIES.values())
    with eng.begin() as con:
        con.exec_driver_sql("SET TRANSACTION READ ONLY")
        for query, params in query_set:
            con.execute(text(f"SELECT * FROM ({query}) AS source_check LIMIT 0"), params)
    print("시세 원천·뉴스·해설 지표 조회 점검 통과")


def check_registered():
    """등록된 운영 모델과 재학습에 필요한 구성 OOS 행이 있는지 확인한다."""
    from sqlalchemy import func, select
    import wk_models
    import wk_store

    eng, tables = wk_store.require_server_db()
    oos = tables["kospi5_mlops_oos"]
    with eng.connect() as con:
        for slot in _WP.SLOTS:
            m = wk_models.load(slot)
            if m is None or m.get("variant") != "v3":
                raise RuntimeError(f"{slot}: v3 운영 학습본이 등록되지 않았습니다.")
            counts = dict(con.execute(select(oos.c.component, func.count()).where(
                oos.c.objective == slot, oos.c.line == "v3").group_by(oos.c.component)).all())
            missing = set(m["training_definition"]["features"]) - counts.keys()
            if missing:
                raise RuntimeError(f"{slot}: PostgreSQL에 구성 OOS 누락 {sorted(missing)}")
            print(f"{slot} 등록 확인: 대상월 {m['trained_for']} · 구성 OOS {len(counts)}종")


def main():
    ap = argparse.ArgumentParser()
    command = ap.add_mutually_exclusive_group(required=True)
    command.add_argument("--bootstrap", action="store_true", help="운영 DB와 동봉 모델 점검. --write를 붙이면 v3 최초 등록")
    command.add_argument("--check-sources", action="store_true", help="예측과 해설의 PostgreSQL 원천 조회 점검")
    command.add_argument("--status", action="store_true", help="운영 DB 권한과 등록된 v3 모델/OOS 확인")
    command.add_argument("--sql", action="store_true", help="DBA용 PostgreSQL DDL 출력")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    if a.write and not a.bootstrap:
        ap.error("--write는 --bootstrap과 함께 사용하세요.")
    if a.sql:
        print(ddl())
        return
    if a.check_sources:
        check_sources()
        return
    src = _WP.HERE / "model"
    check_server(src, require_seed_files=a.bootstrap)
    if a.bootstrap and a.write:
        from wk_lock import service_lock
        with service_lock():
            upload_seed(src)
            check_registered()
    if a.status:
        check_registered()


if __name__ == "__main__":
    from sqlalchemy.exc import DBAPIError
    try:
        main()
    except (RuntimeError, ValueError) as exc:
        _sys.exit(str(exc))
    except DBAPIError as exc:
        reason = str(exc.orig).splitlines()[0]
        _sys.exit(f"PostgreSQL 점검 실패: {reason}")
