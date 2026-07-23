-- 파이프라인에 포함된 데이터 가공들 (선택) : 수집/매핑 이후 실행
create table if not exists dp.api_pipeline_transform (
  id bigint generated always as identity primary key,
  pipeline_id bigint not null references dp.api_pipeline(pipeline_id) on delete cascade,
  transform_id bigint not null references dp.api_transform(transform_id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  constraint api_pipeline_transform_uq unique (pipeline_id, transform_id)
);

create index if not exists ix_api_pipeline_transform_pipeline
  on dp.api_pipeline_transform(pipeline_id, sort_order);
