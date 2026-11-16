"""[실사용 모듈] DB 접속 설정. 정형·뉴스 등 모든 프로젝트가 공유한다.
접속 정보는 웹 .env 의 DP_DB_* 에서 읽는다(코드·대화에 비밀번호를 쓰지 않는다)."""
import os
from pathlib import Path
from urllib.parse import urlparse

DB_DIR = Path(__file__).resolve().parent
RAW_DIR = DB_DIR / "raw"
RAW_DIR.mkdir(exist_ok=True)
WEB_ENV = DB_DIR.parent.parent.parent / ".env"

try:
    from dotenv import load_dotenv
    load_dotenv(WEB_ENV)
    load_dotenv(DB_DIR.parent / ".env")
except ImportError:
    pass


def _host_port(raw: str) -> tuple[str, int]:
    text = (raw or "").strip()
    if text.lower().startswith("jdbc:"):
        text = text[5:]
    parsed = urlparse(text)
    return parsed.hostname or "", parsed.port or 5432


DB_HOST, DB_PORT = _host_port(os.environ.get("DP_DB_URL", ""))
DB_NAME = os.environ.get("DP_DB_NAME", "")
DB_USER = os.environ.get("DP_DB_USER", "dp")
DB_PASSWORD = os.environ.get("DP_DB_PASSWORD", "")
DB_SCHEMA = os.environ.get("DP_DB_SCHEMA", "dp")      # 테이블은 dp.<테이블명>
