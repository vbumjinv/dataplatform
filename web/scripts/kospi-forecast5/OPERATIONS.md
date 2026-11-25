# service_5 PostgreSQL 서버 배포

이 서비스는 기존 service_daily와 같은 `dp` 원천에서 정형 데이터와 뉴스 피처를 읽고, 5거래일 예측과 운영 기록을 `dp.kospi5_*`에 저장합니다. 뉴스 수집과 Jev 피처 적재는 기존 일별 작업이 담당합니다.

## 1. 운영 계정과 접속 정보

서버에서 ZIP을 풀고 `service_5`에 들어갑니다. 동봉한 `.env`의 접속 정보가 서버에서 사용할 운영 계정과 일치하는지 확인합니다. `DP_DB_URL`은 `jdbc:postgresql://<host>:<port>/<database>` 형식이며, URL에 DB 이름이 있으면 `DP_DB_NAME`은 비워 둡니다. 프로세스 환경 변수의 값이 우선합니다. `DP_DB_SCHEMA=dp`, `KOSPI5_STORE_MODE=db`, `KOSPI5_STORE_DB_URL` 공란을 사용합니다.

Linux에서는 동봉한 파일에 `chmod 600 .env`를 적용합니다. Windows에서는 작업 실행 계정의 파일 접근 권한을 설정합니다. ZIP에도 같은 접속 정보와 API 키가 들어 있으므로 권한이 있는 배포 담당자에게만 전달합니다.

DBA는 실제 작업을 실행할 계정에 다음 권한을 확인합니다.

- `dp` 스키마 `USAGE` 및 정형·공휴일·뉴스·해설 원천 `SELECT`.
- `dp.kospi5_*` 12개 테이블 `SELECT, INSERT, UPDATE, DELETE`. 현재 `--bootstrap` 검사 기준입니다.
- `dp.kospi5_mlops_alert_id_seq`, `dp.kospi5_mlops_job_id_seq`, `dp.kospi5_mlops_role_history_id_seq`에 `USAGE`.

2026-11-25 점검에서 운영 DB 스키마와 코드의 저장 정의가 일치했습니다. 점검 계정에는 위 주별 테이블과 시퀀스 권한이 없었습니다. 아래 검증은 실제 운영 계정으로 실행합니다.

## 2. 설치와 초기 모델 등록

