"""[실사용 모듈] (service_5 복사본, 2026-11-19 원본: service_daily/db/settings.py) DB 접속 설정.
접속 정보는 service_5/.env 에서 읽는다(코드·대화에 비밀번호를 쓰지 않는다)."""
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

DB_DIR = Path(__file__).resolve().parent

from dotenv import load_dotenv

load_dotenv(DB_DIR.parent / ".env", override=False, interpolate=False, encoding="utf-8-sig")


def _db_endpoint():
    raw = os.environ.get("DP_DB_URL", "").strip()
    if not raw:
        return os.environ.get("DB_HOST", ""), int(os.environ.get("DB_PORT", "5432")), ""
    try:
        url = urlsplit(raw.removeprefix("jdbc:"))
        if url.scheme not in ("postgresql", "postgres") or not url.hostname:
            raise ValueError
        return url.hostname, url.port or 5432, unquote(url.path.removeprefix("/"))
    except ValueError:
        raise ValueError("DP_DB_URL 형식은 jdbc:postgresql://<host>:<port>/[database] 입니다.") from None


DB_HOST, DB_PORT, _url_database = _db_endpoint()
DB_NAME = os.environ.get("DP_DB_NAME") or _url_database or os.environ.get("DB_NAME", "")
DB_USER = os.environ.get("DP_DB_USER") or os.environ.get("DB_USER", "")
DB_PASSWORD = os.environ.get("DP_DB_PASSWORD", os.environ.get("DB_PASSWORD", ""))
DB_SCHEMA = os.environ.get("DP_DB_SCHEMA") or os.environ.get("DB_SCHEMA") or "dp"
