"""[실사용 모듈] 주별 자료 불러오기 — DB 원천 받기 → 시점별 변수 → 기준일·대상일·정답을 한곳에서 준다(예측·재학습·비교가 모두 이 함수만 씀).

흐름: refresh()(= extract_db.py, DB 읽기 전용, 메모리로) → features(tp)(= build_features.py + wk_news 뉴스 변수, DB 기사 읽기 전용) → base_day·target_day·answers.
로컬 캐시 없음(2026-11-24): 원천·변수 표는 이번 실행 메모리에만 있고, 다음 실행은 DB 에서 다시 만든다.
기준일 b = 코스피 거래일. W0 = b 16:00, W2 = b 다음 거래일 08:30 예측. 대상일 = b 뒤 5번째 거래일, 정답 = 대상일 종가 / b 종가 − 1(kw.target).
거래일 = 거래소 달력(XKRX) − DB 공휴일(dp.datagokr_restdeinfo) — build_features.py 와 같은 규칙.
"""
from __future__ import annotations

from functools import lru_cache

import pandas as pd

import wk_paths as P


def refresh():
    """DB 원천을 메모리로 새로 받는다(extract_db.py 와 같음)."""
    import extract_db
    extract_db.main()
    _holidays.cache_clear()
    import wk_news
    wk_news.clear_memory()
    from kw import sources as SRC
    SRC._CALS.pop("KR", None)


def features(tp: str, *, write=False, news_cutoff=None) -> pd.DataFrame:
    """시점 tp 변수(행 = 기준일 b, 열 = 최종 변수 + prediction_at). 저장하지 않는다."""
    import build_features
    import wk_news
    import wk_relation
    import wk_vkospi
    X = build_features.build(tp)
    X = wk_vkospi.attach(X)                                       # VKOSPI 3개(W0 수익률 1차 학습본 입력) — DB 읽기 전용
    X = wk_relation.attach(X)                                     # 시장 관계 변수 3개(v3 학습본 입력, 2026-11-24) — DB 읽기 전용
    return wk_news.attach(tp, X, write=write, as_of=news_cutoff)                                  # 뉴스 변수(NEWS·CHG·TOPIC·KWS·KWR, 1차 학습본 입력) — DB 기사 읽기 전용


def close_ready(base) -> bool:
    """해당 KOSPI 기준일의 양수 종가가 원천 DB에 도착했는지 확인한다."""
    from db import get_engine, settings
    from sqlalchemy import text
    eng = get_engine()
    schema = eng.dialect.identifier_preparer.quote(settings.DB_SCHEMA)
    day = pd.Timestamp(base).normalize()
    with eng.connect() as con:
        con.execute(text("SET TRANSACTION READ ONLY"))
        vals = con.execute(text(f"SELECT clsprc_idx FROM {schema}.krx_kospi_dd_trd "
                                "WHERE idx_nm = '코스피' AND bas_dd = :day"),
                           {"day": day.date()}).scalars().all()
    import math
    nums = pd.to_numeric(pd.Series(vals, dtype=object), errors="coerce")
    return any(math.isfinite(n) and n > 0 for n in nums)


def model_month(base) -> str:
    """5번째 거래일이 속하는 달."""
    return target_day(base).strftime("%Y%m")


def first_base_in(month) -> pd.Timestamp:
    """해당 대상월에서 첫 예측을 내는 기준일."""
    first_target = next_session(pd.Timestamp(f"{month[:4]}-{month[4:]}-01") - pd.Timedelta(days=1))
    return base_of_target(first_target)


def training_cutoff(tp, run_day, month) -> pd.Timestamp:
    """학습에 쓸 정답일의 배타적 상한. W0는 당일 확정 종가까지, W2는 직전 종가까지."""
    d = pd.Timestamp(run_day).normalize()
    first_base = first_base_in(month)
    first_run = first_base if tp == "W0" else next_session(first_base)
    # 늦게 재시도해도 첫 실행 시점에 알 수 있었던 정답까지만 쓴다.
    asof = min(d, first_run)
    known = asof if tp == "W0" and is_session(asof) else prev_session(asof)
    return known + pd.Timedelta(days=1)


