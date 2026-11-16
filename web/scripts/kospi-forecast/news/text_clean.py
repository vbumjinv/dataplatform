"""[뉴스] 기사 제목·요약·본문 정리 — 통신사·기자 이름·사진 출처·홍보 문구 등 상용구를 지우고 같은 날 같은 본문을 하나로 합친다.

사용처: service/news/article_store.py(Stage 1 입력 준비), service/run_news_features.py(Stage 1 통과 기사 본문 정리)
규칙 출처: news/crawl/news_clean.py → news_feature_from_scratch.py 3절(2026-10-29). 규칙을 바꾸면 Stage 2 입력이 달라진다.
"""
from __future__ import annotations

import hashlib
import re

import pandas as pd

from .settings import OK_BODY_STATUS

MIN_DEDUP_CHARS = 50          # 문장부호·공백을 뺀 글자 수. 이보다 짧은 본문은 중복 판정 제외
_REPORTER = r"(?:기자|특파원|선임기자|객원기자|인턴기자|수습기자|전문기자|기자단|에디터|객원에디터|PD|논설위원|외신\s?캐스터|캐스터|아나운서)"
# 본문 끝·사진 설명 뒤에 붙는 이름 표기에서만 쓰는 직함(앵커는 본문 중간에 '앵커 투자자' 같은 일반 용어로도 나오므로 끝에서만)
_TAIL_ROLE = r"(?:기자|특파원|선임기자|객원기자|인턴기자|수습기자|전문기자|기자단|에디터|PD|논설위원|외신\s?캐스터|캐스터|아나운서|앵커)"
_NAME = r"[가-힣]{2,4}"
_NAMES = _NAME + r"(?:\s*[·,]\s*" + _NAME + r")*"       # 정유정·김제림, 박지영, 안효정

# (이름, 정규식, 바꿀 문자열) — 위에서부터 차례로 적용
_Q = r"['‘’\"“”]"          # 따옴표 변형

