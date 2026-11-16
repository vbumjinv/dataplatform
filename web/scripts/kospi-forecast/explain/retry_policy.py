"""[실사용 모듈] 일시적 API 오류와 출력 검증 실패를 제한 횟수만 재시도한다.

인증·권한·잔액 오류는 즉시 중단한다. 지수 대기와 무작위 지연으로 동시 재호출을 줄인다.
"""
import random
import time


class OutputValidationError(ValueError):
    """재생성으로 복구할 수 있는 응답 검증 실패."""


def retryable(exc):
    if isinstance(exc, OutputValidationError):
        return True
    if type(exc).__name__ in ('ValidationError', 'APIResponseValidationError', 'LengthFinishReasonError'):
        return True
    code = getattr(exc, 'code', None)
    if code in ('insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_exhausted'):
        return False
    status = getattr(exc, 'status_code', None)
    return (type(exc).__name__ in ('APIConnectionError', 'APITimeoutError')
            or status in (408, 409, 429) or isinstance(status, int) and status >= 500)


def run_with_retry(operation, *, attempts=3, on_retry=None, sleep=time.sleep):
    """operation에 시도 번호와 직전 검증 오류를 전달한다. 최대 총 3회."""
    feedback = ''
    for attempt in range(1, attempts + 1):
        try:
            return operation(attempt, feedback)
        except Exception as exc:
            if attempt >= attempts or not retryable(exc):
                raise
            feedback = str(exc)[:1200] if isinstance(exc, OutputValidationError) else ''
            delay = min(30.0, 2 ** attempt + random.uniform(0, 1))
            if getattr(exc,'status_code',None)==429 or type(exc).__name__=='RateLimitError':
                delay=max(delay,min(60.0,30.0*attempt))
            response = getattr(exc, 'response', None)
            try:
                delay = min(60.0, max(delay, float(response.headers.get('retry-after', 0))))
            except (AttributeError, TypeError, ValueError):
                pass
            if on_retry:
                on_retry({'attempt': attempt, 'next_attempt': attempt + 1,
                          'error_type': type(exc).__name__, 'delay_seconds': round(delay, 2)})
            sleep(delay)
