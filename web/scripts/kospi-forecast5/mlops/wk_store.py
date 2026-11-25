"""[실사용 모듈] 주별 저장소 — 예측·해설·운영 기록·학습본·OOS·뉴스 형태소를 운영 DB 테이블에만 읽고 쓴다(로컬 파일 없음, 2026-11-24).

테이블(스키마 dp, 정의서 docs/reports/model/service_data_catalog_20261124.docx 7·10장 — 일별 대응 테이블과 같은 열, 이름 = 일별 이름의 kospi 뒤에 5, 2026-11-25):
  kospi5_pred_cls·reg·explain   예측·해설(일별 kospi_pred_cls·reg·explain 과 같은 열)
  kospi5_mlops_metric·alert·compare·job·role_history   운영 기록(일별 kospi_mlops_* 와 같은 열)
  kospi5_mlops_ledger   챌린저 예측 원장(챌린저를 등록했을 때 거래일 실행만, 운영 예측은 kospi5_pred_* 에서 조인)
  kospi5_mlops_oos      구성·결합 모델 학습 밖 예측(objective = 슬롯, line = 판, component = 구성 이름 또는 combined)
  kospi5_mlops_news_token  기사별 키워드 형태소(어휘 안 단어만, 발행 시각·역할은 news_feature_orig 조인)
  kospi5_mlops_model    학습본(joblib bytes)·역할(champion = 운영·challenger = 비교·retired = 이전) — 일별 model·role·slot 을 하나로
  챌린저는 자리만 있고 지금은 등록된 것이 없다(2026-11-25, 일별 service_daily 와 같은 구조: 비교·승격은 사람이 run_promote.py)
연결: .env DP_DB_*로 PostgreSQL dp 스키마에 접속한다. 원천 시세·뉴스는 읽기 전용이다.
쓰기는 write=True 일 때만(스크립트 --write), 아니면 출력만 한다.
"""
from __future__ import annotations

import json
import os
import socket
from datetime import date

import numpy as np
import pandas as pd
from sqlalchemy import (JSON, BigInteger, Boolean, Column, Date, DateTime, Float, Integer, MetaData, String, Table, Text,
                        delete, select, update as sql_update)
from sqlalchemy.dialects.postgresql import BYTEA, JSONB

JSONT = JSONB(none_as_null=True)
BLOB = BYTEA()
ID = BigInteger()
TS = DateTime(timezone=True)
RANGE = ("range_lo80_pct", "range_hi80_pct", "range_lo95_pct", "range_hi95_pct")
METRIC_COLS = ("n", "hits", "balanced_accuracy", "mcc", "brier", "mae", "rmse", "mae_skill", "sign_hits", "range80_hits")


