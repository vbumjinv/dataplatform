-- KRX API 목록에 서비스별 안내(이용신청) 페이지 URL 컬럼 추가.
-- 등록 마법사의 "KRX OpenAPI 바로가기" 버튼이 선택한 API의 상세 페이지로 바로 이동하도록 한다.
-- URL 패턴: https://openapi.krx.co.kr/contents/OPP/USES/service/OPPUSES002_S2.cmd?BO_ID={BO_ID}
-- (BO_ID 는 KRX OPEN API 서비스 목록 페이지 OPPINFO004 에서 수집)
ALTER TABLE dp.api_stat_list_krx
  ADD COLUMN IF NOT EXISTS guide_url text;

UPDATE dp.api_stat_list_krx AS t
SET guide_url =
  'https://openapi.krx.co.kr/contents/OPP/USES/service/OPPUSES002_S2.cmd?BO_ID=' || v.bo_id
FROM (
  VALUES
    ('krx_dd_trd',        'SsgXTEspyJESKvyXZtCU'),
    ('kospi_dd_trd',      'EREKZauXnMmxyIlqzeDN'),
    ('kosdaq_dd_trd',     'nimebcamqFNIPNcRrHoO'),
    ('bon_dd_trd',        'vMxIKCtPBUeRytCqkoFv'),
    ('drvprod_dd_trd',    'rPBjbLtScMwmSXWDOYPd'),
    ('stk_bydd_trd',      'JvJFzlAENzZlPBDNGAWC'),
    ('ksq_bydd_trd',      'hZjGpkllgCBCWqeTsYFj'),
    ('knx_bydd_trd',      'HSiRvxGSYnvaKuAuqpqp'),
    ('sw_bydd_trd',       'erXKnEAzTqcGnkcoSdGA'),
    ('sr_bydd_trd',       'YieGrzzJtKhbaNLuKmhz'),
    ('stk_isu_base_info', 'PiwgMdTwmsenXhmqqxuj'),
    ('ksq_isu_base_info', 'CifLHplnUFMgpHIMMPXs'),
    ('knx_isu_base_info', 'COgTLqgmGlqyJvaEFNIc'),
    ('etf_bydd_trd',      'nrEpCLaZpoLCTzPUMxuF'),
    ('etn_bydd_trd',      'VujebrcOsZQMybnUuwLk'),
    ('elw_bydd_trd',      'brBhSEuDCUNpmfsCslfM'),
    ('kts_bydd_trd',      'CEnOyORzHgXWpdbUfWyf'),
    ('bnd_bydd_trd',      'JfStBNhXISpVVfBHgspT'),
    ('smb_bydd_trd',      'yrTTOsXuYzHprbWLuYzd'),
    ('fut_bydd_trd',      'ilaVYOabbaicHbKTsqga'),
    ('eqsfu_stk_bydd_trd','JzVvQnspImpuqtZlFWpJ'),
    ('eqkfu_ksq_bydd_trd','henfdJADfLTCUCBWIRCj'),
    ('opt_bydd_trd',      'AoTvuFpukvuBsfypkZbq'),
    ('eqsop_bydd_trd',    'fwWKgzbevDVtAoECgkpA'),
    ('eqkop_bydd_trd',    'AFNbHSizSPnEssZoUqiS'),
    ('oil_bydd_trd',      'rTvrZvAFKfcaLPOggJtW'),
    ('gold_bydd_trd',     'sxveSnWzWNzWxQASsgEG'),
    ('ets_bydd_trd',      'IZiYdcgRQFMeENJPEMKG'),
    ('sri_bond_info',     'MwsSXzVIceQhMSJUeCdp'),
    ('esg_index_info',    'WgFYvEvsseQMARfMVZCq'),
    ('esg_etp_info',      'dpRoGGhdnfSZSrMFtUCz')
) AS v(api_id, bo_id)
WHERE t.api_id = v.api_id;
