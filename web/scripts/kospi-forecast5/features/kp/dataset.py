"""[실사용 모듈] (service_5 복사본, 원본: experiments/daily/kp/dataset.py) 정리된 가격 -> 시점(T0/T1/T2)별 학습 데이터셋. 시점 정렬(point-in-time) 로직은 기존 노트북과 같다."""
from __future__ import annotations
import numpy as np
import pandas as pd
import db
from . import config as C, preprocess as pp, missing as MS
from .features import build_multiday_features, build_kospi_base_and_tech


# ------------------------------------------------------------ DB 원본 -> 정리된 key별 프레임 -> 노트북 형식 raw_frames
def needed_keys():
    keys = [C.KOSPI_KEY] + [s["key"] for s in C.SOURCE_SPECS.values()]
    for ks in C.SECTOR_SPECS.values():
        keys += ks
    return list(dict.fromkeys(keys))


def clean_all(policy=None, ffill_limit=None, cfg=None):
    """db/raw 의 필요한 테이블을 모두 정리하고 결측 정책을 적용한다.
    반환: ({key: DataFrame, "__meta__": dict}, 점검 요약 DataFrame).
    __meta__ = {"policy": 정책, "labels": {key: 날짜 분류(ok/holiday/trading_missing/row_missing)}, "kospi_gap_dates": KOSPI 누락 다음 날}"""
    cfg = cfg or C.CFG
    policy = MS.normalize_policy(policy or C.MISSING_POLICY, ffill_limit)
    start, end = pd.Timestamp(cfg["START_DATE"]), pd.Timestamp(cfg["END_DATE"])
    markets = C.key_market()
    nums, base_rep = {}, {}
    for key in needed_keys():
        raw = db.load_standardized(key)
        if raw is None:
            raise FileNotFoundError(f"PostgreSQL 원천 {key}에 사용 가능한 행이 없습니다.")
        num, r = pp.clean_symbol_frame(raw)
        nums[key] = num.loc[start:end]
        base_rep[key] = r
    # 시장별 거래일 = 거래소 달력 ∩ 같은 시장 시계열 중 하나 이상에 값이 있는 날
    opens = {m: MS.open_days(m, [nums[k]["Close"].dropna().index for k in nums if markets[k] == m], start, end)
             for m in sorted(set(markets.values()))}
    meta = {"policy": policy, "labels": {}, "kospi_gap_dates": pd.DatetimeIndex([])}
    frames, rep = {"__meta__": meta}, []
    for key, num in nums.items():
        labels = MS.classify_missing(num["Close"], opens[markets[key]])
        is_target = key == C.KOSPI_KEY
        df = MS.apply_missing_policy(num, labels, policy, is_target=is_target)
        meta["labels"][key] = labels
        if is_target:
            meta["kospi_gap_dates"] = MS.kospi_gap_dates(df.index, opens[markets[key]])
        frames[key] = df
        rep.append({**MS.missing_report(key, labels), "market": markets[key], "policy": policy,
                    "rows_out": len(df), "rows_out_nan": int(df["Close"].isna().sum()), **base_rep[key]})
    rep = pd.DataFrame(rep)
    cols = ["key", "market", "policy", "rows_in", "rows_out", "rows_out_nan", "n_open_days", "n_ok", "n_holiday_rows",
            "n_trading_missing", "n_row_missing", "missing_pct", "max_consecutive_missing"]
    return frames, rep[cols + [c for c in rep.columns if c not in cols]]


def assemble_raw_frames(frames: dict) -> dict:
    raw = {"KOSPI": frames[C.KOSPI_KEY], "__meta__": frames.get("__meta__", {"policy": C.MISSING_POLICY})}
    for name, spec in C.SOURCE_SPECS.items():
        raw[name] = frames[spec["key"]]
    for sector, keys in C.SECTOR_SPECS.items():
        closes = {k: frames[k]["Close"] for k in keys}
        combined = pd.DataFrame(closes).sort_index()
        normed = combined.apply(lambda col: col / col.dropna().iloc[0] if col.notna().any() else col)
        raw[f"SECTOR_{sector}"] = pd.DataFrame({"Close": normed.mean(axis=1, skipna=True)})
    return raw


