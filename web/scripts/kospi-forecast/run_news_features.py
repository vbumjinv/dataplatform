"""[실사용 스크립트] 뉴스 LLM 피처 적재 — DB 기사(dp.news_stock_article)를 Jev Stage 1·2로 처리해 dp.news_feature_orig 에 기사 단위로 넣는다.

실행(service 폴더에서):
      python run_news_features.py --check          점검만: 경계·처리 대상 건수·빈 구간 의심 날짜 (API 호출·DB 쓰기 없음)
      python run_news_features.py                  첫 실행 = 게시일 2010-01-01 이후 전부, 이후 실행 = 새로 들어온 기사만 (크롤링마다, 예: 하루 4번)
      python run_news_features.py --create-table   dp.news_feature_orig 가 없을 때만: 기존과 같은 구조로 만든 뒤 처리
      --limit N  수집 순서로 앞의 N건만(테스트)  |  --no-write  호출은 하되 DB에 쓰지 않음(테스트)
      --start/--end YYYY-MM-DD  빈 구간 채우기(게시일 기간 지정)
입력: DB dp.news_stock_article(body_status='ok'), service/.env(DB_*, TYPESAFE_API_KEY)
출력: DB dp.news_feature_orig(Stage 1 통과·Stage 2 성공 기사만 upsert). 로컬 파일은 만들지 않는다(어느 PC에서 실행해도 DB만 보고 판단).

기준: 바탕화면 news_feature_from_scratch/news_feature_from_scratch.py(2026-10-29)와 같은 동작이다. 코드를 모듈로 나눴을 뿐
처리 순서·경계·프롬프트(Stage 1 9fa99cc98d22…, Stage 2 v4 aa30364cb9f6…)는 같다. 프롬프트는 import 때 SHA256 assert 로 확인한다.
동작(모두 DB 기준):
  - 경계 = 처리 범위 안에서 dp.news_feature_orig 에 결과가 있는(ok, 현재 Stage 2 프롬프트) 기사 중 가장 늦은 body_fetched_at.
    결과가 없으면(빈 테이블) 처음부터, 있으면 body_fetched_at > 경계 - 10분 인 기사부터 읽는다.
  - 기사는 (body_fetched_at, article_key) 순서로 2,000건씩 끊어 읽고, 이미 결과가 있는 기사는 Stage 1부터 건너뛴다.
  - 200건씩 Stage 1 -> 본문 정리 -> Stage 2 를 하고 수집 순서대로 적재한다. 실패하면 그 뒤는 적재하지 않고 종료 코드 1로 멈춘다
    (경계가 실패 기사를 지나치지 않게). 다시 실행하면 그 기사부터 이어서 처리한다.
  - 동시 실행은 PostgreSQL advisory lock으로 막는다(다른 PC 포함). 앞 실행이 돌고 있으면 바로 끝낸다(종료 코드 0).
  - 한계: reject는 저장하지 않으므로, 경계보다 앞인데 처리되지 않은 기사는 찾지 못한다. 실행 끝에 '빈 구간 의심' 날짜를 경고로 출력한다.
  - 같은 날 같은 본문의 중복 제거는 한 묶음(200건) 안에서만 적용된다.
  - --published-from 은 첫 실행 전에 정하고 바꾸지 않는다(뒤에 앞으로 넓히면 그 구간은 --start/--end 로 따로 처리).
"""
from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pandas as pd  # noqa: E402

from db import get_engine  # noqa: E402
from news.article_store import READ_COLUMNS, clean_bodies, load_db_news  # noqa: E402
from news.common import load_api_key  # noqa: E402
from news.feature_store import FeatureWriter, ensure_table, written_keys  # noqa: E402
from news.news_feature_jev import STAGE1_PROMPT_SHA256, STAGE2_PROMPT_SHA256, run_stage1, run_stage2  # noqa: E402
from news.settings import (ARTICLE_TABLE, AVAILABLE_AT_COLUMN, CHUNK_SIZE, FEATURE_TABLE, FETCHED_AT_COLUMN,  # noqa: E402
                           GAP_CHECK_DAYS, GAP_MIN_ARTICLES, GAP_MIN_RATIO, ID_COLUMN, JEV_MODEL, KEEP_DECISIONS, KST,
                           LOCK_ID, MAX_CONSECUTIVE_ERRORS, MAX_PARALLEL_WORKERS, OK_BODY_STATUS, OVERLAP, PAGE_SIZE,
                           PUBLISHED_AT_COLUMN, STAGE2_OK_VALUE)
