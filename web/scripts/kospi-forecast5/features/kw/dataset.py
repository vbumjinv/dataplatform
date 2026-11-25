"""[실사용 모듈] (service_5 복사본, 원본: experiments/5/kw/dataset.py) 주별 데이터셋 생성 — 원천 목록(kw.sources) 전체를 파생하고 시점(W0 16:00 | W2 다음 거래일 08:30)에 맞춰 정렬해
기준일 b index 데이터셋과 변수 지도(feature_map)를 만든다.

일별 kp 원천(KOSPI·SOURCE_SPECS·업종 대용)은 일별과 같은 정제(clean_all, 결측 skip)·변환·정렬 함수를 쓴다.
그래서 같은 이름의 변수는 일별 쌍둥이(W0 = T0_1600, W2 = T2_0830)의 대상일 next(b) 행과 값이 같아야 한다(01 에서 대조).
거래일은 일별과 같은 정의(거래소 달력 ∩ 같은 시장 시계열에 값이 있는 날)를 쓴다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from kp import config as C, dataset as D, missing as MS
from kp.features import build_kospi_base_and_tech
from . import config as WC, sources as SRC, features as FT, align as AL, target as TG, events as EV

REL_GROUPS = {"KR_SECTOR", "KRX_INDEX", "ASIA", "KR_ADR"}
PRICE_KINDS = {"price", "price_level", "sector", "tv", "helper"}
DOCX_DAILY = ["K_ret_1d", "K_open_gap", "K_intraday", "K_range", "K_close_location", "K_log_volume_change",
              "TA_SMA10_gap", "US_SP500_ret_1d", "US_SOX_ret_1d", "US_SOX_ret_3d", "EU_STOXX600_ret_1d", "EU_DAX_ret_5d",
              "EU_DAX_ma_gap_20", "MACRO_DXY_ret_1d", "MACRO_DXY_ret_10d", "MACRO_DXY_ma_gap_20", "MACRO_GOLD_ret_3d",
              "MACRO_OIL_ret_1d", "SECTOR_AUTO_ma_gap_20", "SECTOR_LIVING_ma_gap_5", "SECTOR_INTERNET_ma_gap_5",
              "SECTOR_FASHION_ret_20d"]
K6 = DOCX_DAILY[:6]
NB_TECH = ["TECH_ret_3d", "TECH_ret_5d", "TECH_ret_10d", "TECH_ret_20d", "TECH_ma_gap_5", "TECH_ma_gap_20", "TECH_vol_10"]
NB_RENAMED = {"MACRO_DXYNYB": "MACRO_DXY", "MACRO_OILFUT": "MACRO_OIL", "SECTOR_AUTOSTK": "SECTOR_AUTO"}   # 노트북 원천을 다른 이름으로 둔 것


class Builder:
    def __init__(self, cfg=None, log=print):
        self.cfg = cfg or WC.cfg_w()
        self.log = log
        self.cat = SRC.catalog()
        self.cat_use = self.cat[self.cat.status == "use"].set_index("source_id")
        self.levels = {}
        self.source_rows = []

    # -------------------------------------------------------------- 원천 수준값
    def level(self, sid):
        if sid in self.levels:
            return self.levels[sid]
        row = self.cat.set_index("source_id").loc[sid]
        end = pd.Timestamp(self.cfg["END_DATE"])
        if row.fetch == "daily_kp":
            name = f"SECTOR_{row.ref}" if row.group == "KR_SECTOR" else sid
            s = D.normalize_daily_frame(self.raw[name], self.cfg["START_DATE"], self.cfg["END_DATE"])["Close"].astype(float)
        elif row.fetch == "composite":
            op = "-" if "-" in row.ref else "/"
            a, b = row.ref.split(op)
            j = pd.concat({"a": self.level(a), "b": self.level(b)}, axis=1).dropna()
            s = j.a - j.b if op == "-" else j.a / j.b
        else:
            s = SRC.load_series(row)
        s = s.dropna()
        if row.kind in PRICE_KINDS:
            s = s[s > 0]
        self.levels[sid] = s[s.index <= end]
        return self.levels[sid]

    # -------------------------------------------------------------- 정렬 기록
    def _add(self, sid, block, age=None):
        a = None if age is None else age.dropna()
        if a is not None and len(a) and (a <= 0).any():
            raise RuntimeError(f"[STOP] {sid}: 예측 시각 뒤에 확정된 값 {int((a <= 0).sum())}건")
        fv = block.notna().any(axis=1)
        self.source_rows.append({"source_id": sid, "n_features": block.shape[1],
                                 "first_pred_dd": fv[fv].index.min() if fv.any() else pd.NaT,
                                 "min_age_hours": float(a.min()) if a is not None and len(a) else np.nan,
                                 "median_age_hours": float(a.median()) if a is not None and len(a) else np.nan})
        self.blocks[sid] = block

    def build(self):
        cfg = self.cfg
        frames, self.clean_report = D.clean_all(cfg=cfg)
        from kp import data_checks as DC
        DC.assert_data_ready(frames)
        self.raw = D.assemble_raw_frames(frames)
        kospi = D.normalize_daily_frame(self.raw["KOSPI"], cfg["START_DATE"], cfg["END_DATE"])
        kb, kt, _ = build_kospi_base_and_tech(kospi)
        gap = kb.index.isin(pd.DatetimeIndex(self.raw["__meta__"].get("kospi_gap_dates", [])))
        kb.loc[gap, ["K_ret_1d", "K_open_gap", "K_log_volume_change"]] = np.nan
        # 행 = 기준일 b(코스피 거래일, 홀드아웃 끝까지). 국내 값은 두 시점 모두 b 자신(ident), 예측 시각만 시점별로 다르다.
        kidx = pd.DatetimeIndex(kb.index)
        pred_dd = kidx[1:][kidx[1:] <= pd.Timestamp(WC.PRED_END)]
        ident = pd.Series(pred_dd, index=pred_dd)
        nxt = pd.Series(kidx[1:], index=kidx[:-1])                    # b -> 다음 코스피 거래일(일별 T2 의 대상일)
        if WC.CP["pred_time"] == "base_day":
            when = pred_dd
        else:
            when = pd.DatetimeIndex(nxt.reindex(pred_dd).to_numpy())
            if when.isna().any():
                raise RuntimeError("다음 거래일이 없는 기준일이 있음(자료 끝 확인)")
        pred_at = D.make_prediction_at(when, {**WC.CP, "anchor": "target_date"}, None)
        self.pred_dd, self.pred_at, self.pred_time_dd = pred_dd, pred_at, when
        self.blocks = {}

        # 코스피: 기준일 b 의 값(b 종가까지)
        kfe = pd.concat([kb, kt, FT.kospi_extra(kospi)], axis=1)
        self._add("KOSPI", D.align_domestic(pred_dd, kfe, ident, "KOSPI").drop(columns=["KOSPI_age_hours", "KOSPI_src_date"]))

        for sid, row in self.cat_use.iterrows():
            if sid == "KOSPI" or row.kind in ("helper", "calendar", "event", "interaction", "placebo", "monthly", "news"):
                continue
            try:
                self._source(sid, row, pred_dd, pred_at, ident)
            except Exception as ex:                       # 받을 수 없는 원천은 기록하고 멈춘다(조용히 빼지 않음)
                raise RuntimeError(f"{sid}: {ex}") from ex
        for sid, row in self.cat_use[self.cat_use.kind == "monthly"].iterrows():
            lm = FT.to_month(self.level(sid), row.agg)
            if sid == "M_EXPORT":
                lm = lm[lm.index < pd.Timestamp.today().to_period("M").to_timestamp()]      # 진행 중인 달(부분 합) 제외
            f = FT.monthly_feats(lm, sid, row.tform)
            blk, _, age = AL.asof_join(pred_dd, pred_at, f, "monthly", row.lag_days)
            self._add(sid, blk, age)

        ds = pd.concat(self.blocks.values(), axis=1)
        # 코스피 대비 상대 수익률(정렬 뒤)
        rel = {}
        for sid, row in self.cat_use.iterrows():
            if row.group in REL_GROUPS and row.kind in ("price", "sector"):
                for w in (1, 3, 5, 10, 20):
                    c = f"{sid}_ret_{w}d"
                    kc = "K_ret_1d" if w == 1 else f"TECH_ret_{w}d"
                    if c in ds:
                        rel[f"{sid}_rel_kospi_{w}d"] = ds[c] - ds[kc]
        ds = pd.concat([ds, pd.DataFrame(rel, index=ds.index)], axis=1)
        # 뉴스(Jev, dp.news_feature_orig): 예측 시각 직전 1·3·5·10 거래일 구간 집계(kw.news)
        if "NEWS" in self.cat_use.index:
            from . import news as NW
            nf = NW.features_5(pred_dd, pred_at, pd.DatetimeIndex(kb.index))
            self._add("NEWS", nf)
            ds = pd.concat([ds, nf], axis=1)

        # 정답·대상일
        # 거래일 = 일별과 같은 정의(거래소 달력 ∩ 같은 시장 시계열에 값이 있는 날, kp.missing.open_days — clean_all 의 KOSPI 날짜 분류에서
        # holiday 를 뺀 날). 거래소 달력에는 거래일인데 실제 휴장한 날(예: 2026-06-03 지방선거, 2026-07-17 제헌절)이 빠진다.
        lab = self.raw["__meta__"]["labels"][C.KOSPI_KEY]
        cal = pd.DatetimeIndex(lab[lab != "holiday"].index).sort_values()
        tail = MS.trading_calendar("KR", cal.max() + pd.Timedelta(days=1), pd.Timestamp(cfg["END_DATE"]) + pd.Timedelta(days=40))
        cal = cal.union(tail)                                               # 자료 끝 뒤(대상일 계산용 여유분)는 거래소 달력
        self.cal = cal
        tg = TG.build_targets(kospi, pred_dd, cal, cfg["END_DATE"])
        # 달력·이벤트·상호작용·위약
        calf = pd.DataFrame(index=pred_dd)
        calf["CAL_weekday"] = pred_dd.weekday.astype(float)
        calf["CAL_horizon_td"] = tg.horizon_td.astype(float)
        calf["CAL_target_shifted"] = tg.target_shifted.astype(float)
        calf["CAL_month"] = pred_dd.month.astype(float)
        calf["CAL_week_of_month"] = ((pred_dd.day - 1) // 7).astype(float)
        calf["CAL_yearend"] = (((pred_dd.month == 12) & (pred_dd.day >= 15)) | ((pred_dd.month == 1) & (pred_dd.day <= 15))).astype(float)
        self.event_table = EV.event_table(cal)
        evf = EV.window_features(tg.base_dd, tg.target_dd, cal, self.event_table)
        intf = pd.DataFrame(index=pred_dd)
        intf["INT_vixhi_x_ret20"] = (ds["US_VIX_level_z_250"] > 0).astype(float).where(ds["US_VIX_level_z_250"].notna()) * ds["TECH_ret_20d"]
        intf["INT_above200_x_ret5"] = (ds["TECH_ma_gap_200"] > 0).astype(float).where(ds["TECH_ma_gap_200"].notna()) * ds["TECH_ret_5d"]
        intf["INT_dd_x_vixz"] = ds["TECH_dd_250"] * ds["US_VIX_level_z_250"]
        intf["INT_frgn_x_ret5"] = ds["FLOW_FRGN_KOSPI_net_5d"] * ds["TECH_ret_5d"]
        rng = np.random.default_rng(20261110)
        plc = pd.DataFrame(index=pred_dd)
        plc["PLACEBO_white_noise"] = rng.standard_normal(len(pred_dd))
        plc["PLACEBO_smoothed_walk"] = pd.Series(rng.standard_normal(len(pred_dd)).cumsum(), index=pred_dd).rolling(5, min_periods=1).mean()
        for sid, b in (("CAL", calf), ("EVT", evf), ("INT", intf), ("PLACEBO", plc)):
            self._add(sid, b)
        ds = pd.concat([ds, calf, evf, intf, plc], axis=1)
        ds = ds.loc[:, ~ds.columns.duplicated()]
        out = pd.concat([ds, tg, pd.DataFrame({"prediction_at": pred_at}, index=pred_dd)], axis=1)
        out.index.name = "pred_dd"
        out = out[out["y_return"].notna()]
        return out

    def _source(self, sid, row, pred_dd, pred_at, ident):
        if row.fetch == "daily_kp":
            src = D.normalize_daily_frame(self.raw[f"SECTOR_{row.ref}" if row.group == "KR_SECTOR" else sid],
                                          self.cfg["START_DATE"], self.cfg["END_DATE"])
            close = src["Close"].astype(float)
            feats = FT.price_feats(close, sid, row.kind) if row.kind in ("price", "price_level") else FT.rate_feats(close, sid, row.kind)
            if row.group == "KR_SECTOR":                 # 국내 업종 대용: 기준일 b 의 값(일별 align_domestic, 기준일 = b)
                blk = D.align_domestic(pred_dd, feats, ident, sid).drop(columns=[f"{sid}_age_hours", f"{sid}_src_date"])
                self._add(sid, blk)
            else:
                spec = C.SOURCE_SPECS[sid]
                blk = D.align_source(pred_dd, pred_at, feats, src.index, spec["rule"], sid, self.cfg, spec.get("lag_days", 0))
                age = blk.pop(f"{sid}_age_hours"); blk = blk.drop(columns=[f"{sid}_src_date"])
                self._add(sid, blk, age)
            return
        s = self.level(sid)
        if row.kind == "flow":
            tv = self.level(sid.replace("FRGN", "TV"))
            feats = FT.flow_feats(s, tv, sid)
        elif row.kind == "tv":
            feats = FT.trading_value_feats(s, self.level("KOSPI_MCAP"), sid)
        elif row.kind == "sector":
            feats = FT.sector_feats(s, sid)
        elif row.kind in ("price", "price_level"):
            feats = FT.price_feats(s, sid, row.kind)
        else:
            feats = FT.rate_feats(s, sid, row.kind)
        blk, _, age = AL.asof_join(pred_dd, pred_at, feats, row.rule, row.lag_days)
        self._add(sid, blk, age)


# ------------------------------------------------------------------ 변수 지도
META = ("y_return", "y_direction", "y_maxdd", "y_range", "prediction_at", "target_dd", "base_dd", "target_shifted", "horizon_td")


def feature_columns(ds):
    return [c for c in ds.columns if c not in META]


def _family(sid, tf):
    if sid == "PLACEBO":
        return "placebo"
    if sid in ("CAL", "EVT", "INT"):
        return {"CAL": "calendar", "EVT": "event", "INT": "interaction"}[sid]
    if sid == "NEWS":
        return "news"
    if tf.startswith("L1"):
        return "monthly_lag"
    if tf.startswith(("dir_", "upcnt_", "streak", "poscnt_")):
        return "direction"
    if tf.startswith("rel_kospi"):
        return "relative"
    if tf.startswith("net"):
        return "flow"
    if tf.startswith(("ratio_", "log_z", "turnover")):
        return "trading_value"
    if tf.startswith(("dd_", "up_")):
        return "drawdown"
    if tf.startswith("vol"):
        return "volatility"
    if tf.startswith(("level", "z_")):
        return "level"
    if tf.startswith("bar_vol_ma_ratio"):
        return "trading_value"
    if tf.startswith("bar_intraday_dret_"):
        return "short"
    if tf.startswith("bar_"):
        return "kospi_bar"
    if tf.startswith("ta_"):
        return "ta"
    import re
    m = re.match(r"(?:ret|diff|ma_gap)_(\d+)", tf)
    if m:
        return "short" if int(m.group(1)) <= 20 else "long"
    return "other"
