"""[실사용 모듈] 사용자용 설명의 내부 식별자 노출과 목표 분량을 점검한다.

입력: 버전별 설명·최종 결론 문자열과 날짜별 근거. 출력: 오류·권고·문자 수.
의미·인과·수치의 완전한 검증은 아니므로 내용 검토가 추가로 필요하다.
"""
import re

def check_quality(answer, evidence, user_facing=True, service_screen=False, length_range=(800, 1200)):
    answer = {k:v for k,v in answer.items() if k != 'news_urls'}
    text = '\n'.join(answer.values())
    errors, warnings = [], []
    if 'conclusion' in answer and not answer['conclusion'].strip():
        errors.append('최종 결론이 비어 있음')
    if user_facing:
        for term in ('SHAP','base_value','article_key','joblib','core/ctx','시드'):
            if term.casefold() in text.casefold():
                errors.append(f'기술 용어 노출: {term}')
        if re.search(r'\b(?:cls|reg|t1|core|ctx)\b|\b(?:core|ctx|t1)_\w+|\d{3}_\d{6,}', text, flags=re.IGNORECASE):
            errors.append('내부 키 또는 기사 ID 노출')
        names = {r['variable'] for obj in ('cls','reg') for r in evidence[obj]['features']}
        if any(name in text for name in names):
            errors.append('변수명 노출')
        if any(re.search(r'(?m)^\s*#{1,6}\s', v) for v in answer.values()):
            errors.append('문자열 안에 마크다운 제목 포함')
        if service_screen:
            for term in ('데이터베이스 재조회','사후 재현','캐시 연결','기사 버전','저장 파일'):
                if term in text:
                    errors.append(f'내부 운영 정보 노출: {term}')
            # 문장 첫머리의 57.1%·0.09%는 번호 목록이 아니다.
            # 마침표 뒤에 숫자가 이어지는 소수점은 제외하고 1. 설명 / 1) 설명만 검출한다.
            if any(re.search(r'(?m)^[ \t]*(?:[0-9]+\.(?![0-9])|[0-9]+\)|[①-⑳])[ \t]*', value) for value in answer.values()):
                errors.append('문자열 안에 번호 목록 포함')
    length = sum(len(v) for v in answer.values())
    if user_facing and not length_range[0] <= length <= length_range[1]:
        warnings.append(f'목표 분량 {length_range[0]}~{length_range[1]}자 범위 밖(권고)')
    return {'errors':sorted(set(errors)), 'warnings':warnings, 'characters':length}
