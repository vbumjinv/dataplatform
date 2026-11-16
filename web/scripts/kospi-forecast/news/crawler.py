"""[뉴스] 네이버페이 증권 뉴스 수집기 — 날짜별 목록(속보·주요뉴스)과 기사 본문을 모아 dp.news_stock_article 열 형식의 표로 만든다.

사용처: service/run_news_crawl.py
기준: 바탕화면 naver_news_crawler.ipynb(2026-10-14) 셀 4~8의 수집 코드를 그대로 옮겼다(요청 간격·재시도·본문 선택자·품질 기준 동일).
      노트북은 CSV만 저장했고, DB 적재(article_store.upsert_articles)와 DB 열 형식 변환(build_db_rows)은 여기서 추가했다.
캐시: <캐시 폴더>/cache/list/<분류>/<YYYYMMDD>.json(완료된 날짜는 다시 받지 않음), cache/body/<article_key>.json(성공 본문 재사용)
주의: 네이버 이용약관·robots 정책을 지키고 요청 간격(MIN/MAX_DELAY_SECONDS)을 낮추지 않는다.
"""
from __future__ import annotations

import hashlib
import html
import json
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from tqdm.auto import tqdm
from urllib3.util.retry import Retry

KST = ZoneInfo("Asia/Seoul")

CFG = {
    "START_DATE": None,      # configure()가 채운다(END 포함)
    "END_DATE": None,
    "API_URL": "https://stock.naver.com/api/domestic/news/list",
    "CATEGORIES": {"flashnews": "FLASHNEWS", "mainnews": "MAINNEWS"},
    "PAGE_SIZE": 100,
    "MAX_PAGES_PER_DATE": 80,
    "MIN_DELAY_SECONDS": 1.0,
    "MAX_DELAY_SECONDS": 1.6,
    "HTTP_TIMEOUT": 25,
    "HTTP_RETRIES": 4,
    "MAX_BODY_ATTEMPTS": 3,
    "MIN_BODY_CHARS": 200,
    "WORKERS": 5,  # 본문 수집 동시 요청 수. 1이면 순차 수집. 차단되면 3~4로 낮춘다.
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/124 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
}

BASE_DIR = LIST_CACHE_DIR = BODY_CACHE_DIR = None
QUALITY_CSV = FAILED_CSV = None


def configure(start: str, end: str, cache_dir: Path, workers: int | None = None) -> None:
    """수집 기간과 캐시 폴더를 정한다(노트북 셀 4의 설정 부분)."""
    global BASE_DIR, LIST_CACHE_DIR, BODY_CACHE_DIR, QUALITY_CSV, FAILED_CSV
    CFG["START_DATE"], CFG["END_DATE"] = start, end
    if workers:
        CFG["WORKERS"] = workers
    BASE_DIR = Path(cache_dir)
    LIST_CACHE_DIR = BASE_DIR / "cache" / "list"
    BODY_CACHE_DIR = BASE_DIR / "cache" / "body"
    LIST_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    BODY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    QUALITY_CSV = BASE_DIR / "quality_report.csv"
    FAILED_CSV = BASE_DIR / "failed_articles.csv"


def clean_text(value) -> str:
    value = html.unescape(str(value or ""))
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def now_kst_iso() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def parse_kst_datetime(value):
    """시각이 없으면 NaT, 있으면 반드시 Asia/Seoul 시간대로 반환한다."""
    if value is None or str(value).strip() == "":
        return pd.NaT
    ts = pd.to_datetime(value, errors="coerce")
    if pd.isna(ts):
        return pd.NaT
    if ts.tzinfo is None:
        return ts.tz_localize(KST)
    return ts.tz_convert(KST)


def parse_korean_datetime(value):
    """기사 화면의 '2026.09.10. 오후 11:45' 형식도 KST로 해석한다."""
    text = clean_text(value)
    match = re.search(
        r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})[.]?\s*"
        r"(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?",
        text,
    )
    if not match:
        return pd.NaT
    year, month, day, ampm, hour, minute, second = match.groups()
    hour = int(hour)
    if ampm == "오후" and hour != 12:
        hour += 12
    elif ampm == "오전" and hour == 12:
        hour = 0
    return pd.Timestamp(
        int(year), int(month), int(day), hour, int(minute), int(second or 0), tz=KST
    )