def _defs(md):
    pk = dict(primary_key=True)
    pred = lambda: [Column("objective", String(20), nullable=False), Column("target_dd", Date, **pk), Column("time_point", String(8), **pk),  # noqa: E731
                    Column("model_version", Text, **pk), Column("prediction_at", TS, **pk)]
    T = [
        Table("kospi5_pred_cls", md, *pred(), Column("yhat_probability", Float), Column("yhat_direction", String(10)),
              Column("model_input", JSONT), Column("shap_result", JSONT), Column("load_dtm", TS)),
        Table("kospi5_pred_reg", md, *pred(), Column("yhat_value", Float), Column("yhat_direction", String(10)),
              Column("yhat_raw_value", Float), *[Column(c, Float) for c in RANGE], Column("range_regime", Boolean),
              Column("model_input", JSONT), Column("shap_result", JSONT), Column("load_dtm", TS)),
        Table("kospi5_pred_explain", md, Column("target_dd", Date, **pk), Column("time_point", String(8), **pk), Column("prediction_at", TS, **pk),
              Column("cls_model_version", Text, nullable=False), Column("reg_model_version", Text, nullable=False), Column("conclusion", Text),
              Column("detail_reason", Text), Column("article_keys", JSONT), Column("llm_model", Text), Column("prompt_version", Text),
              Column("status", Text, nullable=False), Column("error", Text), Column("input_tokens", Integer), Column("output_tokens", Integer),
              Column("created_at", TS)),
        Table("kospi5_mlops_metric", md, Column("time_point", String(8), **pk), Column("objective", String(20), **pk),
              Column("line", String(30), **pk), Column("window", String(20), **pk), Column("date", Date, **pk),
              *[Column(c, Float) for c in METRIC_COLS], Column("computed_at", TS)),
        Table("kospi5_mlops_alert", md, Column("id", ID, primary_key=True, autoincrement=True), Column("asof", Date), Column("time_point", String(8)),
              Column("objective", String(20)), Column("level", String(10)), Column("what", Text), Column("value", Float), Column("detail", JSONT),
              Column("created_at", TS)),
        Table("kospi5_mlops_compare", md, Column("asof", Date, **pk), Column("objective", String(20), **pk), Column("champion", String(100)),
              Column("challenger", String(100)), Column("common_days", Integer), Column("champion_score", Float), Column("challenger_score", Float),
              Column("ci_lo", Float), Column("ci_hi", Float), Column("decision", String(60)),
              Column("detail", JSONT), Column("created_at", TS)),
        Table("kospi5_mlops_role_history", md, Column("id", ID, primary_key=True, autoincrement=True), Column("at", TS),
              Column("objective", String(20)), Column("action", String(30)), Column("from_champion", String(100)), Column("from_challenger", String(100)),
              Column("to_champion", String(100)), Column("to_challenger", String(100)), Column("reason", Text), Column("decision", JSONT)),
        Table("kospi5_mlops_job", md, Column("id", ID, primary_key=True, autoincrement=True), Column("job", String(80)), Column("host", String(100)),
              Column("started_at", TS), Column("finished_at", TS), Column("status", String(20)), Column("detail", JSONT), Column("error", Text)),
        Table("kospi5_mlops_ledger", md, Column("target_dd", Date, **pk), Column("objective", String(20), **pk), Column("model_version", String(100), **pk),
              Column("yhat", Float, nullable=False), Column("prediction_at", String(40)), Column("recorded_at", TS)),
        Table("kospi5_mlops_oos", md, Column("target_dd", Date, **pk), Column("component", String(40), **pk), Column("line", String(30), **pk),
              Column("objective", String(20), **pk), Column("yhat", Float), Column("source", String(60))),
        Table("kospi5_mlops_news_token", md, Column("article_key", Text, **pk), Column("toks", Text, nullable=False)),
        Table("kospi5_mlops_model", md, Column("model_version", String(100), **pk), Column("objective", String(20), nullable=False),
              Column("target_month", String(7)), Column("bundle", BLOB, nullable=False), Column("registered_at", TS), Column("deployed_at", TS),
              Column("role", String(20), nullable=False)),
    ]
    from sqlalchemy import Index, text
    Index("kospi5_mlops_model_role", T[-1].c.objective, T[-1].c.role, unique=True,
          postgresql_where=text("role IN ('champion', 'challenger')"))
    return {t.name: t for t in T}


KEYS = {n: [c.name for c in t.primary_key.columns] for n, t in _defs(MetaData()).items()}
_E = {}

def engine():
    """서버에는 PostgreSQL 저장소만 구성한다."""
    if not _E:
        from db import get_engine, settings
        mode = os.getenv("KOSPI5_STORE_MODE", "db").strip().lower() or "db"
        if mode != "db" or os.getenv("KOSPI5_STORE_DB_URL", "").strip() or settings.DB_SCHEMA != "dp":
            raise ValueError("서버에서는 KOSPI5_STORE_MODE=db, DP_DB_SCHEMA=dp, KOSPI5_STORE_DB_URL 공란을 사용하세요.")
        eng = get_engine()
        if eng.dialect.name != "postgresql":
            raise ValueError("운영 저장소는 PostgreSQL이어야 합니다.")
        _E.update(engine=eng, t=_defs(MetaData(schema="dp")))
    return _E["engine"], _E["t"]


def require_server_db():
    return engine()


def table(name):
    return engine()[1][name]


