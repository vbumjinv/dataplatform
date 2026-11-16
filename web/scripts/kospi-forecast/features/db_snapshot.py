"""[실사용 모듈] DB 원천을 메모리에서 정리하고 time_point 기준 데이터셋을 만든다.

예측·재학습·SHAP 배경 공용. 호출자가 연 읽기 스냅샷을 사용하며 로컬 원천 캐시를 읽거나 쓰지 않는다.
"""
import pandas as pd
import db
from db.standardize import standardize
from . import config as C, dataset as D, timepoints as TPR


def build(con, tp, end, target_date=None, prediction_at=None):
    raw = {}
    for key in D.needed_keys():
        if key == C.KOSPI_KEY and target_date is not None:
            raw[key] = read_kospi(con, target_date)
            continue
        frame = db.read_table(con, key)
        if frame.empty:
            raise ValueError(f'DB 원천 {key}: 빈 테이블')
        raw[key] = standardize(frame.astype('string'), db.TABLES[key].get('cols'))
    cfg = dict(C.CFG, END_DATE=str(pd.Timestamp(end).date()))
    frames, _ = D.clean_all(cfg=cfg, raw_frames=raw)
    cp = TPR.checkpoint(tp)
    result = D.build_dataset(cp, D.assemble_raw_frames(frames), cfg, target_date=target_date, prediction_at=prediction_at)
    D.audit_point_in_time(result, cp)
    return result


def read_kospi(con, target_date=None):
    """1001이 있는 날짜는 1001을 쓰고, 나머지 이력은 일별 테이블에서 읽는다."""
    recent = db.read_table(con, 'kospi_today')
    if 'load_dtm' in recent:
        recent = recent.sort_values('load_dtm', kind='stable', na_position='first')
    today = standardize(recent.astype('string'), db.TABLES['kospi_today'].get('cols'))
    today = today.dropna(subset=['Date', 'Close']).drop_duplicates('Date', keep='last')
    if target_date is not None:
        today = today[today['Date'] < pd.Timestamp(target_date).strftime('%Y-%m-%d')]
    history = db.read_table(con, C.KOSPI_KEY)
    history = standardize(history.astype('string'), db.TABLES[C.KOSPI_KEY].get('cols'))
    merged = pd.concat([history[~history['Date'].isin(today['Date'])], today], ignore_index=True)
    if merged.empty:
        raise ValueError('KOSPI 원천에 사용할 거래일 자료가 없습니다.')
    return merged


def load(tp, end, eng=None, target_date=None):
    from sqlalchemy import text
    eng = eng or db.get_engine()
    with eng.connect().execution_options(isolation_level='REPEATABLE READ') as con:
        with con.begin():
            con.execute(text('SET TRANSACTION READ ONLY'))
            return build(con, tp, end, target_date)