def iso_kst(value) -> str:
    ts = parse_kst_datetime(value)
    return "" if pd.isna(ts) else ts.isoformat()


def content_hash(title: str, body: str) -> str:
    normalized = clean_text(f"{title} {body}").lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


_local = threading.local()
_rate_lock = threading.Lock()
_next_slot = 0.0
random.seed(42)


def get_session() -> requests.Session:
    """스레드마다 별도 세션을 쓴다."""
    session = getattr(_local, "session", None)
    if session is None:
        retry = Retry(
            total=CFG["HTTP_RETRIES"],
            connect=CFG["HTTP_RETRIES"],
            read=CFG["HTTP_RETRIES"],
            backoff_factor=1.0,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
        )
        session = requests.Session()
        session.headers.update(HEADERS)
        session.mount("https://", HTTPAdapter(max_retries=retry))
        _local.session = session
    return session


def wait_rate_limit() -> None:
    """요청 '시작' 간격을 전역으로 제한한다. 동시 요청 수만큼 간격을 나눠 처리량을 높인다."""
    global _next_slot
    gap = random.uniform(CFG["MIN_DELAY_SECONDS"], CFG["MAX_DELAY_SECONDS"]) / max(1, CFG["WORKERS"])
    with _rate_lock:
        now = time.monotonic()
        start = max(now, _next_slot)
        _next_slot = start + gap
    if start > now:
        time.sleep(start - now)


def get_json(url: str, params: dict) -> dict:
    wait_rate_limit()
    response = get_session().get(url, params=params, timeout=CFG["HTTP_TIMEOUT"])
    response.raise_for_status()
    if "json" not in response.headers.get("Content-Type", "").lower():
        raise RuntimeError("목록 API가 JSON이 아닌 응답을 반환했습니다.")
    return response.json()


def get_html(url: str) -> str:
    wait_rate_limit()
    response = get_session().get(url, timeout=CFG["HTTP_TIMEOUT"])
    response.raise_for_status()
    content_type = response.headers.get("Content-Type", "").lower()
    if "html" not in content_type and not response.content.lstrip().startswith(b"<"):
        raise RuntimeError(f"기사 페이지가 HTML이 아닙니다: {content_type}")
    text = response.text
    lowered = text.lower()
    if any(token in lowered for token in ("captcha", "비정상적인 접근", "접근이 제한")):
        raise RuntimeError("차단 또는 CAPTCHA로 의심되는 응답입니다.")
    return text

def parse_list_item(item: dict, crawl_date: str):
    office_id = str(item.get("officeId") or "").strip()
    article_id = str(item.get("articleId") or "").strip()
    published_at = parse_kst_datetime(item.get("datetime"))
    if not office_id or not article_id or pd.isna(published_at):
        return None
    return {
        "news_id": f"{office_id}_{article_id}",
        "office_id": office_id,
        "article_id": article_id,
        "title": clean_text(item.get("title")),
        "summary": clean_text(item.get("subcontent")),
        "publisher": clean_text(item.get("officeHname")),
        "published_at": published_at.isoformat(),  # +09:00, KST
        "url": f"https://n.news.naver.com/mnews/article/{office_id}/{article_id}",
        "crawl_date": crawl_date,
        "list_fetched_at": now_kst_iso(),
    }


def list_cache_path(category_key: str, day: str) -> Path:
    return LIST_CACHE_DIR / category_key / f"{day}.json"


