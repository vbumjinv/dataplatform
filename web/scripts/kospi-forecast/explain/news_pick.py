"""[실사용 모듈] 해설 근거 기사 고르기(LLM 토큰 0) — 코드가 뉴스 DB 영향력·SHAP 요인 분류 일치·키워드 일치를 합친 점수로 기사 몇 건을 골라 링크로 붙인다.

사용처: explain/explain_timepoint.py
기간: 예측 시각 직전 코스피 거래일 장 마감(service/time_points.json market_close, 지금 15:30) 이후 ~ 예측 시각 이전에 쓸 수 있게 된 기사(available_at_kst, 수정 시각도 예측 시각 이전).
  T0 는 그날 장 마감 직후라 하루 전 장 마감부터 본다. 미래 기사는 쓰지 않는다.
고르는 규칙(LLM 호출 없음, 이미 적재된 뉴스 변수 dp.news_feature_orig 만 사용):
  ① 시황 기사(market_recap) 제외, 영향 강도 moderate·strong, 코스피 관련성 >= 0.5, 방향 신뢰도 >= 0.5, 링크 정상
  ② 기본 점수 = 관련성 x 신뢰도 x (strong 1, moderate 2/3)
  ③ SHAP 연결 두 가지(해설에 쓰는 SHAP 상위 요인 기준, 각 0~1 = 이어진 요인들의 |기여| 합 ÷ 상위 요인 |기여| 합)
     - 분류 일치: 요인마다 이어지는 기사 분류(지역 origin_region·업종 primary_sector·경로 primary_channel, MATCH 표)
     - 키워드 일치: 요인마다 키워드(KEYWORDS 표, 예: 유럽 증시 → 유럽·STOXX·DAX)가 제목·요약에 있는지
     최종 점수 = 기본 점수 x (1 + 2 x 분류 일치 + 2 x 키워드 일치) → 예측을 크게 움직인 요인과 관련된 영향력 큰 기사가 앞에 온다.
  ④ 제목이 거의 같은 기사(공백·기호 뺀 앞 24자)는 하나만. 단 ⑤의 개수가 모자랄 때만 뺀 기사로 채운다(점수 순, 5번째에는 안 씀)
  ⑤ 방향 모델 확신 강도(보이는 방향 확률)에 따라 같은 방향·반대 방향 기사 수를 정해 점수 높은 순으로 4건(TIERS, 2026-11-19 사용자 결정)
     강함(>=60%) 같은 4·반대 0, 보통(55~60%) 같은 3·반대 1, 약함(<55%) 같은 2·반대 2.
     같은 방향이 모자라면 반대로 채우지 않고 적게 보여 주고(반대 방향 수 <= 같은 방향 수), 반대 방향이 모자라면 같은 방향으로 채운다.
  ⑥ 5번째는 앞 4건이 다루지 않은 SHAP 요인과 이어지고 점수가 앞 4건 최저의 EXTRA_MIN 배 이상인 기사만(강함·보통은 같은 방향, 약함은 mixed 포함 아무 방향)
프롬프트 v11(2026-11-05)부터 기사는 LLM 에 보내지 않는다. 고른 기사의 제목·링크·점수는 news_links.json 과 해설 근거 기사로 코드가 붙인다.
"""
from __future__ import annotations

import re

import pandas as pd
from sqlalchemy import text
from news.source import FEATURE_READ_TABLE, available

SQL = text(f"""SELECT f.article_key, {available()} AS available_at_kst, f.article_role, f.impact_direction, f.impact_strength,
       f.kospi_relevance, f.conf_impact_direction, f.origin_region, f.primary_sector, f.primary_channel, a.title, a.summary, a.url AS news_url, a.modified_at
  FROM {FEATURE_READ_TABLE} f JOIN dp.news_stock_article a USING(article_key)
 WHERE f.stage2_status = 'ok' AND {available()} >= :lo AND {available()} < :hi
   AND (a.modified_at IS NULL OR a.modified_at < :hi)""")


# SHAP 변수 → 이어지는 기사 조건(지역·업종·경로 중 하나라도 맞으면 연결). 변수 이름 앞부분으로 찾는다(긴 것 먼저).
MATCH = {
    'EU_': {'region': {'europe'}, 'channel': {'위험선호·안전자산'}},
    'US_SOX': {'sector': {'반도체'}},
    'US_': {'region': {'usa'}},
    'MACRO_DXY': {'channel': {'환율'}},
    'MACRO_OIL': {'channel': {'원자재·원가'}, 'sector': {'에너지/유틸리티', '화학/정유'}},
    'MACRO_GOLD': {'channel': {'위험선호·안전자산'}},
    'SECTOR_AUTO': {'sector': {'자동차'}},
    'SECTOR_FASHION': {'sector': {'유통/소비재'}},
    'SECTOR_LIVING': {'sector': {'유통/소비재'}},
    'SECTOR_INTERNET': {'sector': {'IT/플랫폼'}},
    'K_': {'sector': {'시장전체'}, 'channel': {'수급(자금흐름)'}},
    'TA_': {'sector': {'시장전체'}, 'channel': {'수급(자금흐름)'}},
    't1_impact_usa': {'region': {'usa'}},
    't1_impact_kor': {'region': {'korea'}},
}