RULES = [
    # 관련기사 링크 묶음: '▼ 관련기사 보기 <제목> https://... <제목> https://...' (URL 규칙보다 먼저, URL이 제목의 끝 표시)
    ("related_links_url", re.compile(r"▼\s*관련\s?기사\s*보기(?:\s+[^▼]{1,120}?\s+https?://\S+)+"), " "),
    ("url", re.compile(r"https?://\S+|www\.[\w.-]+\.\w+\S*"), " "),
    ("email", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), " "),
    # 제보·구독 안내 꼬리말: 해당 문구부터 본문 끝까지
    ("tip_footer", re.compile(r"(?:발로 뛰는 더팩트는|기사문의 및 제보|▶\s*(?:카카오톡|이메일|제보|뉴스 홈페이지)\s*:|"
                              r"\[?\s*제보하기\s*\]?|당신의 제보가 뉴스가 됩니다).*$", re.S), " "),
    # 저작권·재배포 문구
    ("copyright", re.compile(r"[<\[【(]?\s*(?:저작권자|Copyright|ⓒ|©)[^\]>】)]{0,80}?(?:금지|reserved\.?|무단[^\]>】)]{0,30})\s*[>\]】)]?", re.I), " "),
    ("no_redistribution", re.compile(r"무단\s*전재\s*(?:및|[-·,/]|&)?\s*(?:재배포|배포)\s*(?:금지|불가)|AI\s*학습\s*(?:및\s*)?(?:활용|이용)\s*금지"), " "),
    # 지역·통신사 표기: (서울=연합뉴스) [서울=뉴시스] 【서울=뉴시스】
    #   통신사 표기 바로 뒤의 기자 이름은 함께 지운다: (서울=연합뉴스) 배영경 강류나 기자 = / [서울=뉴시스] 홍길동 인턴기자
    ("dateline_byline", re.compile(r"[\(\[【]\s*[가-힣A-Za-z]{1,10}\s*=\s*[가-힣A-Za-z0-9·&\s]{1,15}?\s*[\)\]】]\s*"
                                   r"(?:[가-힣A-Za-z]{1,10}\s*=\s*)?" + _NAMES + r"(?:\s+" + _NAME + r"){0,2}\s*" + _REPORTER + r"\s*=?"), " "),
    ("dateline", re.compile(r"[\(\[【]\s*[가-힣A-Za-z]{1,10}\s*=\s*[가-힣A-Za-z0-9·&\s]{1,15}?\s*[\)\]】]"), " "),
    # 괄호 안 기자 표기: [더팩트ㅣ박지웅 기자] [이데일리 임정요 기자] <이민영 기자> (이민영 기자)
    #   [로이터, 신동윤 기자 정리] 처럼 '정리·취재'가 뒤에 붙은 것도 포함
    ("bracket_byline", re.compile(r"[\[<【(]\s*[^\[\]<>【】()]{0,30}?" + _REPORTER + r"(?:\s*(?:정리|취재))?\s*[\]>】)]"), " "),
    # 기자 이름 = : 한유주 기자 = / 김경택·이민영 기자 = / 뉴욕=김현석 특파원 =
    #   이름과 '기자' 사이 소속(1~2단어)도 함께: 윤정원 연합인포맥스 기자 =
    #   소속 단어를 허용하므로 앞 문장의 단어를 먹지 않도록 글머리나 문장 끝(. ! ? 따옴표 괄호) 바로 뒤에서만 시작한다.
    ("inline_byline", re.compile(r"(?:^|(?<=[.!?”\"’')\]】>])\s+)(?:[가-힣A-Za-z]{1,10}\s*=\s*)?" + _NAMES
                                 + r"(?:\s+[가-힣A-Za-z]{2,10}){0,2}\s*" + _REPORTER + r"\s*="), " "),
    #   문장 중간(제목 뒤 등): 소속 없이 '이름 직함 =' 형태만, 이름 앞이 한글 글자가 아닐 때: ... 사상최고치 이지헌 특파원 =
    ("inline_byline_strict", re.compile(r"(?<![가-힣])(?:[가-힣A-Za-z]{1,10}\s*=\s*)?" + _NAMES + r"\s*" + _REPORTER + r"\s*="), " "),
    # 사진·그래픽 출처: (사진=연합뉴스) [그래픽=뉴시스] /사진=뉴스1
    ("photo_credit", re.compile(r"[\(\[]\s*(?:사진|그래픽|자료|영상|출처|이미지)\s*=\s*[^\)\]]{1,40}[\)\]]|/\s*(?:사진|그래픽)\s*=\s*[^\s,.]{1,30}"), " "),
    ("provided", re.compile(r"[\[(]\s*[^\[\]()]{1,25}?\s*제공\s*[\])]"), " "),
    ("editor_note", re.compile(r"\[\s*편집자\s*주\s*\]"), " "),
    # 끝부분 해시태그 묶음(2개 이상): #코스피 #시가총액
    ("hashtags", re.compile(r"(?:\s*#[^\s#]{1,30}){2,}\s*$"), " "),
    # 방송 기사 영상 크레딧: 영상취재 : 김태형 기자 영상편집 : 양성훈 그래픽 : 박경희 (끝까지)
    ("video_credit", re.compile(r"영상\s*취재\s*[:：].*$|기자\s*[:：]\s*" + _NAME + r"\s*오디오\s*[:：].*$", re.S), " "),
    ("broadcaster_signoff", re.compile(r"MBN\s*뉴스\s*" + _NAME + r"\s*입니다\.?"), " "),
    # 끝맺음 인사('... 박지원 외신캐스터였습니다.')와 프로그램 진행자 표기('진행 : 정준혜 캐스터')
    ("caster_signoff", re.compile(r"(?<![가-힣])" + _NAME + r"\s*(?:외신\s?캐스터|아나운서)\s*(?:였습니다|입니다)\.?"), " "),
    ("host_credit", re.compile(r"(?<![가-힣])진행\s*[:：]\s*" + _NAME + r"\s*(?:캐스터|앵커|아나운서|기자|PD)(?![가-힣])"), " "),
    # 구독 안내 문구: '[주토피아]를 계속 받아보시려면 기자 페이지를 구독해 주세요' / '아래 기자 페이지에서 ... 구독과 응원'
    ("subscribe_promo", re.compile(r"[\[(][^\[\]()]{1,15}[\])]\s*를\s*계속\s*받아보시려면\s*기자\s*페이지를\s*구독해\s?주세요\.?|아래\s*기자\s*페이지에서.*$", re.S), " "),
    # ---- 홍보·안내·방송 상용구: 기사 내용이 아니라 매체의 홍보·구독 안내·코너 소개·면책 문구. 문구가 정해진 것만 통째로 지운다. ----
    # 링크 모음: '▶기사 바로가기: 제목 ▶기사 바로가기: 제목' 은 기사 끝에 붙으므로 처음 표시부터 끝까지, '▷관련기사: 제목(12월19일)' 은 날짜 괄호까지
    ("related_links_tail", re.compile(r"[▶▷]\s*기사\s*바로가기\s*[:：].*$"), " "),
    ("related_link_dated", re.compile(r"[▷▶]\s*관련\s?기사\s*[:：]?\s*.{1,150}?\(\s*(?:\d{4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}\.?|(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일)\s*\)"), " "),
    ("related_page_ref", re.compile(r"[▶▷]\s*관련\s?기사\s*\d{1,2}(?:[·,]\d{1,2})*\s*면"), " "),      # 지면 참조: '▶관련기사 3면'
    ("related_links_more", re.compile(r"▼\s*관련\s?기사\s*보기"), " "),
    ("empty_paren", re.compile(r"\(\s*\)"), " "),
    # 매체 코너·서비스 소개(기사 앞머리)
    ("promo_hk_global", re.compile(r"이\s*기사는\s*국내\s*최대\s*해외\s*투자정보\s*플랫폼\s*한경\s*글로벌마켓\s*에?\s*게재된\s*기사입니다\.?"), " "),
    ("promo_breakfast", re.compile(r"(?:머니S|동행미디어\s*시대)\s*증권\s?전문\s?기자들이\s*매일\s*아침\s*쏟아지는\s*증권사\s*리포트\s*중에서\s*가장\s*알찬\s*리포트의\s*핵심을\s*요약해\s*제공하는\s*"
                                   + _Q + r"?아침밥" + _Q + r"?을\s*통해\s*든든하게\s*성공\s?투자를\s*시작하세요\.?"), " "),
    ("promo_haengbo", re.compile(_Q + r"동행미디어\s*시대" + _Q + r"\s*증권\s*기자들이\s*글로벌\s*가상자산\s*시장의\s*변동성과\s*투자\s*심리,\s*정책\s*이슈를\s*함께\s*분석합니다\.?"), " "),
    ("promo_eureka", re.compile(r"한경유레카는\s*AI\s*알고리즘들의\s*개별\s*종목\s*투자의견\(점수\)을\s*한눈에\s*볼\s*수\s*있는\s*투자\s*플랫폼입니다\.\s*"
                                + _Q + r"한경유레카" + _Q + r"\s*앱을\s*내려받으면\s*종목별\s*투자의견과\s*나에게\s*맞는\s*AI\s*알고리즘을\s*추천받을\s*수\s*있습니다\.?"), " "),
    ("promo_todays_pick", re.compile(r"※\s*Today" + _Q + r"s\s*Pick은\s*매일\s*아침.{0,200}?간추려\s*전달합니다\.?"), " "),
    ("promo_algo_pick", re.compile(r"※\s*알고리즘\s*종목\s*Pick은.{0,250}?(?:국내|해외)\s*종목\s*3개를\s*제공합니다\.?"), " "),
    ("promo_hk_marketpro", re.compile(r"※\s*한경\s*마켓\s?PRO\s*텔레그램을\s*구독하시면\s*프리미엄\s*투자\s*콘텐츠를\s*보다\s*편리하게\s*볼\s*수\s*있습니다\.\s*"
                                      r"텔레그[램렘]에서\s*" + _Q + r"?\s*마켓\s?PRO\s*" + _Q + r"?\s*를\s*검색하면\s*가입할\s*수\s*있습니다\.?"), " "),
    ("promo_ai_prism", re.compile(r"▲\s*AI\s*프리즘\*?\s*맞춤형\s*경제\s*브리핑\s*\*?\s*편집자\s*주\s*[:：]?.{0,250}?독자\s*유형별\s*맞춤\s*뉴스\s*\d+개를\s*선별해\s*제공합니다\.?"), " "),
    ("promo_unicorn", re.compile(r"\[\s*이\s*기사에\s*나온\s*스타트업에\s*대한.{0,150}?볼\s*수\s*있습니다\.?\s*\]|\[\s*머니투데이\s*스타트업\s*미디어\s*플랫폼\s*유니콘팩토리\s*\]"), " "),
    ("promo_checkgongsi", re.compile(r"\[체크!공시\]는\s*공시\s*관련\s*각종\s*이슈를\s*빠르게\s*확인,\s*전달하는\s*코너입니다\.?"), " "),
    ("promo_series_intro", re.compile(r"\[글쓴이주\]\s*주식시장\s*관련\s*소식이.{0,300}?풀어보겠습니다\.?"
                                     r"|\[편집자\s*주\s*:\s*세계에서\s*가장\s*발전한\s*금융\s*시장은\s*영국입니다.{0,500}?옮겨\s*싣습니다\.?\s*\]"), " "),
    ("promo_tesla", re.compile(r"※\s*(?:하단에\s*있는\s*)?" + _Q + r"?\s*김기혁의\s*테슬라월드\s*" + _Q + r"?\s*를\s*구독하시면.{0,300}?직접\s*해설(?:합니다|해\s*드립니다)\.?(?:\s*많은\s*구독\s*부탁드립니다\.?)?"), " "),
    ("promo_mbloc", re.compile(r"안녕하세요\s*엠블록레터의\s*AI\s*인턴입니다\.?"), " "),
    ("promo_broadcast_open", re.compile(r"방송원문입니다\.?|세계\s*증시\s*소식을\s*빠르게\s*새벽\s*배송\s?해\s?드리는\s*시간입니다\.?|"
                                        r"미\s*증시\s*살펴보며\s*한국\s*증시\s*투자아이디어까지\s*찾는\s*마켓\s*무버입니다\.?|미국\s*증시\s*마감\s*시황\s*전해\s?드리겠습니다\.?"), " "),
    # 기사 끝에 붙는 구독·홍보·면책 문구
    ("promo_wallstreet_in", re.compile(r"(?:[“\"]?\s*매일\s*아침,\s*월가의\s*흐름을\s*한눈에\.?\s*)?\[월스트리트in\]\s*구독[·\s]?좋아요는\s*선택\s*아닌\s*필수!?\s*[”\"]?"), " "),
    ("promo_wallstreet_yt", re.compile(r"(?:\d+만\s*구독자의\s*선택\.\s*)?유튜브\s*채널\s*" + _Q + r"매경\s*월가월부" + _Q + r"\([^)]*\)에서\s*진짜\s*미국\s*월가\s*투자\s*뉴스를\s*만나볼\s*수\s*있습니다\.?"), " "),
    ("promo_mk_telegram", re.compile(r"☞\s*더\s*많은\s*투자\s*정보가\s*궁금하다면\?.{0,400}?확인해\s*보시기\s*바랍니다\.?"), " "),
    ("promo_mk_plus", re.compile(r"※?\s*기사\s*전문은\s*매일경제신문의\s*프리미엄\s*재테크\s*콘텐츠\s*플랫폼\s*매경플러스에서\s*확인할\s*수\s*있습니다\.(?:[^.]{0,80}?QR\s?코드[^.]{0,40}?연결됩니다\.?)?"
                                r"|찐\s*재테크\s*정보\s*M\+에서\s*만나세요.{0,100}?검색창에\s*" + _Q + r"매경엠플러스" + _Q + r"를\s*쳐보세요\.?"), " "),
    ("promo_mirae_disclaimer", re.compile(r"이\s*통계\s*데이터는\s*미래에셋증권의\s*의견과\s*무관한\s*단순\s*정보\s*안내이며\s*(?:각각의|개별)\s*투자자(?:\s*개인)?에게\s*맞는\s*투자\s*또는\s*수익\s*달성을\s*보장하지\s*않는다\.\s*"
                                          r"(?:또\s*)?테마주\s*관련\s*종목은\s*이상\s*급등락\s*가능성이\s*있으므로\s*유의해야\s*한다\.?"), " "),
    ("promo_infomax_auto", re.compile(r"※\s*이\s*기사와\s*표는\s*연합인포맥스의\s*데이터를\s*토대로\s*알고리즘에\s*의해\s*자동\s*작성돼\s*편집자의\s*데스킹을\s*거쳤습니다\.?"), " "),
    ("promo_yonhap_sns", re.compile(r"(?:X\s*\(트위터\)|트위터|인스타그램|페이스북)\s*@yonhap\w*(?:\s*페이스북\s*\S+)?"), " "),
    ("promo_gongsi_jupjup", re.compile(r"\*\s*공시줍줍의\s*모든\s*내용은.{0,150}?않습니다\.?"), " "),
    ("promo_tech_column", re.compile(r"\[테크따라잡기\]는\s*한\s*주간\s*산업계\s*뉴스\s*속에\s*숨어\s*있는\s*기술을.{0,150}?드리겠습니다\.?(?:\s*\[편집자\])?"), " "),
    ("promo_stock_column", re.compile(r"[‘']1500만\s*개미[’']와\s*함께\s*달리겠습니다\.\s*여러분의\s*주식\s*계좌가\s*빨간불이\s*되는\s*그날까지\s*재미있는\s*종목\s*기사\s*많이\s*쓰겠습니다\.?"), " "),
    ("promo_ant_world", re.compile(r"(?:[^.!?]{0,40}?공감할\s*)?\[개미의\s*세계\]\s*를\s*편하게\s*받아보시려면\s*기자\s*페이지를\s*구독해\s?주세요\.?"
                                   r"(?:\s*함께\s*공유하고\s*싶은\s*투자\s*사연이\s*있는\s*개미들의\s*제보도\s*기다립니다\.?)?"), " "),
    ("promo_newsis_money", re.compile(r"※\s*인간의\s*중대\s*관심사인\s*돈의\s*흐름을.{0,300}?뉴시스\s*기자들이\s*돕겠습니다[.．]?"), " "),
    ("promo_fss_pine", re.compile(r"금융감독원이\s*운영하는\s*금융소비자포털\s*" + _Q + r"파인" + _Q + r"을\s*인터넷\s*검색창에.{0,150}?받을\s*수\s*있습니다\.?"), " "),
    ("promo_edaily_clip", re.compile(r"📢\s*기사로\s*상세한\s*내용\s*보고\s*싶다면\?(?:\s*이데일리\s*홈페이지\s*접속!\s*edaily\.co\.kr)?|📢\s*기획\s*총괄\s*이데일리\s*미디어영상팀"), " "),
    ("photo_credit_inline", re.compile(r"(?<![가-힣])(?:사진|그래픽|이미지)\s*(?:제공)?\s*=\s*[가-힣A-Za-z0-9]{2,15}|\(\s*(?:사진|자료|이미지|영상)\s*제공\s*=\s*[^()]{1,25}\)"), " "),
    ("provided_resale", re.compile(r"[\[(][^\[\]()]{0,25}?재판매\s*및\s*DB\s*금지\s*[\])]|\*\s*재판매\s*및\s*DB\s*금지"), " "),
    ("promo_eureka_alarm", re.compile(r"한경유레카에서는\s*관심\s*종목을\s*등록하면\s*AI\s*알고리즘들의\s*종합의견을\s*무료로\s*확인할\s*수\s*있으며\s*매매의견이\s*변동되면\s*오전\s*8시\s*30분에\s*앱을\s*통해\s*알림\s*서비스를\s*제공한다\.?"
                                      r"|\s*한경닷컴\s*뉴스룸\s*$"), " "),
    ("promo_three_point", re.compile(r"※?\s*" + _NAME + r"의\s*쓰리포인트를\s*구독해\s?주세요!?\s*3점슛\s*같은\s*짜릿한\s*기사로\s*보답하겠습니다\.?"), " "),
    ("promo_report_brief", re.compile(r"(?:주요\s*)?증권사\s*리포트를\s*(?:모아\s*전달하는\s*AI\s*기반\s*주식\s*리포트\s*브리핑\s*콘텐츠입니다|정리해\s?드립니다)\.?"), " "),
    ("promo_bizwatch_corner", re.compile(r"\[[^\[\]]{1,15}\]는\s*[^.]{0,80}비즈워치\s*산업부의\s*(?:주말\s*)?뉴스\s*코너입니다\.?(?:\s*\[편집자\])?"), " "),
    ("promo_misc_notice", re.compile(r"[^.]{0,20}기사원문[‘’']을\s*누른\s*후\s*소제목\(링크\)을\s*누르면\s*더\s*자세한\s*기사를\s*보실\s*수\s*있습니다\.?"
                                     r"|궁금하신\s*점과\s*의견\s*댓글로\s*남겨주세요\.?"
                                     r"|[^.]{0,60}서비스는\s*기업공시\s*정보\s*제공\s*업체\s*어웨이크\(AWAKE\)\s*에서\s*정보를\s*받아\s*운영됩니다\.?"), " "),
    ("promo_invest_disclaimer", re.compile(r"(?:[^.]{0,40}미래의\s*수익률[·과\s]*성과를\s*보장하는\s*것은\s*아니다\.\s*)?금융투자상품은\s*자산가격\s*및\s*환율\s*변동\s*등에\s*따라\s*투자원금의\s*손실\(0~100%\)이\s*발생할\s*수\s*있으며,\s*그\s*손실은\s*투자자에게\s*귀속된다\.?"), " "),
    ("broadcast_greeting", re.compile(r"경제\s*현안을\s*보다\s*쉽게\s*풀어보는\s*['‘]경제읽기['’]\s*시간입니다\.?|(?:\[앵커\]\s*)?세계\s*증시와\s*우리\s*증시를\s*짚어보는\s*시간\s*['‘]3분\s*증시['’]입니다\.?|"
                                     r"미국\s*증시\s*마감\s*시황\s*바로\s*전해\s?드리겠습니다\.?"), " "),
    # 방송 대본 끝맺음: 문장이 글 끝에 있을 때만(본문 중간의 '지금까지 ...였습니다'는 내용일 수 있다).
    #   끝에서부터 벗겨 가야 하므로 방송사 서명·영상 크레딧·해시태그를 먼저 지운다.
    ("hashtags_station", re.compile(r"(?:\s*#[^\s#]{1,30})+\s*(?:연합뉴스TV|YTN)\s*$"), " "),
    ("video_credit_bracket", re.compile(r"\[\s*영상\s*(?:취재|편집)\s*[^\]]{1,20}\]|\[\s*(?:그래픽|현장연결|영상출처|화면출처|CG)\s[^\[\]]{1,20}\]"), " "),
    ("video_credit_plain", re.compile(r"영상\s*취재\s+[가-힣]{2,4}(?:\s*기자)?\s+영상\s*편집.*$|영상\s*(?:편집|출처)\s*[:：].*$|제작\s*[:：][^:：]{1,30}?영상\s*[:：].*$"), " "),
    ("station_signoff", re.compile(r"(?<![가-힣])(?:연합뉴스TV|YTN|SBS|KBS|MBC|JTBC|한국경제TV|매일경제TV|서울경제TV)\s*(?:뉴스\s*)?" + _NAME + r"\s*입니다\.?"), " "),
    ("station_tail", re.compile(r"(?:\s*\[[^\[\]]{1,25}\])*\s*(?:연합뉴스TV|YTN)\s*$"), " "),
    # 끝부분에 남은 이름: ... 말했다. 이민영 기자 / 정유정·김제림 기자 / 도쿄=최만수 특파원 / 오은비 외신캐스터 /
    #   마켓시그널 정보경 앵커 / 최효은 아나운서 마켓시그널 / 작성자: 박지원 외신캐스터
    #   '양지윤/서형교 기자', '시드니=맹진규/런던=양지윤 기자'처럼 슬래시로 이어진 앞 이름도 함께 지운다.
    ("trailing_byline", re.compile(r"(?<![가-힣])(?:(?:[가-힣A-Za-z]{1,10}\s*=\s*)?" + _NAME + r"\s*/\s*)*"
                                   r"(?:작성자\s*[:：]?\s*)?(?:[가-힣A-Za-z]{1,10}\s*=\s*)?(?:마켓시그널\s+)?"
                                   + _NAMES + r"\s*" + _TAIL_ROLE + r"(?:\s+마켓시그널)?[\s.]*$"), " "),
    # 사진 설명 바로 뒤에 붙은 이름: '... 표시되어 있다. 임세준 기자 코스피가 ...'
    #   '기자.'·'기자!'(방송 대본), '기자가'(조사 붙음), '취재기자'는 제외된다.
    ("caption_byline", re.compile(r"(?<=[.다]\s)(?!취재|수습|인턴|담당|현장|해당|아래)" + _NAME + r"\s?기자(?=\s+[가-힣])"), " "),
    # 방송 대본 끝맺음은 끝에 붙은 해시태그·이름·서명이 모두 지워진 뒤에 판단해야 하므로 맨 마지막에 둔다.
    ("broadcast_signoff_tail", re.compile(r"지금까지\s+[^.!?]{1,40}?(?:이었습니다|였습니다|살펴봤습니다|전해\s?드렸습니다|함께했습니다)\.?\s*$"), " "),
    ("broadcast_thanks_tail", re.compile(r"(?<=[.!?다요])\s*잘\s*들었습니다\.?\s*$"), " "),
]
_SPACES = re.compile(r"\s+")
_LEAD = re.compile(r"^(?:[\s=·,.▶■◆●○|ㅣ]|-(?!\d))+")     # 맨 앞 '-5%'의 마이너스는 지우지 않는다