def _value(col, v):
    """DataFrame 값 → DB 값: NaN → None, json 문자열 → 객체, 날짜·시각 문자열 → date·UTC datetime."""
    if isinstance(v, np.generic):
        v = v.item()
    if v is None or v is pd.NA or v is pd.NaT or (isinstance(v, float) and not np.isfinite(v)):
        return None
    ty = col.type
    if isinstance(ty, JSON):
        return _clean(json.loads(v) if isinstance(v, str) else v)
    if isinstance(ty, DateTime):
        ts = pd.Timestamp(v)
        return (ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")).to_pydatetime()
    if isinstance(ty, Date):
        return pd.Timestamp(v).date()
    return v


_JSON_NAMES = {"model_input", "shap_result", "article_keys", "detail", "decision"}


def _clean(v):
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_clean(x) for x in v]
    if isinstance(v, np.generic):
        v = v.item()
    if v is pd.NA or v is pd.NaT or (isinstance(v, float) and not np.isfinite(v)):
        return None
    if isinstance(v, date):
        return v.isoformat()
    return v


def _records(name, rows: pd.DataFrame) -> list[dict]:
    t = table(name)
    return [{c: _value(t.c[c], r[c]) for c in rows.columns if c in t.c} for r in rows.to_dict("records")]


def read(name, where: dict | None = None, columns: list | None = None) -> pd.DataFrame:
    """테이블 행(where = {열: 값} 같음 조건). json 열은 객체, 시각은 UTC."""
    eng, _ = engine()
    t = table(name)
    q = select(*[t.c[c] for c in columns]) if columns else select(t)
    for k, v in (where or {}).items():
        q = q.where(t.c[k] == _value(t.c[k], v))
    with eng.connect() as con:
        return pd.DataFrame(con.execute(q).mappings().all(), columns=columns or [c.name for c in t.c])


def read_in(name, col: str, values, columns: list | None = None, chunk: int = 5000) -> pd.DataFrame:
    """col 값이 values 안에 있는 행(긴 목록은 나눠 읽음)."""
    eng, _ = engine()
    t = table(name)
    values = list(dict.fromkeys(values))
    out = []
    with eng.connect() as con:
        for i in range(0, len(values), chunk):
            q = (select(*[t.c[c] for c in columns]) if columns else select(t)).where(t.c[col].in_(values[i:i + chunk]))
            out += con.execute(q).mappings().all()
    return pd.DataFrame(out, columns=columns or [c.name for c in t.c])


def replace(name, rows: pd.DataFrame, by: list[str], write: bool = True, *, con=None) -> int:
    """by 열 값이 같은 기존 행을 지우고 rows 를 넣는다(한 트랜잭션). by = 키 열이면 upsert."""
    if not write:
        print(f"[dry-run] {name}: {len(rows)}행")
        return 0
    if rows.empty:
        return 0
    if con is None:
        with engine()[0].begin() as conn:
            return replace(name, rows, by, con=conn)
    t = table(name)
    recs = _records(name, rows)
    for k in {tuple(r[c] for c in by) for r in recs}:
        con.execute(delete(t).where(*[t.c[c] == v for c, v in zip(by, k)]))
    con.execute(t.insert(), recs)
    return len(recs)


def append(name, rows: pd.DataFrame, *, con=None) -> int:
    if rows.empty:
        return 0
    if con is None:
        with engine()[0].begin() as conn:
            return append(name, rows, con=conn)
    con.execute(table(name).insert(), _records(name, rows))
    return len(rows)


def stamp_now():
    return pd.Timestamp.now(tz="Asia/Seoul")


def upsert(name, rows: pd.DataFrame, write: bool, *, con=None) -> pd.DataFrame:
    """키가 같은 행은 바꾸고 새 행은 더한다. 적재 시각 열(load_dtm·created_at·recorded_at)이 있으면 지금 시각."""
    st = next((c for c in ("load_dtm", "created_at", "recorded_at") if c in table(name).c), None)
    if st:
        rows = rows.assign(**{st: stamp_now()})
    if not write:
        print(f"[dry-run] {name}: {len(rows)}행\n{rows.drop(columns=[c for c in _JSON_NAMES if c in rows]).to_string(index=False)}")
        return rows
    replace(name, rows, KEYS[name], con=con)
    print(f"저장 {name}: {len(rows)}행")
    return rows


def explain_rows(tp: str, target, at) -> pd.DataFrame:
    """해설 테이블에서 (대상일, 시점, prediction_at) 행."""
    return read("kospi5_pred_explain", {"time_point": tp, "target_dd": target, "prediction_at": at})


