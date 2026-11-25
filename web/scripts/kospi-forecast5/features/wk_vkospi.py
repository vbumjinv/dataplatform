"""[실사용 모듈] VKOSPI 변수 3개 — W0 수익률 1차 학습본(XGBoost VKOSPI판)이 쓰는 NEW_KR_VKOSPI_level·level_z_250·ret_60d 를 DB 로 만든다.

원본 계산: experiments/5/test/single_models_td5_20261113/decline_data.derive('KR_VKOSPI', 'price_level') + build(정렬 krx_close, 지연 0일).
원천(DB 읽기 전용): dp.krx_drvprod_dd_trd '코스피 200 변동성지수' 종가. 국내 휴장일 값은 건너뛰고(skip), 예측 시각 앞에 확정된 마지막 값을 붙인다.
"""
from __future__ import annotations

import pandas as pd

from kw import align as AL, features as FT, sources as SRC

SQL = "select bas_dd as date, clsprc_idx as close from dp.krx_drvprod_dd_trd where idx_nm = '코스피 200 변동성지수'"
COLS = ["NEW_KR_VKOSPI_level", "NEW_KR_VKOSPI_level_z_250", "NEW_KR_VKOSPI_ret_60d"]


def build(X: pd.DataFrame) -> pd.DataFrame:
    raw = SRC.series_from_frame(SRC.read_db_sql(SQL, "KR_VKOSPI_DB", refresh=True))
    s = SRC.drop_holiday_copies(raw, "krx_close")
    f = FT.price_feats(s[s > 0], "KR_VKOSPI", "price_level")
    blk, _, age = AL.asof_join(pd.DatetimeIndex(X.index), X["prediction_at"], f, "krx_close", 0)
    AL.check_no_future(age, "VKOSPI")
    return blk.add_prefix("NEW_")[COLS]


def attach(X: pd.DataFrame) -> pd.DataFrame:
    V = build(X)
    return pd.concat([X.drop(columns=[c for c in COLS if c in X.columns]), V], axis=1)
