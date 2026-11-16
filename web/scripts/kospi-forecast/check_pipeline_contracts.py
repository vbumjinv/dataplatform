"""[단위 테스트] 예측 운영 계약 점검 — DB·유료 API 없이 월간 확인, 실패 상태, 저장소, 시점 변경, 실제 모델·SHAP을 확인한다.

실행: python -B check_pipeline_contracts.py (임시 저장소는 종료 시 제거, 운영 기록·학습본 변경 없음).
"""
import pathlib,sys,os,tempfile,json,ast
s=pathlib.Path(__file__).resolve().parent;sys.path[:0]=[str(s/'mlops'),str(s/'predict'),str(s/'explain'),str(s/'train'),str(s)]
import registry as R,pandas as pd,numpy as np
class Fake:
 mode='csv'
 def model_list(self,obj): return pd.DataFrame([dict(manifest=dict(line='model_1',target_month='2026-10',created_utc='x',model_version='old'),model_version='old',deployed_at=None,mlflow_version=None)])
 def model_dir(self,v): return pathlib.Path('unused')
assert R.find(Fake(),'cls','model_1','2026-11',exact=True) is None
assert R.find(Fake(),'cls','model_1','2026-11')['target_month']=='2026-10'
import run_automation as RA
os.environ['KOSPI_RUN_NEWS_FEATURES']='0'
RA.retrain_month=lambda *a:None
RA.step=lambda *a,**k:False
for tp in ('t0','t1','t2'):
 try:getattr(RA,tp)(None,pd.Timestamp('2026-11-05'),False)
 except SystemExit as e:assert e.code==1
 else:raise AssertionError(tp)
from store import DbStore,open_store
from store_csv import CsvStore
with tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).parent) as tmp:
 for st in (CsvStore(True,tmp),DbStore(True,'sqlite:///:memory:')):
  st.create_tables()
  row=dict(objective='DIR_1D',target_dd='2026-10-06',time_point='T0',model_version='m',prediction_at='2026-10-02T16:00:00+09:00',yhat_probability=.6,yhat_direction='UP',model_input={'features':{'x':1.}})
  assert st.pred_put('cls',[row])==1
  assert st.pred_put('cls',[dict(row,yhat_probability=.4)])==0                     # 같은 키는 건너뜀(값이 달라도)
  sat=dict(row,prediction_at='2026-10-03T16:00:00+09:00')                          # 같은 대상일 토요일 실행 = 새 행
  assert st.pred_put('cls',[sat])==1 and st.pred_put('cls',[sat])==0
  got=st.pred_read('cls','T0')
  assert len(got)==2 and got.prediction_at.iloc[-1]==pd.Timestamp('2026-10-03T07:00:00Z')
  assert st.pred_update('cls',dict(target_dd='2026-10-06',time_point='T0',model_version='m',prediction_at='2026-10-03T16:00:00+09:00'),{'shap_result':{'a':1}})==1
  ex=dict(target_dd='2026-10-06',time_point='T0',cls_model_version='m',reg_model_version='m',status='ok')
  assert st.explain_put(dict(ex,prediction_at='2026-10-02T16:00:00+09:00'))==1
  assert st.explain_put(dict(ex,prediction_at='2026-10-02T16:00:00+09:00',status='failed'))==0
  assert st.explain_put(dict(ex,prediction_at='2026-10-03T16:00:00+09:00'))==1
  e=st.explain_read('T0');assert len(e)==2 and (e.status=='ok').all()
print('PASS: exact month / scheduler failure / CSV and SQLite skip-same-key + weekend rows by prediction_at',flush=True)
for tp,day,tgt,at in [('T0','2026-11-13','2026-11-16','2026-11-13 16:00'),('T0','2026-11-14','2026-11-16','2026-11-14 16:00'),
                      ('T0','2026-11-15','2026-11-16','2026-11-15 16:00'),('T0','2026-11-12','2026-11-13','2026-11-12 16:00'),
                      ('T1','2026-11-14','2026-11-16','2026-11-14 02:00'),('T1','2026-11-16','2026-11-16','2026-11-16 02:00'),
                      ('T2','2026-11-15','2026-11-16','2026-11-15 08:30'),('T2','2026-11-13','2026-11-13','2026-11-13 08:30')]:
 from features import timepoints as _T
 assert _T.run_point(tp,day)==(pd.Timestamp(tgt),pd.Timestamp(at,tz='Asia/Seoul')),(tp,day)
 if pd.Timestamp(day).weekday()<5: assert _T.run_point(tp,day)[1]==_T.cutoff(tp,tgt)            # 거래일 실행은 기존 기준 시각과 같음