from news.text_clean import prepare_articles  # noqa: E402

ap = argparse.ArgumentParser(description="뉴스 LLM 피처 적재: dp.news_stock_article -> Stage 1 -> Stage 2 -> dp.news_feature_orig")
ap.add_argument("--check", action="store_true", help="점검만(API 호출·DB 쓰기 없음)")
ap.add_argument("--create-table", action="store_true", help="dp.news_feature_orig 가 없으면 기존과 같은 구조로 만든다")
ap.add_argument("--published-from", default="2010-01-01", help="처리할 기사의 첫 게시일(KST). 첫 실행 전에 정하고 바꾸지 않는다")
ap.add_argument("--start", help="빈 구간 채우기: 게시일(KST) 시작 YYYY-MM-DD (양 끝 포함)")
ap.add_argument("--end", help="빈 구간 채우기: 끝 날짜")
ap.add_argument("--limit", type=int, help="수집 순서로 앞의 N건만(테스트)")
ap.add_argument("--no-write", action="store_true", help="DB에 쓰지 않음(테스트)")
ap.add_argument("--require-completion", action="store_true", help="자동화용: 다른 작업이 잠금을 잡아 건너뛰면 실패 코드로 종료")
ARGS = ap.parse_args()
if bool(ARGS.start) != bool(ARGS.end):
    ap.error("--start 와 --end 는 함께 지정하세요")
PUBLISHED_FROM = ARGS.published_from
PF_TS = pd.Timestamp(PUBLISHED_FROM, tz=KST).to_pydatetime()
WRITE_TO_DB = not ARGS.no_write
WRITE_LABEL = "적재" if WRITE_TO_DB else "검증(쓰기 안 함)"
ENGINE = get_engine()


# ================================================================== 경계·잠금·병렬 실행
def coverage_report(engine, days: int = GAP_CHECK_DAYS) -> pd.DataFrame:
    """최근 days일 게시 날짜별 기사 수·적재 수·비율. 비율이 낮은 날은 처리가 안 된 구간일 수 있다(reject와 구분 불가라 '의심')."""
    from sqlalchemy import text
    lo = (pd.Timestamp.now(tz=KST).normalize() - pd.Timedelta(days=days)).to_pydatetime()
    q = text(f"""SELECT (a.published_at AT TIME ZONE 'Asia/Seoul')::date AS pub_date, count(*) AS n_article,
                        count(f.article_key) AS n_feature
                 FROM {ARTICLE_TABLE} a
                 LEFT JOIN {FEATURE_TABLE} f ON f.article_key = a.article_key AND f.stage2_status = :ok AND f.prompt_sha256 = :sha
                 WHERE a.body_status = :bs AND a.published_at >= :lo GROUP BY 1 ORDER BY 1""")
    with engine.connect() as con:
        df = pd.read_sql(q, con, params={"ok": STAGE2_OK_VALUE, "sha": STAGE2_PROMPT_SHA256, "bs": OK_BODY_STATUS, "lo": lo})
    df["ratio"] = (df["n_feature"] / df["n_article"]).round(3)
    df["suspect"] = (df["n_article"] >= GAP_MIN_ARTICLES) & (df["ratio"] < GAP_MIN_RATIO)
    return df


def acquire_db_lock(engine):
    """DB advisory lock을 잡은 연결을 돌려준다. 다른 실행(어느 PC든)이 잡고 있으면 None. 연결을 닫으면 자동으로 풀린다."""
    from sqlalchemy import text
    con = engine.connect()
    if con.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_ID}).scalar():
        return con
    con.close()
    return None


