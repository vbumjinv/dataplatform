"""[뉴스] 뉴스 피처 테이블 dp.news_feature_orig 적재·읽기 — Stage 2 결과 한 건을 검증해 upsert하고, ML·예측용으로 읽는다.

사용처: service/run_news_features.py(적재), service/predict(읽기), experiments(읽기: read_features)
열: article_key, available_at_kst, stage1_decision·confidence, 변수 11개(kospi_relevance는 숫자, 나머지 라벨), conf_<변수>,
    probs(jsonb, {"변수":{"선택지":확률}}), impact_confidence, stage2_status, prompt_sha256, model, extracted_at(DB가 채움)
"""
from __future__ import annotations

import json
import math

import pandas as pd

from db import get_engine
from .settings import ARTICLE_TABLE, FEATURE_TABLE, ID_COLUMN, KEEP_DECISIONS, KST, STAGE2_FIELDS, STAGE2_OK_VALUE
from .source import FEATURE_READ_TABLE, utc

LABEL_FIELDS = [f for f in STAGE2_FIELDS if f != "kospi_relevance"]      # 라벨(text)로 저장하는 변수 10개. kospi_relevance만 숫자
DB_COLUMNS = (
    ["article_key", "available_at_kst", "stage1_decision", "stage1_confidence", "kospi_relevance"]
    + LABEL_FIELDS
    + [f"conf_{f}" for f in STAGE2_FIELDS]
    + ["probs", "impact_confidence", "stage2_status", "prompt_sha256", "model"]
)      # extracted_at은 DB가 채운다
RELEVANCE_VALUES = {0.0, 0.5, 1.0}
PROB_SUM_TOLERANCE = 0.05


def build_row(stage2: dict, stage1_decision: str, stage1_confidence, available_at_kst, model: str) -> dict:
    """Stage 2 호출 결과(dict, 노트북 run_stage2의 반환값) 한 건 -> dp.news_feature_orig 한 행(dict)."""
    conf = stage2.get("stage2_confidence_by_field") or {}
    probs = stage2.get("stage2_probabilities_by_field") or {}
    row = {
        "article_key": str(stage2[ID_COLUMN]),
        "available_at_kst": kst_naive(available_at_kst),
        "stage1_decision": stage1_decision,
        "stage1_confidence": stage1_confidence,
        "kospi_relevance": pd.to_numeric(stage2.get("stage2_kospi_relevance"), errors="coerce"),
    }
    for f in LABEL_FIELDS:
        row[f] = stage2.get(f"stage2_{f}")
    for f in STAGE2_FIELDS:
        row[f"conf_{f}"] = conf.get(f)
    row["probs"] = json.dumps(probs, ensure_ascii=False) if probs and all(probs.get(f) for f in STAGE2_FIELDS) else None
    row["impact_confidence"] = stage2.get("stage2_impact_confidence")
    row["stage2_status"] = STAGE2_OK_VALUE
    row["prompt_sha256"] = stage2.get("stage2_prompt_sha256")
    row["model"] = model
    return row


def kst_naive(value):
    """orig의 시간대 없는 timestamp 열에 저장할 KST 값(세션 시간대에 의존하지 않음)."""
    stamp = pd.Timestamp(value)
    if pd.isna(stamp):
        return pd.NaT
    return stamp.tz_convert(KST).tz_localize(None) if stamp.tzinfo is not None else stamp


def validate_rows(rows: pd.DataFrame) -> list[str]:
    """값 범위·확률 구조·중복을 검사해 문제 목록을 돌려준다(빈 목록이면 통과)."""
    problems: list[str] = []
    if rows[ID_COLUMN].duplicated().any():
        problems.append(f"article_key 중복 {int(rows[ID_COLUMN].duplicated().sum())}건")
    if rows["available_at_kst"].isna().any():
        problems.append(f"available_at_kst 결측 {int(rows['available_at_kst'].isna().sum())}건")
    for c in ["stage1_decision", "model", "prompt_sha256"] + LABEL_FIELDS:
        if rows[c].isna().any():
            problems.append(f"{c} 결측 {int(rows[c].isna().sum())}건")
    if (~rows["stage1_decision"].isin(KEEP_DECISIONS)).any():
        problems.append("stage1_decision이 pass/uncertain이 아닌 행이 있음(reject는 적재하지 않음)")
    bad_rel = ~rows["kospi_relevance"].isin(RELEVANCE_VALUES)
    if bad_rel.any():
        problems.append(f"kospi_relevance가 0/0.5/1이 아닌 행 {int(bad_rel.sum())}건")
    for c in ["stage1_confidence", "impact_confidence"] + [f"conf_{f}" for f in STAGE2_FIELDS]:
        v = pd.to_numeric(rows[c], errors="coerce").dropna()
        if ((v < 0) | (v > 1)).any():
            problems.append(f"{c}가 0~1 범위를 벗어난 행 {int(((v < 0) | (v > 1)).sum())}건")
    n_bad_probs = 0
    for s in rows["probs"]:
        if s is None:
            n_bad_probs += 1
            continue
        d = json.loads(s)
        if set(d) != set(STAGE2_FIELDS) or any(abs(sum(v.values()) - 1) > PROB_SUM_TOLERANCE for v in d.values()):
            n_bad_probs += 1
    if n_bad_probs:
        problems.append(f"probs 구조/합계 이상 {n_bad_probs}건 (변수 11개, 변수별 확률 합≈1이어야 함)")
    return problems