# ------------------------------------------------------------ 시점 정렬
def normalize_daily_frame(df, start, end):
    out = df.copy()
    idx = pd.DatetimeIndex(pd.to_datetime(out.index))
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    out.index = idx.normalize()
    out.index.name = "Date"
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out.loc[start:end]


def assumed_available_at(index, rule, lag_days=0):
    idx = pd.DatetimeIndex(index).tz_localize(None).normalize()
    if rule == "krx_close":
        local = (idx + pd.Timedelta(hours=15, minutes=40)).tz_localize(C.TZ_KST, ambiguous="infer", nonexistent="shift_forward")
    elif rule == "us_close":
        local = (idx + pd.Timedelta(hours=16, minutes=15)).tz_localize(C.TZ_US, ambiguous="infer", nonexistent="shift_forward")
    elif rule == "eu_close":
        local = (idx + pd.Timedelta(hours=16, minutes=45)).tz_localize(C.TZ_EU, ambiguous="infer", nonexistent="shift_forward")
    elif rule == "kst_eod":      # 국내 지표: 해당일 18:00(KST)에 확정
        local = (idx + pd.Timedelta(hours=18)).tz_localize(C.TZ_KST, ambiguous="infer", nonexistent="shift_forward")
    else:
        raise ValueError(rule)
    if lag_days:                  # DB 반영 지연(일)
        local = local + pd.Timedelta(days=lag_days)
    return pd.DatetimeIndex(local).tz_convert("UTC")


def previous_trading_day_map(idx):
    idx = pd.DatetimeIndex(sorted(pd.unique(idx)))
    return pd.Series(idx[:-1], index=idx[1:])


def make_prediction_at(target_dates, cp, prev_map):
    target_dates = pd.DatetimeIndex(target_dates)
    anchor = (pd.DatetimeIndex([prev_map.get(d, pd.NaT) for d in target_dates])
              if cp["anchor"] == "prev_trading_day" else target_dates)
    naive = anchor + pd.Timedelta(hours=cp["hour"], minutes=cp["minute"])
    local = pd.DatetimeIndex(naive).tz_localize(C.TZ_KST, ambiguous="infer", nonexistent="shift_forward")
    return local.tz_convert("UTC")


def align_source(target_dates, prediction_at, feats, src_index, rule, block, cfg, lag_days=0):
    right = feats.copy()
    right["available_at"] = assumed_available_at(src_index, rule, lag_days).as_unit("ns")
    right = right.reset_index(drop=True).assign(_src_date=src_index).sort_values("available_at")
    left = pd.DataFrame({"target_date": target_dates, "prediction_at": pd.DatetimeIndex(prediction_at).as_unit("ns")}).sort_values("prediction_at")
    j = pd.merge_asof(left, right, left_on="prediction_at", right_on="available_at", direction="backward",
                      allow_exact_matches=False, tolerance=pd.Timedelta(days=cfg["MAX_STALE_DAYS"]))
    j = j.set_index("target_date").reindex(target_dates)
    j[f"{block}_age_hours"] = (j["prediction_at"] - j["available_at"]).dt.total_seconds() / 3600
    j[f"{block}_src_date"] = j["_src_date"]
    return j.drop(columns=[c for c in ("prediction_at", "available_at", "_src_date") if c in j.columns])


