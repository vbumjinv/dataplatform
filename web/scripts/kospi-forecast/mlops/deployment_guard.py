"""[실사용 모듈] 월간 배포 실패 시 모델·범위·SHAP 배경·통합본 파일을 함께 복구한다.

사용처: run_retrain.py. 학습 등록·작업 기록은 감사 이력으로 남긴다.
예외 복구용이며 프로세스 강제 종료·정전 또는 동시 독자의 원자적 전환을 보장하지 않는다.
"""
from contextlib import contextmanager
from pathlib import Path
import shutil
import tempfile

SERVICE = Path(__file__).resolve().parents[1]


@contextmanager
def recover_files(tp, enabled=True, service=None):
    """정상 완료 시 새 파일 유지, 예외 시 진입 전 파일 복구(새 파일도 제거)."""
    if not enabled:
        yield
        return
    if tp not in ('T0', 'T1', 'T2'):
        raise ValueError(f'알 수 없는 시점: {tp}')
    root = Path(service) if service is not None else SERVICE
    directories = [root / 'model' / 'artifacts' / tp,
                   root / 'model' / 'artifacts' / 'bundle',
                   root / 'outputs' / 'explain' / 'shap_background' / tp]
    # T2 등록부 배포는 시점별 배경 외에 런타임용 공용 배경도 교체한다.
    shared = root / 'outputs' / 'explain' / 'shap_background'
    def files():
        found = {p for d in directories if d.exists() for p in d.iterdir() if p.is_file()}
        if tp == 'T2':
            found.update(shared / f'{o}_background.parquet' for o in ('cls', 'reg')
                         if (shared / f'{o}_background.parquet').exists())
        return found
    with tempfile.TemporaryDirectory(prefix='kospi_deployment_') as tmp:
        originals = files()
        saved = {}
        for i, p in enumerate(sorted(originals)):
            dest = Path(tmp) / str(i)
            shutil.copy2(p, dest)
            saved[p] = dest
        try:
            yield
        except BaseException:
            for p in files() - originals:
                p.unlink()
            for p, dest in saved.items():
                p.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dest, p)
            print(f'[배포 복구] {tp}: 모델·범위·SHAP 배경·통합본을 실행 전 파일로 복구했습니다.', flush=True)
            raise
