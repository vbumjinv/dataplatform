"""[DB] 서비스 저장소 — 화면용 예측·해설과 자동화 상태(학습본·역할·원장·지표·경고·비교·작업 기록·학습용 뉴스/OOS)를 DB 테이블(db 모드) 또는 같은 이름의 CSV 파일(csv 모드)에 읽고 쓴다.

사용처: run_*.py, predict/*.py, explain/explain_timepoint.py, mlops/registry.py — 모두 open_store(write, mode) 로 연다.
mode: 예측·해설(kospi_pred_*)과 자동화 기록(kospi_mlops_*)을 따로 고를 수 있다.
  - 예측·해설 = .env KOSPI_PRED_MODE(없으면 아래 KOSPI_MLOPS_MODE 와 같음)
  - 자동화 기록 = .env KOSPI_MLOPS_MODE(없으면 csv)
  - 스크립트 --mode 를 주면 둘 다 그 모드(시험·옮기기용).
  두 모드가 다르면 SplitStore 가 예측·해설 메서드는 한쪽, 나머지는 다른 쪽으로 보낸다
  (지금: 예측·해설 = DB dp.kospi_pred_cls·reg·explain, 자동화 기록 = CSV — mlops 테이블은 DB 적용 전, 2026-11-09).
  db  : 운영 DB(service/.env 의 DB_*, 스키마 DB_SCHEMA=dp)의 아래 테이블(이 파일의 DbStore).
        시험용으로 KOSPI_MLOPS_DB_URL=sqlite:///경로 를 주면 그 DB를 쓴다.
  csv : KOSPI_CSV_DIR(기본 service/outputs/tables)의 <테이블 이름>.csv(mlops/store_csv.py 의 CsvStore). 열·키·동작은 db 와 같다.
  어느 모드든 정형 원천·dp.news_feature_orig 같은 예측 입력은 운영 DB에서 읽기만 한다.
쓰기: write=True 일 때만 한다(스크립트의 --write). write=False 면 쓰는 대신 '쓸 내용'만 출력한다(dry-run).
만들기: run_mlops_setup.py --mode <db|csv> --all --write (db 는 docs/reports/model/service_db_design_20261105.docx 부록 SQL 을 DBA 가 적용)
시점: 행은 시점 이름 time_point(일별 T0·T1·T2)로 구분하고 시각은 저장하지 않는다(service/time_points.json). 목적 objective 는 DIR_1D·RET_1D 처럼
      예측 기간을 담으므로, 나중에 주별 모델을 더해도 같은 테이블에 다른 time_point·objective 로 들어간다.

| 테이블 | 키 | 내용 |
|---|---|---|
| kospi_pred_cls | target_dd, time_point, model_version | 방향 예측: 상승확률·방향, 모델 입력(model_input json), SHAP(shap_result json) |
| kospi_pred_reg | target_dd, time_point, model_version | 수익률 예측: 최종(K1 뒤)·K1 전 값, 80%·95% 범위(%)·급변 신호, 모델 입력, SHAP |
| kospi_pred_explain | target_dd, time_point | LLM 해설: 핵심 결론·상세 사유·근거 기사 키, 설명한 학습본 버전, 모델·프롬프트·상태·토큰 |
| kospi_mlops_model | model_version | 학습본 등록부(T2 챔피언·챌린저): 목적·계열·대상월·manifest(json)·joblib/배경 파일(bytea)·배포 시각 |
| kospi_mlops_role | objective | 지금 champion/challenger 계열(T2) |
| kospi_mlops_role_history | id | 승격·되돌리기 기록 |
| kospi_mlops_ledger | target_dd, objective, model_version | T2 챌린저 일별 예측 원장(구성요소·입력 json, prospective). 챔피언은 kospi_pred_* 에 있다 |
| kospi_mlops_metric | time_point, objective, line, window, date | 시점·목적·계열별 이동 20·60일·월·누적 지표(범위 적중 포함) |
| kospi_mlops_alert | id | 모니터링 경고(시점별) |
| kospi_mlops_compare | asof, objective | T2 챔피언/챌린저 판정 |
| kospi_mlops_job | id | 자동화 실행 기록(예측·재학습·저녁 작업, 상태·오류) |
| kospi_mlops_news_daily | date | 학습용 거래일별 뉴스 변수(26개, json). 시드(실험) + 매달 DB 집계분 |
| kospi_mlops_oos | target_dd, component, line | 회귀 스태킹용 구성요소 과거 OOS 예측 |
| kospi_mlops_slot | time_point, model_version, file_name | 시점별 배포 슬롯 백업(T0·T1 학습본·manifest, 세 시점 예측 범위 이력·설정). 배포 뒤 mlops/post_deploy.py 가 쓰고 시점마다 최근 3번만 파일을 남김 |
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
from contextlib import contextmanager
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import (JSON, BigInteger, Boolean, Column, Date, DateTime, Float, Integer, LargeBinary, MetaData,
                        String, Table, Text, create_engine, delete, inspect, select, update)
from sqlalchemy.dialects.postgresql import BYTEA, JSONB

SERVICE = Path(__file__).resolve().parents[1]
if str(SERVICE) not in sys.path:
    sys.path.append(str(SERVICE))

JSONT = JSON().with_variant(JSONB(), "postgresql")
BLOB = LargeBinary().with_variant(BYTEA(), "postgresql")
ID = BigInteger().with_variant(Integer(), "sqlite")
PREFIX = "kospi_mlops_"
METRIC_COLS = ("n", "hits", "balanced_accuracy", "mcc", "brier", "mae", "rmse", "mae_skill", "sign_hits", "range80_hits")
RANGE_COLS = ("range_lo80_pct", "range_hi80_pct", "range_lo95_pct", "range_hi95_pct")


def _now():
    return datetime.now(timezone.utc)


def _clean(v):
    """json 으로 저장할 값 정리(numpy·NaN·날짜)."""
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_clean(x) for x in v]
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, float) and not np.isfinite(v):
        return None
    if isinstance(v, (pd.Timestamp, datetime, Path)):
        return str(v)
    return v


def _tables(schema):
    md = MetaData(schema=schema)
    t = {}
    t["model"] = Table(PREFIX + "model", md,
        Column("model_version", String(100), primary_key=True), Column("objective", String(10), nullable=False),
        Column("line", String(30), nullable=False), Column("target_month", String(7), nullable=False),
        Column("grid", String(20)), Column("created_utc", String(40)), Column("artifact_sha256", String(64), nullable=False),
        Column("background_sha256", String(64)), Column("manifest", JSONT, nullable=False),
        Column("bundle", BLOB, nullable=False), Column("background", BLOB), Column("mlflow_version", String(20)),
        Column("registered_at", DateTime(timezone=True)), Column("deployed_at", DateTime(timezone=True)))
    t["role"] = Table(PREFIX + "role", md,
        Column("objective", String(10), primary_key=True), Column("champion", String(30), nullable=False),
        Column("challenger", String(30)), Column("updated_at", DateTime(timezone=True)))
    t["role_history"] = Table(PREFIX + "role_history", md,
        Column("id", ID, primary_key=True, autoincrement=True), Column("at", DateTime(timezone=True)),
        Column("objective", String(10)), Column("action", String(20)), Column("from_champion", String(30)),
        Column("from_challenger", String(30)), Column("to_champion", String(30)), Column("to_challenger", String(30)),
        Column("reason", Text), Column("decision", JSONT))
    t["ledger"] = Table(PREFIX + "ledger", md,
        Column("target_dd", Date, primary_key=True), Column("objective", String(10), primary_key=True),
        Column("model_version", String(100), primary_key=True), Column("line", String(30)), Column("role", String(20)),
        Column("target_month", String(7)), Column("yhat", Float),
        Column("components", JSONT), Column("inputs", JSONT), Column("news_articles", Integer),
        Column("prediction_at", String(40)), Column("recorded_at", DateTime(timezone=True)), Column("prospective", Boolean),
        Column("source_snapshot_at", String(40)), Column("host", String(100)))
    t["metric"] = Table(PREFIX + "metric", md,
        Column("time_point", String(8), primary_key=True), Column("objective", String(10), primary_key=True),
        Column("line", String(30), primary_key=True), Column("window", String(20), primary_key=True), Column("date", Date, primary_key=True),
        *[Column(c, Float) for c in METRIC_COLS],
        Column("computed_at", DateTime(timezone=True)))
    t["alert"] = Table(PREFIX + "alert", md,
        Column("id", ID, primary_key=True, autoincrement=True), Column("asof", Date), Column("time_point", String(8)),
        Column("objective", String(10)),
        Column("level", String(10)), Column("what", Text), Column("value", Float), Column("detail", JSONT),
        Column("created_at", DateTime(timezone=True)))
    t["compare"] = Table(PREFIX + "compare", md,
        Column("asof", Date, primary_key=True), Column("objective", String(10), primary_key=True),
        Column("champion", String(30)), Column("challenger", String(30)), Column("common_days", Integer),
        Column("champion_score", Float), Column("challenger_score", Float), Column("diff", Float),
        Column("ci_lo", Float), Column("ci_hi", Float), Column("decision", String(60)), Column("prospective_only", Boolean),
        Column("detail", JSONT), Column("created_at", DateTime(timezone=True)))
    t["job"] = Table(PREFIX + "job", md,
        Column("id", ID, primary_key=True, autoincrement=True), Column("job", String(40)), Column("host", String(100)),
        Column("started_at", DateTime(timezone=True)), Column("finished_at", DateTime(timezone=True)),
        Column("status", String(20)), Column("detail", JSONT), Column("error", Text))
    t["news_daily"] = Table(PREFIX + "news_daily", md,
        Column("date", Date, primary_key=True), Column("source", String(60)), Column("articles", Integer),
        Column("features", JSONT, nullable=False), Column("created_at", DateTime(timezone=True)))
    t["oos"] = Table(PREFIX + "oos", md,
        Column("target_dd", Date, primary_key=True), Column("component", String(20), primary_key=True),
        Column("line", String(30), primary_key=True), Column("objective", String(10)), Column("yhat", Float),
        Column("source", String(60)), Column("model_version", String(100)))
    t["slot"] = Table(PREFIX + "slot", md,
        Column("time_point", String(8), primary_key=True), Column("model_version", String(100), primary_key=True),
        Column("file_name", String(80), primary_key=True), Column("target_month", String(7)),
        Column("sha256", String(64), nullable=False), Column("size_bytes", BigInteger), Column("content", BLOB),
        Column("deployed_at", DateTime(timezone=True)))
    # ---- 화면용 예측·해설(기존 dp.kospi_pred_cls·reg 에 열을 더하고 해설 테이블을 새로 만든다, 설계: service_db_design_20261105.docx)
    pred = lambda: [Column("objective", String(10), nullable=False), Column("target_dd", Date, primary_key=True),
                    Column("time_point", String(8), primary_key=True), Column("model_version", Text, primary_key=True),
                    Column("prediction_at", DateTime(timezone=True), primary_key=True)]      # 운영 DB: unique (target_dd, time_point, model_version, prediction_at)
    t["pred_cls"] = Table("kospi_pred_cls", md, *pred(),
        Column("yhat_probability", Float), Column("yhat_direction", String(10)),
        Column("model_input", JSONT), Column("shap_result", JSONT), Column("load_dtm", DateTime(timezone=True)))
    t["pred_reg"] = Table("kospi_pred_reg", md, *pred(),
        Column("yhat_value", Float), Column("yhat_pct", Float), Column("yhat_direction", String(10)), Column("yhat_raw_value", Float),
        *[Column(c, Float) for c in RANGE_COLS], Column("range_regime", Boolean),
        Column("model_input", JSONT), Column("shap_result", JSONT), Column("load_dtm", DateTime(timezone=True)))
    t["pred_explain"] = Table("kospi_pred_explain", md,
        Column("target_dd", Date, primary_key=True), Column("time_point", String(8), primary_key=True),
        Column("prediction_at", DateTime(timezone=True), primary_key=True),          # 실행일별 해설(예측 행과 같은 값으로 짝지음)
        Column("cls_model_version", Text, nullable=False), Column("reg_model_version", Text, nullable=False),
        Column("conclusion", Text), Column("detail_reason", Text), Column("article_keys", JSONT),
        Column("llm_model", Text), Column("prompt_version", Text), Column("status", Text, nullable=False), Column("error", Text),
        Column("input_tokens", Integer), Column("output_tokens", Integer), Column("created_at", DateTime(timezone=True)))
    return md, t


from store_pred import PredMixin  # noqa: E402  (예측·해설 테이블 읽기·쓰기, 두 모드 공통)


PRED_TABLES = ("pred_cls", "pred_reg", "pred_explain")
PRED_METHODS = ("pred_put", "pred_read", "pred_latest", "pred_update", "pred_copy_from", "explain_put", "explain_read")


class DbStore(PredMixin):
    mode = "db"

    def __init__(self, write: bool = False, url: str | None = None, only: tuple | None = None):
        """only: 다룰 테이블 키(예: PRED_TABLES). 주면 그 테이블만 확인·생성한다(mlops 테이블이 아직 없는 DB)."""
        self.write = write
        url = url or os.environ.get("KOSPI_MLOPS_DB_URL", "").strip()
        if url:
            self.engine = create_engine(url)
        else:
            import db
            self.engine = db.get_engine()
        self.schema = None if self.engine.dialect.name == "sqlite" else os.environ.get("DP_DB_SCHEMA", "dp")
        self.md, self.t = _tables(self.schema)
        if only:
            self.t = {k: self.t[k] for k in only}
        self.host = socket.gethostname()
        self._tz = None

    # ------------------------------------------------------------ 공통
    def describe(self) -> str:
        u = self.engine.url
        return f"db {u.get_backend_name()}://{u.host or ''}/{u.database} schema={self.schema} write={self.write}"

    def counts(self) -> dict:
        from sqlalchemy import func
        miss = set(self.missing_tables())
        with self.engine.connect() as con:
            return {t.name: (None if t.name in miss else con.execute(select(func.count()).select_from(t)).scalar())
                    for t in self.t.values()}

    @contextmanager
    def lock(self, job: str):
        """같은 작업 동시 실행 막기(PostgreSQL advisory lock — 노트북·서버 사이에도 적용). 잡으면 True."""
        if self.engine.dialect.name != "postgresql":
            yield True
            return
        from sqlalchemy import text
        key = int(hashlib.sha256(f"kospi_mlops:{job}".encode()).hexdigest()[:15], 16)
        with self.engine.connect() as con:
            ok = bool(con.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}).scalar())
            try:
                yield ok
            finally:
                if ok:
                    con.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})

    def missing_tables(self) -> list[str]:
        have = set(inspect(self.engine).get_table_names(schema=self.schema))
        return [t.name for t in self.t.values() if t.name not in have]

    def require_tables(self):
        miss = self.missing_tables()
        if miss:
            raise RuntimeError(f"DB 테이블이 없습니다: {miss}. python run_mlops_setup.py --mode db --all --write 로 만드세요"
                               " (설계·SQL: docs/reports/model/service_db_design_20261105.docx).")
        cols = self.missing_columns()
        if cols:
            raise RuntimeError(f"DB 테이블에 새 열이 없습니다: {cols}. DBA 에게 설계서 부록 SQL 적용을 요청하세요.")

    def create_tables(self):
        if not self.write:
            print(f"[dry-run] 테이블 생성 예정: {self.missing_tables()}")
            return
        self.md.create_all(self.engine, tables=list(self.t.values()), checkfirst=True)

    def db_tz(self) -> str:
        """DB 세션 시간대(시간대 없는 열 load_dtm 을 읽을 때 붙인다). sqlite 는 UTC."""
        if self._tz is None:
            self._tz = "UTC"
            if self.engine.dialect.name == "postgresql":
                from sqlalchemy import text
                with self.engine.connect() as con:
                    self._tz = con.execute(text("SHOW timezone")).scalar() or "UTC"
        return self._tz

    def _dry(self, what, n):
        print(f"[dry-run] {what}: {n}건 (쓰지 않음, --write 로 실제 저장)")

    def _kv(self, v):
        """키 비교값: 시각은 UTC 로 맞춘다(시간대 없는 열 kospi_pred_explain.prediction_at 은 세션 시간대 값)."""
        if isinstance(v, datetime):
            from zoneinfo import ZoneInfo
            return (v.replace(tzinfo=ZoneInfo(self.db_tz())) if v.tzinfo is None else v).astimezone(timezone.utc)
        return v

    def _read(self, stmt) -> pd.DataFrame:
        with self.engine.connect() as con:
            return pd.DataFrame(con.execute(stmt).mappings().all())

    def _insert_new(self, name, rows: list[dict], keys: list[str]) -> int:
        """키가 없는 행만 넣는다(이미 있으면 그대로 둔다)."""
        if not rows:
            return 0
        if not self.write:
            self._dry(f"{name} 추가 후보", len(rows))
            return 0
        t = self.t[name]
        with self.engine.begin() as con:
            have = {tuple(map(self._kv, r)) for r in con.execute(select(*[t.c[k] for k in keys])).all()}
            new = [r for r in rows if tuple(self._kv(r[k]) for k in keys) not in have]
            if new:
                con.execute(t.insert(), new)
        return len(new)

    def _select(self, name, eq: dict | None = None, start=None, end=None) -> pd.DataFrame:
        """eq 열 값이 같고 target_dd 가 start~end 인 행(예측 테이블용)."""
        t = self.t[name]
        stmt = select(t)
        for k, v in (eq or {}).items():
            stmt = stmt.where(t.c[k] == v)
        if start is not None:
            stmt = stmt.where(t.c.target_dd >= pd.Timestamp(start).date())
        if end is not None:
            stmt = stmt.where(t.c.target_dd <= pd.Timestamp(end).date())
        df = self._read(stmt)
        if df.empty:
            return pd.DataFrame(columns=[c.name for c in t.c])
        df["target_dd"] = pd.to_datetime(df["target_dd"])
        for c in t.c:                           # 운영 DB 의 load_dtm 은 시간대 없는 열(세션 시간대 Asia/Seoul 값) — 시간대를 붙여 UTC 로
            if isinstance(c.type, DateTime) and c.name in df and df[c.name].notna().any():
                s = pd.to_datetime(df[c.name])
                df[c.name] = s.dt.tz_localize(self.db_tz()).dt.tz_convert("UTC") if s.dt.tz is None else s.dt.tz_convert("UTC")
            elif isinstance(c.type, Float) and c.name in df:        # numeric 열(yhat_probability 등)은 float 로
                df[c.name] = pd.to_numeric(df[c.name])
        return df

    def _update(self, name, key: dict, values: dict) -> int:
        """키가 같은 행의 열 값을 바꾼다. 바뀐 행 수."""
        if not self.write:
            self._dry(f"{name} {list(values)} 갱신", 1)
            return 0
        t = self.t[name]
        with self.engine.begin() as con:
            return con.execute(update(t).where(*[t.c[k] == v for k, v in key.items()]).values(**values)).rowcount

    def _upsert(self, name, rows: list[dict], keys: list[str]) -> int:
        return self._replace(name, rows, keys)

    def missing_columns(self) -> dict:
        """있는 테이블에 빠진 열(기존 dp.kospi_pred_cls·reg 에 새 열이 적용됐는지 확인)."""
        insp, out = inspect(self.engine), {}
        for t in self.t.values():
            if t.name in self.missing_tables():
                continue
            have = {c["name"] for c in insp.get_columns(t.name, schema=self.schema)}
            miss = [c.name for c in t.c if c.name not in have]
            if miss:
                out[t.name] = miss
        return out

    def _replace(self, name, rows: list[dict], keys: list[str]) -> int:
        """같은 키는 지우고 다시 넣는다(지표처럼 다시 계산하는 값)."""
        if not rows:
            return 0
        if not self.write:
            self._dry(f"{name} 갱신", len(rows))
            return 0
        t = self.t[name]
        with self.engine.begin() as con:
            for r in rows:
                con.execute(delete(t).where(*[t.c[k] == r[k] for k in keys]))
            con.execute(t.insert(), rows)
        return len(rows)

    # ------------------------------------------------------------ 학습본 등록부
    def model_put(self, manifest: dict, folder: Path, mlflow_version: str | None = None) -> bool:
        row = {"model_version": manifest["model_version"], "objective": manifest["objective"],
               "line": manifest.get("line", "model_1"), "target_month": manifest["target_month"],
               "grid": manifest.get("grid"), "created_utc": manifest.get("created_utc"),
               "artifact_sha256": manifest["artifact_sha256"], "background_sha256": manifest["background"]["sha256"],
               "manifest": _clean({k: v for k, v in manifest.items() if not k.startswith("_")}),
               "bundle": (folder / manifest["artifact"]).read_bytes(),
               "background": (folder / manifest["background"]["artifact"]).read_bytes(),
               "mlflow_version": mlflow_version, "registered_at": _now()}
        return self._insert_new("model", [row], ["model_version"]) == 1

    def model_set(self, model_version: str, **values):
        if not self.write:
            self._dry(f"model {model_version} {list(values)} 갱신", 1)
            return
        t = self.t["model"]
        with self.engine.begin() as con:
            con.execute(update(t).where(t.c.model_version == model_version).values(**values))

    def model_drop_files(self, model_version: str):
        """오래된 등록부 학습본의 파일(bytea)만 비운다(행·manifest 는 남김)."""
        if not self.write:
            self._dry(f"model {model_version} 파일 비우기", 1)
            return
        t = self.t["model"]
        with self.engine.begin() as con:
            con.execute(update(t).where(t.c.model_version == model_version).values(bundle=b"", background=None))

    def model_list(self, objective: str | None = None) -> pd.DataFrame:
        t = self.t["model"]
        cols = [c for c in t.c if c.name not in ("bundle", "background")]
        stmt = select(*cols)
        if objective:
            stmt = stmt.where(t.c.objective == objective)
        return self._read(stmt)

    def model_files(self, model_version: str) -> tuple[bytes, bytes]:
        t = self.t["model"]
        with self.engine.connect() as con:
            r = con.execute(select(t.c.bundle, t.c.background).where(t.c.model_version == model_version)).one()
        return bytes(r.bundle), bytes(r.background)

    # ------------------------------------------------------------ 배포 슬롯 백업(시점별)
    def slot_put(self, time_point: str, model_version: str, target_month: str, files: dict) -> int:
        """files: {파일 이름: 경로}. 같은 시점·버전 행은 바꿔 쓴다."""
        rows = [{"time_point": time_point, "model_version": model_version, "file_name": n, "target_month": target_month,
                 "sha256": hashlib.sha256(Path(f).read_bytes()).hexdigest(), "size_bytes": Path(f).stat().st_size,
                 "content": Path(f).read_bytes(), "deployed_at": _now()} for n, f in files.items()]
        if not self.write:
            self._dry(f"slot {time_point} {model_version} 백업", len(rows))
            return 0
        t = self.t["slot"]
        with self.engine.begin() as con:
            con.execute(delete(t).where(t.c.time_point == time_point, t.c.model_version == model_version,
                                        t.c.file_name.in_(list(files))))
            con.execute(t.insert(), rows)
        return len(rows)

    def slot_list(self, time_point: str | None = None) -> pd.DataFrame:
        t = self.t["slot"]
        stmt = select(*[c for c in t.c if c.name != "content"])
        if time_point:
            stmt = stmt.where(t.c.time_point == time_point)
        return self._read(stmt)

    def slot_files(self, time_point: str, model_version: str) -> dict:
        t = self.t["slot"]
        with self.engine.connect() as con:
            rs = con.execute(select(t.c.file_name, t.c.sha256, t.c.content).where(t.c.time_point == time_point, t.c.model_version == model_version)).all()
        return {r.file_name: (r.sha256, None if r.content is None else bytes(r.content)) for r in rs}

    def slot_prune(self, time_point: str, keep: int = 3) -> list[str]:
        """시점별로 최근 keep 번 배포만 파일(content)을 남긴다(행은 남김)."""
        df = self.slot_list(time_point)
        if df.empty:
            return []
        order = df.groupby("model_version").deployed_at.max().sort_values()
        drop = list(order.index[:-keep])
        if drop and self.write:
            t = self.t["slot"]
            with self.engine.begin() as con:
                con.execute(update(t).where(t.c.time_point == time_point, t.c.model_version.in_(drop)).values(content=None))
        return drop

    # ------------------------------------------------------------ 역할
    def roles(self) -> dict:
        df = self._read(select(self.t["role"]))
        return {r.objective: {"champion": r.champion, "challenger": r.challenger} for r in df.itertuples()} if len(df) else {}

    def set_roles(self, objective, champion, challenger, action="init", reason="", decision=None):
        cur = self.roles().get(objective, {})
        if not self.write:
            self._dry(f"역할 {objective}: champion={champion}, challenger={challenger}", 1)
            return
        with self.engine.begin() as con:
            con.execute(delete(self.t["role"]).where(self.t["role"].c.objective == objective))
            con.execute(self.t["role"].insert(), [{"objective": objective, "champion": champion, "challenger": challenger,
                                                    "updated_at": _now()}])
            con.execute(self.t["role_history"].insert(), [{
                "at": _now(), "objective": objective, "action": action, "from_champion": cur.get("champion"),
                "from_challenger": cur.get("challenger"), "to_champion": champion, "to_challenger": challenger,
                "reason": reason, "decision": _clean(decision) if decision else None}])

    def role_history(self, objective) -> pd.DataFrame:
        t = self.t["role_history"]
        return self._read(select(t).where(t.c.objective == objective).order_by(t.c.id))

    # ------------------------------------------------------------ 예측 원장
    def ledger_append(self, df: pd.DataFrame) -> int:
        rows = []
        for r in df.to_dict("records"):
            r = dict(r)
            r["target_dd"] = pd.Timestamp(r["target_dd"]).date()
            r["components"] = _clean(json.loads(r["components"]) if isinstance(r["components"], str) else r["components"])
            r["inputs"] = _clean(json.loads(r["inputs"]) if isinstance(r["inputs"], str) else r["inputs"])
            r["recorded_at"] = pd.Timestamp(r["recorded_at"]).to_pydatetime()
            r["host"] = self.host
            rows.append({k: _clean(v) if k not in ("target_dd", "recorded_at") else v for k, v in r.items()})
        return self._insert_new("ledger", rows, ["target_dd", "objective", "model_version"])

    def ledger_read(self) -> pd.DataFrame:
        df = self._read(select(self.t["ledger"]))
        if len(df):
            df["target_dd"] = pd.to_datetime(df["target_dd"])
        return df

    # ------------------------------------------------------------ 모니터링 결과
    def metrics_put(self, mt: pd.DataFrame) -> int:
        cols = [c.name for c in self.t["metric"].c]
        rows = []
        for r in mt.to_dict("records"):
            row = {c: _clean(r.get(c)) for c in cols if c != "computed_at"}
            row["date"] = pd.Timestamp(r["date"]).date()
            row["computed_at"] = _now()
            rows.append(row)
        if not rows:
            return 0
        if not self.write:
            self._dry("지표 갱신", len(rows))
            return 0
        t = self.t["metric"]
        with self.engine.begin() as con:      # 지표는 예측·정답에서 매번 전부 다시 계산하므로 시점·목적·계열 단위로 바꿔 넣는다
            for tp, obj, line in {(r["time_point"], r["objective"], r["line"]) for r in rows}:
                con.execute(delete(t).where(t.c.time_point == tp, t.c.objective == obj, t.c.line == line))
            con.execute(t.insert(), rows)
        return len(rows)

    def alerts_put(self, asof, alerts: list[dict]) -> int:
        rows = [{"asof": pd.Timestamp(asof).date(), "time_point": a.get("time_point"), "objective": a.get("objective"), "level": a.get("level"),
                 "what": a.get("what"), "value": float(a["value"]) if isinstance(a.get("value"), (int, float)) else None,
                 "detail": _clean(a), "created_at": _now()} for a in alerts]
        if not rows:
            return 0
        if not self.write:
            self._dry("경고", len(rows))
            return 0
        t = self.t["alert"]
        with self.engine.begin() as con:
            con.execute(delete(t).where(t.c.asof == pd.Timestamp(asof).date()))
            con.execute(t.insert(), rows)
        return len(rows)

    def compare_put(self, asof, results: list[dict]) -> int:
        rows = []
        for r in results:
            ci = r.get("ci90") or [None, None]
            rows.append({"asof": pd.Timestamp(asof).date(), "objective": r["objective"], "champion": r.get("champion"),
                         "challenger": r.get("challenger"), "common_days": r.get("common_days", 0),
                         "champion_score": _clean(r.get("champion_score")), "challenger_score": _clean(r.get("challenger_score")),
                         "diff": _clean(r.get("diff")), "ci_lo": _clean(ci[0]), "ci_hi": _clean(ci[1]),
                         "decision": r["decision"], "prospective_only": r.get("prospective_only"),
                         "detail": _clean(r), "created_at": _now()})
        return self._replace("compare", rows, ["asof", "objective"])

    def compare_latest(self, objective) -> dict | None:
        t = self.t["compare"]
        df = self._read(select(t).where(t.c.objective == objective).order_by(t.c.asof.desc()).limit(1))
        return None if df.empty else df.iloc[0].to_dict()

    # ------------------------------------------------------------ 작업 기록
    def job_start(self, job: str, detail: dict | None = None) -> int | None:
        if not self.write:
            print(f"[dry-run] 작업 기록 시작: {job}")
            return None
        t = self.t["job"]
        with self.engine.begin() as con:
            res = con.execute(t.insert().values(job=job, host=self.host, started_at=_now(), status="running",
                                                detail=_clean(detail or {})))
            return int(res.inserted_primary_key[0])

    def job_end(self, job_id, status: str, detail: dict | None = None, error: str | None = None):
        if job_id is None:
            print(f"[dry-run] 작업 기록 끝: {status} {error or ''}")
            return
        t = self.t["job"]
        with self.engine.begin() as con:
            con.execute(update(t).where(t.c.id == job_id).values(finished_at=_now(), status=status,
                                                                  detail=_clean(detail or {}), error=error))

    # ------------------------------------------------------------ 학습 입력
    def news_daily_read(self) -> pd.DataFrame:
        df = self._read(select(self.t["news_daily"]))
        if df.empty:
            return pd.DataFrame()
        out = pd.DataFrame(list(df.features), index=pd.DatetimeIndex(pd.to_datetime(df["date"]), name="date")).sort_index()
        out.attrs["articles"] = pd.Series(df.articles.to_numpy(), index=out.index)
        return out

    def news_daily_append(self, frame: pd.DataFrame, source: str, articles: pd.Series | None = None) -> int:
        rows = [{"date": pd.Timestamp(d).date(), "source": source,
                 "articles": None if articles is None or pd.isna(articles.get(d)) else int(articles.get(d)),
                 "features": _clean({k: float(v) for k, v in r.items()}), "created_at": _now()}
                for d, r in frame.iterrows()]
        return self._insert_new("news_daily", rows, ["date"])

    def news_daily_replace(self, frame: pd.DataFrame, source: str, articles: pd.Series | None = None) -> int:
        """전체 재학습 배포용 파생 입력 교체. 원천 뉴스 테이블에는 쓰지 않는다."""
        if frame.empty or frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
            raise ValueError("일별 뉴스 교체 입력이 비었거나 날짜가 중복·역순입니다.")
        rows = [{"date": pd.Timestamp(d).date(), "source": source,
                 "articles": None if articles is None or pd.isna(articles.get(d)) else int(articles.get(d)),
                 "features": _clean({k: float(v) for k, v in r.items()}), "created_at": _now()}
                for d, r in frame.iterrows()]
        if not self.write:
            self._dry("파생 일별 뉴스 스냅샷 교체", len(rows))
            return 0
        table = self.t["news_daily"]
        with self.engine.begin() as con:
            con.execute(delete(table))
            con.execute(table.insert(), rows)
        return len(rows)

    def oos_read(self, objective="reg") -> pd.DataFrame:
        t = self.t["oos"]
        df = self._read(select(t).where(t.c.objective == objective))
        if len(df):
            df["target_dd"] = pd.to_datetime(df["target_dd"])
        return df

    def oos_put(self, df: pd.DataFrame, replace=False) -> int:
        rows = [{"target_dd": pd.Timestamp(r["target_dd"]).date(), "component": r["component"], "line": r["line"],
                 "objective": r.get("objective", "reg"), "yhat": float(r["yhat"]), "source": r.get("source"),
                 "model_version": r.get("model_version")} for r in df.to_dict("records")]
        keys = ["target_dd", "component", "line"]
        if not replace:
            return self._insert_new("oos", rows, keys)
        if not rows:
            return 0
        if not self.write:
            self._dry("OOS 갱신", len(rows))
            return 0
        t = self.t["oos"]
        with self.engine.begin() as con:
            for line in {r["line"] for r in rows}:
                days = sorted({r["target_dd"] for r in rows if r["line"] == line})
                con.execute(delete(t).where(t.c.line == line, t.c.target_dd.in_(days)))
            con.execute(t.insert(), rows)
        return len(rows)


class SplitStore:
    """예측·해설(kospi_pred_*)은 pred 저장소, 나머지(kospi_mlops_*·학습본·슬롯·잠금)는 ops 저장소로 보낸다."""

    def __init__(self, pred, ops):
        self.pred, self.ops = pred, ops
        self.write = ops.write
        self.mode = ops.mode                       # registry 의 학습본 위치는 자동화 기록 모드를 따른다

    def __getattr__(self, name):
        return getattr(self.pred if name in PRED_METHODS else self.ops, name)

    def describe(self) -> str:
        return f"예측·해설 [{self.pred.describe()}] / 자동화 기록 [{self.ops.describe()}]"

    def counts(self) -> dict:
        return {**self.ops.counts(), **self.pred.counts()}

    def missing_tables(self) -> list[str]:
        return self.pred.missing_tables() + self.ops.missing_tables()

    def require_tables(self):
        self.pred.require_tables()
        self.ops.require_tables()

    def create_tables(self):
        self.pred.create_tables()
        self.ops.create_tables()


def _backend(mode: str, write: bool, only=None):
    if mode == "db":
        return DbStore(write=write, only=only)
    if mode == "csv":
        from store_csv import CsvStore
        return CsvStore(write=write)
    raise ValueError(f"mode 는 db 또는 csv 입니다: {mode}")


def modes(mode: str | None = None) -> tuple[str, str]:
    """(예측·해설 모드, 자동화 기록 모드). mode 를 주면 둘 다 그 값."""
    try:
        from db import settings as _  # noqa: F401  (service/.env 를 환경변수로 읽음)
    except ImportError:
        pass
    if mode:
        return mode.strip().lower(), mode.strip().lower()
    ops = (os.environ.get("KOSPI_MLOPS_MODE", "") or "csv").strip().lower()
    return (os.environ.get("KOSPI_PRED_MODE", "") or ops).strip().lower(), ops


def open_store(write: bool = False, mode: str | None = None):
    """mode: 'db'·'csv' 면 예측·해설·자동화 기록 모두 그 모드. 없으면 .env KOSPI_PRED_MODE(예측·해설)·KOSPI_MLOPS_MODE(자동화 기록, 기본 csv)."""
    pred, ops = modes(mode)
    os.environ["KOSPI_MLOPS_MODE"] = ops           # 하위 스크립트(run_automation)도 같은 모드를 따른다
    os.environ["KOSPI_PRED_MODE"] = pred
    if pred == ops:
        return _backend(ops, write)
    return SplitStore(_backend(pred, write, PRED_TABLES if pred == "db" else None), _backend(ops, write))


def open_prediction_store(write: bool = False, mode: str | None = None):
    """예측 단계는 예측·해설 세 표만 요구한다(미구축 mlops 표 때문에 예측을 막지 않음)."""
    pred, _ = modes(mode)
    os.environ['KOSPI_PRED_MODE'] = pred
    return _backend(pred, write, PRED_TABLES if pred == 'db' else None)


def add_args(ap):
    """스크립트 공통 인자: --mode {db,csv}, --write(옛 이름 --write-db 도 받음)."""
    ap.add_argument("--mode", choices=("db", "csv"), help="상태 저장 위치(기본 .env KOSPI_MLOPS_MODE, 없으면 csv)")
    ap.add_argument("--write", "--write-db", dest="write", action="store_true", help="실제로 저장(없으면 dry-run)")