# 제목에는 이름+직함 규칙을 쓰지 않는다. 제목의 '기자'·'앵커'·'논설위원'은 대부분 기사 소재(예: '주가조작 기자 구속')라
# 지우면 내용이 상한다. 형식 표기(URL·이메일·통신사·사진 출처)만 지운다.
TITLE_RULE_NAMES = ("url", "email", "dateline", "photo_credit", "provided", "editor_note", "hashtags")
TITLE_RULES = [r for r in RULES if r[0] in TITLE_RULE_NAMES]


def _apply(rules, text, return_hits: bool = False):
    s = "" if text is None or (isinstance(text, float) and pd.isna(text)) else str(text)
    hits = {}
    for name, pat, rep in rules:
        s, n = pat.subn(rep, s)
        if n:
            hits[name] = n
    s = _LEAD.sub("", _SPACES.sub(" ", s)).strip()
    return (s, hits) if return_hits else s


def clean_body(text, return_hits: bool = False):
    """본문 정리. return_hits=True면 (정리된 본문, {규칙: 지운 개수})."""
    return _apply(RULES, text, return_hits)


def clean_summary(text, return_hits: bool = False):
    """요약 정리. 본문과 같은 규칙(RULES 전체)을 쓴다. '[서울=연합뉴스] 홍길동 기자 =' 같은 앞머리가 요약에도 붙어 있다."""
    return _apply(RULES, text, return_hits)