def check_schema(engine) -> None:
    """DB 테이블 열 구성이 코드의 열 목록과 같은지 확인한다(DDL이 바뀌었으면 중단)."""
    from sqlalchemy import text
    schema, table = FEATURE_TABLE.split(".")
    with engine.connect() as con:
        cols = pd.read_sql(text("SELECT column_name FROM information_schema.columns WHERE table_schema=:s AND table_name=:t"),
                           con, params={"s": schema, "t": table})["column_name"].tolist()
    if not cols:
        raise RuntimeError(f"{FEATURE_TABLE} 테이블이 없습니다.")
    expected = set(DB_COLUMNS) | {"extracted_at"}
    if set(cols) != expected:
        raise RuntimeError(f"{FEATURE_TABLE} 열 구성이 코드와 다릅니다. DB에만 있음={sorted(set(cols) - expected)}, 코드에만 있음={sorted(expected - set(cols))}")


def _py(v):
    """pandas/numpy 값 -> DB 드라이버가 받는 파이썬 값(NaN/NaT -> None)."""
    if v is None or v is pd.NaT:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime()
    if hasattr(v, "item"):
        return v.item()
    return v


def written_keys(engine, keys: list[str], prompt_sha256: str) -> set[str]:
    """keys 중 이미 현재 프롬프트로 적재된('ok') 기사의 article_key — 노트북이 건너뛸 대상."""
    from sqlalchemy import bindparam, text
    found: set[str] = set()
    q = text(f"SELECT article_key FROM {FEATURE_TABLE} WHERE prompt_sha256 = :sha AND stage2_status = :ok AND article_key IN :keys"
             ).bindparams(bindparam("keys", expanding=True))
    with engine.connect() as con:
        for i in range(0, len(keys), 5000):
            found.update(r[0] for r in con.execute(q, {"sha": prompt_sha256, "ok": STAGE2_OK_VALUE, "keys": keys[i:i + 5000]}))
    return found


class FeatureWriter:
    """Stage 2가 끝난 기사를 한 건씩 dp.news_feature에 upsert한다. enabled=False면 검증만 하고 쓰지 않는다."""

    def __init__(self, model: str = "jev-latest", enabled: bool = True, engine=None):
        from sqlalchemy import text
        if engine is None:
            engine = get_engine()
        self.engine, self.model, self.enabled = engine, model, enabled
        check_schema(engine)
        set_cols = [c for c in DB_COLUMNS if c != ID_COLUMN]
        values = ", ".join(f"CAST(:{c} AS jsonb)" if c == "probs" else f":{c}" for c in DB_COLUMNS)
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in set_cols) + ", extracted_at = now()"
        self._sql = text(f"INSERT INTO {FEATURE_TABLE} ({', '.join(DB_COLUMNS)}) VALUES ({values}) "
                         f"ON CONFLICT (article_key) DO UPDATE SET {updates}")
        self.written = 0

    def write(self, stage2: dict, stage1_decision: str, stage1_confidence, available_at_kst) -> dict:
        """한 기사를 검증하고 적재한다. 검증에 실패하면 ValueError(그 기사는 DB에 쓰지 않음)."""
        row = build_row(stage2, stage1_decision, stage1_confidence, available_at_kst, self.model)
        problems = validate_rows(pd.DataFrame([row]))
        if problems:
            raise ValueError(f"{row['article_key']}: " + "; ".join(problems))
        if self.enabled:
            with self.engine.begin() as con:                 # 기사 한 건 = 트랜잭션 한 번
                con.execute(self._sql, {c: _py(row[c]) for c in DB_COLUMNS})
            self.written += 1
        return row


