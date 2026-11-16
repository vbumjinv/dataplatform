"""[실사용 모듈] T2 월간 재학습 — 다음 달용 챔피언·챌린저 학습본(정형 F0 + 뉴스 결합)을 만들어 등록부에 올리고 챔피언을 운영 슬롯에 배포한다.

파라미터: 매달은 계열별 직전 학습본의 뉴스 모델 설정 고정 재학습, 대상월이 1·4·7·10월이면 grid search 로 다시 고른다
          (train/grid_schedule.py, 사용자 결정 2026-11-04). 정형 F0 는 원래대로 model/configs/f0_T2.json 고정.

저장소: --mode db(dp.kospi_mlops_* 테이블) | csv(outputs/tables/kospi_mlops_*.csv), 빼면 .env KOSPI_MLOPS_MODE(기본 csv) — mlops/store.py.
        아래 kospi_mlops_* 는 두 모드에서 같은 이름·열이다. 정형 원천·dp.news_feature_orig 는 모드와 관계없이 운영 DB에서 읽기만 한다.
실행은 공통 입구 run_retrain.py 로 한다(service 폴더):
                   python run_retrain.py --tp T2                                   # dry-run: 학습만 하고 저장소·운영 슬롯은 바꾸지 않음
                   python run_retrain.py --tp T2 --month 2026-11 --write           # 두 계열 학습 → 등록부 등록 → 챔피언 배포
                   python run_retrain.py --tp T2 --month 2026-11 --write --no-deploy     # 배포 없이 학습·등록만
                   python run_retrain.py --tp T2 --month 2026-11 --write --deploy-only   # 이미 등록된 그달 챔피언 배포만
                   --grid on|off(격자 주기 무시), --objective cls|reg, --lines model_1 …, --force, --allow-missing-news
입력: 정형 원천·dp.news_feature_orig(읽기 전용), kospi_mlops_news_daily·kospi_mlops_oos·kospi_mlops_model·kospi_mlops_role
출력(저장소, --write): kospi_mlops_news_daily(새 거래일 뉴스 변수), kospi_mlops_oos(직전 달 구성요소 예측), kospi_mlops_model(학습본),
      kospi_mlops_job(실행 기록)
로컬: mlops/paths.STAGING(학습 직후), paths.MODELS(캐시) — 지워도 DB에서 다시 받는다.

순서: ① DB 스냅샷(정형·뉴스) ② 뉴스 일별 변수 이어 붙이기(0건인 날 있으면 멈춤) ③ 직전 달 학습본으로 그 달 회귀 구성요소 OOS 이어 붙이기
     ④ 계열별·목적별 학습(train/trainer.fit_one) ⑤ DB 등록부 기록 ⑥ --deploy 면 챔피언 배포
     ⑧ 배포했으면 mlops/post_deploy.after_deploy(T2): 예측 범위·해설용 SHAP 배경·통합본(T2 파일만 바꿈), 등록부 학습본 파일은 최근 2개 대상월만 남기기(registry.prune_files).
실패하면 이전 배포본이 그대로 남고 알림(mlops/notify.py)을 남긴다.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

SERVICE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICE / "train"), str(SERVICE / "mlops"), str(SERVICE / "predict"), str(SERVICE)]

import grid_schedule as G  # noqa: E402
import inputs as I  # noqa: E402
import notify  # noqa: E402
import registry as R  # noqa: E402
import trainer as T  # noqa: E402
from store import open_store  # noqa: E402


def extend_news(st, store_news, news_new, month_start, allow_missing=False) -> pd.DataFrame:
    """월 시작 전 거래일의 DB 뉴스 변수만 고정 저장(이미 저장된 날짜는 다시 계산하지 않는다).

    2017년 이후 뉴스 0건인 거래일은 한 번도 없었다(시드 2,388일). 0건인 날이 있으면 dp.news_feature_orig 처리가
    끝나지 않은 것으로 보고 멈춘다(0으로 고정 저장하면 학습·스태킹이 틀어진다).
    """
    if not news_new or news_new["cls"].empty:
        return store_news
    frame = pd.concat([news_new["cls"], news_new["reg"]], axis=1)
    frame = frame[frame.index < month_start]
    if frame.empty:
        return store_news
    art = news_new["articles_per_day"].reindex(frame.index).fillna(0)
    if (art == 0).any() and not allow_missing:
        raise ValueError(f"뉴스 피처가 0건인 거래일 {int((art == 0).sum())}일({', '.join(d.strftime('%m-%d') for d in frame.index[art == 0][:8])} ...). "
                         "외부 dp.news_feature_orig 적재 완료를 확인한 뒤 다시 실행하세요(--allow-missing-news 는 비교용).")
    n = st.news_daily_append(frame, source="db:dp.news_feature_orig", articles=art)
    print(f"뉴스 일별 변수: {frame.index.min().date()} ~ {frame.index.max().date()} {len(frame)}일 계산, DB 추가 {n}일", flush=True)
    return pd.concat([store_news, frame[~frame.index.isin(store_news.index)]]).sort_index()


def extend_oos(st, oos, ds, news, prev_month, lines) -> tuple[pd.DataFrame, dict]:
    """직전 달 학습본(계열별)으로 그 달 거래일의 회귀 구성요소 예측을 만들어 OOS 표에 붙인다."""
    days = ds.index[(ds.index.strftime("%Y-%m") == prev_month)].intersection(news.index)
    done = {}
    for line in lines:
        man = R.find(st, "reg", line, prev_month)
        if man is None:
            done[line] = "직전 달 학습본 없음(시드 OOS로 대체)"
            continue
        have = oos[(oos.line == line) & oos.target_dd.isin(days)]
        if len(days) and len(have) >= len(days) * 5:
            done[line] = "이미 있음"
            continue
        bundle = R.load(st, man)
        frame = pd.concat([ds.loc[days], news.loc[days]], axis=1)[T.feature_columns(bundle)]
        _, parts = T.predict_parts(bundle, frame)
        rows = pd.concat([pd.DataFrame({"target_dd": days, "objective": "reg", "component": k, "yhat": np.asarray(v, float),
                                        "source": "registry", "model_version": man["model_version"], "line": line})
                          for k, v in parts.items()], ignore_index=True)
        st.oos_put(rows, replace=True)
        oos = pd.concat([oos[~((oos.line == line) & oos.target_dd.isin(days))], rows], ignore_index=True)
        done[line] = f"{len(days)}일 계산 ({man['model_version']})"
    return oos, done


def deploy_champion(st, obj, month) -> str:
    champ = R.find(st, obj, st.roles()[obj]["champion"], month, exact=True)
    if champ is None:
        raise ValueError(f"{obj}: champion 계열 {month} 학습본이 DB 등록부에 없어 배포하지 않습니다.")
    R.deploy(st, champ)
    print(f"[배포] {obj}: {champ['model_version']}", flush=True)
    return champ["model_version"]


def run(a):
    """a: run_retrain.py 인자(month·write·mode·deploy·deploy_only·objective·lines·force·allow_missing_news·grid)."""
    objs = ("cls", "reg") if a.objective == "both" else (a.objective,)
    if (a.deploy or a.deploy_only) and not a.write:
        raise SystemExit("배포는 --write 와 함께 쓴다(배포 기록을 DB에 남긴다).")
    if a.deploy and a.allow_missing_news:
        raise SystemExit("--allow-missing-news 학습본은 배포하지 않습니다.")
    st = open_store(a.write, a.mode)
    st.require_tables()
    month = a.month
    month_start = pd.Period(month, freq="M").start_time
    prev_month = (pd.Period(month, freq="M") - 1).strftime("%Y-%m")
    grid = G.grid_due(month, a.grid)
    print(f"재학습 {month} | DB {st.describe()} | {'grid search' if grid else f'뉴스 모델 설정 고정(다음 격자 {G.next_grid_month(month)})'}", flush=True)
    log = {"month": month, "lines": a.lines, "objectives": list(objs), "grid_search": grid, "results": {}}
    import post_deploy as PD
    close = PD.check_ready("T2", month, st) if (a.deploy or a.deploy_only) else None   # 배포 뒤 범위 이력에 붙일 예측이 다 있는지 학습 전에 확인
    job = st.job_start("retrain_monthly", {"month": month, "lines": a.lines, "deploy": a.deploy or a.deploy_only})
    try:
        if a.deploy_only:
            for obj in objs:
                log["results"][f"{obj}/deployed"] = deploy_champion(st, obj, month)
            log["results"]["post_deploy"] = PD.after_deploy("T2", st, close, month)
            st.job_end(job, "ok", log)
            return
        from service_runtime import pipeline_hash
        store_news = st.news_daily_read()
        if store_news.empty:
            raise RuntimeError("kospi_mlops_news_daily 가 비어 있습니다. run_mlops_setup.py --upload-seed 를 먼저 실행하세요.")
        last = I.last_session_before(month)                 # 마지막 거래일 장중(T2 예측 직후)에도 그날 행이 있게 한다(gap 으로 빠짐)
        print(f"[1] DB 스냅샷: 정형 ~{last.date()}, 뉴스 {store_news.index.max().date()} 이후", flush=True)
        ds, news_new, meta = I.load_snapshot(last, target_date=last, news_after=store_news.index.max(), news_hist=store_news)
        log["source_snapshot_at"] = meta["source_snapshot_at"]
        news = extend_news(st, store_news, news_new, month_start, a.allow_missing_news)
        # 전체 기간 재학습본을 배포한 뒤에도 다시 2017년부터로 줄이지 않는다.
        news_start = min(R.deployed(o).get("news_train", {}).get("start", "2017-01-01") for o in objs)   # 입력 점검용(가장 이른 시작). 학습은 목적별 시작(2026-11-09: 방향 2010, 수익률 2017)
        missing = ds.index[(ds.index >= news_start) & (ds.index < month_start)].difference(news.index)
        if len(missing):
            raise ValueError(f"뉴스 일별 변수가 없는 거래일 {len(missing)}일: {[str(d.date()) for d in missing[:5]]}")
        print(f"[2] 직전 달({prev_month}) 회귀 구성요소 OOS", flush=True)
        oos, log["oos"] = extend_oos(st, st.oos_read(), ds, news, prev_month, a.lines)
        print("   ", log["oos"], flush=True)
        phash = pipeline_hash()
        roles = st.roles()
        for obj in objs:
            dep = R.deployed(obj)
            for line in a.lines:
                key = f"{obj}/{line}"
                existing = R.find(st, obj, line, month, exact=True)
                if existing is not None and not a.force:
                    print(f"[3] {key}: 이미 등록됨 {existing['model_version']}", flush=True)
                    man = existing
                else:
                    prev = None if grid else (R.find(st, obj, line, prev_month) or existing)   # 그 계열 직전 학습본(--force 로 같은 달을 다시 만들면 그 달 기존 학습본), 없으면 격자
                    fixed = prev["news_train"]["selected_spec"] if prev else None
                    how = f"설정 고정 {prev['model_version']}" if prev else "grid search"
                    print(f"[3] {key}: {month}용 학습 ({how})", flush=True)
                    sprev = prev if prev else R.find(st, obj, line, prev_month)          # 정형 F0 도 격자 달이 아니면 직전 학습본 파라미터
                    folder = T.fit_one(month, obj, ds, news, oos=oos, line=line, pipeline_sha256=phash,
                                       fixed_specs=fixed, fixed_from=prev["model_version"] if prev else None,
                                       structured_grid=grid, structured_fixed=None if grid or not sprev else sprev.get("structured_params"),
                                       news_start=R.deployed(obj).get("news_train", {}).get("start", news_start), fusion=(sprev or {}).get("fusion") if obj == "cls" else None)
                    m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
                    if m["feature_columns"] == dep.get("feature_columns"):
                        m["feature_version"] = dep["feature_version"]
                        (folder / "manifest.json").write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
                    man = R.register(st, folder)
                    if not a.write:
                        import shutil
                        import paths
                        if folder.resolve().parent == paths.STAGING.resolve():
                            shutil.rmtree(folder)
                log["results"][key] = {"model_version": man["model_version"], "selected_spec": man["news_train"]["selected_spec"]}
            if a.deploy:
                log["results"][f"{obj}/deployed"] = deploy_champion(st, obj, month)
        if a.deploy and a.write:
            log["results"]["post_deploy"] = PD.after_deploy("T2", st, close, month)
            log["results"]["pruned_registry_files"] = R.prune_files(st)
        st.job_end(job, "ok", log)
        deployed = [f"{k}: {v}" for k, v in log["results"].items() if k.endswith("/deployed")]
        notify.send(f"KOSPI 재학습 완료 {month}", deployed or ["배포 없음(학습·등록만)"], level="info")
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        st.job_end(job, "failed", log, err + "\n" + traceback.format_exc())
        notify.send(f"KOSPI 재학습 실패 {month}", [err, "재학습 진입점의 파일 복구 결과와 배포 버전을 확인하세요"], level="error")
        raise
    print(json.dumps(log["results"], ensure_ascii=False, indent=1, default=str))

