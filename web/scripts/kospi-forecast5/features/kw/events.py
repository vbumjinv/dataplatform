"""[실사용 모듈] (service_5 복사본, 원본: experiments/5/kw/events.py) 이벤트 달력 — 미리 알려진 일정만 쓴다(누수 없음). 대상 기간(기준일 다음 거래일 ~ 대상일) 안 이벤트 수를 변수로 만든다.

이벤트(코스피가 반응하는 한국 거래일 기준):
  opt_expiry  매월 둘째 목요일(옵션 만기, 휴장이면 앞 거래일)       fut_expiry 3·6·9·12월 둘째 목요일(선물 동시 만기)
  fomc        FOMC 성명일(미국) 다음 한국 거래일(긴급 회의 제외)  nfp 미국 고용지표(첫째 금요일 근사) 다음 한국 거래일
  msci        MSCI 정기 변경 적용(2·5·8·11월 마지막 평일 근사)   samsung 삼성전자 잠정실적 시기(1·4·7·10월 셋째~여덟째 거래일 근사)
  month_end / quarter_end 대상 기간이 월말·분기말을 지남      holiday 대상 기간 안 평일 휴장 일수(설·추석 등)
FOMC 날짜는 연준 공지 일정(성명일)을 손으로 옮겼다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

FOMC = """2010-01-27 2010-03-16 2010-04-28 2010-06-23 2010-08-10 2010-09-21 2010-11-03 2010-12-14
2011-01-26 2011-03-15 2011-04-27 2011-06-22 2011-08-09 2011-09-21 2011-11-02 2011-12-13
2012-01-25 2012-03-13 2012-04-25 2012-06-20 2012-08-01 2012-09-13 2012-10-24 2012-12-12
2013-01-30 2013-03-20 2013-05-01 2013-06-19 2013-07-31 2013-09-18 2013-10-30 2013-12-18
2014-01-29 2014-03-19 2014-04-30 2014-06-18 2014-07-30 2014-09-17 2014-10-29 2014-12-17
2015-01-28 2015-03-18 2015-04-29 2015-06-17 2015-07-29 2015-09-17 2015-10-28 2015-12-16
2016-01-27 2016-03-16 2016-04-27 2016-06-15 2016-07-27 2016-09-21 2016-11-02 2016-12-14
2017-02-01 2017-03-15 2017-05-03 2017-06-14 2017-07-26 2017-09-20 2017-11-01 2017-12-13
2018-01-31 2018-03-21 2018-05-02 2018-06-13 2018-08-01 2018-09-26 2018-11-08 2018-12-19
2019-01-30 2019-03-20 2019-05-01 2019-06-19 2019-07-31 2019-09-18 2019-10-30 2019-12-11
2020-01-29 2020-04-29 2020-06-10 2020-07-29 2020-09-16 2020-11-05 2020-12-16
2021-01-27 2021-03-17 2021-04-28 2021-06-16 2021-07-28 2021-09-22 2021-11-03 2021-12-15
2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14
2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28 2026-12-09""".split()


def _nth_weekday(year, month, weekday, n):
    d = pd.Timestamp(year, month, 1)
    d += pd.Timedelta(days=(weekday - d.weekday()) % 7)
    return d + pd.Timedelta(weeks=n - 1)


def _on_or_before(cal, d):
    p = cal.searchsorted(d, side="right") - 1
    return cal[p] if p >= 0 else pd.NaT


def _after(cal, d):
    p = cal.searchsorted(d, side="right")
    return cal[p] if p < len(cal) else pd.NaT


def event_table(cal, start="2009-06-01", end="2026-12-31"):
    """이벤트 -> 코스피가 반응하는 한국 거래일 표(type, event_date, kr_date, source)."""
    cal = pd.DatetimeIndex(cal).sort_values()
    rows = []
    for p in pd.period_range(start, end, freq="M"):
        y, m = p.year, p.month
        sec_thu = _nth_weekday(y, m, 3, 2)
        rows.append(("opt_expiry", sec_thu, _on_or_before(cal, sec_thu), "규칙: 둘째 목요일"))
        if m in (3, 6, 9, 12):
            rows.append(("fut_expiry", sec_thu, _on_or_before(cal, sec_thu), "규칙: 분기 둘째 목요일"))
        first_fri = _nth_weekday(y, m, 4, 1)
        rows.append(("nfp", first_fri, _after(cal, first_fri), "근사: 첫째 금요일"))
        if m in (2, 5, 8, 11):
            last_bd = pd.offsets.BMonthEnd().rollforward(pd.Timestamp(y, m, 1))
            rows.append(("msci", last_bd, _on_or_before(cal, last_bd), "근사: 마지막 평일"))
        if m in (1, 4, 7, 10):
            mdays = cal[(cal.year == y) & (cal.month == m)]
            for k in range(2, 8):
                if k < len(mdays):
                    rows.append(("samsung", mdays[k], mdays[k], "근사: 셋째~여덟째 거래일"))
    for s in FOMC:
        d = pd.Timestamp(s)
        rows.append(("fomc", d, _after(cal, d), "연준 일정 손 입력(확인 필요)"))
    t = pd.DataFrame(rows, columns=["type", "event_date", "kr_date", "source"]).dropna(subset=["kr_date"])
    return t.sort_values(["type", "kr_date"]).reset_index(drop=True)


def window_features(base_dd, target_dd, cal, table):
    """대상 기간 (base_dd, target_dd] 안의 이벤트 수(삼성은 기간에 포함 여부)."""
    cal = pd.DatetimeIndex(cal)
    out = pd.DataFrame(index=pd.DatetimeIndex(target_dd.index))
    b = pd.DatetimeIndex(base_dd).to_numpy()
    t = pd.DatetimeIndex(target_dd).to_numpy()
    for typ, g in table.groupby("type"):
        days = np.sort(pd.DatetimeIndex(g.kr_date.unique()).to_numpy())
        cnt = np.searchsorted(days, t, side="right") - np.searchsorted(days, b, side="right")
        col = f"EVT_{typ}"
        out[col] = (cnt > 0).astype(float) if typ == "samsung" else cnt.astype(float)
    bm, tm = pd.DatetimeIndex(base_dd).to_period("M"), pd.DatetimeIndex(target_dd).to_period("M")
    out["EVT_month_end"] = np.asarray(bm != tm, float)
    out["EVT_quarter_end"] = np.asarray(pd.DatetimeIndex(base_dd).to_period("Q") != pd.DatetimeIndex(target_dd).to_period("Q"), float)
    wk = pd.bdate_range(cal.min(), cal.max())
    hol = np.sort(wk.difference(cal).to_numpy())
    out["EVT_holiday"] = (np.searchsorted(hol, t, side="right") - np.searchsorted(hol, b, side="right")).astype(float)
    bad = pd.isna(target_dd).to_numpy() | pd.isna(base_dd).to_numpy()
    out.loc[bad] = np.nan
    return out
