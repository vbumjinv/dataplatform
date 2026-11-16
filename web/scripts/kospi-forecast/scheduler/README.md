# scheduler — 예약 실행 (서버 Linux cron, 노트북 Windows 작업 스케줄러)

파이썬 코드는 스스로 시간을 기다리지 않는다. **운영체제의 예약 기능이 정해진 시각에 `python run_automation.py <작업> --write`를 부른다.** 작업 순서·휴장일·그달 마지막 거래일 판단·중복 실행 막기·기록·실패 알림은 `run_automation.py`가 한다(`mlops/README.md`). 저장 모드(csv/db)는 `service/.env`의 `KOSPI_MLOPS_MODE`를 따른다.

예약 시각은 `service/time_points.json`(시점 시각 + `run_delay_minutes`, 저녁 `evening_run`)에서 나온다. 시각을 바꾸면 `python scheduler/make_schedule.py --write` 로 `crontab.example`을 다시 만들고 서버 crontab·작업 스케줄러를 그 줄로 바꾼다(아래 표·명령은 지금 값).

| 작업 | 언제(KST) | 하는 일 |
|---|---|---|
| t0 | 월~금 16:00 | 다음 거래일 T0 예측·범위·SHAP(·해설). 그 대상일이 그달 마지막 거래일이면 이어서 다음 달용 T0 재학습·배포 |
| t1 | 월~금 02:00 | [뉴스 피처] → T1 예측·범위·SHAP(·해설). 그달 마지막 거래일이면 이어서 다음 달용 T1 재학습·배포 |
| t2 | 월~금 08:30 | [뉴스 피처] → T2 운영 예측 → 챔피언·챌린저 원장(09:00 전). 그달 마지막 거래일이면 이어서 다음 달용 T2 재학습·등록·배포 |
| evening | 월~금 19:00 | 정답 결합·지표·경고·비교(T2) |

월간 재학습은 따로 예약하지 않는다. 시점마다 대상일이 이번 달인 마지막 예측을 마친 직후 다음 달용 학습본을 만들어 바로 배포한다(사용자 결정 2026-11-04). 학습 자료는 그달 마지막 거래일을 gap 으로 빼므로 이때 모두 있고, 다음 예측(다음 달 첫 거래일)까지 약 하루 여유가 있다. 월말 재학습을 놓치거나 실패하면(운영 슬롯이 그달보다 이른 학습본) 다음 거래일부터 같은 작업이 예측 직후 그달 학습본을 다시 시도한다. T0 은 끝에서 두 번째 거래일 16:00 예측(대상일 = 그달 마지막 거래일) 직후에 재학습한다. 배포 뒤에는 그 시점만 `mlops/post_deploy.py` 가 예측 범위·SHAP 배경·통합본을 새 학습본에 맞추고 슬롯을 백업한다. 재학습은 매달이고, grid search 는 대상월이 1·4·7·10월일 때만 한다(`train/grid_schedule.py`).

## 서버 (Linux, cron)
| 파일 | 내용 |
|---|---|
| `t0.sh`, `t1.sh`, `t2.sh`, `evening.sh` | `run_automation.py <작업> --write` 호출, 로그 `<캐시>/logs/<작업>.log` |
| `common.sh` | service 폴더 이동, 가상환경(`KOSPI_VENV`), 시간대·인코딩 |
| `crontab.example` | `crontab -e`에 넣을 내용 |

1. 코드 복사(예: `/opt/kospi_pred/service`), `python3.13 -m venv /opt/kospi_venv`, `pip install -r requirements.txt`
2. `service/.env` 작성: DB_*, API 키, `KOSPI_MLOPS_MODE`, `KOSPI_CACHE_DIR`(영구 디스크), `KOSPI_*` 스위치(`.env.example`).
   - csv 모드면 `KOSPI_CSV_DIR`(영구 디스크)를 정하고, 노트북의 `outputs/tables/` 폴더(예측·해설·자동화 기록 CSV와 등록부 학습본 `models/`)를 통째로 복사한다.
   - db 모드면 같은 DB를 보므로 복사할 것이 없다.
3. `python run_mlops_setup.py --check` — 학습본 4개·역할·시드가 보여야 한다.
4. `python run_automation.py evening`(dry-run) → `python run_automation.py evening --write`
5. `chmod +x scheduler/*.sh`, `crontab -e`에 `crontab.example` 붙여 넣기
6. 노트북 예약을 끈다. db 모드에서는 겹쳐 돌아도 advisory lock이 막지만, csv 모드에서는 노트북과 서버가 서로 다른 파일을 보므로 한쪽만 돌린다.

## 노트북 (Windows, 작업 스케줄러) — 시험용
`run_job.bat <작업>`이 `python run_automation.py <작업> --write`를 실행하고, 로그를 `mlops\cache\logs\<작업>.log`에 남긴다. 손으로 실행해도 되고, 아래처럼 등록할 수도 있다(PC가 켜져 있어야 실행됨).
```
schtasks /Create /TN kospi_t1 /TR "C:\kospi_pred\service\scheduler\run_job.bat t1" /SC DAILY /ST 02:00
schtasks /Create /TN kospi_t2 /TR "C:\kospi_pred\service\scheduler\run_job.bat t2" /SC DAILY /ST 08:30
schtasks /Create /TN kospi_evening /TR "C:\kospi_pred\service\scheduler\run_job.bat evening" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 19:00
```
- 바로 한 번 실행: `schtasks /Run /TN kospi_evening`
- 지우기: `schtasks /Delete /TN kospi_evening /F`

## 주의
- 코드를 다시 배포하면서 `model/artifacts/T1/`·`T2/`를 git 사본으로 덮어쓰면 지난 월간 배포가 사라진다. T2는 `python run_retrain.py --tp T2 --month <이번 달> --write --deploy-only`로 저장소의 그달 챔피언을 다시 배포하고, T0·T1은 `<캐시>/slot_history/<T>/`에 남은 학습본을 슬롯에 다시 복사한다.
- 서버 시간대가 KST가 아니면 `CRON_TZ=Asia/Seoul`을 지원하는 cron(cronie)인지 확인하고, 지원하지 않으면 시각을 UTC로 바꾼다.
- 알림 채널은 아직 없다. `mlops/notify.py`가 `<캐시>/logs/notifications.jsonl`에 쌓고, `.env`에 `NOTIFY_WEBHOOK_URL`을 넣으면 웹훅으로도 보낸다.
