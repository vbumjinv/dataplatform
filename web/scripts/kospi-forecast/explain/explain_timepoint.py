"""[실사용 스크립트] 세 시점(T0·T1·T2) 예측 해설 — 최종 학습본 기준 SHAP(배경 행 수는 시점별 shap_config.json)과 LLM 한국어 해설(핵심 결론·SHAP 쉬운 설명·관련 뉴스).

실행(service 폴더에서):
  python explain/explain_timepoint.py --tp T1 --target 2026-10-30                 # SHAP + LLM 입력 만들기(무료, API 호출 없음, 저장 없음)
  python explain/explain_timepoint.py --tp T1 --target 2026-10-30 --llm --write   # + LLM 해설(기본 GPT: OPENAI_MODEL, 기본 gpt-5.6-sol, 유료) + 저장소에 쓰기
  python explain/explain_timepoint.py --tp T1 --target 2026-10-30 --response-file my.json   # API 대신 손으로 쓴 응답을 같은 검사·저장 과정으로 넣기
  --mode csv|db(저장소, 기본 .env KOSPI_MLOPS_MODE), --source bundle(통합본), --top 8(LLM 에 보낼 SHAP 변수 수), --max-articles 3(근거 기사 수)
사전 준비: python explain/build_shap_background.py --tp <T> --write (배경, 행 수 shap_config.json — 재학습 스크립트가 배포 뒤 자동으로 다시 만듦),
  run_predict.py --tp <T> --write(예측·범위를 저장소에 저장: 해설은 저장된 예측 행의 모델 입력을 쓰고, 수익률은 점 예측 대신 범위로 설명)
입력: 저장소 kospi_pred_cls·reg(예측·모델 입력·범위), model/artifacts/<T>/{cls,reg}_model_1(최종 학습본), outputs/explain/shap_background/<T>/{cls,reg}_background.*,
      DB(읽기 전용: KOSPI 종가·기사), model/data/feature_definitions.json(변수 뜻), explain/prompts/v12(동결 프롬프트, manifest 해시 대조)
출력(--write): 저장소 kospi_pred_cls·reg.shap_result(SHAP: 기준값·합계 오차·배경 해시·설정·변수별 shap·시드 차이),
      kospi_pred_explain(핵심 결론·상세 사유·근거 기사 키·설명한 학습본 버전·모델·프롬프트·상태·토큰).
캐시: outputs/explain/explain_timepoint_runs.json — 파일 하나. 키 "<시점>_<대상일>"마다 그날 마지막 실행의 SHAP 전체·LLM 입력·근거 기사 점수·해설·LLM 응답을 두어
      같은 입력으로 다시 돌리면 SHAP 을 다시 계산하지 않고 LLM 을 다시 부르지 않는다. 최근 KOSPI_EXPLAIN_CACHE_DAYS(기본 60)일만 남긴다.
방향·수익률: 분류 = 상승확률(0.5 초과 상승), 회귀 = 방향 맞춤(K1, 수익률 부호를 방향에 맞춤) 후 값. 회귀 SHAP 은 맞춤 전 수익률 모델 출력을 설명한다.
수익률 해설: 점 예측 값 대신 80% 범위(직전 종가 대비 %, 지수)와 평소 대비 폭(그 시점 과거 범위 폭의 백분위)·기운 쪽만 넘긴다(2026-11-05 사용자 요청).
LLM: OpenAI(OPENAI_MODEL, 기본 gpt-5.6-sol). 다른 제공자 전환 기능은 2026-11-11 삭제(사용자 요청).
토큰 절약: ① SHAP 상위 --top 개 변수 + 나머지 합만, 쉬운 이름·짧은 뜻만 보낸다 ② 관련 기사는 코드가 SHAP 핵심 요인과 이어지는 기사로 고른 최대 --max-articles 건
  (뉴스 DB 영향력 x SHAP 요인 분류·키워드 일치 점수, news_pick.py). 기사는 LLM 에 보내지 않고 근거 기사 링크로 코드가 붙인다 ③ 짧은 프롬프트 v12(출력은 핵심 결론·상세 사유 두 항목, 기사는 LLM 에 보내지 않음, 입력에 없는 숫자·덧붙인 반대 요인 문장은 코드가 막음)
  ④ 같은 요청의 응답이 explain_timepoint_runs.json 에 있으면 다시 부르지 않는다(SHAP 도 같은 입력이면 다시 계산하지 않음).
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True
from pathlib import Path as _P
_H = _P(__file__).resolve().parent
sys.path[:0] = [str(_H), str(_H.parent / 'predict'), str(_H.parent / 'mlops'), str(_H.parent)]

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

import pandas as pd  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import timepoint as TPM  # noqa: E402
from shap_calc import shap_values  # noqa: E402
from retry_policy import run_with_retry, OutputValidationError  # noqa: E402
from output_quality import check_quality  # noqa: E402
from service_runtime import SERVICE, OUTPUTS, DATA, sha, clean, encoded, digest  # noqa: E402

EXPLAIN = _H
RUNS = OUTPUTS / 'explain' / 'explain_timepoint_runs.json'    # 시점·대상일별 실행 캐시 한 파일(날짜별 폴더를 만들지 않음, 2026-11-05)
CACHE_DAYS = int(os.environ.get('KOSPI_EXPLAIN_CACHE_DAYS', '60'))   # 캐시는 최근 이 일수만 남긴다(서버에서 계속 쌓이지 않게)
LENGTH = (450, 750)                                    # 프롬프트 v11·v12 목표 분량(권고)
OPPOSITE = ('반대로 작용한 요인은', '반대 요인은', '가장 크게 반대로', '반대 방향으로 가장')   # v12: 덧붙인 반대 요인 문장 금지(2026-11-05 사용자 요청)
NEWS_USE = ('뉴스를 입력', '뉴스를 사용하지', '관련 기사가 없', '관련 기사도 없', '참고 배경')   # v11: 뉴스 사용 여부·기사 유무 언급 금지


class Explanation(BaseModel):
    conclusion: str = Field(min_length=1)                  # "다음 거래일 코스피는 ~": 방향·확률·80% 범위와 읽는 법
    detail_reason: str = Field(min_length=1)               # 방향·수익률 SHAP 핵심 요인을 종합한 상세 사유


# ------------------------------------------------------------------ SHAP
def run_shap(tp, bundles, manifests, inp, permutations):
    out = {}
    for obj in ('cls', 'reg'):
        bg, meta = TPM.background(tp, obj, manifests[obj])
        x = inp['x'][obj]
        base, yhat, values, spread, err = shap_values(TPM.model_fn(tp, bundles[obj]), x, bg, permutations)
        expect = inp['p'] if obj == 'cls' else inp['r_raw']
        if abs(yhat - expect) > 1e-10:
            raise ValueError(f'{obj}: SHAP 모델 출력과 예측이 다릅니다.')
        cols = list(x.columns)
        feats = [{'variable': c, 'value': clean(float(x.iloc[0][c])), 'shap': float(values[j]), 'contribution_pp': float(values[j] * 100),
                  'seed_difference_pp': float(spread[j] * 100)} for j, c in enumerate(cols)]
        feats.sort(key=lambda f: -abs(f['shap']))
        out[obj] = {'time_point': tp, 'objective': obj, 'base_value': base, 'yhat': yhat, 'additivity_error': err, 'features': feats,
                    'explained_output': 'prob_up' if obj == 'cls' else 'return_before_direction_rule',
                    'model_version': manifests[obj]['model_version'], 'background_sha256': meta['sha256'], 'background_rows': meta['rows'],
                    'config': {'algorithm': 'PermutationExplainer', 'permutations_per_seed': permutations, 'seeds': [20261029, 20261030]}}
        print(f'{tp}/{obj} SHAP: 기준 {base:.5f} → 예측 {yhat:.5f}, 합계 오차 {err:.2g}', flush=True)
    return out


# ------------------------------------------------------------------ LLM 입력
def definitions():
    d = json.loads((DATA / 'feature_definitions.json').read_text(encoding='utf-8'))
    out = {}
    for r in d:
        out.setdefault(r['variable'], r)
    return out


DAY_VARS = ('K_ret_1d', 'K_open_gap', 'K_range', 'K_intraday', 'K_close_location', 'K_log_volume_change')


def period(var, group):
    """요인의 기간(코드가 변수 이름으로 정함): 전날 움직임 / 최근 흐름(여러 날) / 밤사이 뉴스 / 최근 뉴스 흐름."""
    if group == '뉴스':
        return '최근 뉴스 흐름' if var.startswith('ctx_') else '밤사이 뉴스'
    if var in DAY_VARS or var.endswith('_ret_1d'):
        return '전날 움직임'
    return '최근 흐름'


def factor_list(shap, top, defs, obj):
    rows = []
    for f in shap['features'][:top]:
        v = f['variable']
        g, n = TPM.NAMES.get(v, ('기타', v))
        m = defs.get(v, {})
        meaning = (f"{m.get('target')}: " if m.get('target') and g != '뉴스' else '') + str(m.get('meaning', ''))
        up = f['contribution_pp'] > 0
        effect = ('상승 가능성을 높임' if up else '상승 가능성을 낮춤') if obj == 'cls' else ('방향 맞춤 전 수익률 예측을 높임' if up else '방향 맞춤 전 수익률 예측을 낮춤')
        rows.append({'name': n, 'group': g, 'period': period(v, g), 'value': TPM.show_value(v, f['value']), 'effect': effect,
                     'pp': round(f['contribution_pp'], 2), 'meaning': meaning[:60]})
    others = sum(f['contribution_pp'] for f in shap['features'][top:])
    return rows, round(others, 2)


def range_info(st, tp, target, inp):
    """저장된 회귀 행의 범위를 해설하고, 평소 대비 폭은 대상일 이전 이력과 비교한다."""
    import predict_range as PR
    hint = f'python predict/predict_range.py --target {target.date()} --tps {tp} --write'
    stored = inp['rows']['reg']
    columns = ('range_lo95_pct', 'range_lo80_pct', 'range_hi80_pct', 'range_hi95_pct')
    bounds = [stored.get(c) for c in columns]
    if (any(pd.isna(v) or not math.isfinite(float(v)) for v in bounds)
            or bounds != sorted(bounds) or pd.isna(stored.get('range_regime'))):
        raise ValueError(f'{tp} {target.date()} 저장 범위가 누락되었거나 유효하지 않습니다: {hint}')
    close = PR.kospi_close()
    prev_close = PR.before(close, pd.DatetimeIndex([target])).iloc[0]
    if not math.isfinite(prev_close) or prev_close <= 0:
        raise ValueError(f'{tp} {target.date()} 직전 거래일 종가가 없습니다.')
    history, _ = PR.build(tp, PR.service(st, tp, end=target - pd.Timedelta(days=1)), close)
    row = pd.Series({**dict(zip(columns, bounds)), 'prev_close': prev_close, 'range_regime': stored['range_regime']})
    return PR.RM.range_summary(history, target, row)


def llm_input(tp, target, inp, shap, news, top, rng):
    defs = definitions()
    p = inp['p']
    up = p > 0.5
    cf, co = factor_list(shap['cls'], top, defs, 'cls')
    rf, ro = factor_list(shap['reg'], top, defs, 'reg')
    mid = (rng['range80_pct'][0] + rng['range80_pct'][1]) / 2
    return {
        'time_point': TPM.NAME[tp], 'target_date': str(pd.Timestamp(target).date()),
        'prediction_at': inp['prediction_at'].strftime('%Y-%m-%d %H:%M KST'),
        'direction': {'decision': '상승' if up else '하락', 'shown_prob_pct': round((p if up else 1 - p) * 100, 1),
                      'base_prob_up_pct': round(shap['cls']['base_value'] * 100, 1), 'factors': cf, 'others_pp': co},
        'return': {**rng, 'tilt': '상승 쪽' if mid > 0.05 else '하락 쪽' if mid < -0.05 else '어느 쪽으로도 거의 기울지 않음',
                   'rule_applied': inp['k1_applied'], 'factors': rf, 'others_pp': ro,
                   'explained_output': 'return_before_direction_rule',
                   'factor_scope': '요인 기여는 K1 전 점 예측을 설명하며 범위 경계의 기여나 최종 부호의 기여가 아니다. K1 적용 시 최종 부호는 방향 모델이 정한다.'},
    }                                                      # 기사는 보내지 않는다(v11: 근거 기사 링크는 코드가 붙임)


def estimate_tokens(prompt, payload):
    """대략 토큰 수(한국어 약 1.5자/토큰, JSON 기호 포함). 비용 확인용 추정값."""
    return int(len(prompt) / 1.5 + len(encoded(payload)) / 1.5)


# ------------------------------------------------------------------ LLM 호출·검사
def prompt_text(version):
    path = EXPLAIN / 'prompts' / version / 'explain_prediction.txt'
    meta = json.loads((path.parent / 'manifest.json').read_text(encoding='utf-8'))
    if sha(path) != meta['prompt_sha256']:
        raise ValueError(f'동결 프롬프트 {version} 변경. 고친 프롬프트는 새 버전 폴더와 manifest 로 등록하세요.')
    return path, path.read_text(encoding='utf-8')


def numbers(text):
    """본문의 숫자(쉼표·부호 제거, 소수 둘째 자리 반올림) 집합."""
    return {round(float(x.replace(',', '')), 2) for x in re.findall(r'\d[\d,]*(?:\.\d+)?', text)}


def allowed_numbers(payload):
    """해설에 써도 되는 숫자: SHAP 요인 값·이름 속 숫자(예: 10일, S&P 500), 방향 확률, 80% 범위(%·지수), 50%(반반)·80%(범위 수준)."""
    d, r = payload['direction'], payload['return']
    src = [str(d['shown_prob_pct']), *map(str, r['range80_pct']), *map(str, r['range80_close']), '50', '80']
    src += [f[k] for blk in (d, r) for f in blk['factors'] for k in ('value', 'name')]
    return numbers(' '.join(src))


def public_answer(parsed, payload, links, shap):
    """검사: URL·변수명·기술 용어·번호 목록 노출, 수익률을 범위로 썼는지(면책 문구는 막지 않음, 2026-11-13 사용자 결정). 통과하면 코드가 고른 기사 링크를 근거 기사로 붙인다(LLM 은 고르지 않음)."""
    data = parsed.model_dump() if isinstance(parsed, BaseModel) else dict(parsed)
    if any('http://' in v.lower() or 'https://' in v.lower() for v in data.values()):
        raise OutputValidationError('본문에 URL을 쓰지 마세요.')
    if any(f'n{i}' in v for v in data.values() for i in range(1, 10)):
        raise OutputValidationError('본문에 기사 번호(n1 등)를 쓰지 마세요.')
    text = ' '.join(data.values())
    if not data['conclusion'].startswith('다음 거래일 코스피는'):
        raise OutputValidationError('conclusion 은 "다음 거래일 코스피는"으로 시작하세요.')
    if any(w in text for w in NEWS_USE):
        raise OutputValidationError('모델의 뉴스 사용 여부나 관련 기사 유무를 쓰지 마세요.')
    lo, hi = payload['return']['range80_pct']
    if f'{abs(lo):.2f}' not in data['conclusion'] or f'{abs(hi):.2f}' not in data['conclusion']:
        raise OutputValidationError('conclusion 에 80% 범위(range80_pct 두 값)를 쓰세요.')
    if any(w in data['detail_reason'] for w in OPPOSITE):
        raise OutputValidationError('"반대로 작용한 요인은 ~"처럼 반대 요인을 따로 덧붙이지 말고, 확신이 약한 이유로 흐름 안에 녹이거나 빼세요.')
    extra = sorted(numbers(text) - allowed_numbers(payload))
    if extra:
        raise OutputValidationError(f'입력에 없는 수치({", ".join(map(str, extra))})를 쓰지 마세요. factors 의 value·확률·범위 값만 씁니다.')
    used = [{'title': v['title'], 'url': v['url']} for v in links.values()]
    check = {o: {'features': shap[o]['features']} for o in ('cls', 'reg')}
    q = check_quality({k: v for k, v in data.items()}, check, user_facing=True, service_screen=True, length_range=LENGTH)
    if q['errors']:
        raise OutputValidationError('; '.join(q['errors']))
    data['news'] = used
    return data, q


def openai_client():
    """GPT(OpenAI Responses API) 호출 함수. 환경변수 OPENAI_API_KEY, OPENAI_MODEL(기본 gpt-5.6-sol)."""
    from openai import OpenAI
    key = os.getenv('OPENAI_API_KEY', '').strip()
    if not key:
        raise ValueError('OPENAI_API_KEY 가 비어 있습니다.')
    client = OpenAI(api_key=key, timeout=180, max_retries=0)

    def ask(instructions, raw):
        r = client.responses.parse(model=ask.model, instructions=instructions, input=raw, text_format=Explanation,
                                   max_output_tokens=3000, store=False)
        if r.status != 'completed' or r.output_parsed is None:
            raise OutputValidationError('완료된 해설 응답이 없습니다.')
        return r.output_parsed, clean(r.usage.model_dump() if r.usage else None)
    ask.model = os.getenv('OPENAI_MODEL', 'gpt-5.6-sol')
    return ask


def call_llm(payload, links, shap, cached, version, response_file=None, use_cache=True, allow_unvalidated=False):
    """cached = 이전 실행의 LLM 응답({request_sha256, structured, usage}) 또는 None. 돌려주는 result['response'] 를 기록에 저장한다."""
    path, prompt = prompt_text(version)
    raw = encoded(payload)
    if response_file:                                               # API 대신 손으로 쓴 응답(같은 검사·저장)
        parsed = Explanation.model_validate(json.loads(Path(response_file).read_text(encoding='utf-8')))
        answer, q = public_answer(parsed, payload, links, shap)
        return {'answer': answer, 'quality': q, 'model': 'manual_response', 'prompt_version': version, 'prompt_sha256': sha(path), 'usage': None}
    from dotenv import load_dotenv
    load_dotenv(SERVICE / '.env', override=False)
    provider = 'openai'                                             # 캐시 키(request_sha256)를 그대로 두려고 값은 남긴다
    ask = openai_client()
    model = ask.model
    req = digest({'provider': provider, 'model': model, 'prompt': prompt, 'input': payload})

    fallback = None

    def generate(attempt, feedback):
        nonlocal fallback
        if use_cache and cached and cached.get('request_sha256') == req and attempt == 1:   # use_cache=False: 소요 시간 측정용(time_pipeline.py)
            result = cached
            parsed = Explanation.model_validate(result['structured'])
        else:
            parsed, usage = ask(prompt + ('\n[수정 요청]\n' + feedback if feedback else ''), raw)
            result = {'request_sha256': req, 'structured': parsed.model_dump(), 'usage': usage}
        metadata = {'provider': provider, 'model': model, 'prompt_version': version, 'prompt_sha256': sha(path),
                    'request_sha256': req, 'usage': result.get('usage')}
        try:
            answer, q = public_answer(parsed, payload, links, shap)
        except OutputValidationError as exc:
            answer = parsed.model_dump()
            if all(answer[field].strip() for field in ('conclusion', 'detail_reason')):
                fallback = {**metadata, 'answer': answer, 'validation_error': str(exc)}
            raise
        return {**metadata, 'answer': answer, 'quality': q, 'response': result}

    try:
        return run_with_retry(generate)
    except OutputValidationError:
        if allow_unvalidated and fallback is not None:
            return fallback
        raise


# ------------------------------------------------------------------ 저장
def load_runs():
    from store import modes
    if modes()[0] == 'db':
        return {}  # DB 경로는 로컬 SHAP·LLM 캐시를 읽지 않는다.
    return json.loads(RUNS.read_text(encoding='utf-8')) if RUNS.exists() else {}


def save_run(key, entry):
    """실행 캐시 한 파일에 "<시점>_<대상일>" 항목을 넣고(같은 키는 덮어씀) 최근 CACHE_DAYS 일만 남겨 대상일·시점 순으로 다시 쓴다."""
    from store import modes
    if modes()[0] == 'db':
        return  # 모델 입력·SHAP·해설은 기존 DB 테이블이 보관한다.
    runs = load_runs()
    runs[key] = entry
    newest = max(pd.Timestamp(k.split('_', 1)[1]) for k in runs)
    runs = {k: v for k, v in runs.items() if pd.Timestamp(k.split('_', 1)[1]) > newest - pd.Timedelta(days=CACHE_DAYS)}
    runs = dict(sorted(runs.items(), key=lambda kv: (kv[0].split('_', 1)[1], kv[0])))
    RUNS.parent.mkdir(parents=True, exist_ok=True)
    tmp = RUNS.with_suffix('.tmp')
    tmp.write_text(json.dumps(clean(runs), ensure_ascii=False, indent=1), encoding='utf-8')
    tmp.replace(RUNS)


def shap_row(shap):
    """저장소 shap_result: 다른 열·모델 입력에서 계산되는 값(변수 값·기여 %p·순위·설명한 예측값)은 빼고 남긴다."""
    return {'base_value': shap['base_value'], 'additivity_error': shap['additivity_error'], 'background_sha256': shap['background_sha256'],
            'config': shap['config'], 'features': [{'variable': f['variable'], 'shap': f['shap'],
                                                    'seed_difference': f['seed_difference_pp'] / 100} for f in shap['features']]}


def tokens(usage):
    """(입력, 출력) 토큰 — OpenAI usage 의 input_tokens·output_tokens."""
    u = usage or {}
    return u.get('input_tokens'), u.get('output_tokens')


def main():
    ap = argparse.ArgumentParser(description='세 시점 예측 SHAP·LLM 해설(최종 학습본 기준)')
    ap.add_argument('--tp', choices=TPM.TPS, required=True)
    ap.add_argument('--target', required=True, help='예측 대상일 YYYY-MM-DD')
    ap.add_argument('--prediction-at', help='해설할 예측 행의 기준 시각(시간대 포함). 빼면 그 대상일의 가장 늦은 행')
    ap.add_argument('--source', choices=('files', 'bundle'), default='files')
    ap.add_argument('--mode', choices=('csv', 'db'), help='저장소(주면 예측·해설·자동화 기록 모두 이 모드. 빼면 .env KOSPI_PRED_MODE(예측·해설)·KOSPI_MLOPS_MODE(자동화 기록), 없으면 csv)')
    ap.add_argument('--write', action='store_true', help='SHAP·해설을 저장소에 쓴다(없으면 화면·캐시만)')
    ap.add_argument('--permutations', type=int, default=8)
    ap.add_argument('--top', type=int, default=8, help='LLM 에 보낼 SHAP 상위 변수 수(나머지는 합계 하나)')
    ap.add_argument('--max-articles', type=int, default=3)
    ap.add_argument('--refresh-shap', action='store_true', help='저장된 SHAP 이 있어도 다시 계산(소요 시간 측정용)')
    ap.add_argument('--prompt-version', default='v12')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--llm', action='store_true', help='LLM 해설 생성(OpenAI, OPENAI_MODEL)')
    g.add_argument('--response-file', help='API 대신 쓸 응답 JSON(검사·저장 과정 확인용)')
    a = ap.parse_args()
    import db
    import news_pick
    from store import open_prediction_store
    t0 = time.perf_counter()
    timing = {}
    target = pd.Timestamp(a.target)
    st = open_prediction_store(a.write, a.mode)
    st.require_tables()
    bundles, manifests = TPM.load(a.tp, target, a.source)
    eng = db.get_engine()
    inp = TPM.inputs(a.tp, target, bundles, manifests, st, a.prediction_at)
    rng = range_info(st, a.tp, target, inp)
    timing['load_predict_sec'] = round(time.perf_counter() - t0, 1)
    print(f"{TPM.NAME[a.tp]} {target.date()}: 상승확률 {inp['p']:.4f}, 수익률 {inp['r'] * 100:+.3f}% "
          f"(맞춤 전 {inp['r_raw'] * 100:+.3f}%, 방향 맞춤 {'적용' if inp['k1_applied'] else '없음'})", flush=True)
    bgs = {o: TPM.background(a.tp, o, manifests[o])[1]['sha256'] for o in ('cls', 'reg')}   # 배경이 바뀌면 SHAP 을 새로 계산
    key = digest({o: {'model': manifests[o]['model_version'], 'x': clean(inp['x'][o].iloc[0].to_dict()), 'perm': a.permutations,
                      'background': bgs[o]} for o in ('cls', 'reg')})[:16]
    run_key = f"{a.tp}_{target.date()}"
    prev = load_runs().get(run_key, {})
    same = prev.get('input_key') == key                              # 같은 학습본·입력·배경이면 저장된 SHAP·응답을 다시 쓴다
    shap = prev['shap'] if same and not a.refresh_shap else {}
    if len(shap) < 2:
        t = time.perf_counter()
        shap = run_shap(a.tp, bundles, manifests, inp, a.permutations)
        sec = round(time.perf_counter() - t, 1)
        for obj in shap:
            shap[obj]['seconds_both'] = sec                       # 방향·수익률 SHAP 합계 계산 시간
    timing['shap_sec'] = shap['cls'].get('seconds_both')
    for o in ('cls', 'reg'):
        st.pred_update(o, {'target_dd': target, 'time_point': a.tp, 'model_version': manifests[o]['model_version'],
                           'prediction_at': inp['prediction_at']}, {'shap_result': shap_row(shap[o])})
    t = time.perf_counter()
    factors = [{'variable': f['variable'], 'name': TPM.NAMES.get(f['variable'], ('', f['variable']))[1], 'pp': f['contribution_pp'] / (1 if o == 'cls' else 0.1)}
               for o in ('cls', 'reg') for f in shap[o]['features'][:a.top]]   # 수익률 기여는 크기가 1/10 수준이라 10배로 맞춰 함께 본다
    with eng.connect() as con:
        news = news_pick.pick(con, inp['prediction_at'], factors, a.max_articles)
    timing['news_sec'] = round(time.perf_counter() - t, 1)
    payload = llm_input(a.tp, target, inp, shap, news, a.top, rng)
    entry = {'input_key': key, 'shap': shap, 'llm_input': payload,                 # llm_input = LLM 에 보낸 그대로(점검·보고서용)
             'news': {'window': news['window'], 'counts': news['counts'], 'links': news['links']}}   # 근거 기사 후보 수(기간 안 → 조건 통과 → 고른 수)·점수
    _, prompt = prompt_text(a.prompt_version)
    print(f"근거 기사: {len(news['articles'])}건(기간 안 {news['counts']['in_window']}건, LLM 에 보내지 않음) | LLM 입력: 변수 상위 {a.top}개, "
          f"추정 입력 토큰 약 {estimate_tokens(prompt, payload):,}", flush=True)
    if not (a.llm or a.response_file):
        if same and 'explanation' in prev:                               # 해설 없이 다시 돌려도 같은 입력의 이전 해설은 남긴다
            entry.update(explanation=prev['explanation'], response=prev.get('response'))
        save_run(run_key, entry)
        print('SHAP 처리 완료. LLM은 호출하지 않았습니다(--llm이면 유료 해설 생성).')
        return
    old = st.explain_read(a.tp, target, target)
    if len(old) and ((old.prediction_at == inp['prediction_at']) & (old.status == 'ok')).any():   # 같은 (대상일, 시점, prediction_at) 성공 해설이 있으면 GPT 를 부르지 않는다(failed 는 다시 만듦)
        save_run(run_key, entry)
        return
    t = time.perf_counter()
    base = {'target_dd': target, 'time_point': a.tp, 'prediction_at': inp['prediction_at'], 'cls_model_version': manifests['cls']['model_version'],
            'reg_model_version': manifests['reg']['model_version'], 'prompt_version': a.prompt_version}
    try:
        result = call_llm(payload, news['links'], shap, prev.get('response') if same else None, a.prompt_version, a.response_file, allow_unvalidated=True)
    except Exception as e:
        # The result store keeps the failure for a later run, while the prediction remains usable.
        st.explain_put({**base, 'status': 'failed', 'error': f'{type(e).__name__}: {e}'[:2000]})
        return
    timing['llm_sec'] = round(time.perf_counter() - t, 1)
    timing['total_sec'] = round(time.perf_counter() - t0, 1)
    result['timing'] = timing
    result['provenance'] = {o: {'model_version': manifests[o]['model_version'], 'background_sha256': shap[o]['background_sha256']} for o in ('cls', 'reg')}
    entry['response'] = result.pop('response', None)
    entry['explanation'] = result
    save_run(run_key, entry)
    ans = result['answer']
    tin, tout = tokens(result.get('usage'))
    validation_error = result.get('validation_error')
    st.explain_put({**base, 'conclusion': ans['conclusion'], 'detail_reason': ans['detail_reason'],
                    'article_keys': [v['article_key'] for v in news['links'].values()], 'llm_model': result['model'],
                    'status': 'failed' if validation_error else 'ok',
                    'error': validation_error[:2000] if validation_error else None, 'input_tokens': tin, 'output_tokens': tout})
    if validation_error:
        print(ans['conclusion'], ans['detail_reason'], sep='\n\n', flush=True)
        return
    print(f'해설 완료: {RUNS.name}[{run_key}]', '| 분량', result['quality']['characters'], '자', '| 권고', result['quality']['warnings'] or '없음')


if __name__ == '__main__':
    main()