def kospi_close() -> pd.Series:
    """코스피 종가(index = 거래일, 이번 실행에 받은 DB 원천)."""
    _, db = P.setup()
    k = db.load_standardized("kospi")
    if k is None or k.empty:
        raise RuntimeError("DB 에서 코스피 원천(kospi)을 받지 못했습니다.")
    return k.set_index(pd.to_datetime(k["Date"]))["Close"].astype(float).sort_index()


@lru_cache(maxsize=1)
def _holidays() -> pd.DatetimeIndex:
    SRC, _ = P.setup()
    return pd.DatetimeIndex(SRC.kr_holidays())


def sessions(start, end) -> pd.DatetimeIndex:
    """[start, end] 코스피 거래일(거래소 달력 − DB 공휴일)."""
    P.setup()
    from kp import missing as MS
    return MS.trading_calendar("KR", pd.Timestamp(start), pd.Timestamp(end)).difference(_holidays())


def is_session(d) -> bool:
    d = pd.Timestamp(d).normalize()
    return d in sessions(d, d)


def next_session(d, n: int = 1) -> pd.Timestamp:
    d = pd.Timestamp(d).normalize()
    return sessions(d + pd.Timedelta(days=1), d + pd.Timedelta(days=20 + 3 * n))[n - 1]


def prev_session(d) -> pd.Timestamp:
    d = pd.Timestamp(d).normalize()
    return sessions(d - pd.Timedelta(days=20), d - pd.Timedelta(days=1))[-1]


def base_day(tp: str, run_day) -> pd.Timestamp:
    """실행일의 기준일(주말·휴일 포함, 2026-11-23): W0 = 그날이 거래일이면 그날, 아니면 직전 거래일. W2 = 직전 거래일.
    대상일 = 기준일 뒤 5번째 거래일(target_day) — 토·일 실행은 금요일 기준일·다음 주 금요일 대상일(평일 실행과 같은 영업일 +5)."""
    d = pd.Timestamp(run_day).normalize()
    return d if tp == "W0" and is_session(d) else prev_session(d)


def base_of_target(target) -> pd.Timestamp:
    """대상일의 기준일 = 대상일보다 5거래일 앞(target_day 의 반대)."""
    t = pd.Timestamp(target).normalize()
    return sessions(t - pd.Timedelta(days=25), t - pd.Timedelta(days=1))[-5]


def run_time(tp: str, run_day) -> pd.Timestamp:
    """실행일의 예측 시각(prediction_at, UTC) = 실행일 + time_points.json 의 시점 시각(W0 16:00·W2 08:30 KST 기본)."""
    import timepoints
    return timepoints.run_time(tp, run_day)


def news_cutoff(tp: str, prediction_at) -> pd.Timestamp:
    """뉴스 적재 마감(예약 실행 시각, timepoints.news_cutoff)."""
    import timepoints
    return timepoints.news_cutoff(tp, prediction_at)


def run_inputs(tp: str, run_day, X: pd.DataFrame, *, write=False):
    """실행일의 (기준일 b, 예측 시각, 입력 표). 입력 표 = b 까지 행, b 행의 prediction_at = 실행 시각.
    거래일 실행은 변수 표 그대로(실행 시각 = 기준일 행 시각). 주말·휴일 실행은 정형 변수는 기준일 값 그대로 두고 뉴스 변수만 실행 시각까지의 기사로 다시 만든다
    (뉴스 창 끝 = 실행 시각; shortcut: 정형 변수의 해외 지표는 기준일 시각 기준 — 주말에 새로 나온 해외 종가는 반영 안 함, 필요하면 build_features 를 실행 시각으로 확장)."""
    b = base_day(tp, run_day)
    at = run_time(tp, run_day)
    if b not in X.index:
        raise RuntimeError(f"{tp}: 기준일 {b.date()} 변수 행이 없습니다(변수 마지막 기준일 {X.index.max().date()}). DB 원천 적재를 확인하세요.")
    Xb = X.loc[:b].copy()
    if pd.Timestamp(Xb.loc[b, "prediction_at"]) != at:
        import wk_news
        Xb["prediction_at"] = Xb["prediction_at"].astype(object)
        Xb.loc[b, "prediction_at"] = at
        Xb["prediction_at"] = pd.to_datetime(Xb["prediction_at"], utc=True)
        Xb = wk_news.attach(tp, Xb, write=write, as_of=news_cutoff(tp, at))
    return b, at, Xb