# SHAP 변수 → 제목·요약에서 찾을 키워드(하나라도 들어 있으면 일치). 변수 이름 앞부분으로 찾는다(긴 것 먼저).
KEYWORDS = {
    'EU_': ('유럽', 'STOXX', '독일', 'DAX', 'ECB', '유로존'),
    'US_SOX': ('반도체', '엔비디아', 'HBM', '메모리', '하이닉스', '삼성전자', '필라델피아'),
    'US_': ('미국', '뉴욕', 'S&P', '나스닥', '다우', '연준', '월가'),
    'MACRO_DXY': ('달러', '환율', '원화', '원·달러', '원/달러'),
    'MACRO_OIL': ('유가', 'WTI', '원유', 'OPEC', '중동'),
    'MACRO_GOLD': ('금값', '금 가격', '안전자산'),
    'SECTOR_AUTO': ('자동차', '현대차', '기아'),
    'SECTOR_FASHION': ('패션', '의류'),
    'SECTOR_LIVING': ('생활용품', '화장품'),
    'SECTOR_INTERNET': ('네이버', '카카오', '플랫폼', '인터넷'),
    'K_': ('코스피', '외국인', '기관', '증시'),
    'TA_': ('코스피', '외국인', '기관', '증시'),
    't1_impact_usa': ('미국', '뉴욕', '연준', '월가'),
    't1_impact_kor': ('코스피', '국내'),
}


# 확신 강도(|상승 확률 - 0.5|) 하한 → (이름, 같은 방향 수, 반대 방향 수). 근거: range_history 2011~2026-10 에서 T1·T2 가 구간별 약 1/3,
# 적중률 약함 54~56% → 보통 58~61% → 강함 67~74%(세 시점 공통 고정 기준, 2026-11-19 사용자 결정)
TIERS = ((0.10, 'strong', 4, 0), (0.05, 'medium', 3, 1), (0.0, 'weak', 2, 2))
EXTRA_MIN = 0.5      # 5번째 기사 점수 하한 = 앞 4건 최저 점수 x 0.5


def tier(p: float) -> tuple[str, int, int]:
    s = abs(p - 0.5)
    return next((name, same, opp) for cut, name, same, opp in TIERS if s >= cut)


def rule(var, table=MATCH):
    for k in sorted(table, key=len, reverse=True):
        if var.startswith(k):
            return table[k]
    return None


def links_to(row, factors):
    """기사 한 건이 이어지는 SHAP 요인 (쉬운 이름 목록, 분류 일치 |기여| 합, 키워드 일치 |기여| 합). factors: [{'variable','name','pp'}]."""
    names, w_tag, w_kw = [], 0.0, 0.0
    text_ = f'{row.title or ""} {row.summary or ""}'
    for f in factors:
        m, kw = rule(f['variable']), rule(f['variable'], KEYWORDS)
        tag = bool(m) and (row.origin_region in m.get('region', ()) or row.primary_sector in m.get('sector', ())
                           or row.primary_channel in m.get('channel', ()))
        hit = bool(kw) and any(k in text_ for k in kw)
        if tag or hit:
            if f['name'] not in names:
                names.append(f['name'])
            w_tag += abs(f['pp']) * tag
            w_kw += abs(f['pp']) * hit
    return names, w_tag, w_kw


def window(cutoff: pd.Timestamp) -> tuple[pd.Timestamp, pd.Timestamp]:
    """(시작, 끝): 예측 시각 날짜의 직전 코스피 거래일 장 마감 ~ 예측 시각."""
    from features import timepoints as TPR
    import exchange_calendars as xcals
    cal = xcals.get_calendar('XKRX')
    day = pd.Timestamp(cutoff.tz_convert('Asia/Seoul').date())
    prev = pd.Timestamp(cal.date_to_session(day - pd.Timedelta(days=1), direction='previous'))
    return pd.Timestamp(f'{prev.date()} {TPR.market_close_str()}', tz=TPR.tz()), cutoff


