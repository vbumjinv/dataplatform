"""[실사용 모듈] 운영 DB의 advisory lock으로 주별 작업의 동시 쓰기를 막는다."""
from contextlib import contextmanager

from sqlalchemy import text


class StoreBusy(RuntimeError):
    """다른 5거래일 작업이 운영 저장소를 쓰고 있다."""


@contextmanager
def service_lock(write=True):
    if not write:
        yield
        return
    import wk_store

    engine, _ = wk_store.engine()
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as con:
        locked = con.execute(text("SELECT pg_try_advisory_lock(712025, 5)")).scalar_one()
        if not locked:
            raise StoreBusy("같은 5거래일 저장소에서 다른 작업이 실행 중입니다.")
        try:
            yield
        finally:
            con.execute(text("SELECT pg_advisory_unlock(712025, 5)"))