def target_day(b) -> pd.Timestamp:
    """기준일 b 의 대상일 = b 뒤 5번째 거래일(kw.config.HORIZON_TD)."""
    P.setup()
    from kw import config as WC
    return next_session(b, WC.HORIZON_TD)


def to_target(bases) -> pd.DatetimeIndex:
    """기준일들 → 대상일들(5거래일 뒤, target_day 와 같음). DB OOS 행의 target_dd 를 만들 때 쓴다."""
    P.setup()
    from kw import config as WC
    b = pd.DatetimeIndex(pd.to_datetime(bases)).normalize()
    if b.empty:
        return b
    cal = sessions(b.min(), b.max() + pd.Timedelta(days=20 + 3 * WC.HORIZON_TD))
    pos = cal.get_indexer(b)
    if (pos < 0).any():
        raise ValueError(f"거래일이 아닌 기준일: {list(b[pos < 0][:3])}")
    return cal[pos + WC.HORIZON_TD]


def to_base(targets) -> pd.DatetimeIndex:
    """대상일들 → 기준일들(5거래일 앞, base_of_target 와 같음)."""
    P.setup()
    from kw import config as WC
    t = pd.DatetimeIndex(pd.to_datetime(targets)).normalize()
    if t.empty:
        return t
    cal = sessions(t.min() - pd.Timedelta(days=20 + 3 * WC.HORIZON_TD), t.max())
    pos = cal.get_indexer(t)
    if (pos < WC.HORIZON_TD).any():
        raise ValueError(f"거래일이 아닌 대상일: {list(t[pos < WC.HORIZON_TD][:3])}")
    return cal[pos - WC.HORIZON_TD]


def is_month_end(b) -> bool:
    """b 가 그달 마지막 거래일이면 True(이 예측 직후 다음 달용 재학습)."""
    return next_session(b).month != pd.Timestamp(b).month


def answers(base_dd) -> pd.DataFrame:
    """기준일들의 대상일·정답(index = base_dd, 열 target_dd·y_return·y_direction). 대상일 종가가 아직 없으면 NaN."""
    P.setup()
    from kw import target as TG
    base = pd.DatetimeIndex(base_dd)
    if base.empty:
        return pd.DataFrame(index=base, columns=["target_dd", "y_return", "y_direction"])
    close = kospi_close()
    cal = sessions(min(close.index.min(), base.min()) if len(base) else close.index.min(),
                   close.index[-1] + pd.Timedelta(days=30))
    kospi = pd.DataFrame({"Close": close, "High": close, "Low": close})    # 정답에는 종가만 쓴다(고가·저가는 보조 정답용)
    out = TG.build_targets(kospi, base, cal, close.index[-1])
    return out[["target_dd", "y_return", "y_direction"]]


def training_set(tp: str, X: pd.DataFrame, cutoff) -> pd.DataFrame:
    """재학습 행: 변수 X + 정답, 대상일 < cutoff(= 새 학습본의 첫 예측일)인 행만(정답 기간 겹침 purge, kw.target.purge_before)."""
    P.setup()
    from kw import target as TG
    ds = X.drop(columns=["prediction_at"]).join(answers(X.index))
    return TG.purge_before(ds.dropna(subset=["y_return"]), cutoff)
