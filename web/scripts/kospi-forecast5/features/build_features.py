"""[실사용 스크립트] 주별 변수 만들기 — DB 원천(extract_db 가 이번 실행 메모리로 받음)으로 최종 주별 모델 변수(feature_sources.json)를 시점별로 만든다.

행 = 기준일 b(코스피 거래일, 원천 마지막 날까지), 열 = 그 시점(W0 = b 16:00, W2 = b 다음 거래일 08:30) 최종 모델이 쓰는 변수 + prediction_at.
계산식·시점 정렬은 주별 실험(kw.dataset.Builder, kw.features, kw.align, 일별 kp)과 같고, 원천은 DB 에서 읽는다(로컬 캐시 없음).
실행: python -B features/build_features.py --tp W2
"""
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()
import argparse

import numpy as np
import pandas as pd

import wk_paths as P

VK = "KR_VKOSPI"


def features_of(tp):
    from extract_db import source_config

    F = source_config()
    return F[F.time_points.str.contains(tp)]


def build(tp):
    SRC, _ = P.setup(tp)
    from kw import config as WC, dataset as WD, align as AL, features as FT
    from kp import config as C, dataset as D, missing as MS, data_checks as DC
    from kp.features import build_kospi_base_and_tech
    F = features_of(tp)
    sids = sorted(set(F.source_id) - {"KOSPI", VK})
    import db
    raw_last = max(db.load_raw("kospi").iloc[:, 0].astype(str).map(lambda s: s.replace("-", "")[:8]))
    cfg = {**C.CFG, "END_DATE": pd.Timestamp(raw_last).strftime("%Y-%m-%d")}
    b = WD.Builder(cfg, log=print)
    b.cat_use = b.cat_use.loc[sids]
    frames, _ = D.clean_all(cfg=cfg)
    DC.assert_data_ready(frames)
    b.raw = D.assemble_raw_frames(frames)
    kospi = D.normalize_daily_frame(b.raw["KOSPI"], cfg["START_DATE"], cfg["END_DATE"])
    kb, kt, _ = build_kospi_base_and_tech(kospi)
    gap = kb.index.isin(pd.DatetimeIndex(b.raw["__meta__"].get("kospi_gap_dates", [])))
    kb.loc[gap, ["K_ret_1d", "K_open_gap", "K_log_volume_change"]] = np.nan
    kidx = pd.DatetimeIndex(kb.index)
    pred_dd = kidx[1:]
    ident = pd.Series(pred_dd, index=pred_dd)
    if WC.CP["pred_time"] == "base_day":
        when = pred_dd
    else:                                                     # 마지막 기준일의 다음 거래일은 거래소 달력에서 DB 공휴일을 뺀 날
        fut = MS.trading_calendar("KR", kidx[-1] + pd.Timedelta(days=1), kidx[-1] + pd.Timedelta(days=20)).difference(SRC.kr_holidays())
        cal = MS.trading_calendar("KR", kidx[0], fut[0]).difference(SRC.kr_holidays())
        when = pd.DatetimeIndex(pd.Series(cal[1:], index=cal[:-1]).reindex(pred_dd).to_numpy())
    pred_at = D.make_prediction_at(when, {**WC.CP, "anchor": "target_date"}, None)
    b.blocks = {}
    kfe = pd.concat([kb, kt, FT.kospi_extra(kospi)], axis=1)
    b._add("KOSPI", D.align_domestic(pred_dd, kfe, ident, "KOSPI").drop(columns=["KOSPI_age_hours", "KOSPI_src_date"]))
    for sid, row in b.cat_use.iterrows():
        b._source(sid, row, pred_dd, pred_at, ident)
    ds = pd.concat(b.blocks.values(), axis=1)
    if (F.source_id == VK).any():
        s = SRC.drop_holiday_copies(SRC.series_from_frame(SRC.read_db_sql(F[F.source_id == VK].sql.iloc[0], "KR_VKOSPI_DB")), "krx_close")
        blk, _, age = AL.asof_join(pred_dd, pred_at, FT.price_feats(s[s > 0], VK, "price_level"), "krx_close", 0)   # 실험 decline_data(lag 0)와 같음
        AL.check_no_future(age, f"{tp} {VK}")
        ds = pd.concat([ds, blk.add_prefix("NEW_")], axis=1)
    miss = sorted(set(F.feature) - set(ds.columns))
    if miss:
        raise RuntimeError(f"만들지 못한 변수: {miss}")
    out = ds[F.feature.tolist()].assign(prediction_at=pred_at)
    out.index.name = "pred_dd"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tp", choices=["W0", "W2"], required=True)
    a = ap.parse_args()
    import extract_db
    extract_db.main()
    X = build(a.tp)
    print(f"{a.tp}: 기준일 {len(X)}개({X.index.min().date()}~{X.index.max().date()}), 변수 {X.shape[1] - 1}개")
if __name__ == "__main__":
    from wk_lock import service_lock
    with service_lock(write=False):
        main()