def save_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def crawl_one_date(category_code: str, day: str) -> dict:
    """하루의 모든 목록 페이지를 읽는다. 전날 기사로 넘어가면 정상 종료한다."""
    rows, seen = [], set()
    status, reason = "partial", "page_cap"

    for page in range(1, CFG["MAX_PAGES_PER_DATE"] + 1):
        try:
            payload = get_json(
                CFG["API_URL"],
                {"category": category_code, "page": page, "pageSize": CFG["PAGE_SIZE"], "date": day},
            )
            items = payload.get("articles") if isinstance(payload, dict) else None
            if not isinstance(items, list):
                raise RuntimeError("예상과 다른 목록 API 스키마입니다.")
        except Exception as exc:
            status = "partial" if rows else "failed"
            reason = f"{type(exc).__name__}: {str(exc)[:300]}"
            break

        if not items:
            status, reason = "done", "empty_page"
            break

        valid = [parse_list_item(item, day) for item in items]
        if any(row is None for row in valid):
            reason = "unparseable_item"
            break

        same_day, older_day, future_day = [], 0, 0
        for row in valid:
            row_day = parse_kst_datetime(row["published_at"]).strftime("%Y%m%d")
            if row_day == day:
                if row["news_id"] not in seen:
                    same_day.append(row)
                    seen.add(row["news_id"])
            elif row_day < day:
                older_day += 1
            else:
                future_day += 1
        rows.extend(same_day)

        if future_day:
            reason = "unexpected_future_article"
            break
        if older_day:
            # 같은 경계 페이지의 당일 기사는 이미 저장했다.
            status, reason = "done", "rolled_over_to_prior_day"
            break
        if not same_day:
            reason = "repeated_or_empty_page"
            break
        if len(items) < CFG["PAGE_SIZE"]:
            status, reason = "done", "short_page"
            break

    return {"status": status, "stop_reason": reason, "rows": rows, "saved_at": now_kst_iso()}


def target_days():
    return [day.strftime("%Y%m%d") for day in pd.date_range(CFG["START_DATE"], CFG["END_DATE"], freq="D")]