def run_parallel(records: list[dict], fn, label: str) -> dict:
    """기사별로 fn을 병렬 호출해 성공 결과를 article_key -> 결과 dict로 모은다. 실패한 기사는 errors에 남는다.
    연속 오류가 MAX_CONSECUTIVE_ERRORS번이면 중단한다(이 묶음은 아무것도 적재되지 않으므로 다시 실행하면 이어서 처리)."""
    print(f"[{label}] {len(records)}건, 병렬 수={MAX_PARALLEL_WORKERS}")
    ok: dict[str, dict] = {}
    errors: dict[str, str] = {}
    if not records:
        return {"ok": ok, "errors": errors, "seconds": 0.0}
    consecutive = 0
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_WORKERS) as executor:
        futures = {executor.submit(fn, r): str(r[ID_COLUMN]) for r in records}
        for future in as_completed(futures):
            key = futures[future]
            try:
                rec = future.result()
            except Exception as exc:
                rec = {ID_COLUMN: key, "error": f"{type(exc).__name__}: {exc}"}
            if rec.get("error"):
                errors[key] = str(rec["error"])[:300]
                consecutive += 1
            else:
                ok[key] = {k: v for k, v in rec.items() if k != "error_traceback"}
                consecutive = 0
            if consecutive >= MAX_CONSECUTIVE_ERRORS:
                for f in futures:
                    f.cancel()
                first = next(iter(errors.items()))
                raise RuntimeError(f"[{label}] 연속 {MAX_CONSECUTIVE_ERRORS}회 실패했습니다. 첫 오류: {first}\n"
                                   "API 키·네트워크·모델명·DB를 확인한 뒤 같은 명령을 다시 실행하세요(이어서 처리).")
    seconds = time.perf_counter() - started
    print(f"[{label}] 완료: 성공 {len(ok)}, 오류 {len(errors)}, {seconds:.0f}초")
    return {"ok": ok, "errors": errors, "seconds": seconds}


# ================================================================== 묶음 처리
def stage2_row(row: dict) -> dict:
    # Stage 2 입력의 발행 시각은 기존 pilot과 같은 ISO 형식(+09:00)으로 전달한다.
    out = dict(row)
    out[PUBLISHED_AT_COLUMN] = row[PUBLISHED_AT_COLUMN].isoformat()
    return out


def process_chunk(chunk: pd.DataFrame, writer: FeatureWriter) -> tuple[dict, str | None]:
    """수집 순서로 정렬된 기사 묶음 하나: Stage 1 -> 본문 정리 -> Stage 2 -> 적재.
    적재는 묶음이 끝난 뒤 수집 순서대로 하고, 실패한 기사를 만나면 그 뒤 기사는 적재하지 않는다.
    그래야 경계(처리된 기사 중 가장 늦은 수집 시각)가 실패한 기사를 지나치지 않는다(다음 실행이 실패 기사부터 다시 처리)."""
    s1 = run_parallel(chunk.to_dict("records"), run_stage1, "Stage 1")
    passed = {k for k, r in s1["ok"].items() if r["stage1_screening_decision"] in KEEP_DECISIONS}
    stage2_df = clean_bodies(chunk[chunk[ID_COLUMN].isin(passed)], verbose=False)
    s2 = run_parallel([stage2_row(r) for r in stage2_df.to_dict("records")], run_stage2, "Stage 2")
    available_by_key = stage2_df.set_index(ID_COLUMN)[AVAILABLE_AT_COLUMN]

    stats = {"stage1": len(s1["ok"]), "reject": len(s1["ok"]) - len(passed), "stage2": len(s2["ok"]), "written": 0}
    for key in chunk[ID_COLUMN]:
        if key in s1["errors"] or key not in s1["ok"]:
            return stats, f"{key} Stage 1 실패: {s1['errors'].get(key, '결과 없음')}"
        if key not in passed or key not in available_by_key.index:
            continue                          # reject, 또는 본문 정리로 빠진 기사(빈 본문·같은 날 같은 본문)
        if key not in s2["ok"]:
            return stats, f"{key} Stage 2 실패: {s2['errors'].get(key, '결과 없음')}"
        s1r = s1["ok"][key]
        try:
            writer.write(s2["ok"][key], stage1_decision=s1r["stage1_screening_decision"],
                         stage1_confidence=s1r["stage1_confidence"], available_at_kst=available_by_key.loc[key])
        except Exception as exc:
            return stats, f"{key} DB 적재 실패: {type(exc).__name__}: {exc}"
        stats["written"] += 1
    return stats, None


