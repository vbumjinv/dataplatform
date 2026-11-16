"""[실사용 모듈] 서비스 저장소의 CSV 모드 — mlops/store.DbStore 와 같은 메서드를 CSV 파일로 구현한다(DB 테이블이 아직 없을 때).

사용처: mlops/store.open_store(mode='csv')
위치: KOSPI_CSV_DIR(.env), 비우면 service/outputs/tables (파일 이름 = DB 테이블 이름)
  <테이블 이름>.csv(kospi_pred_cls·kospi_pred_reg·kospi_pred_explain·kospi_mlops_*) — DB 테이블과 같은 열(학습본 파일 열 bundle·background 만 뺌).
  json 열은 json 문자열, 날짜는 YYYY-MM-DD
  models/<model_version>/bundle.joblib·background.parquet — 학습본 파일(DB 모드의 bytea 대신)
  .lock_<작업>  — 같은 작업 동시 실행 막기(12시간 지난 잠금은 비정상 종료로 보고 다시 잡음)
쓰기: write=True 일 때만. 파일은 임시 파일에 쓴 뒤 바꿔 끼워 중간에 끊겨도 깨지지 않게 한다.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import BigInteger, Float, Integer

from sqlalchemy import Boolean

from store import SERVICE, _clean, _now, _tables
from store_pred import PredMixin

JSON_COLS = {"model": ["manifest"], "role_history": ["decision"], "ledger": ["components", "inputs"], "alert": ["detail"],
             "compare": ["detail"], "job": ["detail"], "news_daily": ["features"],
             "pred_cls": ["model_input", "shap_result"], "pred_reg": ["model_input", "shap_result"], "pred_explain": ["article_keys"]}
DATE_COLS = {"ledger": ["target_dd"], "metric": ["date"], "alert": ["asof"], "compare": ["asof"], "news_daily": ["date"],
             "oos": ["target_dd"], "pred_cls": ["target_dd"], "pred_reg": ["target_dd"], "pred_explain": ["target_dd"]}


def _k(v):
    """키 비교용 문자열(날짜는 YYYY-MM-DD, 시간대 있는 시각(prediction_at)은 UTC ISO)."""
    if isinstance(v, str) and len(v) > 10 and v[4:5] == "-" and v[10:11] in (" ", "T"):
        v = pd.Timestamp(v)                       # CSV 에서 읽은 prediction_at 문자열
    if isinstance(v, (pd.Timestamp, datetime)) or (hasattr(v, "year") and not isinstance(v, str)):
        t = pd.Timestamp(v)
        return t.tz_convert("UTC").isoformat() if t.tzinfo is not None else str(t.date())
    return str(v)


class CsvStore(PredMixin):
    mode = "csv"

    def __init__(self, write: bool = False, folder: str | None = None):
        self.write = write
        self.dir = Path(folder or os.environ.get("KOSPI_CSV_DIR", "").strip() or SERVICE / "outputs" / "tables").resolve()
        _, tabs = _tables(None)
        self.names = {k: t.name for k, t in tabs.items()}
        self.cols = {k: [c.name for c in t.c if c.name not in ("bundle", "background", "content")] for k, t in tabs.items()}
        self.num = {k: [c.name for c in t.c if isinstance(c.type, (Float, Integer, BigInteger))] for k, t in tabs.items()}
        self.bool = {k: [c.name for c in t.c if isinstance(c.type, Boolean)] for k, t in tabs.items()}
        self.host = socket.gethostname()

    # ------------------------------------------------------------ 공통
    def path(self, name) -> Path:
        return self.dir / f"{self.names[name]}.csv"

    def describe(self) -> str:
        return f"csv {self.dir} write={self.write}"

    def missing_tables(self) -> list[str]:
        return [self.names[k] for k in self.cols if not self.path(k).exists()]

    def require_tables(self):
        miss = self.missing_tables()
        if miss:
            raise RuntimeError(f"CSV 파일이 없습니다: {miss}. python run_mlops_setup.py --mode csv --all --write 로 만드세요.")

    def create_tables(self):
        if not self.write:
            print(f"[dry-run] CSV 파일 생성 예정: {self.missing_tables()} ({self.dir})")
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        for k, cols in self.cols.items():
            if not self.path(k).exists():
                pd.DataFrame(columns=cols).to_csv(self.path(k), index=False, encoding="utf-8-sig")

    def counts(self) -> dict:
        return {self.names[k]: (len(self._load(k)) if self.path(k).exists() else None) for k in self.cols}

    @contextmanager
    def lock(self, job: str):
        self.dir.mkdir(parents=True, exist_ok=True)
        f = self.dir / f".lock_{job}"
        if f.exists() and datetime.now().timestamp() - f.stat().st_mtime > 12 * 3600:
            f.unlink(missing_ok=True)
        try:
            fd = os.open(f, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            yield False
            return
        try:
            os.write(fd, f"{self.host} {datetime.now().isoformat()}".encode())
            os.close(fd)
            yield True
        finally:
            f.unlink(missing_ok=True)

    def _dry(self, what, n):
        print(f"[dry-run] {what}: {n}건 (쓰지 않음, --write 로 실제 저장)")

    def _load(self, name) -> pd.DataFrame:
        p = self.path(name)
        if not p.exists():
            return pd.DataFrame(columns=self.cols[name])
        df = pd.read_csv(p, encoding="utf-8-sig", dtype=str, keep_default_na=False, na_values=[""])
        for c in JSON_COLS.get(name, []):
            df[c] = df[c].map(lambda x: json.loads(x) if isinstance(x, str) and x else None)
        for c in DATE_COLS.get(name, []):
            df[c] = pd.to_datetime(df[c])
        for c in self.num[name]:
            if c in df:
                df[c] = pd.to_numeric(df[c])
        for c in self.bool[name]:
            if c in df:
                df[c] = df[c].map(lambda x: None if pd.isna(x) else str(x).lower() == "true")
        return df

    def _save(self, name, df: pd.DataFrame):
        out = df.reindex(columns=self.cols[name]).copy()
        for c in JSON_COLS.get(name, []):
            out[c] = out[c].map(lambda x: None if x is None or (isinstance(x, float) and np.isnan(x))
                                else json.dumps(_clean(x), ensure_ascii=False))
        for c in DATE_COLS.get(name, []):
            out[c] = pd.to_datetime(out[c]).dt.strftime("%Y-%m-%d")
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path(name).with_suffix(".tmp")
        out.to_csv(tmp, index=False, encoding="utf-8-sig")
        tmp.replace(self.path(name))

    def _insert_new(self, name, rows: list[dict], keys: list[str]) -> int:
        """키가 없는 행만 넣는다(이미 있으면 그대로 둔다)."""
        if not rows:
            return 0
        if not self.write:
            self._dry(f"{name} 추가 후보", len(rows))
            return 0
        old = self._load(name)
        have = {tuple(_k(v) for v in r) for r in old[keys].itertuples(index=False)} if len(old) else set()
        new = [r for r in rows if tuple(_k(r[k]) for k in keys) not in have]
        if new:
            self._save(name, pd.concat([old, pd.DataFrame(new)], ignore_index=True) if len(old) else pd.DataFrame(new))
        return len(new)

    def _replace_where(self, name, rows: list[dict], drop) -> int:
        """drop(old) 가 True 인 기존 행을 지우고 rows 를 넣는다."""
        if not rows:
            return 0
        if not self.write:
            self._dry(f"{name} 갱신", len(rows))
            return 0
        old = self._load(name)
        if len(old):
            old = old[~drop(old)]
        self._save(name, pd.concat([old, pd.DataFrame(rows)], ignore_index=True) if len(old) else pd.DataFrame(rows))
        return len(rows)

    def _select(self, name, eq: dict | None = None, start=None, end=None) -> pd.DataFrame:
        """eq 열 값이 같고 target_dd 가 start~end 인 행(예측 테이블용)."""
        df = self._load(name)
        for k, v in (eq or {}).items():
            df = df[df[k].map(_k) == _k(v)] if len(df) else df
        if start is not None and len(df):
            df = df[df.target_dd >= pd.Timestamp(start)]
        if end is not None and len(df):
            df = df[df.target_dd <= pd.Timestamp(end)]
        return df.reset_index(drop=True)

    def _update(self, name, key: dict, values: dict) -> int:
        """키가 같은 행의 열 값을 바꾼다. 바뀐 행 수."""
        if not self.write:
            self._dry(f"{self.names[name]} {list(values)} 갱신", 1)
            return 0
        df = self._load(name)
        m = pd.Series(True, index=df.index)
        for k, v in key.items():
            m &= df[k].isna() if v is None else df[k].map(_k) == _k(v)
        for c, v in values.items():
            if c not in df:
                df[c] = None
            df[c] = df[c].astype(object)
            for i in df.index[m]:
                df.at[i, c] = v
        if m.any():
            self._save(name, df)
        return int(m.sum())

    def _upsert(self, name, rows: list[dict], keys: list[str]) -> int:
        """같은 키는 지우고 다시 넣는다."""
        want = {tuple(_k(r[k]) for k in keys) for r in rows}
        return self._replace_where(name, rows, lambda o: pd.Series([tuple(_k(v) for v in t) for t in o[keys].itertuples(index=False)],
                                                                   index=o.index).isin(want))

    @staticmethod
    def _next_id(df) -> int:
        return int(pd.to_numeric(df["id"]).max()) + 1 if len(df) else 1

    # ------------------------------------------------------------ 학습본 등록부
    def model_dir(self, model_version) -> Path:
        return self.dir / "models" / model_version

    def model_drop_files(self, model_version: str):
        """오래된 등록부 학습본의 파일만 지운다(행·manifest 는 남김)."""
        if not self.write:
            self._dry(f"model {model_version} 파일 지우기", 1)
            return
        shutil.rmtree(self.model_dir(model_version), ignore_errors=True)

    def model_put(self, manifest: dict, folder: Path, mlflow_version: str | None = None) -> bool:
        mv = manifest["model_version"]
        if not self.write:
            self._dry("model 추가 후보", 1)
            return False
        if mv in set(self._load("model").model_version):
            return False
        d = self.model_dir(mv)
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy2(folder / manifest["artifact"], d / "bundle.joblib")
        shutil.copy2(folder / manifest["background"]["artifact"], d / "background.parquet")
        row = {"model_version": mv, "objective": manifest["objective"], "line": manifest.get("line", "model_1"),
               "target_month": manifest["target_month"], "grid": manifest.get("grid"), "created_utc": manifest.get("created_utc"),
               "artifact_sha256": manifest["artifact_sha256"], "background_sha256": manifest["background"]["sha256"],
               "manifest": _clean({k: v for k, v in manifest.items() if not k.startswith("_")}),
               "mlflow_version": mlflow_version, "registered_at": _now().isoformat()}
        return self._insert_new("model", [row], ["model_version"]) == 1

    def model_set(self, model_version: str, **values):
        if not self.write:
            self._dry(f"model {model_version} {list(values)} 갱신", 1)
            return
        df = self._load("model")
        for k, v in values.items():
            df[k] = df[k].astype(object)  # pandas 3 StringArray에도 등록부 API의 int 버전·ISO 시각을 안전하게 기록
            df.loc[df.model_version == model_version, k] = v.isoformat() if hasattr(v, "isoformat") else v
        self._save("model", df)

    def model_list(self, objective: str | None = None) -> pd.DataFrame:
        df = self._load("model")
        if objective and len(df):
            df = df[df.objective == objective]
        return df.astype(object).where(df.notna(), None)

    def model_files(self, model_version: str) -> tuple[bytes, bytes]:
        d = self.model_dir(model_version)
        return (d / "bundle.joblib").read_bytes(), (d / "background.parquet").read_bytes()

    # ------------------------------------------------------------ 배포 슬롯 백업(시점별, 파일은 slots/<시점>/<버전>/)
    def slot_dir(self, time_point, model_version) -> Path:
        return self.dir / "slots" / time_point / model_version

    def slot_put(self, time_point: str, model_version: str, target_month: str, files: dict) -> int:
        import hashlib
        if not self.write:
            self._dry(f"slot {time_point} {model_version} 백업", len(files))
            return 0
        d = self.slot_dir(time_point, model_version)
        d.mkdir(parents=True, exist_ok=True)
        rows = []
        for n, f in files.items():
            shutil.copy2(f, d / n)
            rows.append({"time_point": time_point, "model_version": model_version, "file_name": n, "target_month": target_month,
                         "sha256": hashlib.sha256((d / n).read_bytes()).hexdigest(), "size_bytes": (d / n).stat().st_size,
                         "deployed_at": _now().isoformat()})
        df = self._load("slot")
        df = df[~((df.time_point == time_point) & (df.model_version == model_version) & df.file_name.isin(files))]
        self._save("slot", pd.concat([df, pd.DataFrame(rows)], ignore_index=True))
        return len(rows)

    def slot_list(self, time_point: str | None = None) -> pd.DataFrame:
        df = self._load("slot")
        if time_point and len(df):
            df = df[df.time_point == time_point]
        return df

    def slot_files(self, time_point: str, model_version: str) -> dict:
        df = self.slot_list(time_point)
        df = df[df.model_version == model_version]
        d = self.slot_dir(time_point, model_version)
        return {r.file_name: (r.sha256, (d / r.file_name).read_bytes() if (d / r.file_name).exists() else None) for r in df.itertuples()}

    def slot_prune(self, time_point: str, keep: int = 3) -> list[str]:
        df = self.slot_list(time_point)
        if df.empty:
            return []
        order = df.groupby("model_version").deployed_at.max().sort_values()
        drop = list(order.index[:-keep])
        if self.write:
            for v in drop:
                shutil.rmtree(self.slot_dir(time_point, v), ignore_errors=True)
        return drop

    # ------------------------------------------------------------ 역할
    def roles(self) -> dict:
        return {r.objective: {"champion": r.champion, "challenger": r.challenger if isinstance(r.challenger, str) else None}
                for r in self._load("role").itertuples()}

    def set_roles(self, objective, champion, challenger, action="init", reason="", decision=None):
        cur = self.roles().get(objective, {})
        if not self.write:
            self._dry(f"역할 {objective}: champion={champion}, challenger={challenger}", 1)
            return
        role = self._load("role")
        role = role[role.objective != objective]
        new = pd.DataFrame([{"objective": objective, "champion": champion, "challenger": challenger, "updated_at": _now().isoformat()}])
        self._save("role", pd.concat([role, new], ignore_index=True) if len(role) else new)
        hist = self._load("role_history")
        row = pd.DataFrame([{"id": self._next_id(hist), "at": _now().isoformat(), "objective": objective, "action": action,
                             "from_champion": cur.get("champion"), "from_challenger": cur.get("challenger"),
                             "to_champion": champion, "to_challenger": challenger, "reason": reason,
                             "decision": _clean(decision) if decision else None}])
        self._save("role_history", pd.concat([hist, row], ignore_index=True) if len(hist) else row)

    def role_history(self, objective) -> pd.DataFrame:
        df = self._load("role_history")
        return df[df.objective == objective].sort_values("id") if len(df) else df

    # ------------------------------------------------------------ 예측 원장
    def ledger_append(self, df: pd.DataFrame) -> int:
        rows = []
        for r in df.to_dict("records"):
            r = dict(r)
            r["target_dd"] = pd.Timestamp(r["target_dd"])
            for c in ("components", "inputs"):
                r[c] = _clean(json.loads(r[c]) if isinstance(r[c], str) else r[c])
            r["recorded_at"] = str(pd.Timestamp(r["recorded_at"]))
            r["host"] = r.get("host") or self.host
            rows.append(r)
        return self._insert_new("ledger", rows, ["target_dd", "objective", "model_version"])

    def ledger_read(self) -> pd.DataFrame:
        return self._load("ledger")

    # ------------------------------------------------------------ 모니터링 결과
    def metrics_put(self, mt: pd.DataFrame) -> int:
        rows = []
        for r in mt.to_dict("records"):
            row = {c: _clean(r.get(c)) for c in self.cols["metric"] if c != "computed_at"}
            row.update(date=pd.Timestamp(r["date"]), computed_at=_now().isoformat())
            rows.append(row)
        keys = {(r["time_point"], r["objective"], r["line"]) for r in rows}   # 지표는 매번 전부 다시 계산하므로 시점·목적·계열 단위로 바꿔 넣는다
        return self._replace_where("metric", rows, lambda o: pd.Series(list(zip(o.time_point, o.objective, o.line)), index=o.index).isin(keys))

    def alerts_put(self, asof, alerts: list[dict]) -> int:
        day = pd.Timestamp(asof).normalize()
        start = self._next_id(self._load("alert"))
        rows = [{"id": start + i, "asof": day, "time_point": a.get("time_point"), "objective": a.get("objective"),
                 "level": a.get("level"), "what": a.get("what"),
                 "value": float(a["value"]) if isinstance(a.get("value"), (int, float)) else None, "detail": _clean(a),
                 "created_at": _now().isoformat()} for i, a in enumerate(alerts)]
        return self._replace_where("alert", rows, lambda o: o.asof == day)

    def compare_put(self, asof, results: list[dict]) -> int:
        day = pd.Timestamp(asof).normalize()
        rows = []
        for r in results:
            ci = r.get("ci90") or [None, None]
            rows.append({"asof": day, "objective": r["objective"], "champion": r.get("champion"), "challenger": r.get("challenger"),
                         "common_days": r.get("common_days", 0), "champion_score": _clean(r.get("champion_score")),
                         "challenger_score": _clean(r.get("challenger_score")), "diff": _clean(r.get("diff")),
                         "ci_lo": _clean(ci[0]), "ci_hi": _clean(ci[1]), "decision": r["decision"],
                         "prospective_only": r.get("prospective_only"), "detail": _clean(r),
                         "created_at": _now().isoformat()})
        objs = {r["objective"] for r in rows}
        return self._replace_where("compare", rows, lambda o: (o.asof == day) & o.objective.isin(objs))

    def compare_latest(self, objective) -> dict | None:
        df = self._load("compare")
        df = df[df.objective == objective].sort_values("asof") if len(df) else df
        return None if df.empty else df.iloc[-1].to_dict()

    # ------------------------------------------------------------ 작업 기록
    def job_start(self, job: str, detail: dict | None = None) -> int | None:
        if not self.write:
            print(f"[dry-run] 작업 기록 시작: {job}")
            return None
        df = self._load("job")
        jid = self._next_id(df)
        row = pd.DataFrame([{"id": jid, "job": job, "host": self.host, "started_at": _now().isoformat(), "status": "running",
                             "detail": _clean(detail or {})}])
        self._save("job", pd.concat([df, row], ignore_index=True) if len(df) else row)
        return jid

    def job_end(self, job_id, status: str, detail: dict | None = None, error: str | None = None):
        if job_id is None:
            print(f"[dry-run] 작업 기록 끝: {status} {error or ''}")
            return
        df = self._load("job")
        i = df.index[pd.to_numeric(df["id"]) == job_id]
        df["detail"] = df["detail"].astype(object)
        for j in i:
            df.at[j, "finished_at"] = _now().isoformat()
            df.at[j, "status"] = status
            df.at[j, "error"] = error
            df.at[j, "detail"] = _clean(detail or {})
        self._save("job", df)

    # ------------------------------------------------------------ 학습 입력
    def news_daily_read(self) -> pd.DataFrame:
        df = self._load("news_daily")
        if df.empty:
            return pd.DataFrame()
        idx = pd.DatetimeIndex(df["date"], name="date")
        out = pd.DataFrame(list(df.features), index=idx).sort_index()
        out.attrs["articles"] = pd.Series(df.articles.to_numpy(), index=idx)
        return out

    def news_daily_append(self, frame: pd.DataFrame, source: str, articles: pd.Series | None = None) -> int:
        rows = [{"date": pd.Timestamp(d), "source": source,
                 "articles": None if articles is None or pd.isna(articles.get(d)) else int(articles.get(d)),
                 "features": _clean({k: float(v) for k, v in r.items()}), "created_at": _now().isoformat()}
                for d, r in frame.iterrows()]
        return self._insert_new("news_daily", rows, ["date"])

    def news_daily_replace(self, frame: pd.DataFrame, source: str, articles: pd.Series | None = None) -> int:
        """전체 재학습 배포 시 파생 일별 입력을 새 스냅샷으로 교체한다(원천 기사·피처는 수정하지 않음)."""
        if frame.empty or frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
            raise ValueError("일별 뉴스 교체 입력이 비었거나 날짜가 중복·역순입니다.")
        rows = [{"date": pd.Timestamp(d), "source": source,
                 "articles": None if articles is None or pd.isna(articles.get(d)) else int(articles.get(d)),
                 "features": _clean({k: float(v) for k, v in r.items()}), "created_at": _now().isoformat()}
                for d, r in frame.iterrows()]
        if not self.write:
            self._dry("파생 일별 뉴스 스냅샷 교체", len(rows))
            return 0
        self._save("news_daily", pd.DataFrame(rows))
        return len(rows)

    def oos_read(self, objective="reg") -> pd.DataFrame:
        df = self._load("oos")
        return df[df.objective == objective] if len(df) else df

    def oos_put(self, df: pd.DataFrame, replace=False) -> int:
        rows = [{"target_dd": pd.Timestamp(r["target_dd"]), "component": r["component"], "line": r["line"],
                 "objective": r.get("objective", "reg"), "yhat": float(r["yhat"]), "source": r.get("source"),
                 "model_version": r.get("model_version")} for r in df.to_dict("records")]
        if not replace:
            return self._insert_new("oos", rows, ["target_dd", "component", "line"])
        keys = {(r["line"], _k(r["target_dd"])) for r in rows}
        return self._replace_where("oos", rows, lambda o: pd.Series([(l, _k(d)) for l, d in zip(o.line, o.target_dd)],
                                                                     index=o.index).isin(keys))