def explain_put(row: dict, write: bool) -> int:
    """해설 한 행(일별 store_pred.explain_put 과 같은 규칙): 같은 (대상일, 시점, prediction_at) 행이 없으면 넣고, 있으면 그대로 둔다.
    기존 행이 failed 이면 최신 시도 결과를 저장한다. 반환: 넣은/바꾼 행 수."""
    old = explain_rows(row["time_point"], row["target_dd"], pd.Timestamp(row["prediction_at"])) if write else pd.DataFrame()
    if len(old):
        if not (old.status == "failed").all():
            print(f"해설 이미 있음({old.status.iloc[0]}): 그대로 둠", flush=True)
            return 0
    upsert("kospi5_pred_explain", pd.DataFrame([row]), write)
    return 1


def publish_prediction(key, tables, explanation):
    """점예측·범위·SHAP·정상 해설을 같은 실행 키에서 한 번에 교체한다."""
    with engine()[0].begin() as con:
        for name, rows in tables:
            if name in ("kospi5_pred_cls", "kospi5_pred_reg"):
                upsert_stamp = rows.assign(load_dtm=stamp_now())
                replace(name, upsert_stamp, list(key), con=con)
            else:
                upsert(name, rows, True, con=con)
        t = table("kospi5_pred_explain")
        con.execute(delete(t).where(*[t.c[k] == _value(t.c[k], v) for k, v in key.items()]))
        if explanation:
            upsert(t.name, pd.DataFrame([explanation]), True, con=con)


def update(name, key: dict, values: dict, write: bool, *, con=None) -> None:
    """이미 저장한 한 행(key)의 열 values 만 바꾼다(예: 예측 행에 SHAP 결과 shap_result 넣기). 행이 없으면 멈춤."""
    if not write:
        print(f"[dry-run] {name} {key}: {', '.join(values)} 갱신")
        return
    if con is None:
        with engine()[0].begin() as conn:
            return update(name, key, values, True, con=conn)
    t = table(name)
    n = con.execute(sql_update(t).where(*[t.c[k] == _value(t.c[k], v) for k, v in key.items()])
                    .values(**{c: _value(t.c[c], v) for c, v in values.items()})).rowcount
    if n != 1:
        raise RuntimeError(f"{name}: 키 {key} 행이 {n}개입니다(1개여야 함).")
    print(f"갱신 {name}: {', '.join(values)}")


JOB = "kospi5_mlops_job"


def job_start(job: str, detail: dict | None, write: bool):
    """작업 시작 기록(status running) → id. write=False 면 기록하지 않고 None."""
    if not write:
        print(f"[dry-run] 작업 기록 시작: {job}")
        return None
    eng, _ = engine()
    t = table(JOB)
    with eng.begin() as con:
        res = con.execute(t.insert().values(job=job, host=socket.gethostname(), started_at=_value(t.c.started_at, stamp_now()), status="running",
                                            detail=_clean(detail or {})))
        return int(res.inserted_primary_key[0])


def job_end(job_id, status: str, detail: dict | None = None, error: str | None = None) -> None:
    """작업 끝 기록(status ok·failed·skipped, finished_at·detail·error). job_id 가 None(쓰기 없음)이면 출력만."""
    if job_id is None:
        print(f"[dry-run] 작업 기록 끝: {status} {error or ''}")
        return
    eng, _ = engine()
    t = table(JOB)
    with eng.begin() as con:
        con.execute(sql_update(t).where(t.c.id == job_id).values(finished_at=_value(t.c.finished_at, stamp_now()), status=status,
                                                                  detail=_clean(detail or {}), error=error))


CHALLENGER_ACTIONS = ("challenger_new", "retrain_challenger")


def log_promotion(slot, action, from_version, to_version, detail="", decision=None, *, con=None):
    """학습본 교체 이력(재학습 배포·승격·되돌리기·올리기·분기 재탐색, objective = 슬롯, 일별 kospi_mlops_role_history 와 같은 열).
    챌린저 자리 일(CHALLENGER_ACTIONS)은 *_challenger 열, 그 밖은 *_champion 열. decision = 비교 일수·점수, 분기 재탐색 값 등."""
    side = "challenger" if action in CHALLENGER_ACTIONS else "champion"
    row = {"at": stamp_now(), "objective": slot, "action": action, f"from_{side}": from_version or None, f"to_{side}": to_version or None,
           "reason": detail, "decision": dict(decision or {})}
    append("kospi5_mlops_role_history", pd.DataFrame([row]), con=con)