def target_rows(label: str, news_df: pd.DataFrame) -> pd.DataFrame:
    """읽은 기사에서 이미 적재된 기사(dp.news_feature_orig)를 빼고 수집 순서로 정렬한다(--start/--end 기간 지정용)."""
    done = written_keys(ENGINE, news_df[ID_COLUMN].tolist(), STAGE2_PROMPT_SHA256) if len(news_df) else set()
    todo = news_df[~news_df[ID_COLUMN].isin(done)]
    todo = todo.sort_values([FETCHED_AT_COLUMN, ID_COLUMN]).reset_index(drop=True)
    if ARGS.limit is not None:
        todo = todo.head(ARGS.limit)
    print(f"[{label}] 읽은 기사 {len(news_df):,}건 | 이미 적재됨 {len(done):,}건 건너뜀"
          + f" | 이번 처리 대상 {len(todo):,}건" + (f" (--limit {ARGS.limit})" if ARGS.limit is not None else ""))
    return todo


def process_all(label: str, todo_df: pd.DataFrame, writer: FeatureWriter) -> None:
    """수집 순서로 CHUNK_SIZE건씩 처리한다. 실패하면 그 자리에서 멈추고 종료 코드 1로 끝낸다(다시 실행하면 이어서 처리)."""
    total = {"stage1": 0, "reject": 0, "stage2": 0, "written": 0}
    n_chunks = (len(todo_df) + CHUNK_SIZE - 1) // CHUNK_SIZE
    for i in range(n_chunks):
        chunk = todo_df.iloc[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
        print(f"\n--- [{label}] 묶음 {i + 1}/{n_chunks}: 수집 {chunk[FETCHED_AT_COLUMN].iloc[0]} ~ {chunk[FETCHED_AT_COLUMN].iloc[-1]}, {len(chunk)}건")
        stats, failure = process_chunk(chunk, writer)
        for k in total:
            total[k] += stats[k]
        print(f"묶음 {i + 1}: Stage 1 {stats['stage1']}건(reject {stats['reject']}), Stage 2 {stats['stage2']}건, {WRITE_LABEL} {stats['written']}건")
        if failure:
            sys.exit(f"\n실패로 멈춤: {failure}\n이 기사부터 뒤는 적재하지 않았습니다. 원인을 확인한 뒤 같은 파일을 다시 실행하면 여기서부터 이어서 처리합니다.")
    print(f"\n[{label}] 완료: Stage 1 {total['stage1']}건(reject {total['reject']}), Stage 2 {total['stage2']}건, DB {WRITE_LABEL} {total['written']}건")


def with_lock(fn) -> None:
    """DB lock을 잡고 fn(writer)을 실행한다. 다른 실행(어느 PC든)이 돌고 있으면 바로 끝낸다."""
    con = acquire_db_lock(ENGINE)
    if con is None:
        print("다른 실행이 진행 중입니다(DB lock). 이번 실행은 건너뜁니다. 남은 기사는 다음 실행이 처리합니다.")
        sys.exit(75 if ARGS.require_completion else 0)
    try:
        load_api_key()
        writer = FeatureWriter(model=JEV_MODEL, enabled=WRITE_TO_DB, engine=ENGINE)      # DB 열 구성 대조(다르면 중단)
        print(f"DB {WRITE_LABEL}, 묶음 크기={CHUNK_SIZE}")
        fn(writer)
    finally:
        con.close()                   # 연결을 닫으면 advisory lock이 풀린다


# ================================================================== 처리 범위 읽기(경계 방식)
def fresh_boundary() -> pd.Timestamp | None:
    """경계 = 처리 범위(PUBLISHED_FROM 이후) 기사 중 dp.news_feature_orig 에 결과가 있는 기사의 가장 늦은 body_fetched_at. 없으면 None(처음부터)."""
    from sqlalchemy import text
    q = text(f"SELECT max(a.body_fetched_at) FROM {FEATURE_TABLE} f JOIN {ARTICLE_TABLE} a USING (article_key) "
             "WHERE f.stage2_status = :ok AND f.prompt_sha256 = :sha AND a.published_at >= :pf")
    with ENGINE.connect() as con:
        v = con.execute(q, {"ok": STAGE2_OK_VALUE, "sha": STAGE2_PROMPT_SHA256, "pf": PF_TS}).scalar()
    return None if v is None else pd.Timestamp(v).tz_convert(KST)


def start_cursor() -> tuple:
    """읽기 시작점 (body_fetched_at, article_key). 경계가 없으면 처음부터."""
    boundary = fresh_boundary()
    if boundary is None:
        print(f"dp.news_feature_orig 에 처리 범위의 결과가 없습니다 -> 게시일 {PUBLISHED_FROM} 이후 기사를 처음부터 수집 순서대로 처리합니다")
        return (pd.Timestamp("1900-01-01", tz=KST), "")
    print(f"경계(처리된 기사 중 가장 늦은 수집 시각) = {boundary} -> 수집 시각 > {boundary - OVERLAP} 인 기사부터 읽는다")
    return (boundary - OVERLAP, "￿")         # 같은 시각의 기사는 모두 경계 뒤로 본다


def load_page(cursor: tuple, n: int) -> pd.DataFrame:
    """(body_fetched_at, article_key) > cursor 인 처리 범위 기사를 수집 순서로 n건 읽는다(load_db_news 와 같은 정리 적용)."""
    from sqlalchemy import text
    sql = text(f"SELECT {', '.join(READ_COLUMNS)} FROM {ARTICLE_TABLE} "
               "WHERE body_status = :ok AND published_at >= :pf AND body_fetched_at IS NOT NULL "
               "AND (body_fetched_at, article_key) > (:cf, :ck) ORDER BY body_fetched_at, article_key LIMIT :n")
    with ENGINE.connect() as con:
        raw = pd.read_sql(sql, con, params={"ok": OK_BODY_STATUS, "pf": PF_TS, "cf": cursor[0].to_pydatetime(),
                                            "ck": cursor[1], "n": n})
    if raw.empty:
        return raw
    df = prepare_articles(raw, verbose=False)
    for c in ("published_at", "modified_at", "body_fetched_at"):
        df[c] = df[c].dt.tz_convert(KST)
    df[AVAILABLE_AT_COLUMN] = pd.concat([df["published_at"], df["modified_at"]], axis=1).max(axis=1)
    df[ID_COLUMN] = df[ID_COLUMN].astype(str)
    return df.reset_index(drop=True)


def count_remaining(cursor: tuple) -> tuple[int, int]:
    """cursor 뒤의 처리 범위 기사 수와, 그중 dp.news_feature_orig 에 결과가 없는(처리 대상) 기사 수."""
    from sqlalchemy import text
    q = text(f"""SELECT count(*), count(*) FILTER (WHERE f.article_key IS NULL) FROM {ARTICLE_TABLE} a
                 LEFT JOIN {FEATURE_TABLE} f ON f.article_key = a.article_key AND f.stage2_status = :s2 AND f.prompt_sha256 = :sha
                 WHERE a.body_status = :ok AND a.published_at >= :pf AND a.body_fetched_at IS NOT NULL
                   AND (a.body_fetched_at, a.article_key) > (:cf, :ck)""")
    with ENGINE.connect() as con:
        n_all, n_todo = con.execute(q, {"s2": STAGE2_OK_VALUE, "sha": STAGE2_PROMPT_SHA256, "ok": OK_BODY_STATUS, "pf": PF_TS,
                                        "cf": cursor[0].to_pydatetime(), "ck": cursor[1]}).one()
    return int(n_all), int(n_todo)


def gaps(show_all: bool = True) -> int:
    """처리 범위 안 최근 GAP_CHECK_DAYS일의 '빈 구간 의심' 날짜를 출력한다."""
    cov = coverage_report(ENGINE)
    cov = cov[pd.to_datetime(cov["pub_date"]) >= pd.Timestamp(PUBLISHED_FROM)]
    sus = cov[cov["suspect"]]
    if len(sus) or show_all:
        print(f"\n[점검] 최근 {GAP_CHECK_DAYS}일 게시일별 처리 비율(적재 ÷ 기사, 평소 0.4~0.7): 빈 구간 의심 {len(sus)}일")
    if len(sus):
        print(sus[["pub_date", "n_article", "n_feature", "ratio"]].to_string(index=False))
    return len(sus)


def run_pages(writer: FeatureWriter) -> None:
    """시작점부터 끝까지 PAGE_SIZE건씩 읽어 처리한다. --limit 은 전체 처리 건수 상한."""
    cursor = start_cursor()
    n_all, n_todo = count_remaining(cursor)
    print(f"읽을 기사 {n_all:,}건 중 처리 대상 {n_todo:,}건(나머지는 이미 적재됨)")
    left = ARGS.limit
    page_no = 0
    while left is None or left > 0:
        page = load_page(cursor, PAGE_SIZE)
        if page.empty:
            break
        page_no += 1
        cursor = (page[FETCHED_AT_COLUMN].iloc[-1], page[ID_COLUMN].iloc[-1])
        done = written_keys(ENGINE, page[ID_COLUMN].tolist(), STAGE2_PROMPT_SHA256)
        todo = page[~page[ID_COLUMN].isin(done)].reset_index(drop=True)
        if left is not None:
            todo = todo.head(left)
            left -= len(todo)
        print(f"\n=== 페이지 {page_no}: 수집 ~{cursor[0]} | 읽음 {len(page):,}, 이미 적재 {len(done):,}, 처리 {len(todo):,}")
        if len(todo):
            process_all(f"페이지 {page_no}", todo, writer)
    print("\n끝까지 처리했습니다.")


def run(writer: FeatureWriter) -> None:
    if ARGS.start:
        process_all("기간 지정", target_rows(f"기간 {ARGS.start}~{ARGS.end}", load_db_news(ARGS.start, ARGS.end)), writer)
    else:
        run_pages(writer)
    if gaps(show_all=False):
        print("[경고] 위 날짜는 처리가 안 된 구간일 수 있습니다. 실행 중에 새로 들어온 최근 1~2일은 다음 실행이 처리하고, 그 앞 날짜는 --start/--end 로 처리하세요.")


if __name__ == "__main__":
    if not ensure_table(ENGINE, create=ARGS.create_table and not ARGS.check):
        sys.exit("dp.news_feature_orig 테이블이 없습니다. 만들려면 --create-table 을 붙여 실행하세요(--check 와는 함께 쓰지 않음).")
    if ARGS.check:
        if ARGS.start:
            target_rows(f"기간 {ARGS.start}~{ARGS.end}", load_db_news(ARGS.start, ARGS.end))
        else:
            n_all, n_todo = count_remaining(start_cursor())
            print(f"[점검] 읽을 기사 {n_all:,}건 중 처리 대상 {n_todo:,}건(나머지는 이미 적재됨)")
        gaps()
        print(f"[점검] 프롬프트 SHA256 일치(Stage1 {STAGE1_PROMPT_SHA256[:12]}, Stage2 {STAGE2_PROMPT_SHA256[:12]}). 종료(호출·쓰기 없음)")
        sys.exit(0)
    with_lock(run)
