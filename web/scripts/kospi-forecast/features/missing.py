"""[실사용 모듈] 결측 처리 전용 모듈. 숫자 변환이 끝난 일별 시계열에서 날짜마다 결측 종류를 나누고 정책을 적용한다.

날짜 분류 (classify_missing)
  ok              거래일이고 종가가 있음
  holiday         그 시장의 휴장일 행 중 값이 없거나('.') 직전 유효값을 그대로 복사한 행. 결측이 아니므로 모든 정책에서 지운다.
                  (대표 거래소가 쉬어도 그 지표는 거래된 날 — 예: 성금요일의 달러지수, 독일 통일의 날의 STOXX600 — 은
                   값이 직전과 다르면 실제 값이므로 ok로 남긴다. 2015-08-14처럼 휴장일에 전날 종가를 복사한 행은 지운다.)
  trading_missing 거래일인데 종가가 '.'/NULL/NaN
  row_missing     거래일인데 행 자체가 없음

거래일 판정 = 거래소 달력(exchange_calendars)상 거래일 AND 같은 시장의 다른 시계열 중 하나 이상에 값이 있는 날.
  달력만 쓰면 임시공휴일(예: 2026-06-03 지방선거)을 놓치고, DB 값만 쓰면 DB에서 빠진 날(KOSPI 7일)을 못 잡는다.
  시계열마다 첫 유효값~마지막 유효값 사이만 판정한다(상장 전·수집 전 기간은 결측이 아님).

정책 (trading_missing·row_missing에만 적용. KOSPI는 정답이므로 정책과 관계없이 채우지 않는다)
  skip    결측 날짜를 빼고 유효값만 이어 붙인다. 변수는 유효한 최근 n개로 계산된다.
  ffill1  직전 값으로 1일까지 채운다(채운 날 수익률 0). 한도를 넘는 날은 skip.
  ffill3  직전 값으로 최대 3일까지 채운다.
  nanmean 결측 날짜를 NaN 행으로 남긴다. 변수 계산(features.build_multiday_features)에서 창 안의 유효값만 평균한다.
  nan     결측 날짜를 NaN 행으로 남긴다. NaN이 창에 하나라도 있으면 변수가 NaN이 되고 모델의 결측 처리에 맡긴다.
미래 값으로 채우기(bfill·보간)는 쓰지 않는다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

POLICIES = ("skip", "ffill1", "ffill3", "nanmean", "nan")
CALENDAR_CODES = {"US": "XNYS", "EU": "XETR", "KR": "XKRX"}
_ALIASES = {"drop": "skip"}


def normalize_policy(policy: str, ffill_limit: int | None = None) -> str:
    """이전 이름(drop, ffill+limit)을 새 정책 이름으로 바꾼다."""
    policy = _ALIASES.get(policy, policy)
    if policy == "ffill":
        policy = f"ffill{ffill_limit or 1}"
    if policy not in POLICIES and not (policy.startswith("ffill") and policy[5:].isdigit()):
        raise ValueError(f"알 수 없는 결측 정책: {policy} (가능: {POLICIES})")
    return policy


def ffill_limit_of(policy: str) -> int:
    return int(policy[5:]) if policy.startswith("ffill") else 0


def keeps_nan_rows(policy: str) -> bool:
    return policy in ("nanmean", "nan")


def trading_calendar(market: str, start, end) -> pd.DatetimeIndex:
    """거래소 달력의 거래일. exchange_calendars가 없으면 평일로 대신한다."""
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    try:
        import exchange_calendars as xc
    except ImportError:
        return pd.bdate_range(start, end)
    cal = xc.get_calendar(CALENDAR_CODES[market], start=(start - pd.Timedelta(days=30)).strftime("%Y-%m-%d"))
    first, last = (pd.Timestamp(x).tz_localize(None) if pd.Timestamp(x).tz else pd.Timestamp(x) for x in (cal.first_session, cal.last_session))
    ses = pd.DatetimeIndex(cal.sessions_in_range(max(start, first), min(end, last)))
    return ses.tz_localize(None) if ses.tz is not None else ses


def is_calendar_day_series(dates) -> bool:
    """주말에도 값이 있는 시계열(예: ECOS 기준금리는 매일 값이 있음). 거래일 근거로 쓰지 않는다."""
    d = pd.DatetimeIndex(dates)
    return len(d) > 0 and float((d.dayofweek >= 5).mean()) > 0.05


def open_days(market: str, valid_dates: list, start, end) -> pd.DatetimeIndex:
    """달력상 거래일 중 같은 시장 시계열(주말에도 값이 있는 시계열 제외) 하나 이상에 값이 있는 날."""
    cal = trading_calendar(market, start, end)
    evidence = [set(pd.DatetimeIndex(v)) for v in valid_dates if not is_calendar_day_series(v)]
    seen = pd.DatetimeIndex(sorted(set().union(*evidence))) if evidence else pd.DatetimeIndex([])
    return cal.intersection(seen)


def classify_missing(close: pd.Series, open_idx: pd.DatetimeIndex) -> pd.Series:
    """close: 날짜 index의 종가(NaN = '.' 등 결측). 반환: 날짜별 분류(Series, index = 기존 행 ∪ 결측 거래일)."""
    close = close.sort_index()
    valid = close.dropna()
    if valid.empty:
        return pd.Series("trading_missing", index=close.index)
    lo, hi = valid.index.min(), valid.index.max()
    is_open = close.index.isin(open_idx)
    prev_valid = close.ffill().shift(1)
    traded_off_calendar = ~is_open & close.notna().to_numpy() & ~np.isclose(close, prev_valid, rtol=0, atol=1e-12)
    lab = pd.Series(np.where(~is_open & ~traded_off_calendar, "holiday", np.where(close.isna(), "trading_missing", "ok")), index=close.index)
    in_span = open_idx[(open_idx >= lo) & (open_idx <= hi)]
    absent = in_span.difference(close.index)
    if len(absent):
        lab = pd.concat([lab, pd.Series("row_missing", index=absent)]).sort_index()
    return lab


def apply_missing_policy(df: pd.DataFrame, labels: pd.Series, policy: str, is_target: bool = False) -> pd.DataFrame:
    """df: 날짜 index의 OHLCV 숫자 프레임. holiday 행은 항상 지우고, 결측 거래일에만 정책을 적용한다."""
    policy = normalize_policy(policy)
    df = df.reindex(labels.index)                            # row_missing 날짜는 NaN 행으로 들어온다
    df = df[labels.ne("holiday").to_numpy()]
    lab = labels[labels.ne("holiday")]
    miss = lab.isin(["trading_missing", "row_missing"]).to_numpy()
    if is_target or policy == "skip":
        return df[~miss]
    if keeps_nan_rows(policy):
        df.loc[miss, :] = np.nan
        return df
    limit = ffill_limit_of(policy)
    filled = df["Close"].ffill(limit=limit)
    out = df.copy()
    out.loc[miss, ["Open", "High", "Low"]] = np.nan
    out.loc[miss, "Volume"] = np.nan
    out["Close"] = filled
    return out[out["Close"].notna()]                         # 한도를 넘어 비어 있는 날은 제거


def runs(mask: pd.Series) -> int:
    """True가 연속된 최대 길이."""
    m = mask.to_numpy(bool)
    best = cur = 0
    for v in m:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best


def missing_report(key: str, labels: pd.Series) -> dict:
    """시계열 하나의 결측 요약(엑셀·CSV용)."""
    miss = labels.isin(["trading_missing", "row_missing"])
    span = labels[labels.ne("holiday")]
    return {
        "key": key,
        "n_open_days": int(len(span)),
        "n_ok": int((labels == "ok").sum()),
        "n_holiday_rows": int((labels == "holiday").sum()),
        "n_trading_missing": int((labels == "trading_missing").sum()),
        "n_row_missing": int((labels == "row_missing").sum()),
        "missing_pct": round(float(miss[labels.ne("holiday")].mean() * 100), 3) if len(span) else 0.0,
        "max_consecutive_missing": runs(miss[labels.ne("holiday")]),
        "missing_dates": ", ".join(d.strftime("%Y-%m-%d") for d in labels.index[miss.to_numpy()]),
    }


def kospi_gap_dates(kospi_index: pd.DatetimeIndex, open_idx: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """KOSPI 행 중 '달력상 바로 전 거래일'이 데이터에 없는 날(그 날의 전일 대비 값은 여러 날 수익률이 된다)."""
    k = pd.DatetimeIndex(sorted(kospi_index))
    o = pd.DatetimeIndex(sorted(open_idx.union(k)))
    prev_open = pd.Series(o[:-1], index=o[1:])
    prev_data = pd.Series(k[:-1], index=k[1:])
    common = prev_data.index.intersection(prev_open.index)
    return pd.DatetimeIndex(common[prev_open[common].to_numpy() != prev_data[common].to_numpy()])