def collect_lists() -> tuple[list[dict], dict]:
    """완료 캐시는 건너뛰고, 실패/부분 날짜만 재수집한다."""
    all_rows, states = [], {}
    for category_key, category_code in CFG["CATEGORIES"].items():
        for day in tqdm(target_days(), desc=f"{category_key} 목록", unit="일"):
            cache_file = list_cache_path(category_key, day)
            cached = None
            if cache_file.exists():
                try:
                    cached = json.loads(cache_file.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    pass
            result = cached if cached and cached.get("status") == "done" else crawl_one_date(category_code, day)
            if result is not cached:
                save_json_atomic(cache_file, result)
            states[(category_key, day)] = result.get("status", "failed")
            for row in result.get("rows", []):
                row = dict(row)
                row["category"] = category_key
                all_rows.append(row)
    return all_rows, states


def merge_categories(rows: list[dict]) -> pd.DataFrame:
    """동일 기사는 한 번만 본문 요청하고, 속한 카테고리는 합쳐 보존한다."""
    frame = pd.DataFrame(rows)
    if frame.empty:
        raise RuntimeError("목록 기사가 없습니다. 캐시의 실패 사유를 확인하세요.")
    membership = (
        frame.groupby("news_id")["category"]
        .agg(lambda values: "|".join(sorted(set(values))))
        .rename("category")
    )
    frame = frame.sort_values("published_at").drop_duplicates("news_id", keep="last")
    return frame.drop(columns="category").merge(membership, on="news_id", how="left")

def meta_content(soup: BeautifulSoup, *selectors: str) -> str:
    for selector in selectors:
        tag = soup.select_one(selector)
        if tag and tag.get("content"):
            value = clean_text(tag["content"])
            if value:
                return value
    return ""


def tag_text(soup: BeautifulSoup, *selectors: str) -> str:
    for selector in selectors:
        tag = soup.select_one(selector)
        if tag:
            value = clean_text(tag.get_text(" ", strip=True))
            if value:
                return value
    return ""


def article_datetime(soup: BeautifulSoup, selectors: list[str]):
    for selector in selectors:
        tag = soup.select_one(selector)
        if not tag:
            continue
        for attr in ("data-date-time", "datetime", "content"):
            parsed = parse_kst_datetime(tag.get(attr))
            if not pd.isna(parsed):
                return parsed
        parsed = parse_korean_datetime(tag.get_text(" ", strip=True))
        if not pd.isna(parsed):
            return parsed
    return pd.NaT


def extract_article(raw_html: str, url: str) -> dict:
    soup = BeautifulSoup(raw_html, "lxml")
    title = tag_text(soup, "#title_area", ".media_end_head_headline") or meta_content(
        soup, 'meta[property="og:title"]'
    )
    publisher = tag_text(soup, ".media_end_head_top_logo")
    logo = soup.select_one(".media_end_head_top_logo img[alt]")
    if logo and logo.get("alt"):
        publisher = clean_text(logo["alt"])
    summary = meta_content(soup, 'meta[property="og:description"]', 'meta[name="description"]')
    reporter = tag_text(soup, ".media_end_head_journalist_name", ".byline_s")
    published_at = article_datetime(
        soup,
        ["span.media_end_head_info_datestamp_time", "._ARTICLE_DATE_TIME", 'meta[property="article:published_time"]'],
    )
    modified_at = article_datetime(
        soup,
        ["._ARTICLE_MODIFY_DATE_TIME", 'meta[property="article:modified_time"]'],
    )
    body_tag = soup.select_one("#dic_area") or soup.select_one("#newsct_article")
    if not body_tag:
        raise RuntimeError("기사 본문 선택자(#dic_area/#newsct_article)를 찾지 못했습니다.")
    for junk in body_tag.select("script, style, iframe, .end_photo_org, .vod_area, .ab_source, em.img_desc"):
        junk.decompose()
    body = clean_text(body_tag.get_text(" ", strip=True))
    return {
        "title_from_article": title,
        "summary_from_article": summary,
        "publisher_from_article": publisher,
        "reporter": reporter,
        "published_at_from_article": iso_kst(published_at),
        "modified_at": iso_kst(modified_at),
        "body": body,
        "body_chars": len(body),
        "content_hash": content_hash(title, body),
        "canonical_url": url,
        "body_fetched_at": now_kst_iso(),
    }


def body_cache_path(news_id: str) -> Path:
    return BODY_CACHE_DIR / f"{news_id}.json"


def collect_body(record: dict, reset: bool = False) -> dict:
    """성공 캐시는 재사용하고, 실패 기사는 최대 횟수까지만 재시도한다."""
    path = body_cache_path(record["news_id"])
    previous = {}
    if path.exists():
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previous = {}
    if previous.get("status") == "ok":
        return previous
    attempts = 0 if reset else int(previous.get("attempts", 0))
    if attempts >= CFG["MAX_BODY_ATTEMPTS"]:
        return previous
    try:
        parsed = extract_article(get_html(record["url"]), record["url"])
        status = "ok" if parsed["body_chars"] >= CFG["MIN_BODY_CHARS"] else "low_quality"
        result = {
            "news_id": record["news_id"],
            "status": status,
            "attempts": attempts + 1,
            "error": "" if status == "ok" else "본문 길이가 기준보다 짧습니다.",
            **parsed,
        }
    except Exception as exc:
        result = {
            "news_id": record["news_id"],
            "status": "failed",
            "attempts": attempts + 1,
            "error": f"{type(exc).__name__}: {str(exc)[:300]}",
            "body_fetched_at": now_kst_iso(),
        }
    save_json_atomic(path, result)
    return result


def collect_bodies(list_frame: pd.DataFrame, cooldown: int = 30) -> list[dict]:
    """1차 수집 후 실패한 기사만 모아 최대 MAX_BODY_ATTEMPTS 차까지 다시 시도한다."""
    records = list_frame.to_dict("records")
    results, todo = {}, records
    for round_no in range(1, CFG["MAX_BODY_ATTEMPTS"] + 1):
        failed, ok = [], 0
        bar = tqdm(total=len(todo), desc=f"기사 본문 {round_no}차", unit="건")
        pool = ThreadPoolExecutor(max_workers=CFG["WORKERS"])
        try:
            # 1차에서는 이전 실행의 실패 횟수를 초기화해 재실행 시 실패분을 다시 시도한다.
            futures = {pool.submit(collect_body, r, round_no == 1): r for r in todo}
            for future in as_completed(futures):
                record = futures[future]
                result = future.result()
                results[record["news_id"]] = result
                if result.get("status") == "ok":
                    ok += 1
                else:
                    failed.append(record)
                bar.update(1)
                bar.set_postfix(성공=ok, 실패=len(failed))
        finally:
            pool.shutdown(wait=False, cancel_futures=True)  # 중단 시 대기 중인 작업 취소
            bar.close()
        if not failed:
            break
        if round_no < CFG["MAX_BODY_ATTEMPTS"]:
            print(f"[{round_no}차] 실패 {len(failed):,}건 -> {cooldown}초 쉬고 실패분만 재시도합니다.")
            time.sleep(cooldown)
        todo = failed
    return [results[r["news_id"]] for r in records]

FINAL_COLUMNS = [
    "news_id", "office_id", "article_id", "category", "published_at", "modified_at",
    "title", "summary", "publisher", "url", "body", "reporter", "body_chars",
    "content_hash", "crawl_date", "list_fetched_at", "body_fetched_at",
]


def choose(primary, fallback) -> str:
    primary = "" if pd.isna(primary) else str(primary).strip()
    fallback = "" if pd.isna(fallback) else str(fallback).strip()
    return primary or fallback


def build_final(list_frame: pd.DataFrame, body_rows: list[dict]) -> pd.DataFrame:
    body_frame = pd.DataFrame(body_rows)
    good = body_frame[body_frame.get("status", pd.Series(dtype=str)).eq("ok")].copy()
    if good.empty:
        raise RuntimeError("성공한 기사 본문이 없습니다. body 캐시의 error를 확인하세요.")
    merged = list_frame.merge(good, on="news_id", how="inner")
    merged["title"] = [choose(a, b) for a, b in zip(merged["title"], merged["title_from_article"])]
    # 네이버페이 증권 목록 API의 subcontent를 우선 사용한다. 없을 때만 기사 메타 요약을 쓴다.
    merged["summary"] = [choose(a, b) for a, b in zip(merged["summary"], merged["summary_from_article"])]
    merged["publisher"] = [choose(a, b) for a, b in zip(merged["publisher"], merged["publisher_from_article"])]
    merged["published_at"] = [
        choose(article_time, list_time)
        for article_time, list_time in zip(merged["published_at_from_article"], merged["published_at"])
    ]
    for col in ("published_at", "modified_at", "list_fetched_at", "body_fetched_at"):
        merged[col] = merged[col].map(iso_kst)
    merged = merged[merged["published_at"].ne("")].copy()
    local_days = pd.to_datetime(merged["published_at"], errors="coerce").dt.tz_convert(KST).dt.date
    start, end = pd.Timestamp(CFG["START_DATE"]).date(), pd.Timestamp(CFG["END_DATE"]).date()
    merged = merged[local_days.between(start, end)].copy()
    merged = merged.drop_duplicates("news_id", keep="last").sort_values("published_at")
    return merged[[column for column in FINAL_COLUMNS if column in merged.columns]].reset_index(drop=True)


def write_quality_report(final: pd.DataFrame, states: dict) -> None:
    required = ["published_at", "title", "summary", "publisher", "url", "body"]
    rows = []
    for column in required:
        filled = int(final[column].fillna("").astype(str).str.strip().ne("").sum())
        rows.append({"check": f"filled:{column}", "value": filled, "total": len(final), "pass": filled == len(final)})
    rows.append({"check": "duplicate_news_id", "value": int(final["news_id"].duplicated().sum()), "total": len(final), "pass": not final["news_id"].duplicated().any()})
    incomplete = sum(status != "done" for status in states.values())
    rows.append({"check": "incomplete_list_dates", "value": incomplete, "total": len(states), "pass": incomplete == 0})
    pd.DataFrame(rows).to_csv(QUALITY_CSV, index=False, encoding="utf-8-sig")


def collect_lists_with_retry(rounds: int = 3, cooldown: int = 30):
    """미완료(failed/partial) 날짜는 완료 캐시를 건너뛰고 다시 시도한다."""
    for round_no in range(1, rounds + 1):
        list_rows, states = collect_lists()
        incomplete = [k for k, v in states.items() if v != "done"]
        if not incomplete:
            return list_rows, states
        print(f"[목록 {round_no}차] 미완료 {len(incomplete)}개: {incomplete[:10]}")
        if round_no < rounds:
            time.sleep(cooldown)
    raise RuntimeError(f"목록 수집 미완료 {len(incomplete)}개. 이 셀을 다시 실행하면 해당 날짜만 재시도합니다.")


def save_failed_report(list_frame: pd.DataFrame, body_rows: list[dict]) -> int:
    bad = pd.DataFrame([r for r in body_rows if r.get("status") != "ok"])
    if bad.empty:
        if FAILED_CSV.exists():
            FAILED_CSV.unlink()
        return 0
    cols = [c for c in ("news_id", "status", "attempts", "error") if c in bad.columns]
    bad = bad[cols].merge(list_frame[["news_id", "url", "published_at", "title"]], on="news_id", how="left")
    bad.to_csv(FAILED_CSV, index=False, encoding="utf-8-sig")
    return len(bad)


# ------------------------------------------------------------------ DB 열 형식 (노트북에 없던 부분)
def _kst_ts(values: pd.Series) -> pd.Series:
    """ISO 문자열(빈 값 포함) -> KST 시각. 빈 값은 NaT."""
    text = values.fillna("").astype(str).map(iso_kst)
    return pd.to_datetime(text.where(text != ""), errors="coerce", utc=True).dt.tz_convert(KST)


def build_db_rows(list_frame: pd.DataFrame, body_rows: list[dict]) -> pd.DataFrame:
    """목록 + 본문 결과 -> dp.news_stock_article 열 형식. 본문 실패(failed)·짧은 본문(low_quality) 기사도 상태와 함께 남긴다
    (DB의 다른 크롤러와 같은 방식: body_status = ok / low_quality / failed). 기간 밖 기사는 뺀다."""
    body = pd.DataFrame(body_rows)
    merged = list_frame.merge(body, on="news_id", how="left", suffixes=("", "_body"))
    for c in ("title_from_article", "summary_from_article", "publisher_from_article", "published_at_from_article",
              "modified_at", "body", "reporter", "content_hash", "body_fetched_at", "error"):
        if c not in merged:
            merged[c] = ""
    merged["title"] = [choose(a, b) for a, b in zip(merged["title"], merged["title_from_article"])]
    merged["summary"] = [choose(a, b) for a, b in zip(merged["summary"], merged["summary_from_article"])]
    merged["publisher"] = [choose(a, b) for a, b in zip(merged["publisher"], merged["publisher_from_article"])]
    merged["published_at"] = [choose(a, b) for a, b in zip(merged["published_at_from_article"], merged["published_at"])]
    out = pd.DataFrame({
        "article_key": merged["news_id"].astype(str),
        "office_id": merged["office_id"].astype(str),
        "article_id": merged["article_id"].astype(str),
        "category": merged["category"],
        "published_at": _kst_ts(merged["published_at"]),
        "modified_at": _kst_ts(merged["modified_at"]),
        "title": merged["title"].fillna(""),
        "summary": merged["summary"].fillna(""),
        "publisher": merged["publisher"].fillna(""),
        "reporter": merged["reporter"].fillna(""),
        "url": merged["url"],
        "body": merged["body"].fillna(""),
        "body_chars": merged["body"].fillna("").str.len(),
        "content_hash": merged["content_hash"].fillna(""),
        "crawl_date": pd.to_datetime(merged["crawl_date"], format="%Y%m%d").dt.date,
        "list_fetched_at": _kst_ts(merged["list_fetched_at"]),
        "body_fetched_at": _kst_ts(merged["body_fetched_at"]),
        "body_status": merged["status"].fillna("failed"),
        "body_error": merged["error"].fillna(""),
    })
    out = out[out["published_at"].notna()]
    days = out["published_at"].dt.date
    out = out[days.between(pd.Timestamp(CFG["START_DATE"]).date(), pd.Timestamp(CFG["END_DATE"]).date())]
    return out.drop_duplicates("article_key", keep="last").sort_values("published_at").reset_index(drop=True)


def crawl(start: str, end: str, cache_dir: Path, workers: int | None = None) -> pd.DataFrame:
    """기간(KST, 양 끝 포함)의 목록·본문을 수집해 DB 열 형식 표를 돌려준다. 품질·실패 보고서는 캐시 폴더에 쓴다."""
    configure(start, end, cache_dir, workers)
    print(f"수집 기간(KST): {CFG['START_DATE']} ~ {CFG['END_DATE']} | 캐시 폴더: {BASE_DIR.resolve()}")
    list_rows, states = collect_lists_with_retry()
    list_frame = merge_categories(list_rows)
    print(f"목록 기사 {len(list_frame):,}건 -> 본문 수집 시작")
    body_rows = collect_bodies(list_frame)
    final = build_final(list_frame, body_rows)
    write_quality_report(final, states)
    failed_count = save_failed_report(list_frame, body_rows)
    print(f"본문 성공 {len(final):,}건, 실패·짧은 본문 {failed_count:,}건 (품질 {QUALITY_CSV}, 실패 목록 {FAILED_CSV})")
    return build_db_rows(list_frame, body_rows)

