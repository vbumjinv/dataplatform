"""[실사용 모듈] 운영 뉴스 공통 원천과 KST 시각 정규화 — 읽기·적재는 같은 테이블을 사용한다."""
import pandas as pd
from .settings import FEATURE_READ_TABLE, KST


def available(alias='f'):
    """orig의 timestamp without time zone을 KST로 명시해서 세션 시간대 의존을 없앤다."""
    return f"({alias}.available_at_kst AT TIME ZONE '{KST}')"


def utc(series):
    values = pd.to_datetime(series)
    if values.dt.tz is None:
        values = values.dt.tz_localize(KST)
    return values.dt.tz_convert('UTC')
