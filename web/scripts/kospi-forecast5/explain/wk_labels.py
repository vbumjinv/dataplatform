"""[실사용 모듈] 주별 변수 쉬운 이름 — 변수 코드(KWS_여의도, NEWS_w10_t2_sec_fin 등)를 LLM 해설·사람이 읽을 한국어 이름으로 바꾼다.

사용처: wk_shap.py(세부 기여 항목의 label). 규칙 기반이라 새 변수도 접두어·접미어로 이름이 붙고, 못 붙이면 코드 그대로 둔다(check 로 확인).
근거: 뉴스 변수 계산 kw/news_agg.py·wk_news.py, 정형 변수 feature_sources.json(원천)·kp 계산 규칙.
점검: python -B wk_labels.py   (운영·챌린저 학습본의 모든 변수에 이름이 붙는지, 서로 다른 변수가 같은 이름을 쓰지 않는지)
"""
from __future__ import annotations
import sys as _sys  # noqa: E402  (폴더 구조 2026-11-23: 직접 실행해도 모듈 폴더를 찾게)
from pathlib import Path as _Path  # noqa: E402
_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "mlops"))
import wk_paths as _WP  # noqa: E402
_WP.add_paths()

import re

NAME = {   # 원천 코드 → 쉬운 이름
    "SP500": "S&P500", "NASDAQ": "나스닥", "RUSSELL2000": "러셀2000", "W5000": "윌셔5000", "SOX": "필라델피아 반도체지수",
    "AMAT": "어플라이드머티리얼즈", "VVIX": "VVIX(VIX 의 변동성)", "VXN": "나스닥 변동성지수(VXN)", "VIX": "VIX",
    "HYG": "미국 하이일드 채권 ETF(HYG)", "XLU": "미국 유틸리티 ETF(XLU)", "DAX": "독일 DAX", "STOXX600": "유럽 STOXX600", "HSI": "홍콩 항셍지수",
    "DXY": "달러지수", "GOLD": "금 가격", "OIL": "국제 유가", "KORIBOR6M": "KORIBOR 6개월 금리", "KORU": "한국 3배 레버리지 ETF(KORU, 미국 상장)",
    "K200_STAPLE": "코스피200 필수소비재", "AUTO": "자동차 업종", "FASHION": "섬유·의복 업종", "INTERNET": "인터넷 업종", "LIVING": "생활소비재 업종",
}
STAT = [   # 접미어 규칙(정규식, 이름 틀)
    (r"ret_1d$", "하루 수익률"), (r"ret_(\d+)d$", "{n}거래일 수익률"), (r"ma_gap_(\d+)$", "{n}일 이동평균 대비 괴리"), (r"z_(\d+)$", "{n}일 평균 대비 위치(z점수)"),
    (r"dd_(\d+)$", "{n}일 고점 대비 낙폭"), (r"upcnt_(\d+)$", "최근 {n}일 중 오른 날 수"), (r"vol_(\d+)$", "{n}일 변동성"),
    (r"level_z_(\d+)$", "{n}일 평균 대비 위치(z점수)"), (r"level$", "수준"),
]
K = {"K_ret_1d": "코스피 최근 거래일 수익률", "K_open_gap": "코스피 최근 거래일 시가 갭(전 거래일 종가 대비)", "K_intraday": "코스피 최근 거래일 장중 수익률(시가 대비 종가)",
     "K_range": "코스피 최근 거래일 고가·저가 차이", "K_close_location": "코스피 최근 거래일 종가 위치(저가 0 ~ 고가 1)", "K_log_volume_change": "코스피 거래량 변화(전 거래일 대비)",
     "TECH_dd_250": "코스피 250일 고점 대비 낙폭", "TECH_ret_60d": "코스피 60거래일 수익률", "TECH_vol_60": "코스피 60일 변동성",
     "TA_SMA10_gap": "코스피 10일 이동평균 대비 괴리",
     # 시장 관계 변수(features/wk_relation.py, 2026-11-24 W0 수익률 학습본)
     "exp_chip_spread": "미국 반도체지수의 S&P500 대비 하루 초과 수익률",
     "exp_sector_dispersion": "국내 업종 간 수익률 격차",
     "exp_fx_vol": "원화 약세와 코스피 변동성 동시 상승 정도"}
T1 = {"impact": "영향 점수(+ 상승·− 하락 쪽)", "impact_std": "영향 점수 흩어짐", "pos_share": "상승 쪽 기사 비중", "neg_share": "하락 쪽 기사 비중",
      "mix_share": "방향 혼재 기사 비중", "strength": "영향 강도", "log_n": "기사 수(시황 제외)", "recap_share": "시황 기사 비중", "log_recap_n": "시황 기사 수",
      "impact_kor": "국내 기사 영향 점수", "impact_usa": "미국 기사 영향 점수", "surprise": "예상 대비 서프라이즈", "unexpected": "예상 밖 기사 비중", "no_news": "기사 없음"}
