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
        frame = db.read_table(con, key)
        if frame.empty:
            raise ValueError(f'DB 원천 {key}: 빈 테이블')
        raw[key] = standardize(frame.astype('string'), db.TABLES[key].get('cols'))
    if target_date is not None:
        raw[C.KOSPI_KEY] = fill_kospi_today(con, raw[C.KOSPI_KEY], target_date)
    cfg = dict(C.CFG, END_DATE=str(pd.Timestamp(end).date()))
    frames, _ = D.clean_all(cfg=cfg, raw_frames=raw)
    cp = TPR.checkpoint(tp)
    result = D.build_dataset(cp, D.assemble_raw_frames(frames), cfg, target_date=target_date, prediction_at=prediction_at)
    D.audit_point_in_time(result, cp)
    return result


def fill_kospi_today(con, kospi, target_date=None):
    """예측 때만: KOSPI 는 당일 테이블(krx_kospi_1001) 값을 쓰고, 그 테이블에 없는 날짜(이전 이력)만 일별 테이블(krx_kospi_dd_trd)로 채운다.
    EMA 등은 전체 이력이 필요해 1001(2026-08~)만으로는 학습 때 값을 만들 수 없다. 학습에는 쓰지 않는다(사용자 지시 2026-10-26·2026-11-13).
    장 마감(15:30) 전에 적재된 행은 장중 값일 수 있어 쓰지 않고, target_date 가 있으면 대상일 이후 행도 넣지 않는다.
    사용처: build(예측 입력), predict/predict_range.kospi_close(범위·해설·모니터링 종가)."""
    raw = db.read_table(con, 'kospi_today')
    today = standardize(raw.astype('string'), db.TABLES['kospi_today'].get('cols'))
    today = today[pd.to_datetime(raw['load_dtm']).to_numpy() >= (pd.to_datetime(today['Date']) + pd.Timedelta(hours=15, minutes=40)).to_numpy()]
    if target_date is not None:
        today = today[today['Date'] < pd.Timestamp(target_date).strftime('%Y-%m-%d')]
    return pd.concat([kospi[~kospi['Date'].isin(today['Date'])], today], ignore_index=True)


def load(tp, end, eng=None, target_date=None):
    from sqlalchemy import text
    eng = eng or db.get_engine()
    with eng.connect().execution_options(isolation_level='REPEATABLE READ') as con:
        with con.begin():
            con.execute(text('SET TRANSACTION READ ONLY'))
            return build(con, tp, end, target_date)