def align_domestic(target_dates, feats, prev_map, block, max_stale_days=None):
    """국내 변수: 기준일(직전 KOSPI 거래일) 이전 마지막 행을 쓴다(최대 MAX_STALE_DAYS일 전까지).
    skip 정책에서 기준일 값이 빠졌으면 직전 유효값, nan·nanmean 정책에서는 기준일의 NaN 행이 그대로 쓰인다."""
    max_stale_days = C.CFG["MAX_STALE_DAYS"] if max_stale_days is None else max_stale_days
    anchor = pd.DatetimeIndex([prev_map.get(d, pd.NaT) for d in target_dates])
    feats = feats.sort_index()
    pos = feats.index.get_indexer(anchor, method="pad")
    src = pd.DatetimeIndex(np.where(pos >= 0, feats.index.to_numpy()[np.clip(pos, 0, None)], np.datetime64("NaT")))
    stale = (anchor - src) > pd.Timedelta(days=max_stale_days)
    out = feats.iloc[np.clip(pos, 0, None)].copy()
    out.index = target_dates
    out.loc[(pos < 0) | stale] = np.nan
    out[f"{block}_age_hours"] = np.nan
    out[f"{block}_src_date"] = src.where(~stale)
    return out


def build_dataset(cp, raw_frames, cfg=None):
    cfg = cfg or C.CFG
    kospi = normalize_daily_frame(raw_frames["KOSPI"], cfg["START_DATE"], cfg["END_DATE"])
    meta = raw_frames.get("__meta__", {})
    policy = meta.get("policy", C.MISSING_POLICY)
    nan_mode = "nanmean" if policy == "nanmean" else None
    kb, kt, kclose = build_kospi_base_and_tech(kospi)
    # KOSPI 누락일 바로 다음 행: 전일 대비 값이 여러 날 변화가 되므로 해당 변수와 그날 정답을 결측으로 둔다
    gap = pd.DatetimeIndex(meta.get("kospi_gap_dates", []))
    gap_rows = kb.index.isin(gap)
    kb.loc[gap_rows, ["K_ret_1d", "K_open_gap", "K_log_volume_change"]] = np.nan
    target_dates = pd.DatetimeIndex(kb.index[1:])
    prev_map = previous_trading_day_map(kb.index)
    pred_at = make_prediction_at(target_dates, cp, prev_map)
    blocks = {"KOSPI": align_domestic(target_dates, pd.concat([kb, kt], axis=1), prev_map, "KOSPI")}
    for name, spec in C.SOURCE_SPECS.items():
        src = normalize_daily_frame(raw_frames[name], cfg["START_DATE"], cfg["END_DATE"])
        feats = build_multiday_features(src["Close"].astype(float), spec["kind"], name, nan_mode=nan_mode, min_frac=C.NANMEAN_MIN_FRAC)
        blocks[name] = align_source(target_dates, pred_at, feats, src.index, spec["rule"], name, cfg, spec.get("lag_days", 0))
    for sector in C.SECTOR_SPECS:
        b = f"SECTOR_{sector}"
        src = normalize_daily_frame(raw_frames[b], cfg["START_DATE"], cfg["END_DATE"])
        feats = build_multiday_features(src["Close"].astype(float), "price", b, nan_mode=nan_mode, min_frac=C.NANMEAN_MIN_FRAC)
        blocks[b] = align_domestic(target_dates, feats, prev_map, b)
    ds = pd.concat(blocks.values(), axis=1)
    y = (kclose / kclose.shift(1) - 1)
    y[gap_rows] = np.nan
    y = y.reindex(target_dates)
    extra = pd.DataFrame({"y_return": y, "y_direction": (y > 0).astype(float).where(y.notna(), np.nan),
                          "prediction_at": pred_at}, index=ds.index)
    return pd.concat([ds, extra], axis=1)


def audit_point_in_time(ds, cp):
    """해외 소스의 값이 예측 시점 이후에 확정된 것이면 중단한다(음수 age)."""
    dom = {"KOSPI_age_hours"} | {f"SECTOR_{s}_age_hours" for s in C.SECTOR_SPECS}
    bad = sum(int((ds[c].dropna() < 0).sum()) for c in ds.columns if c.endswith("_age_hours") and c not in dom)
    if bad:
        raise RuntimeError(f"[STOP] {cp['name']}: point-in-time 위반 {bad}건")


def feature_columns(ds):
    return [c for c in ds.columns if not c.endswith(("_age_hours", "_src_date"))
            and c not in ("y_return", "y_direction", "prediction_at")]
