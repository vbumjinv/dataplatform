"""[뉴스] 기사 테이블 dp.news_stock_article 읽기·쓰기 — Jev 처리용 기사 읽기와 크롤링 결과 적재.

사용처: service/run_news_features.py(읽기), service/run_news_crawl.py(쓰기)
읽기: body_status='ok' 기사만, title·summary 정리 후 available_at_kst = max(발행, 수정) 추가.
쓰기: upsert_articles — 기본은 이미 있는 기사(article_key)를 건드리지 않는다(다른 크롤러가 같은 테이블에 적재 중).
"""
from __future__ import annotations

import time

import pandas as pd

from db import get_engine
from .common import add_available_at
from .settings import ARTICLE_TABLE, AVAILABLE_AT_COLUMN, ID_COLUMN, KST, OK_BODY_STATUS
from .text_clean import clean_article_bodies, prepare_articles

READ_COLUMNS = ["article_key", "published_at", "modified_at", "body_fetched_at", "publisher", "title", "summary", "body", "body_status"]
LAST_TIMINGS: dict[str, float] = {}      # 마지막 load_db_news 단계별 소요 시간(초): db_query_s, title_summary_prep_s


def load_db_news(start: str | None = None, end: str | None = None, verbose: bool = True,
                 fetched_from: pd.Timestamp | None = None, fetched_to: pd.Timestamp | None = None) -> pd.DataFrame:
    """body_status='ok' 기사를 읽고 title·summary를 정리한다(본문은 원문).
    start/end: 발행일(KST 날짜, 양 끝 포함)로 고른다. fetched_from/fetched_to: body_fetched_at 구간 (from, to]으로 고른다(정기 실행)."""
    from sqlalchemy import text
    t0 = time.perf_counter()
    where, params = ["body_status = :ok"], {"ok": OK_BODY_STATUS}
    if start is not None:
        where.append("published_at >= :s")
        params["s"] = pd.Timestamp(start).tz_localize(KST).to_pydatetime()
    if end is not None:
        where.append("published_at < :e")                                       # 끝 날짜 포함 -> 다음 날 0시 미만
        params["e"] = (pd.Timestamp(end) + pd.Timedelta(days=1)).tz_localize(KST).to_pydatetime()
    if fetched_from is not None:
        where.append("body_fetched_at > :ff")
        params["ff"] = fetched_from.to_pydatetime()
    if fetched_to is not None:
        where.append("body_fetched_at <= :ft")
        params["ft"] = fetched_to.to_pydatetime()
    sql = text(f"SELECT {', '.join(READ_COLUMNS)} FROM {ARTICLE_TABLE} WHERE " + " AND ".join(where))
    with get_engine().connect() as con:
        raw = pd.read_sql(sql, con, params=params)
    t1 = time.perf_counter()
    if verbose:
        rng = f"발행 {start}~{end}" if start is not None else f"수집 ({fetched_from}, {fetched_to}]"
        print(f"DB 조회: {ARTICLE_TABLE} {rng} body_status={OK_BODY_STATUS} {len(raw):,}건 ({t1 - t0:.1f}초)")
    if raw.empty:
        LAST_TIMINGS.update(db_query_s=t1 - t0, title_summary_prep_s=0.0, db_rows=0)
        return raw.assign(**{AVAILABLE_AT_COLUMN: pd.Series(dtype=f"datetime64[ns, {KST}]")})
    df = prepare_articles(raw, verbose=verbose)
    for c in ("published_at", "modified_at", "body_fetched_at"):
        df[c] = df[c].dt.tz_convert(KST)
    df = add_available_at(df).drop(columns=["published_at_kst"])
    df[ID_COLUMN] = df[ID_COLUMN].astype(str)
    LAST_TIMINGS.update(db_query_s=t1 - t0, title_summary_prep_s=time.perf_counter() - t1, db_rows=len(raw))
    return df.sort_values(["published_at", ID_COLUMN]).reset_index(drop=True)


def clean_bodies(df: pd.DataFrame, verbose: bool = True) -> pd.DataFrame:
    """Stage 1을 통과한 기사에만 쓴다. body -> body_clean 정리, 빈 본문 제거, 같은 날 같은 본문 중복 제거."""
    t0 = time.perf_counter()
    out = clean_article_bodies(df, id_col=ID_COLUMN, verbose=verbose)
    LAST_TIMINGS.update(body_clean_s=time.perf_counter() - t0, body_clean_in=len(df), body_clean_out=len(out))
    return out