Linux 명령입니다. Windows는 `py -3.13 -m venv .venv`와 `\.venv\Scripts\python.exe`를 사용합니다. 먼저 읽기 전용 점검을 실행합니다.

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
PGOPTIONS='-c default_transaction_read_only=on' .venv/bin/python -B run_mlops_setup.py --check-sources
PGOPTIONS='-c default_transaction_read_only=on' .venv/bin/python -B run_mlops_setup.py --bootstrap
```

두 점검이 통과하면 운영 권한을 가진 담당자가 다음 명령을 실행합니다.

```bash
.venv/bin/python -B run_mlops_setup.py --bootstrap --write
.venv/bin/python -B run_mlops_setup.py --status
.venv/bin/python -B run_promote.py status
```

초기 등록은 빈 챔피언 슬롯에 동봉 v3 모델과 구성 OOS(학습 밖 예측)를 넣습니다. 운영 모델이 이미 있는 슬롯은 건너뜁니다. 새 환경에서 W0·W2 방향·수익률 네 챔피언과 구성 OOS를 확인합니다. 동봉 모델의 대상월은 2026년 11월입니다. 새 대상월의 첫 결과에서 직전 월 모델 사용 로그를 확인하고, 최신 월 모델을 먼저 사용해야 하는 경우 로드된 대상월을 확인한 후 `run_retrain.py --tp W0|W2 --base YYYY-MM-DD --write`로 재학습합니다. `--base`는 희망 대상월의 +5거래일 대상일에 대응하는 확정 종가 기준일입니다. 과거 재실행에 DB의 최신 모델이 해당 예측 대상월보다 새로우면 쓰기 경로가 중단됩니다.

확정 종가가 있는 실행일을 골라 두 시점을 먼저 시험합니다. `--date`는 실행일입니다. W2는 이 날짜의 직전 거래일을 기준일로 사용합니다. 드라이런은 보류 시에도 종료 코드 0일 수 있으므로 방향·수익률·범위·SHAP 출력에서 완료 여부를 확인합니다. 쓰기 권한을 갖춘 담당자가 같은 명령에 `--write`를 붙여 처음 한 건씩 저장한 후 결과 DB를 확인합니다.

```bash
.venv/bin/python -B run_predict.py --tp W0 --date YYYY-MM-DD
.venv/bin/python -B run_predict.py --tp W2 --date YYYY-MM-DD
```

각 실행에서 동일한 `target_dd, time_point, prediction_at`의 분류·회귀가 한 행씩 있고 회귀 범위 4개와 두 행의 SHAP이 저장됐는지 확인합니다. 화면 백분율은 `yhat_value × 100`입니다. 해설 사용 시 저장된 두 모델 버전이 해설 행과 일치하는지 확인합니다. 수동 쓰기 로그는 `outputs/logs/kospi5_predict.log`에 남습니다. 운영 DB의 등록 및 저장 검증을 마친 후 예약합니다.

## 3. 예약 작업

스크립트 디렉터리를 실제 배포 경로로 바꿉니다. cron이 KST이거나 cronie가 `CRON_TZ`를 적용하는 경우 `.venv/bin/python -B scheduler/make_schedule.py`의 KST 줄을 사용합니다. UTC 서버에서 `CRON_TZ`를 지원하지 않으면 다음 UTC 시각을 사용합니다.

```cron
30 23 * * *   /bin/bash /opt/kospi_pred/service_5/scheduler/w2.sh
30 7  * * *   /bin/bash /opt/kospi_pred/service_5/scheduler/w0.sh
0  10 * * 1-5 /bin/bash /opt/kospi_pred/service_5/scheduler/evening.sh
```

Windows 작업 스케줄러의 시각은 서버 로컬 시각 기준입니다. KST 서버에서는 `scheduler/make_schedule.py`가 출력한 `schtasks` 명령을 작업 실행 계정과 경로에 맞게 등록합니다.

| KST | 작업 |
| --- | --- |
| 08:30 매일 | W2. 직전 거래일이 기준일입니다. 08:30 전 공개·08:30까지 적재된 뉴스를 사용합니다. |
| 16:30 매일 | W0. 거래일에는 당일 종가, 휴장일에는 직전 거래일 종가를 사용합니다. 16:00 전 공개·16:30까지 적재된 뉴스를 사용합니다. |
| 19:00 거래일 | 확정 정답 결합, 지표·경고 기록, 챌린저가 있으면 비교합니다. |

W0와 W2는 금일 종가 또는 직전 종가와 실행 시각을 확인합니다. 준비가 늦으면 2분 간격으로 최대 90분 폴링합니다. 지난 2일의 누락 예측도 원래 시각 기준으로 재시도합니다. 예측 80%·95% 범위와 SHAP 준비 후 결과를 한 트랜잭션으로 저장합니다. 뉴스 조회·계산 오류는 W0에서 정형 대체 모델을 사용하고 W2의 쓰기 경로에서는 해당 실행을 중단합니다. 기사 0건은 경고를 기록하고 계속합니다. 뉴스 마감 후 적재된 기사는 90분 대기 중에도 해당 실행 입력에 들어가지 않습니다.

대상월은 실행일이 속한 달이 아니라 `기준일 + 5거래일`이 속한 달입니다. 예약 작업은 다음 실행의 대상월 모델이 오래됐으면 현재 예측 직후 월간 재학습을 시도합니다. 1·4·7·10월 대상 모델은 탐색 대상 구성원을 Optuna로 다시 평가합니다. 월간 학습 실패 시 기존 모델로 다음 예측을 수행하고 이후 다시 시도합니다. 챌린저는 등록했을 때만 따로 학습합니다. 승격은 운영 담당자가 수행합니다.

종료 코드는 0 정상, 1 실행 실패, 2 입력·잠금 등으로 보류입니다. Linux 예약 작업 로그는 `outputs/logs/w0.log`, `w2.log`, `evening.log`입니다. DB의 `kospi5_mlops_job`, `kospi5_mlops_alert`도 확인합니다. 동봉한 `.env`는 `KOSPI5_SCHEDULE_LLM=1`이며 기존 API 키와 모델 설정을 사용합니다. W0·W2 예약 작업은 GPT 해설을 자동 실행합니다. 최초 저장 시험에도 해설을 포함하려면 `run_predict.py --tp W0 --date YYYY-MM-DD --write --llm`을 사용합니다. W2도 같은 방식으로 실행합니다. GPT 또는 근거 기사 조회가 실패하면 새 결과 게시도 중단될 수 있습니다.

