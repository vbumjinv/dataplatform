# outputs — 서비스 실행 때 생기는 파일 (2026-11-05)

서비스 스크립트가 만드는 파일은 모두 이 폴더에 둔다. 예측마다 새 파일을 만들지 않는다(서버에서 몇 년 돌려도 파일 수가 늘지 않게).
DB 와 이미 연결된 것(정형 원천·`dp.news_stock_article`·`dp.news_feature_orig` 읽기/쓰기)은 여기에 두지 않는다.
DB 원천 임시 캐시(`db/raw/`, `.runtime_cache/`)는 DB 에서 다시 받을 수 있어 outputs 에 넣지 않는다(`.runtime_cache` 는 실행마다 지움).

git: 이 폴더는 git 에서 빠진다(운영 기록이라 따로 백업). 예외로 `explain/shap_background/`(배포 파일)과 이 문서는 git 에 남긴다.

## tables/ — 저장소 CSV 모드 (`mlops/store.py`, 파일 이름 = DB 테이블 이름)
DB 테이블이 생기기 전까지 DB 와 같은 열로 여기에 쓴다. 예측·해설(`kospi_pred_*`)은 `.env` `KOSPI_PRED_MODE=db` 면 DB 에 쓰고 읽는다(2026-11-09부터, 여기 CSV 는 옮기기 전 기록). `--mode db` 면 같은 내용이 `dp` 스키마 테이블로 간다(설계·SQL: `docs/reports/model/service_db_design_20261105.docx`).
위치를 바꾸려면 `.env` 의 `KOSPI_CSV_DIR`. DB 가 생기면 `run_mlops_setup.py --mode db --all --from-csv --write` 로 옮긴다.

| 파일 | 키 | 내용 | 쓰는 스크립트 |
|---|---|---|---|
| `kospi_pred_cls.csv` | target_dd, time_point, model_version, prediction_at | 방향 예측: 상승확률·방향, 모델 입력 `model_input`(json: 변수 값, T1 은 뉴스 건수·조건 값·기준값, T2 는 뉴스 집계 건수·자료 준비 점검), SHAP `shap_result`(json) | `predict/predict_t0·t1·t2.py --write`, `explain/explain_timepoint.py --write` |
| `kospi_pred_reg.csv` | 같음 | 수익률 예측: 최종(K1 뒤)·`yhat_raw_value`(K1 전), 80%·95% 범위(%)·`range_regime`, 모델 입력, SHAP | 같음 + `predict/predict_range.py --write` |
| `kospi_pred_explain.csv` | target_dd, time_point, prediction_at | LLM 해설: 핵심 결론·상세 사유·근거 기사 키, 설명한 학습본 버전, 모델·프롬프트·상태·토큰 | `explain/explain_timepoint.py --llm --write` |
| `kospi_mlops_*.csv` (11개) | `mlops/store.py` 머리말 | 학습본 등록부·역할·T2 챌린저 원장·세 시점 지표·경고·T2 비교·작업 기록·학습용 뉴스·OOS·시점별 배포 슬롯 백업 | `run_automation.py` 와 단계 스크립트 |
| `models/<model_version>/` | — | T2 등록부 학습본 파일(bundle.joblib·background.parquet·manifest.json). 최근 2개 대상월만 남긴다 | `mlops/registry.py` |
| `slots/<시점>/<model_version>/` | — | 세 시점 배포 슬롯 복원용 joblib·manifest·범위·SHAP 배경 백업. 시점마다 최근 3번만. 운영 조회용 부속 자산은 별도로 DB kospi_mlops_slot에 자동 등록 | `mlops/post_deploy.py`, `model/assets.py` |

## explain/
| 파일 | 내용 | 만든 스크립트 |
|---|---|---|
| `explain_timepoint_runs.json` | 해설 실행 캐시 한 파일. 키 `<시점>_<대상일>` 마다 SHAP 전체·LLM 입력·근거 기사 후보 수·점수·해설·LLM 응답. 같은 입력이면 SHAP 재계산·LLM 재호출 없음. 최근 60일(`KOSPI_EXPLAIN_CACHE_DAYS`)만 남김 | `explain/explain_timepoint.py` |
| `shap_background/<T>/{cls,reg}_background.parquet·.json` | 세 시점 해설용 SHAP 배경(200행)과 학습본 버전·해시. 재학습 배포 때 다시 만든다 | `explain/build_shap_background.py --write`(재학습 스크립트가 자동 실행) |
| `shap_background/{cls,reg}_background.parquet` | T2 학습본 무결성 검사용 배경(manifest `background.sha256`) | `mlops/registry.py` 배포 |
| `plot_range_<T\|all>.png` | 확인용 범위 그래프 한 장(실행할 때마다 덮어씀) | `explain/plot_range.py` |
| `time_pipeline_timings.csv` | 캐시 없이 DB부터 예측→범위→SHAP→근거 기사→LLM 단계별 소요 시간(결과서용, 저장소 사본에서 실행) | `explain/time_pipeline.py` |

## mlops/tracking/ (`KOSPI_CACHE_DIR`)
| 파일 | 내용 |
|---|---|
| `mlflow.db`·`mlruns/` | MLflow 실행 기록(csv 모드는 sqlite). 학습본은 manifest 만 남긴다(파일은 등록부) |
| `slot_history/<T>/<model_version>/` | T0·T1 재학습 직전 운영 학습본 백업(최근 3개, 되돌리기용) |
| `staging/`·`models/` | 재학습 직후 임시 학습본, db 모드에서 내려받은 학습본 캐시(지워도 다시 받음) |
| `logs/` | 알림 기록(`notifications.jsonl`), cron 로그(`t0.log` 등, 서버는 logrotate 권장) |

## news/
| 파일 | 내용 |
|---|---|
| `run_news_crawl_<시작>_<끝>/` | 뉴스 수집 이어받기 캐시. DB 적재(`--write`)가 끝나면 지운다(실패하면 남아 다음 실행이 이어 받음) |

## 실행 예 (service 폴더에서)
```
python run_predict.py --tp T2 --target 2026-10-06 --write          (예측 → 범위 → SHAP 을 저장소에. --llm 은 유료 해설)
python predict/predict_range.py --target 2026-10-06 --tps T0 --write
python explain/plot_range.py --tp all --date 2026-10-06
python run_monitor_daily.py --asof 2026-10-06 --write
```

2026-11-05 검토 보완: T2 dry-run 성공 시 자체 staging 산출물을 제거한다. DB 등록부의 오래된 학습본 파일을 정리할 때 같은 버전의 로컬 models 캐시도 제거한다. 모델·SHAP 배경·범위 이력·뉴스 시드는 현재 운영 의존성이므로 보존한다. 로그 파일은 별도 logrotate 보존 정책을 적용해야 한다.