# ------------------------------------------------------------------ 크롤링 결과 적재
WRITE_COLUMNS = [
    "article_key", "office_id", "article_id", "category", "published_at", "modified_at", "title", "summary",
    "publisher", "reporter", "url", "body", "body_chars", "content_hash", "crawl_date", "list_fetched_at",
    "body_fetched_at", "body_status", "body_error",
]
REQUIRED_COLUMNS = ["article_key", "office_id", "article_id", "category", "published_at", "title", "url", "crawl_date", "body_status"]
BODY_STATUSES = {"ok", "low_quality", "failed"}      # DB에 이미 쓰이는 값(2026-11-02 조회: ok·low_quality·failed)


def existing_keys(keys: list[str], engine=None) -> set[str]:
    """keys 중 이미 기사 테이블에 있는 article_key."""
    from sqlalchemy import bindparam, text
    engine = engine or get_engine()
    q = text(f"SELECT article_key FROM {ARTICLE_TABLE} WHERE article_key IN :keys").bindparams(bindparam("keys", expanding=True))
    found: set[str] = set()
    with engine.connect() as con:
        for i in range(0, len(keys), 5000):
            found.update(r[0] for r in con.execute(q, {"keys": keys[i:i + 5000]}))
    return found


def _db_value(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NaT:
        return None
    if isinstance(v, str) and v == "":
        return None
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime()
    if hasattr(v, "item"):
        return v.item()
    return v


def upsert_articles(df: pd.DataFrame, write: bool = False, update_existing: bool = False, engine=None) -> dict:
    """크롤링 결과(crawler.build_db_rows 반환 형식)를 dp.news_stock_article 에 넣는다.

    write=False(기본): 검증·건수만 출력하고 쓰지 않는다(dry-run).
    update_existing=False(기본): 이미 있는 article_key는 건드리지 않는다(ON CONFLICT DO NOTHING).
        다른 크롤러가 같은 테이블에 적재하고 있으므로 덮어쓰기는 사용자 확인 뒤에만 켠다.
    한 번에 한 트랜잭션으로 쓴다(중간에 실패하면 전부 되돌린다).
    """
    from sqlalchemy import text
    missing = [c for c in WRITE_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"적재할 열이 없습니다: {missing}")
    for c in REQUIRED_COLUMNS:
        if df[c].isna().any() or (df[c].astype(str).str.strip() == "").any():
            raise ValueError(f"{c} 값이 비어 있는 행이 있습니다(NOT NULL 열).")
    bad = set(df["body_status"]) - BODY_STATUSES
    if bad:
        raise ValueError(f"body_status 값이 기존 값(ok/low_quality/failed)과 다릅니다: {sorted(bad)}")
    if df["article_key"].duplicated().any():
        raise ValueError("article_key 중복 행이 있습니다.")
    engine = engine or get_engine()
    keys = df["article_key"].astype(str).tolist()
    have = existing_keys(keys, engine)
    stats = {"rows": len(df), "existing": len(have), "new": len(df) - len(have),
             "status": df["body_status"].value_counts().to_dict(), "written": 0}
    print(f"[기사 적재] 입력 {stats['rows']:,}건 | DB에 이미 있음 {stats['existing']:,}건 | 새 기사 {stats['new']:,}건 | 본문 상태 {stats['status']}")
    if not write:
        print("[기사 적재] dry-run: DB에 쓰지 않았습니다(쓰려면 --write).")
        return stats
    cols = ", ".join(WRITE_COLUMNS)
    vals = ", ".join(f":{c}" for c in WRITE_COLUMNS)
    if update_existing:
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in WRITE_COLUMNS if c != "article_key")
        conflict = f"ON CONFLICT (article_key) DO UPDATE SET {sets}"
    else:
        conflict = "ON CONFLICT (article_key) DO NOTHING"
    sql = text(f"INSERT INTO {ARTICLE_TABLE} ({cols}) VALUES ({vals}) {conflict}")
    rows = [{c: _db_value(r[c]) for c in WRITE_COLUMNS} for r in df.to_dict("records")]
    for r in rows:      # NOT NULL + 기본값 '' 인 열은 None 대신 빈 문자열/0
        for c in ("summary", "publisher", "reporter", "body", "content_hash", "body_error"):
            r[c] = r[c] or ""
        r["body_chars"] = int(r["body_chars"] or 0)
    with engine.begin() as con:
        res = con.execute(sql, rows)
    stats["written"] = res.rowcount if res.rowcount is not None and res.rowcount >= 0 else len(rows)
    print(f"[기사 적재] 완료: {stats['written']:,}건 {'upsert' if update_existing else '새로 추가'}")
    return stats