def _kst(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return t.tz_localize('UTC').tz_convert('Asia/Seoul') if t.tzinfo is None else t.tz_convert('Asia/Seoul')


def _norm_title(t) -> str:
    return re.sub(r'[\W_]+', '', str(t or ''))[:24]


def _valid(url) -> bool:
    from service_runtime import valid_url
    return valid_url(url)


def choose(e: pd.DataFrame, p: float, dups: pd.DataFrame | None = None) -> tuple[list, dict]:
    """점수 순 기사 표 e 에서 확신 강도 규칙(⑤·⑥)으로 고른 행 목록과 기록(강도·같은/반대 수·5번째 여부).
    dups: 제목 중복으로 뺀 기사(점수 순). 방향마다 e 뒤에 붙여 e 만으로 개수가 모자랄 때만 쓰인다(④ 예외, 2026-11-19 사용자 결정)."""
    name, n_same, n_opp = tier(p)
    up = p > 0.5                                        # llm_input 과 같은 판정(0.5 는 하락)
    dups = e.iloc[:0] if dups is None else dups
    pick_side = lambda d: pd.concat([e[e.impact_direction == d], dups[dups.impact_direction == d]])
    side = 'positive' if up else 'negative'
    same = pick_side(side)
    opp = pick_side('negative' if up else 'positive')
    a = [r for _, r in same.head(n_same).iterrows()]
    b = [r for _, r in opp.head(min(n_opp, len(a))).iterrows()]   # 반대 방향은 같은 방향보다 많지 않게(같은 방향 0건이면 반대만 보이지 않게)
    a += [r for _, r in same.iloc[n_same:n_same + n_opp - len(b)].iterrows()]   # 반대가 모자라면 같은 방향으로
    chosen = a + b
    extra = False
    if len(chosen) == n_same + n_opp:
        used = {r.article_key for r in chosen}
        covered = {n for r in chosen for n in r.linked}
        pool = e if name == 'weak' else e[e.impact_direction == side]   # 5번째는 제목 중복 기사 제외
        floor = EXTRA_MIN * min(r.score for r in chosen)
        for _, r in pool[~pool.article_key.isin(used)].iterrows():
            if r.score < floor:
                break
            if set(r.linked) - covered:
                chosen.append(r)
                extra = True
                break
    d = [r.impact_direction for r in chosen]
    return chosen, {'tier': name, 'shown_prob_pct': round(max(p, 1 - p) * 100, 1), 'decision': 'up' if up else 'down',
                    'n_same': d.count(side), 'n_opposite': sum(x not in (side, 'mixed') for x in d), 'n_mixed': d.count('mixed'), 'extra': extra,
                    'n_dup_title': sum(r.article_key in set(dups.article_key) for r in chosen)}


def pick(con, cutoff: pd.Timestamp, factors: list[dict], p: float, summary_chars: int = 80) -> dict:
    """factors: SHAP 상위 요인 [{'variable','name','pp'}](방향·수익률 합친 것), p: 방향 모델 상승 확률.
    반환: {'window', 'counts'(후보 수·강도·같은/반대 수), 'articles'(짧은 기사), 'links'(번호 -> URL·기사 키·제목, 코드가 근거 기사로 붙임)}."""
    lo, hi = window(cutoff)
    art = pd.read_sql(SQL, con, params={'lo': lo.to_pydatetime(), 'hi': hi.to_pydatetime()})
    counts = {'in_window': int(len(art)), 'tier': tier(p)[0]}
    if art.empty:
        return {'window': [lo.isoformat(), hi.isoformat()], 'counts': counts | {'eligible': 0}, 'articles': [], 'links': {}}
    ok = (art.article_role.ne('market_recap') & art.impact_strength.isin(['moderate', 'strong'])
          & (pd.to_numeric(art.kospi_relevance, errors='coerce') >= .5)
          & (pd.to_numeric(art.conf_impact_direction, errors='coerce') >= .5) & art.news_url.map(_valid))
    e = art[ok].copy()
    e['base'] = (pd.to_numeric(e.kospi_relevance) * pd.to_numeric(e.conf_impact_direction)
                 * e.impact_strength.map({'strong': 1.0, 'moderate': 2 / 3}))
    total = sum(abs(f['pp']) for f in factors) or 1.0
    lk = [links_to(r, factors) for r in e.itertuples()]
    e['linked'] = [n for n, _, _ in lk]
    e['link_share'] = [w / total for _, w, _ in lk]            # 기사 분류(지역·업종·경로) 일치
    e['keyword_share'] = [w / total for _, _, w in lk]          # 제목·요약 키워드 일치
    e['score'] = e.base * (1 + 2 * e.link_share + 2 * e.keyword_share)
    e = e.sort_values(['score', 'article_key'], ascending=[False, True])
    dup = e.title.map(_norm_title).duplicated()
    dups, e = e[dup], e[~dup]
    counts |= {'eligible': int(len(e)), 'linked_to_shap': int(((e.link_share > 0) | (e.keyword_share > 0)).sum()), **{f'n_{d}': int((e.impact_direction == d).sum()) for d in ('positive', 'negative', 'mixed')}}
    chosen, how = choose(e, p, dups)
    counts |= how
    articles, links = [], {}
    for k, r in enumerate(chosen, 1):
        nid = f'n{k}'
        s = str(r.summary or '').strip()
        articles.append({'id': nid, 'title': str(r.title or '').strip(), 'summary': s[:summary_chars] + ('…' if len(s) > summary_chars else ''),
                         'direction': r.impact_direction, 'linked': r.linked[:2],
                         'time': _kst(r.available_at_kst).strftime('%m-%d %H:%M')})
        links[nid] = {'article_key': str(r.article_key), 'url': r.news_url, 'title': str(r.title or '').strip(),
                      'time': articles[-1]['time'], 'direction': r.impact_direction, 'linked': r.linked,
                      'impact': round(float(r.base), 3), 'tag_match': round(float(r.link_share), 3),
                      'keyword_match': round(float(r.keyword_share), 3), 'score': round(float(r.score), 3)}
    return {'window': [lo.isoformat(), hi.isoformat()], 'counts': counts, 'articles': articles, 'links': links}
