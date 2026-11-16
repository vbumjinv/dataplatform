-- 기존 KRX Open API 기관 표시를 OpenAPI KRX 로 바꾼다.
-- provider krx 는 openapi_krx 로 맞추고, 화면/파이프라인 이름의 앞 KRX 도 함께 바꾼다.
-- pykrx 수집(provider=pykrx, 표시명 KRX)과 구분하기 위한 이름 변경이다.

UPDATE dp.api_source
SET
  name = CASE
    WHEN name = 'KRX' THEN 'OpenAPI KRX'
    WHEN name = 'KRX_템플릿' THEN 'OpenAPI KRX_템플릿'
    WHEN name ~ '^KRX(\s|$)' THEN regexp_replace(name, '^KRX(\s|$)', 'OpenAPI KRX\1')
    ELSE name
  END,
  provider = 'openapi_krx'
WHERE lower(provider) = 'krx';

UPDATE dp.api_param_group AS g
SET name = regexp_replace(g.name, '^KRX(\s|$)', 'OpenAPI KRX\1')
FROM dp.api_source AS s
WHERE g.source_id = s.id
  AND lower(s.provider) = 'openapi_krx'
  AND g.name ~ '^KRX(\s|$)';

UPDATE dp.api_pipeline
SET name = regexp_replace(name, '^KRX(\s|$)', 'OpenAPI KRX\1')
WHERE name ~ '^KRX(\s|$)';
