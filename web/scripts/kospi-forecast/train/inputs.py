"""[실사용 모듈] DB 읽기 전용 스냅샷으로 정형 데이터셋과 일별 뉴스 변수를 만든다 — 재학습·예측 원장·모니터링 공용.

사용처: train/trainer.py, train/retrain_t2.py, train/retrain_f0.py(last_session_before), run_record_predictions.py, run_monitor_daily.py
입력: DB 정형 원천(db/tables.py), dp.news_feature_orig(+dp.news_stock_article), 뉴스 이력(시드 또는 model/data/news_daily_history.parquet)
출력: (ds, news) — ds는 features.dataset.build_dataset 결과(정답 y_return·y_direction 포함), news는 {'cls': 12열, 'reg': 14열}

계산은 predict/engine.py --tp T2 와 같다(같은 함수 w1_days·news_cls_features·news_reg_features 를 import 해서 쓴다).
원천 조회·정리는 features/db_snapshot.py를 공용으로 사용한다. DB에는 쓰지 않는다.
"""
from __future__ import annotations

import json
import shutil
import sys
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import text

SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / "predict"), str(SERVICE)]

import db  # noqa: E402
import db.settings as S  # noqa: E402
from features import config as C, dataset as D  # noqa: E402
from t2_model import news_cls_features, news_reg_features, w1_days  # noqa: E402
from news.source import FEATURE_READ_TABLE, available, utc

DATA = SERVICE / "model" / "data"
from features import timepoints as TPR  # noqa: E402
CP_NAME = TPR.checkpoint_id("T2")   # 시각은 service/time_points.json
NEWS_SQL = f"""select f.article_key, {available()} AS available_at_kst, f.article_role, f.probs, f.prompt_sha256
    from {FEATURE_READ_TABLE} f
    where f.stage2_status='ok' and {available()} >= :lo and {available()} < :hi and f.probs is not null"""


def last_session_before(month: str) -> pd.Timestamp:
    """대상월 직전 KOSPI 거래일(대상월 학습본의 gap 날짜). 그날 장중에 재학습해도 그 행이 데이터셋에 있도록 target_date 로 쓴다."""
    import exchange_calendars as xcals
    start = pd.Period(month, "M").start_time
    return pd.Timestamp(xcals.get_calendar("XKRX").date_to_session(start - pd.Timedelta(days=1), direction="previous")).tz_localize(None)


def checkpoint():
    return TPR.checkpoint("T2")


def load_snapshot(end, target_date=None, news_after=None, news_hist=None):
    """DB에서 정형 원천·뉴스 기사를 한 번에(REPEATABLE READ, READ ONLY) 읽어 데이터셋을 만든다.

    end: 정형 데이터셋 마지막 날짜(END_DATE). target_date: 장 시작 전 예측 대상일(정답 없음, 운영 예측과 같은 방식).
    news_after: 이 날짜 이후 거래일의 뉴스 변수를 DB 기사로 계산. news_hist: ctx 지수감쇠용 과거 일별 core 값(index=날짜).
    """
    end = pd.Timestamp(end)
    target_date = pd.Timestamp(target_date) if target_date is not None else None
    from features import db_snapshot
    with db.get_engine().connect().execution_options(isolation_level="REPEATABLE READ") as con:
        with con.begin():
            con.execute(text('SET TRANSACTION READ ONLY'))
            snapshot_at = con.execute(text('SELECT transaction_timestamp()')).scalar()
            ds = db_snapshot.build(con, 'T2', end, target_date)
            art = None
            if news_after is not None:
                days = pd.DatetimeIndex(ds.index[ds.index > pd.Timestamp(news_after)])
                if len(days):
                    prev = D.previous_trading_day_map(ds.index).reindex(days)
                    hi = pd.Timestamp(ds.loc[days[-1], 'prediction_at']).to_pydatetime()
                    art = pd.read_sql(text(NEWS_SQL), con, params={'lo': pd.Timestamp(prev.min()).tz_localize('Asia/Seoul').to_pydatetime(), 'hi': hi})
    news = None
    if news_after is not None:
        news = daily_news(ds, art, pd.Timestamp(news_after), news_hist)
    return ds, news, {"source_snapshot_at": str(snapshot_at)}


def daily_news(ds, art, after, hist):
    """after 다음 거래일부터 ds 마지막 날까지 뉴스 일별 변수(방향 12열·수익률 14열)."""
    days = pd.DatetimeIndex(ds.index[ds.index > after])
    if len(days) == 0:
        return {"cls": pd.DataFrame(), "reg": pd.DataFrame()}
    if art is None or art.empty:
        art = pd.DataFrame(columns=["article_key", "available_at_kst", "article_role", "probs", "prompt_sha256"])
    if art.article_key.duplicated().any():
        raise ValueError("기사 키 중복: 뉴스 피처 버전을 먼저 확정하세요.")
    cols = json.loads((DATA / "cols.json").read_text(encoding="utf-8"))
    ci = {c: i for i, c in enumerate(cols)}
    fo = [(c.split("__")[0], c.split("__", 1)[1]) for c in cols]
    av = utc(art.available_at_kst).dt.tz_convert("Asia/Seoul").dt.tz_localize(None)
    pr = art["probs"].map(lambda x: json.loads(x) if isinstance(x, str) else x)
    P = np.array([[d[f].get(o, 0.0) for f, o in fo] for d in pr], np.float16).reshape(len(art), len(cols))
    prev = D.previous_trading_day_map(ds.index).reindex(days)
    day = w1_days(av, days, prev, ds.loc[days, "prediction_at"])
    recap = (art.article_role == "market_recap").to_numpy()
    hist = hist[hist.index <= after][["core_wmean_s", "core_mean_sw"]]
    return {"cls": news_cls_features(P, day, recap, ci, days, hist), "reg": news_reg_features(P, day, ci, days),
            "articles_per_day": pd.Series(np.bincount(day[day >= 0], minlength=len(days)), index=days)}