def read_features(start: str | None = None, end: str | None = None, keys: list[str] | None = None,
                  flatten_probs: bool = False, with_article: bool = True, engine=None) -> pd.DataFrame:
    """dp.news_feature_orig를 읽는다(ML 입력). 기간(KST 날짜, 양 끝 포함, 기사 발행일 기준) 또는 article_key 목록으로 고른다.

    with_article=True면 기사 테이블의 published_at·modified_at·publisher·title을 붙인다(본문은 붙이지 않음).
    flatten_probs=True면 probs를 `prob_<변수>__<선택지>` 숫자 열 88개로 펼친다(원래 probs 열은 제거).
    """
    from sqlalchemy import bindparam, text
    if engine is None:
        engine = get_engine()
    art = ", a.published_at, a.modified_at, a.publisher, a.title" if with_article else ""
    sql, params = f"SELECT f.*{art} FROM {FEATURE_READ_TABLE} f JOIN {ARTICLE_TABLE} a USING (article_key)", {}
    where = []
    if start is not None:
        where.append("a.published_at >= :s")
        params["s"] = pd.Timestamp(start).tz_localize(KST).to_pydatetime()
    if end is not None:
        where.append("a.published_at < :e")
        params["e"] = (pd.Timestamp(end) + pd.Timedelta(days=1)).tz_localize(KST).to_pydatetime()
    q = text(sql + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY a.published_at, f.article_key")
    if keys is not None:
        q = text(sql + " WHERE f.article_key IN :keys" + (" AND " + " AND ".join(where) if where else "")
                 + " ORDER BY a.published_at, f.article_key").bindparams(bindparam("keys", expanding=True))
        params["keys"] = list(keys)
    with engine.connect() as con:
        df = pd.read_sql(q, con, params=params)
    for c in ("available_at_kst", "published_at", "modified_at"):
        if c in df:
            df[c] = utc(df[c]).dt.tz_convert(KST)
    if flatten_probs and len(df):
        flat = pd.DataFrame([{f"prob_{f}__{o}": v for f, opts in p.items() for o, v in opts.items()} for p in df["probs"]], index=df.index)
        df = pd.concat([df.drop(columns=["probs"]), flat], axis=1)
    return df


# 기존 dp.news_feature_orig 와 같은 구조(2026-10-29 DB에서 읽은 열·제약·색인)
CREATE_TABLE_SQL = [
    f"""CREATE TABLE IF NOT EXISTS {FEATURE_TABLE} (
        article_key text PRIMARY KEY REFERENCES dp.news_stock_article(article_key),
        available_at_kst timestamp without time zone, stage1_decision text, stage1_confidence numeric, kospi_relevance numeric,
        article_role text, event_type text, event_status text, origin_region text, primary_sector text, primary_channel text,
        surprise_vs_expectation text, impact_direction text, impact_strength text, active_at_target text,
        conf_kospi_relevance numeric, conf_article_role numeric, conf_event_type numeric, conf_event_status numeric,
        conf_origin_region numeric, conf_primary_sector numeric, conf_primary_channel numeric,
        conf_surprise_vs_expectation numeric, conf_impact_direction numeric, conf_impact_strength numeric,
        conf_active_at_target numeric, probs jsonb, impact_confidence numeric, stage2_status text, prompt_sha256 text,
        model text, extracted_at timestamptz NOT NULL DEFAULT now())""",
    f"CREATE INDEX IF NOT EXISTS ix_news_feature_orig_available ON {FEATURE_TABLE} USING btree (available_at_kst)",
    f"CREATE INDEX IF NOT EXISTS ix_news_feature_orig_impact ON {FEATURE_TABLE} USING btree (impact_direction)",
    f"CREATE INDEX IF NOT EXISTS ix_news_feature_orig_probs_gin ON {FEATURE_TABLE} USING gin (probs)",
]


def ensure_table(engine, create: bool = False) -> bool:
    """dp.news_feature_orig 가 있으면 True. 없고 create=True면 기존과 같은 구조로 만든 뒤 True, 아니면 False."""
    from sqlalchemy import text
    with engine.connect() as con:
        exists = con.execute(text("SELECT to_regclass(:table_name) IS NOT NULL"), {"table_name": FEATURE_TABLE}).scalar()
    if exists or not create:
        return bool(exists)
    with engine.begin() as con:
        for sql in CREATE_TABLE_SQL:
            con.execute(text(sql))
    print("dp.news_feature_orig 테이블을 만들었습니다(기존과 같은 구조).")
    return True
