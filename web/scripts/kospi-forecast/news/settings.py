"""[뉴스] 뉴스 처리 설정값 — 테이블·열 이름, Jev 호출·묶음 크기, 프롬프트 SHA256 기대값을 한곳에 둔다.

사용처: service/news/*.py, service/run_news_features.py
값의 출처: news_feature_from_scratch.py(2026-10-29) 6절 실행 설정. 값을 바꾸면 처리 결과·경계 판단이 달라지므로 근거를 남긴다.
"""
import pandas as pd

KST = "Asia/Seoul"
ID_COLUMN = "article_key"
KEEP_DECISIONS = {"pass", "uncertain"}    # reject가 아니면 Stage 2로 보낸다
OK_BODY_STATUS = "ok"                     # DB 기사에서 본문 정리·분석 대상으로 쓰는 body_status 값

# DB 테이블
ARTICLE_TABLE = "dp.news_stock_article"
FEATURE_TABLE = "dp.news_feature_orig"  # 적재·처리 경계·점검·운영 읽기의 공통 테이블
FEATURE_READ_TABLE = FEATURE_TABLE
STAGE2_OK_VALUE = "ok"
STAGE2_FIELDS = [
    "kospi_relevance", "article_role", "event_type", "event_status", "origin_region", "primary_sector",
    "primary_channel", "surprise_vs_expectation", "impact_direction", "impact_strength", "active_at_target",
]

# 기사 열 이름
PUBLISHED_AT_COLUMN = "published_at"
FETCHED_AT_COLUMN = "body_fetched_at"
PUBLISHER_COLUMN = "publisher"
TITLE_COLUMN = "title"
SUMMARY_COLUMN = "summary"
BODY_COLUMN = "body_clean"
AVAILABLE_AT_COLUMN = "available_at_kst"

# Jev 호출
JEV_MODEL = "jev-latest"
EXPECTED_STAGE1_SHA12 = "9fa99cc98d22"
EXPECTED_STAGE2_SHA12 = "aa30364cb9f6"
MAX_API_RETRIES = 4
MAX_CONSECUTIVE_ERRORS = 3
MAX_PARALLEL_WORKERS = 8          # 기사 단위 동시 호출 수. 429가 잦으면 낮춘다.
MAX_BODY_CHARS = 40_000

# 실행(경계 방식)
PAGE_SIZE = 2_000                     # DB에서 한 번에 읽는 기사 수(수집 순서). 처리는 그 안에서 CHUNK_SIZE씩
CHUNK_SIZE = 200                      # 수집 순서로 이만큼씩 처리·적재한다(실패하면 그 자리에서 멈춘다)
OVERLAP = pd.Timedelta(minutes=10)    # 경계에서 겹쳐 읽는 시간(크롤러의 수집 시각 기록과 커밋 사이 차이로 빠지는 기사 방지)
LOCK_ID = 7_202_610_290               # PostgreSQL advisory lock 번호(동시 실행 방지, 테이블 변경 없음)
GAP_CHECK_DAYS = 45                   # 날짜별 처리 비율을 볼 기간(일)
GAP_MIN_ARTICLES = 50                 # 이보다 기사가 적은 날은 비율 점검에서 뺀다
GAP_MIN_RATIO = 0.2                   # 처리 비율(적재 ÷ 기사)이 이보다 낮으면 '빈 구간 의심'(평소 0.4~0.7)
