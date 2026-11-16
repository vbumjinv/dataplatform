"""[실사용 모듈] time_point에 맞춘 뉴스 모델 입력 구성 — 한 DB 스냅샷에서 T0·T1·T2를 처리한다.

T0는 뉴스 미사용, T1은 조건부 잔차 입력, T2는 core/ctx·확률 가중 입력이다. 수식은 각 모델 모듈을 재사용한다.
"""
import json
import numpy as np
import pandas as pd
from sqlalchemy import text
from features import dataset as D
from model import assets
from . import t1_news as N
from .source import FEATURE_READ_TABLE, available, utc


def build(tp, bundles, manifests, ds, target, con, local_assets=False):
    if tp == 'T0':
        days = ds.index[ds.index <= target]
        return {o: ds.loc[days, bundles[o]['features']] for o in ('cls', 'reg')}, None
    if tp == 'T1':
        import t1_model as M
        start = pd.Period(bundles['cls']['target_month'], 'M').start_time
        days = ds.index[(ds.index >= start) & (ds.index <= target)]
        prev = D.previous_trading_day_map(ds.index).reindex(days)
        news = N.build(con, days, ds.loc[days, 'prediction_at'], prev)
        known = ds.loc[days, 'y_return'].notna() & (days < target)
        result = {}
        for obj in ('cls', 'reg'):
            cond = bundles[obj]['condition']
            flags, thresholds = M.condition_flags(cond, news[cond['column']], known)
            news[f'{cond["name"]}_threshold'] = thresholds
            result[obj] = pd.concat([ds.loc[days, bundles[obj]['features']], news[N.SEM]], axis=1).assign(
                **{cond['name']: flags})[M.inputs(bundles[obj])]
        return result, news
    from t2_model import w1_days, news_cls_features, news_reg_features
    hist = assets.parquet('T2', 'news_daily_history.parquet', local=local_assets)
    cols = assets.js('T2', 'cols.json', local=local_assets)
    days = ds.index[(ds.index > hist.index.max()) & (ds.index <= target)]
    if not len(days):
        raise ValueError('대상일이 배포 뉴스 이력 이전입니다.')
    prev = D.previous_trading_day_map(ds.index).reindex(days)
    art = pd.read_sql(text(f'''select f.*, a.published_at, a.modified_at
        from {FEATURE_READ_TABLE} f left join dp.news_stock_article a using(article_key)
        where f.stage2_status='ok' and {available()} >= :lo
          and {available()} < :hi and f.probs is not null'''), con,
        params={'lo': pd.Timestamp(prev.min()).tz_localize('Asia/Seoul').to_pydatetime(),
                'hi': pd.Timestamp(ds.loc[target, 'prediction_at']).to_pydatetime()})
    if art.article_key.duplicated().any():
        raise ValueError('기사 키 중복: 뉴스 피처 버전을 먼저 확정하세요.')
    av = utc(art.available_at_kst).dt.tz_convert('Asia/Seoul').dt.tz_localize(None)
    probs = art.probs.map(lambda v: json.loads(v) if isinstance(v, str) else v)
    fields = [c.split('__', 1) for c in cols]
    matrix = np.array([[p[f].get(o, 0.0) for f, o in fields] for p in probs], np.float16).reshape(len(art), len(cols))
    day = w1_days(av, days, prev, ds.loc[days, 'prediction_at'])
    ci = {c: i for i, c in enumerate(cols)}
    cls = news_cls_features(matrix, day, (art.article_role == 'market_recap').to_numpy(), ci, days, hist)
    reg = news_reg_features(matrix, day, ci, days)
    frames = {}
    for obj, news in (('cls', cls), ('reg', reg)):
        frames[obj] = pd.concat([ds.loc[days, bundles[obj]['structured']['columns']], news], axis=1)[manifests[obj]['feature_columns']]
    counts = pd.Series(np.bincount(day[day >= 0], minlength=len(days)), index=days)
    print(f'DB 뉴스: {len(art)}건, 대상일 {target.date()} {counts.loc[target]}건', flush=True)
    return frames, pd.DataFrame({'n_articles': counts})
