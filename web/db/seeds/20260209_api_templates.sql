-- Seed API templates (optional)
-- 마이그레이션 20260312_api_tables_create.sql 실행 후 실행
-- 여러 번 실행해도 중복되지 않음 (idempotent)

-- 한국은행(BOK)
INSERT INTO dp.api_source
  (name, provider, base_url, api_key, enabled, api_key_param_key, api_key_location, api_key_order, api_key_encode_mode, is_template)
VALUES
  ('한국은행_템플릿', 'bok', 'https://ecos.bok.or.kr/api/StatisticSearch', '', true, 'apiKey', 'path', 0, 'encode', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO dp.api_param_group (source_id, name, is_template)
SELECT s.id, '기본', true
FROM dp.api_source s
WHERE s.name = '한국은행_템플릿'
  AND NOT EXISTS (
    SELECT 1 FROM dp.api_param_group g
    WHERE g.source_id = s.id AND g.name = '기본' AND g.is_template = true
  );

INSERT INTO dp.api_param (group_id, param_key, param_value, param_location, param_order, encode_mode, param_role)
SELECT g.id, v.param_key, v.param_value, v.param_location, v.param_order, v.encode_mode, v.param_role
FROM dp.api_source s
JOIN dp.api_param_group g ON g.source_id = s.id AND g.is_template = true
CROSS JOIN (VALUES
  ('format','json','path',1,'encode',NULL),
  ('lang','kr','path',2,'encode',NULL),
  ('start','1','path',3,'encode',NULL),
  ('end','100000','path',4,'encode',NULL),
  ('statCode','', 'path',5,'encode',NULL),
  ('period','M','path',6,'encode','period_type'),
  ('apiStart','', 'path',7,'encode','start'),
  ('apiEnd','', 'path',8,'encode','end')
) AS v(param_key, param_value, param_location, param_order, encode_mode, param_role)
WHERE s.name = '한국은행_템플릿'
ON CONFLICT (group_id, param_key) DO NOTHING;

-- 통계청(KOSIS)
INSERT INTO dp.api_source
  (name, provider, base_url, api_key, enabled, api_key_param_key, api_key_location, api_key_order, api_key_encode_mode, is_template)
VALUES
  ('통계청_템플릿', 'kosis', 'https://kosis.kr/openapi/statisticsData.do', '', true, 'apiKey', 'query', 99, 'none', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO dp.api_param_group (source_id, name, is_template)
SELECT s.id, '기본', true
FROM dp.api_source s
WHERE s.name = '통계청_템플릿'
  AND NOT EXISTS (
    SELECT 1 FROM dp.api_param_group g
    WHERE g.source_id = s.id AND g.name = '기본' AND g.is_template = true
  );

INSERT INTO dp.api_param (group_id, param_key, param_value, param_location, param_order, encode_mode, param_role)
SELECT g.id, v.param_key, v.param_value, v.param_location, v.param_order, v.encode_mode, v.param_role
FROM dp.api_source s
JOIN dp.api_param_group g ON g.source_id = s.id AND g.is_template = true
CROSS JOIN (VALUES
  ('method','getList','query',1,'encode',NULL),
  ('format','json','query',2,'encode',NULL),
  ('jsonVD','Y','query',3,'encode',NULL),
  ('userStatsId','', 'query',4,'none',NULL),
  ('prdSe','M','query',5,'encode','period_type'),
  ('startPrdDe','', 'query',6,'encode','start'),
  ('endPrdDe','', 'query',7,'encode','end')
) AS v(param_key, param_value, param_location, param_order, encode_mode, param_role)
WHERE s.name = '통계청_템플릿'
ON CONFLICT (group_id, param_key) DO NOTHING;

-- 공공데이터포탈(dataGoKr)
INSERT INTO dp.api_source
  (name, provider, base_url, api_key, enabled, api_key_param_key, api_key_location, api_key_order, api_key_encode_mode, is_template)
VALUES
  ('공공데이터포탈_템플릿', 'datagokr', 'https://apis.data.go.kr', '', true, 'serviceKey', 'query', 99, 'decode', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO dp.api_param_group (source_id, name, is_template)
SELECT s.id, '기본', true
FROM dp.api_source s
WHERE s.name = '공공데이터포탈_템플릿'
  AND NOT EXISTS (
    SELECT 1 FROM dp.api_param_group g
    WHERE g.source_id = s.id AND g.name = '기본' AND g.is_template = true
  );

INSERT INTO dp.api_param (group_id, param_key, param_value, param_location, param_order, encode_mode, param_role)
SELECT g.id, v.param_key, v.param_value, v.param_location, v.param_order, v.encode_mode, v.param_role
FROM dp.api_source s
JOIN dp.api_param_group g ON g.source_id = s.id AND g.is_template = true
CROSS JOIN (VALUES
  ('periodType','M','query',0,'encode','period_type'),
  ('orgCode','', 'path',1,'encode',NULL),
  ('apiName','', 'path',2,'encode',NULL),
  ('functionName','', 'path',3,'encode',NULL),
  ('strtYymm','', 'query',1,'encode','start'),
  ('endYymm','', 'query',2,'encode','end')
) AS v(param_key, param_value, param_location, param_order, encode_mode, param_role)
WHERE s.name = '공공데이터포탈_템플릿'
ON CONFLICT (group_id, param_key) DO NOTHING;


-- FREd
INSERT INTO dp.api_source
  (name, provider, base_url, api_key, enabled, api_key_param_key, api_key_location, api_key_order, api_key_encode_mode, is_template)
VALUES
  ('FRED_템플릿', 'fred', 'https://api.stlouisfed.org/fred/series/observations', '', true, 'api_key', 'query', 0, 'encode', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO dp.api_param_group (source_id, name, is_template)
SELECT s.id, '기본', true
FROM dp.api_source s
WHERE s.name = 'FRED_템플릿'
  AND NOT EXISTS (
    SELECT 1 FROM dp.api_param_group g
    WHERE g.source_id = s.id AND g.name = '기본' AND g.is_template = true
  );

INSERT INTO dp.api_param (group_id, param_key, param_value, param_location, param_order, encode_mode, param_role)
SELECT g.id, v.param_key, v.param_value, v.param_location, v.param_order, v.encode_mode, v.param_role
FROM dp.api_source s
JOIN dp.api_param_group g ON g.source_id = s.id AND g.is_template = true
CROSS JOIN (VALUES
  ('file_type','json','query',1,'encode',NULL),
  ('series_id','', 'query',5,'encode',NULL),
  ('frequency','m','query',6,'encode','period_type'),
  ('observation_start','', 'query',7,'encode','start'),
  ('observation_end','', 'query',8,'encode','end')
) AS v(param_key, param_value, param_location, param_order, encode_mode, param_role)
WHERE s.name = 'FRED_템플릿'
ON CONFLICT (group_id, param_key) DO NOTHING;

-- KRX
INSERT INTO dp.api_source
  (name, provider, base_url, api_key, enabled, api_key_param_key, api_key_location, api_key_order, api_key_encode_mode, is_template)
VALUES
  ('KRX_템플릿', 'krx', 'https://data-dbg.krx.co.kr/svc/apis/gen', '', true, NULL, 'query', 0, 'encode', true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO dp.api_param_group (source_id, name, is_template)
SELECT s.id, 'KRX', true
FROM dp.api_source s
WHERE s.name = 'KRX_템플릿'
  AND NOT EXISTS (
    SELECT 1 FROM dp.api_param_group g
    WHERE g.source_id = s.id AND g.name = 'KRX' AND g.is_template = true
  );

INSERT INTO dp.api_param (group_id, param_key, param_value, param_location, param_order, encode_mode, param_role)
SELECT g.id, v.param_key, v.param_value, v.param_location, v.param_order, v.encode_mode, v.param_role
FROM dp.api_source s
JOIN dp.api_param_group g ON g.source_id = s.id AND g.is_template = true
CROSS JOIN (VALUES
  ('period','D','query',1,'encode','period_type'),
  ('apiStart','', 'query',2,'encode','start'),
  ('apiEnd','__TODAY__', 'query',3,'encode','end'),
  ('basDd','', 'query',4,'encode',NULL)
) AS v(param_key, param_value, param_location, param_order, encode_mode, param_role)
WHERE s.name = 'KRX_템플릿'
ON CONFLICT (group_id, param_key) DO NOTHING;