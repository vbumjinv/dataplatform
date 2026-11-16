"""[실사용 스크립트] 뉴스 크롤링 → DB 적재 — 네이버페이 증권 뉴스를 기간별로 수집해 dp.news_stock_article 에 넣는다.

실행(service 폴더에서):
      python run_news_crawl.py --start 2026-11-01 --end 2026-11-02            수집 + 적재 점검(dry-run, DB에 쓰지 않음)
      python run_news_crawl.py --start 2026-11-01 --end 2026-11-02 --write    수집 + 새 기사만 DB에 추가
      --update-existing  이미 있는 기사도 덮어쓴다(다른 크롤러가 같은 테이블에 적재 중이므로 확인 뒤에만)
      --csv PATH         수집 결과를 CSV로도 저장   |  --workers N  본문 동시 요청 수(기본 5)
입력: 네이버페이 증권 목록 API·기사 페이지, service/.env(DB_*)
출력: DB dp.news_stock_article(article_key 기준). 이어받기 캐시 outputs/news/run_news_crawl_<시작>_<끝>/(목록·기사별 본문·품질·실패 CSV)는
      DB 적재(--write)가 끝나면 지운다(기사마다 파일이라 서버에 쌓이지 않게). 중간에 실패하면 남아 다음 실행이 이어 받는다. --keep-cache 면 남김.
다음 단계: python run_news_features.py (새로 들어온 기사를 Jev로 처리해 dp.news_feature_orig 에 적재)

주의: 2026-11-02 현재 dp.news_stock_article 은 다른 크롤러(서버)가 계속 적재하고 있다(같은 열·body_status 값 ok/low_quality/failed).
      이 스크립트는 빠진 기간을 채우거나 서버 크롤러를 대신할 때 쓴다. 기본은 이미 있는 기사를 건드리지 않는다.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from news import crawler  # noqa: E402
from news.article_store import upsert_articles  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="네이버페이 증권 뉴스 수집 -> dp.news_stock_article")
    ap.add_argument("--start", required=True, help="수집 시작일(KST) YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="수집 끝 날짜(포함)")
    ap.add_argument("--write", action="store_true", help="DB에 실제로 쓴다(없으면 dry-run)")
    ap.add_argument("--update-existing", action="store_true", help="이미 있는 기사도 덮어쓴다")
    ap.add_argument("--csv", type=Path, help="수집 결과를 이 경로에 CSV로도 저장")
    ap.add_argument("--workers", type=int, help="본문 동시 요청 수(기본 5)")
    ap.add_argument("--keep-cache", action="store_true", help="적재 뒤에도 이어받기 캐시 폴더를 남긴다(점검용)")
    a = ap.parse_args()
    cache = HERE / "outputs" / "news" / f"run_news_crawl_{a.start.replace('-', '')}_{a.end.replace('-', '')}"
    rows = crawler.crawl(a.start, a.end, cache, a.workers)
    if a.csv:
        rows.to_csv(a.csv, index=False, encoding="utf-8-sig")
        print(f"CSV 저장: {a.csv}")
    if rows.empty:
        print("수집된 기사가 없습니다.")
        return
    upsert_articles(rows, write=a.write, update_existing=a.update_existing)
    if a.write and not a.keep_cache:
        shutil.rmtree(cache, ignore_errors=True)
        print(f"이어받기 캐시 삭제: {cache}")


if __name__ == "__main__":
    main()