def clean_title(text, return_hits: bool = False):
    """제목 정리. 형식 표기만 지운다(TITLE_RULES)."""
    return _apply(TITLE_RULES, text, return_hits)


def body_key(text) -> str | None:
    """정리된 본문의 중복 판정 키. 너무 짧으면 None(중복 판정 제외)."""
    s = re.sub(r"[\W_]+", "", "" if text is None or pd.isna(text) else str(text))
    if len(s) < MIN_DEDUP_CHARS:
        return None
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _kst_date(s: pd.Series) -> pd.Series:
    """발행 시각 열 -> KST 날짜 문자열(YYYY-MM-DD). 시간대가 있으면 KST로 바꾸고, 문자열이면 앞 10자(통합 파일은 KST ISO)를 쓴다."""
    if pd.api.types.is_datetime64_any_dtype(s):
        t = s.dt.tz_convert("Asia/Seoul") if s.dt.tz is not None else s
        return t.dt.strftime("%Y-%m-%d")
    return s.astype("string").str[:10]


def dedupe_by_body(df: pd.DataFrame, body_col: str = "body_clean", time_col: str = "published_at",
                   id_col: str = "news_id", same_day: bool = False) -> tuple[pd.DataFrame, int]:
    """정리된 본문이 같은 기사 중 가장 먼저 발행된 1건만 남긴다. 반환: (남은 df, 지운 건수).
    dup_count = 합쳐진 기사 수(자기 포함). 이미 dup_count가 있는 행은 그 값을 더한다.
    same_day=True면 발행일(KST)까지 같은 기사만 같은 기사로 본다(다른 날의 같은 내용은 다른 이벤트)."""
    df = df.copy()
    if "dup_count" not in df.columns:
        df["dup_count"] = 1
    df["dup_count"] = pd.to_numeric(df["dup_count"], errors="coerce").fillna(1).astype("Int64")
    df["body_hash"] = df[body_col].map(body_key).astype("string")
    group = df["body_hash"]
    if same_day:
        group = (_kst_date(df[time_col]) + "|" + df["body_hash"]).where(df["body_hash"].notna())
    df["_dedup_group"] = group
    df = df.sort_values([time_col, id_col], kind="stable")
    has = df["_dedup_group"].notna()
    counts = df[has].groupby("_dedup_group")["dup_count"].sum()
    keep = df[~has | ~df["_dedup_group"].duplicated(keep="first")].copy()
    m = keep["_dedup_group"].notna()
    keep.loc[m, "dup_count"] = keep.loc[m, "_dedup_group"].map(counts).astype("Int64")
    return keep.drop(columns=["_dedup_group"]), len(df) - len(keep)