assert _T.run_day('T0','2026-11-14T15:59:00+09:00')==pd.Timestamp('2026-11-13') and _T.run_day('T0','2026-11-14T16:00:00+09:00')==pd.Timestamp('2026-11-14')
print('PASS: weekend run day -> next Monday target, prediction_at = run day time point',flush=True)
import grid_schedule as G
assert [m for m in range(1,13) if G.grid_due(f'2027-{m:02}')]==[1,4,7,10]
from features import timepoints as TPR,dataset as D
for tp in TPR.TPS:
 expected=TPR.cutoff(tp,'2026-10-06')
 old=TPR._reg()['models']['daily']['time_points'][tp]['time'];h,m=map(int,old.split(':'))
 TPR._reg()['models']['daily']['time_points'][tp]['time']=f'{h:02}:{m+10:02}'
 assert TPR.cutoff(tp,'2026-10-06')==expected+pd.Timedelta(minutes=10)
 TPR._reg()['models']['daily']['time_points'][tp]['time']=old
os.environ.pop('KOSPI_NEWS_READY_THROUGH',None)
assert '--ready-through' not in RA.predict_args('T2',pd.Timestamp('2026-11-05'),False)
os.environ['KOSPI_NEWS_READY_THROUGH']='2026-11-05T08:30:00+09:00'
assert '--ready-through' in RA.predict_args('T2',pd.Timestamp('2026-11-05'),False)
print('PASS: quarterly grid / central cutoff shifts / explicit readiness',flush=True)

import types
news_tree=ast.parse((s/'run_news_features.py').read_text(encoding='utf8'))
lock_node=next(n for n in news_tree.body if isinstance(n,ast.FunctionDef) and n.name=='with_lock')
ns={'acquire_db_lock':lambda engine:None,'ENGINE':None,'ARGS':types.SimpleNamespace(require_completion=True),'sys':sys}
exec(compile(ast.Module(body=[lock_node],type_ignores=[]),'news_lock_contract','exec'),ns)
try:ns['with_lock'](lambda writer:None)
except SystemExit as ex:assert ex.code==75
else:raise AssertionError('news lock skip falsely reports completion')
import predict_range as PR
missing=pd.Series([100.],index=pd.to_datetime(['2026-10-01']))
assert pd.isna(PR.before(missing,pd.to_datetime(['2026-10-06'])).iloc[0])
print('PASS: news lock completion contract / missing prior session blocks stale range input',flush=True)

for p in s.rglob('*.py'):ast.parse(p.read_text(encoding='utf-8-sig'))
import timepoint as TPM, explain_timepoint as E, predict_range as PR
st=open_store(False,'csv'); evidence=[]
import json as _json, artifacts as _A
for tp in TPR.TPS:
 # 배포 학습본(시점별) 기준: 그 학습본이 저장한 가장 최근 예측을 재현한다. 새 달에 아직 예측이 없으면 배경 첫 행으로 SHAP 합계만 확인한다.
 dep=_json.loads(_A.manifest_path(tp,'cls').read_text(encoding='utf-8'))
 c=st._load('pred_cls'); c=c[(c.time_point==tp)&(c.model_version==dep['model_version'])]
 if len(c):
  target=pd.Timestamp(sorted(c.target_dd.astype(str))[-1]);b,m=TPM.load(tp,target);inp=TPM.inputs(tp,target,b,m,st)
 else:
  target=pd.Timestamp(dep['target_month']+'-01');b,m=TPM.load(tp,target)
  x={o:TPM.background(tp,o,m[o])[0].iloc[[0]].reset_index(drop=True) for o in ('cls','reg')}
  pv=float(TPM.model_fn(tp,b['cls'])(x['cls'])[0]);rr=float(TPM.model_fn(tp,b['reg'])(x['reg'])[0]);rk,ap=TPM.k1(pv,rr)
  inp={'x':x,'p':pv,'r_raw':rr,'r':rk,'k1_applied':ap}
  print(f'  {tp}: {dep["model_version"]} 저장 예측 없음 — 배경 첫 행으로 SHAP 합계 확인',flush=True)
 shap=E.run_shap(tp,b,m,inp,2)
 for o in ('cls','reg'):
  assert abs(shap[o]['additivity_error'])<1e-9
 evidence.append(dict(tp=tp,p=inp['p'],ret=inp['r'],raw=inp['r_raw'],shap_errors={o:shap[o]['additivity_error'] for o in shap}))
print('PASS: all six artifact hashes + stored-input reproduction + real SHAP additivity',flush=True)