CODE = {"sec_mkt": "시장 전체", "sec_semi": "반도체", "sec_fin": "금융", "sec_etc": "기타 업종",
        "ch_rate": "금리·통화 경로", "ch_fx": "환율 경로", "ch_flow": "수급 경로", "ch_earn": "실적 경로", "ch_geo": "지정학 경로", "ch_etc": "기타 경로",
        "or_korea": "국내발", "or_usa": "미국발", "or_china": "중국발", "or_other": "기타 지역발",
        "ev_monpol": "통화정책", "ev_macro": "경제지표", "ev_earn": "실적", "ev_geo": "지정학·무역", "ev_policy": "정부 정책·규제",
        "ev_flow": "자금 흐름", "ev_corp": "기업 행동", "ev_ind": "산업 수급",
        "role_event_report": "사건 보도", "role_analysis_outlook": "분석·전망", "role_scheduled_preview": "일정 예고", "role_opinion_recommendation": "의견·추천",
        "st_confirmed": "확정된 일", "st_ongoing": "진행 중인 일", "st_scheduled": "예정된 일", "st_rumor_or_outlook": "소문·전망"}


def _win(n: str) -> str:
    """뉴스 창 이름 — 1거래일 창 = 직전 거래일 같은 시각부터(주말·휴일 포함이라 '하루'가 아님)."""
    return "직전 거래일 이후" if n == "1" else f"최근 {n}거래일"


def label(f: str) -> str:
    """변수 코드 → 쉬운 한국어 이름(못 붙이면 코드 그대로)."""
    if f in K:
        return K[f]
    m = re.match(r"KWS_(.+)$", f)
    if m:
        return f"뉴스 키워드 '{m.group(1)}' 기사 비중(최근 5거래일)"
    m = re.match(r"KWR_w(\d+):(.+)$", f)
    if m:
        return f"뉴스 키워드 '{m.group(2)}' 급증({_win(m.group(1))})"
    m = re.match(r"NEWS_w(\d+)_t1_(.+)$", f)
    if m and m.group(2) in T1:
        return f"{_win(m.group(1))} 뉴스 {T1[m.group(2)]}"
    m = re.match(r"NEWS_w(\d+)_t2_(.+)$", f)
    if m and m.group(2) in CODE:
        return f"{_win(m.group(1))} '{CODE[m.group(2)]}' 뉴스 영향 점수"
    m = re.match(r"NEWS_w(\d+)_t3_(.+)$", f)
    if m and m.group(2) in CODE:
        return f"{_win(m.group(1))} '{CODE[m.group(2)]}' 기사 비중"
    m = re.match(r"TOPIC_(.+)_(share|pos|neg)_(\d+)$", f)
    if m and m.group(1) in CODE:
        what = {"share": "뉴스 비중", "pos": "뉴스 중 상승 쪽 비율", "neg": "뉴스 중 하락 쪽 비율"}[m.group(2)]
        return f"'{CODE[m.group(1)]}' {what}({_win(m.group(3))})"
    m = re.match(r"CHG_t1_(.+)$", f)
    if m and m.group(1) in T1:
        return f"직전 거래일 이후 뉴스 {T1[m.group(1)]} − 그 전 20거래일 평균"
    m = re.match(r"NEW_KR_VKOSPI_(.+)$", f)
    if m:
        name = next((t.format(n=re.search(p, m.group(1)).group(1) if "(" in p else "") for p, t in STAT if re.search(p, m.group(1))), m.group(1))
        return "VKOSPI " + name.replace("수익률", "변화율")   # 변동성 지수는 수익률이 아니라 변화율
    m = re.match(r"(US|USETF|EU|ASIA|MACRO|KR_RATE|KR|KRX|SECTOR)_([A-Z0-9_]+?)_(ret_\d+d|ma_gap_\d+|z_\d+|dd_\d+|upcnt_\d+|vol_\d+)$", f)
    if m and m.group(2) in NAME:
        st = m.group(3)
        for p, t in STAT:
            mm = re.search(p, st)
            if mm:
                s = f"{NAME[m.group(2)]} {t.format(n=mm.group(1) if mm.groups() else '')}"
                return s.replace("수익률", "변화율") if m.group(2) in ("VIX", "VVIX", "VXN") else s
    return f


def check():
    import wk_models
    feats = set()
    for s in ("W0_cls", "W0_reg", "W2_cls", "W2_reg"):
        for role in ("champion", "challenger"):
            m = wk_models.load(s, role)
            if m:
                feats |= set(m["features"])
    miss = sorted(f for f in feats if label(f) == f)
    print(f"변수 {len(feats)}개 중 이름 못 붙인 것 {len(miss)}개: {miss[:20]}")
    for f in sorted(feats)[::60]:
        print(f"  {f} → {label(f)}")
    assert not miss, miss
    seen = {}
    dup = [(seen[label(f)], f) for f in sorted(feats) if seen.setdefault(label(f), f) != f]
    print(f"같은 이름을 쓰는 서로 다른 변수 {len(dup)}쌍: {dup[:10]}")
    assert not dup, dup


if __name__ == "__main__":
    check()
