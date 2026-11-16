"""[뉴스] 뉴스 처리 공통 함수 — KST 시각 변환, available_at 계산, 재시도, 토큰 사용량, 해시, API 키 읽기.

사용처: service/news/*.py
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any

import pandas as pd

from .settings import KST


def load_api_key(var: str = "TYPESAFE_API_KEY") -> str:
    """service/.env(db.settings가 읽음) 또는 환경변수에서 Jev API 키를 읽는다. 값은 출력하지 않는다."""
    import db.settings  # noqa: F401  (service/.env 를 환경변수로 읽어 둔다)
    key = (os.environ.get(var) or "").strip()
    if not key:
        raise RuntimeError(f"{var}가 비어 있습니다. service/.env 에 키를 넣으세요(.env.example 참고).")
    print(f"{var} 로드 완료 (길이 {len(key)}자, 값은 표시하지 않음)")
    return key


def to_kst(s: pd.Series) -> pd.Series:
    """문자열/날짜 열 -> KST 시각(tz-aware). 시간대 표기가 있으면 KST로 변환, 없으면 KST로 간주한다."""
    if pd.api.types.is_datetime64_any_dtype(s):
        return s.dt.tz_convert(KST) if s.dt.tz is not None else s.dt.tz_localize(KST, ambiguous="NaT", nonexistent="shift_forward")
    t = s.astype("string").str.strip()
    has_tz = t.str.contains(r"(?:[+-]\d{2}:?\d{2}|Z)$", regex=True, na=False)
    out = pd.Series(pd.NaT, index=s.index, dtype=f"datetime64[ns, {KST}]")
    if has_tz.any():
        out[has_tz] = pd.to_datetime(t[has_tz], utc=True, errors="coerce", format="mixed").dt.tz_convert(KST)
    if (~has_tz).any():
        out[~has_tz] = pd.to_datetime(t[~has_tz], errors="coerce", format="mixed").dt.tz_localize(KST, ambiguous="NaT", nonexistent="shift_forward")
    return out


def add_available_at(df: pd.DataFrame, published_col: str = "published_at", modified_col: str = "modified_at",
                     out_col: str = "available_at_kst") -> pd.DataFrame:
    """available_at_kst = max(발행 시각, 수정 시각)."""
    df = df.copy()
    pub = to_kst(df[published_col])
    mod = to_kst(df[modified_col])
    df[out_col] = pd.concat([pub, mod], axis=1).max(axis=1)
    print(f"{out_col}: 수정 기사 {int((mod > pub).sum()):,}건은 수정 시각을 사용, 수정 기록이 없는 {int(mod.isna().sum()):,}건은 발행 시각 사용")
    df[published_col + "_kst"] = pub
    return df


def with_retry(callable_, max_retries: int = 4):
    retries = 0
    for attempt in range(max_retries + 1):
        try:
            return callable_(), retries
        except Exception:
            if attempt >= max_retries:
                raise
            retries += 1
            time.sleep(min(2 ** attempt, 8))


def response_usage(response) -> tuple[int | None, int | None]:
    try:
        usage = (response.raw_http_response.json().get("usage") or {})
        return usage.get("input_tokens"), usage.get("output_tokens")
    except Exception:
        return None, None


def clean_text(value: Any) -> str:
    if value is None or (not isinstance(value, (dict, list)) and pd.isna(value)):
        return ""
    return str(value).replace("\x00", " ").strip()


def probabilities_as_dict(answer) -> dict[str, float] | None:
    probabilities = getattr(answer, "probabilities", None)
    return probabilities if isinstance(probabilities, dict) else None


def sha256_json(payload: Any) -> str:
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