def prepare_articles(df: pd.DataFrame, status_col: str = "body_status", verbose: bool = True) -> pd.DataFrame:
    """DB 기사 표 1단계(Stage 1 입력 준비). body_status가 ok인 행만 남기고(정리 전에 거른다) title·summary를 정리한다.
    본문(body)은 정리하지 않는다. Stage 1은 제목·요약만 쓰고, 본문 정리는 Stage 1 통과 기사에만 clean_article_bodies로 한다."""
    n0 = len(df)
    df = df[df[status_col] == OK_BODY_STATUS].copy()
    df["title"] = df["title"].map(clean_title)
    df["summary"] = df["summary"].map(clean_summary)
    df = df.drop(columns=[status_col, "body_chars", "body_error"], errors="ignore")
    if verbose:
        print(f"기사 준비: 입력 {n0:,}건 -> body_status≠{OK_BODY_STATUS} {n0 - len(df):,}건 제외 -> {len(df):,}건 (title·summary 정리)")
    return df.reset_index(drop=True)


def clean_article_bodies(df: pd.DataFrame, id_col: str = "article_key", time_col: str = "published_at",
                         verbose: bool = True) -> pd.DataFrame:
    """DB 기사 표 2단계(Stage 2 입력 준비, Stage 1 통과 기사에만 쓴다). body를 정리해 body_clean 열로 바꾸고(원문 body 열은 버림),
    정리 후 본문이 빈 행을 빼고, 같은 날 같은 본문 중복을 1건만 남긴다."""
    n0 = len(df)
    pos = list(df.columns).index("body")
    df = df.copy()
    df.insert(pos, "body_clean", df["body"].map(clean_body))
    df = df.drop(columns=["body"])
    empty = df["body_clean"].fillna("").str.strip() == ""
    n_empty = int(empty.sum())
    df, n_dup = dedupe_by_body(df[~empty], body_col="body_clean", time_col=time_col, id_col=id_col, same_day=True)
    df = df.drop(columns=["body_hash", "dup_count"])
    if verbose:
        print(f"본문 정리: 입력 {n0:,}건 -> 정리 후 빈 본문 {n_empty:,}건 제외, 같은 날 같은 본문 중복 {n_dup:,}건 제외 -> {len(df):,}건")
    return df.sort_values([time_col, id_col]).reset_index(drop=True)
