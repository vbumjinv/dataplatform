"""[실사용 모듈] 시점·목적·모델별 입력 변수 선택 — 변수 목록(feature_sets/)과 학습본 manifest를 읽어 모델에 넣을 열을 고르고 대조한다.

사용처: service/predict(입력 열 확인), 새 시점(T0·T1) 모델을 붙일 때 변수 목록 확인
입력: model/feature_sets/use_data.csv(시점 × 목적 × 변수, 모델별 사용 여부 used_by),
      model/feature_sets/variable_selection_result.csv(정형 변수 탐색 결과: 시점·목적별 선정 변수),
      model/artifacts/<시점폴더>/*_manifest.json(학습본이 실제로 받는 열 순서)
실행: python model/select_features.py --tp T2 --objective cls [--model model_1]   변수 목록 출력
      python model/select_features.py --check                                                 use_data.csv 와 학습본 manifest 대조

규칙
- 모델 입력 열 순서는 manifest가 기준이다(학습 때 순서). use_data.csv는 변수 의미·원천 테이블·시점 규칙을 설명하는 목록이다.
- 시점은 T0·T1·T2 로만 받는다. 학습본·use_data.csv 안 이름표(T2_0830 등)와 시각은 service/time_points.json 에 있다.
- 정형 변수는 features/dataset.py build_dataset(시점 정렬)이 만들고, 뉴스 변수는 predict/engine.py --tp T2 가 dp.news_feature_orig 를 하루 단위로 집계해 만든다.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
USE_DATA = HERE / "feature_sets" / "use_data.csv"
SELECTION = HERE / "feature_sets" / "variable_selection_result.csv"
ARTIFACTS = HERE / "artifacts"
import sys  # noqa: E402
sys.path.insert(0, str(HERE.parent))
from features import timepoints as TPR  # noqa: E402
CHECKPOINT_DIR = {TPR.checkpoint_id(tp): tp for tp in TPR.TPS}   # 학습본 안 이름표 -> 시점
# 모델 이름 -> (목적, manifest 파일, manifest 안의 열 목록 키)
MODELS = {
    ("cls", "model_1"): ("cls_model_1_manifest.json", "feature_columns"),
    ("reg", "model_1"): ("reg_model_1_manifest.json", "feature_columns"),
    ("cls", "cls_rf_Bn"): ("cls_rf_Bn_manifest.json", "features"),
}


def _cp(x):
    """시점(T0·T1·T2) 또는 이름표 → use_data.csv·학습본 안 이름표."""
    return TPR.checkpoint_id(x) if str(x).upper() in TPR.TPS else x


def feature_table(checkpoint: str | None = None, objective: str | None = None) -> pd.DataFrame:
    """use_data.csv 를 시점·목적으로 거른 표(열: variable, group, meaning, db_table, time_rule, used_by ...)."""
    df = pd.read_csv(USE_DATA, encoding="utf-8-sig")
    if checkpoint:
        df = df[df["checkpoint"] == _cp(checkpoint)]
    if objective:
        df = df[df["objective"] == objective]
    return df.reset_index(drop=True)


def manifest_columns(checkpoint: str, objective: str, model: str = "model_1") -> list[str] | None:
    """학습본 manifest 에 저장된 입력 열(학습 때 순서). 학습본이 없으면 None."""
    spec = MODELS.get((objective, model))
    if spec is None:
        return None
    path = ARTIFACTS / CHECKPOINT_DIR[_cp(checkpoint)] / spec[0]
    if not path.exists():
        return None
    return list(json.loads(path.read_text(encoding="utf-8"))[spec[1]])


def structured_selection(checkpoint: str, objective: str, union: bool = False) -> list[str]:
    """정형 변수 탐색 결과. union=False면 그 시점의 선정 변수(csv_A), True면 세 시점 합집합(csv_B, 지금 T2 모델이 쓰는 방식)."""
    sm = pd.read_csv(SELECTION, encoding="utf-8-sig")
    sm = sm[sm["objective"] == objective]
    if not union:
        sm = sm[sm["checkpoint"] == _cp(checkpoint)]
    return list(dict.fromkeys(f.strip() for v in sm["final_features"] for f in str(v).split(",") if f.strip()))


def features_for(checkpoint: str, objective: str, model: str = "model_1", group: str | None = None) -> list[str]:
    """모델에 넣을 변수 목록. 학습본 manifest 가 있으면 그 순서, 없으면 use_data.csv 의 used_by 기준.
    group='정형'이면 정형 변수만, '뉴스'면 뉴스 변수만(이름이 '뉴스'로 시작하는 group 전부)."""
    table = feature_table(checkpoint, objective)
    used = table[table["used_by"].fillna("").str.split(r",\s*", regex=True).map(lambda names: model in names)]
    cols = manifest_columns(checkpoint, objective, model) or used["variable"].tolist()
    if group:
        keep = set(used.loc[used["group"].str.startswith(group), "variable"])
        cols = [c for c in cols if c in keep]
    return cols


def select(frame: pd.DataFrame, checkpoint: str, objective: str, model: str = "model_1") -> pd.DataFrame:
    """정형+뉴스 변수가 합쳐진 일별 표에서 모델 입력 열만 학습 때 순서로 고른다. 없는 열이 있으면 멈춘다."""
    cols = features_for(checkpoint, objective, model)
    missing = [c for c in cols if c not in frame.columns]
    if missing:
        raise ValueError(f"{checkpoint}/{objective}/{model}: 입력에 없는 변수 {missing}")
    return frame[cols]


def check() -> int:
    """use_data.csv 의 used_by 와 학습본 manifest 의 열이 같은지 대조한다. 다르면 1."""
    bad = 0
    for (obj, model), _ in MODELS.items():
        cols = manifest_columns("T2", obj, model)
        if cols is None:
            print(f"[건너뜀] T2/{obj}/{model}: 학습본 manifest 없음")
            continue
        table = feature_table("T2", obj)
        listed = set(table.loc[table["used_by"].fillna("").str.split(r",\s*", regex=True).map(lambda n: model in n), "variable"])
        diff_m, diff_u = sorted(set(cols) - listed), sorted(listed - set(cols))
        status = "일치" if not (diff_m or diff_u) else "불일치"
        bad += status != "일치"
        print(f"[{status}] T2/{obj}/{model}: manifest {len(cols)}개, use_data {len(listed)}개"
              + (f" | manifest에만 {diff_m}" if diff_m else "") + (f" | use_data에만 {diff_u}" if diff_u else ""))
    return int(bad > 0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="시점·목적·모델별 입력 변수 목록")
    ap.add_argument("--tp", dest="checkpoint", default="T2", type=TPR.norm, choices=list(TPR.TPS))
    ap.add_argument("--objective", choices=["cls", "reg"])
    ap.add_argument("--model", default="model_1")
    ap.add_argument("--check", action="store_true", help="use_data.csv 와 manifest 대조")
    a = ap.parse_args()
    if a.check:
        raise SystemExit(check())
    for obj in [a.objective] if a.objective else ["cls", "reg"]:
        cols = features_for(a.checkpoint, obj, a.model)
        print(f"{a.checkpoint}/{obj}/{a.model}: {len(cols)}개")
        meta = feature_table(a.checkpoint, obj).drop_duplicates("variable").set_index("variable")
        for c in cols:
            row = meta.loc[c] if c in meta.index else None
            print(f"  {c:<34} {'' if row is None else row['group']:<18} {'' if row is None else row['meaning']}")
