"""[실사용 모듈] 원본(문자열) -> 숫자 일별 시계열 정리(숫자 변환·중복·이상값). 결측 처리는 kp/missing.py 가 맡는다.

  * '.', '', NULL, 'nan' 등 결측 표기(config.MISSING_TOKENS)와 숫자가 아닌 값은 NaN으로 바꾼다.
  * 가격 <= 0, 고가 < 저가는 비정상 값으로 보고 NaN으로 바꾼다(이후 결측 정책을 따른다).
  * 결측 행은 지우지 않고 NaN으로 남긴다. 휴장일인지 거래일 결측인지는 missing.classify_missing 이 판정한다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from . import config as C

PRICE_COLS = ["Open", "High", "Low", "Close", "Volume"]


def to_number(s: pd.Series) -> pd.Series:
    """문자열 열을 숫자로. 결측 표기 토큰과 숫자가 아닌 값은 NaN. (천단위 쉼표 제거)"""
    t = s.astype("string").str.strip()
    t = t.mask(t.str.lower().isin({x.lower() for x in C.MISSING_TOKENS}))
    t = t.str.replace(",", "", regex=False)
    return pd.to_numeric(t, errors="coerce").astype(float)


def clean_symbol_frame(raw: pd.DataFrame):
    """심볼 하나의 원본을 숫자 프레임으로 정리한다. 반환: (DataFrame[index=Date, NaN 유지], 점검 요약 dict)."""
    df = raw.copy()
    n0 = len(df)
    df["Date"] = pd.to_datetime(df["Date"].astype("string").str.strip().str[:10], errors="coerce")
    bad_date = int(df["Date"].isna().sum())
    df = df.dropna(subset=["Date"])
    num = pd.DataFrame({c: to_number(df[c]) if c in df else np.nan for c in PRICE_COLS}, index=df.index)
    token_missing = {c: int(num[c].isna().sum()) for c in PRICE_COLS}
    num["Date"] = df["Date"].dt.normalize()
    dup = int(num["Date"].duplicated().sum())
    num = num.drop_duplicates("Date", keep="last").sort_values("Date").set_index("Date")

    # 값 자체가 비정상인 경우(가격 <= 0, 고가<저가)는 결측으로 취급
    nonpos = int(((num[["Open", "High", "Low", "Close"]] <= 0).any(axis=1)).sum())
    for c in ["Open", "High", "Low", "Close"]:
        num.loc[num[c] <= 0, c] = np.nan
    inverted = int((num["High"] < num["Low"]).sum())
    num.loc[num["High"] < num["Low"], ["High", "Low"]] = np.nan
    num.loc[num["Volume"] < 0, "Volume"] = np.nan

    ret = num["Close"].dropna().pct_change().abs()
    report = {"rows_in": n0, "bad_date": bad_date, "duplicate_dates": dup,
              "nonpositive_price_rows": nonpos, "high_lt_low": inverted,
              "close_nan_rows": int(num["Close"].isna().sum()),
              "jump_gt_20pct": int((ret > 0.20).sum()),
              **{f"missing_{c}": v for c, v in token_missing.items()}}
    return num, report
