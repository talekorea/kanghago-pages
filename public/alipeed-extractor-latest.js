/* ============================================================
   알리피드 주문 추출 + Airtable 자동 푸시 v2.9.10 (콘솔 fetch 전 페이지 순회)
   ★버전 위생(3곳 항상 일치): ① 파일명(alipeed-extractor-v2.9.10.js) ② 이 헤더 버전 ③ EXTRACTOR_VERSION 상수.

   v2.9.10 수정 (2026-07-21): ★사업자개인 필드 저장(전자상거래 계산방식용).
     - Shipments.사업자개인(Single select, 옵션 사업자/개인) 신설 대응 — 이미 파생하던 o.사업자개인을 statsBySaseom 집계 후 저장.
     - 전자상거래 건 + 값 있을 때만 fields['사업자개인'] 저장(무역 미포함=빈값 유지, 회귀0). typecast:true로 옵션 수용.
     - 전자상거래 그룹은 통관구분(사업자/개인 포함)으로 이미 분리 → 그룹 내 동일값(첫 전자상거래 주문값 채택).

   v2.9.9 수정 (2026-07-21): ★전자상거래 통관유형 5종 완전 분리(v2.9.8 해운/항공 2분할 → 5분할).
     - 파생: ordTyText에서 (전자상거래|항공특송)+(사업자|개인)+(해운|항공|특송) → o.통관구분(정규화 5종) + o.사업자개인.
       5종: 전자상거래사업자해운/전자상거래개인해운/전자상거래사업자항공/전자상거래개인항공/항공특송사업자.
       ★항공특송사업자 ≠ 전자상거래사업자항공 → 다른 키(병합 방지).
     - 그룹핑: 전자상거래=AP+통관구분 → 복합키 'AP-통관구분-YYMMDD'(끝 -YYMMDD·고객사서함=원본AP → base 복원 안전).
       무역=AP만 → 키 바이트 동일(무변경). 한 AP 5종 → Shipment 5개(무게·박스 각각 분리).
     - 사업자/개인: 계산방식 결정 요소지만 Shipments 전용 필드 없음 → 저장 스킵(사장 수동생성 권장), 값은 통관구분 키에 인코딩(무손실).

   v2.9.8 수정 (2026-07-21): ★전자상거래 트랙 판정 확장 + 항공·해상 키 분리(전자상거래 격리).
     - 트랙: ordTyText에 "전자상거래" OR "항공특송" 포함 → 전자상거래(v2.9.7의 전자상거래-only → 항공특송 포함 5종 커버).
     - 운송수단: /항공|특송/→항공, else /해운|해상/→해운(전자상거래 그룹키 분리에만 사용, 무역 미사용).
     - 그룹핑: 전자상거래는 AP+운송수단 → 복합키 'AP-운송수단-YYMMDD'(끝 -YYMMDD 유지·고객사서함=원본AP → base 복원 안전).
       무역은 AP만 → 키 바이트 동일(무변경). 항공+해상 한 AP → Shipment 2개(무게·박스 분리).
     - Shipments에 전용 '운송수단' 필드 없음(배송방식=택배/화물 예약) → 필드 저장 스킵, 운송수단은 키에 인코딩(무손실).

   v2.9.7 수정 (2026-07-21): ★전자상거래 자동 트랙분류. 주문구분 셀(ordTyText)에 "전자상거래" 포함 시
     (예 "전자상거래(사업자)-해운") o.전자상거래=true → 사서함 OR 집계 → Shipments.통관트랙='전자상거래' 저장.
     기존엔 자체추출(ecommerce-tool line 16343)만 태그해 일반추출 전자상거래 건이 빈값(무역 오분류)이던 반쪽 구조 해소.
     무역 건은 통관트랙 키 미포함=빈값 유지(회귀0). typecast:true로 singleSelect 옵션 수용.

   v2.9.6 수정 (2026-07-21): ★구매수수료CNY 매핑 누락 복구. 파싱(p.구매수수료CNY, line 644)은 됐으나
     Products 업로드 fields에 키가 없어(line 1444~) 무조건 0 저장되던 버그. 스키마엔 '구매수수료CNY'(precision4)만
     존재 → CNY만 매핑('현지배송비CNY'=Orders 전용 422 진범·'구매수수료KRW'=스키마 없음 → 미포함).
     debugCommission 통계도 fields→파싱원본(orders[].상품[])에서 읽도록 정정(가짜 0% 지표 제거).
     기능 변경 시 세 곳을 반드시 함께 올린다(불일치 금지). 시작 시 버전 알림창 첫 줄에도 버전이 표시되어
     실행자가 신/구버전을 즉시 눈으로 확인한다.
   v2.9.5 수정 (2026-06-27): ★대행종류 소스 = 주문구분 → 물류센터 대괄호 (알리피드 시스템 변경 대응).
   - 알리피드 변경: 수입자 판단 = 주문구분 → 물류센터. 주문번호 셀 raw HTML `<br>웨이하이[배송대행]&nbsp;`의 대괄호.
   - parseOrderRow: agentType = ordNoHtml의 [구매대행|결제대행|배송대행](대·소괄호 모두) ‖ ordTy(주문구분 폴백). 주문구분 필드=agentType로 저장 → Orders.대행종류.
   - ★구매대행 오판 차단: 주문구분엔 구매대행 없고 결제/배송만 → 주문구분만 보면 구매대행 주문이 실화주로 오판. 물류센터 [구매대행] 우선으로 차단.
   - 매핑: [구매대행]→테일코리아 수입자 / [결제대행]·[배송대행]→실화주. 도구는 무변경(Orders.대행종류 단일소스 → 수입자·납세·CO·발행주체 자동 파생).
   v2.9.4 수정 (2026-06-26): ★자동매칭 broadcast 오염 근본 차단.
   - matchFromHistory URL 정확매칭에 isUniqueProductUrl 게이트: 공용 이미지/에디터/alicdn URL(Edt_*.png 등)은 비고유 → 매칭 키 제외(고유 1688/타오바오 detail URL만).
   - exact·similar 모두 빈칸만 채움(onlyEmpty) + 관세사확정 자동설정 폐지(사람만). 덮어쓰기·자동확정 제거 → 다른 제품 영문명 broadcast 오염 차단.
   - 사고: AP1840 규조토 코스터 5건이 공용 Editor 이미지 URL 공유 → history "Chiffon Fabric Poster"(12회)와 URL일치 → 전부 덮임. (v2.9.x autoMatchFromHistory와 동일 경로 — 도구도 v3.2.150에서 동일 차단.)
   v2.9.3 수정 (2026-06-25): ★★선적일 수동 입력(prompt) 완전 제거 — 휴먼에러 근본 차단.
   - [근본] 선적일 = 추출 주문의 실제출고요청일(cells.eq(12))에서 ★자동 도출★. 사람이 날짜를 타이핑하지 않는다.
   - 분기: ①전부 동일 날짜 → 그 날짜 자동 사용("선적일 X · N건 동일 · 진행?" 확인만)
          ②여러 날짜 섞임 → ⛔차단(한 날짜씩 분리 추출 안내)  ③빈 날짜 → 목록 표시, 과반 빈값이면 차단·아니면 제외(경고).
   - 검색필터 날짜는 참고 교차확인만(추출 데이터와 다르면 경고).
   - 가드 A(입력↔원본 대조)는 자동도출로 무의미해져 제거. 가드 C(링크 이동 방지)는 2차 안전망으로 유지. 가드 B(수동 날짜 sanity)도 제거(수동입력 없음).
   v2.9.2 수정 (2026-06-25): ★날짜 오타·주문 이동 사고 재발 방지 가드 3종 추가.
   - [가드 B] 날짜 sanity: 입력 선적일이 오늘 -3 ~ +5일 밖이면 confirm 경고(미래/과거 오타 차단). prompt 직후.
   - [가드 A] 입력↔원본 대조: 추출된 Orders.실제출고요청일 분포 집계 → 입력 선적일과 다른 주문이 있으면
     업로드 직전 confirm. 다수(과반) 불일치면 강한 차단 권고. (260626 오타로 주문이 엉뚱한 선적분에 적재된 사고 차단.)
   - [가드 C] Shipment 링크 이동 방지: 기존 주문이 이미 ★다른★ 복합키 Shipment에 연결돼 있으면
     무조건 덮지 않음 → 이동 대상·건수 confirm. 승인 시만 이동(덮어쓰기), 거절 시 기존 링크 보존(Shipment 필드 미포함).
     같은 날짜 재추출(동일 링크)은 이동 아님 → 무경고 통과. (D 검토안=출고요청 단계 보존은 C 거절 경로로 흡수.)
   - 데이터/파싱 로직 무변경 — 입력검증·업로드 가드만 추가.
   v2.9.1 수정 (2026-06-14): ★대행유형 파싱을 색상→텍스트 매칭으로 전면 교체.
   - [근본 원칙] 색상(ff6600 등)으로 대행유형을 나누지 않는다. cell2 전체 텍스트에서
     "구매대행/배송대행/결제대행" 세 단어만 화이트리스트(정규식)로 선택. 합배송·단독배송·복사본·LCL·통관 등은 전부 무시.
   - 이전 v2.9의 span[ff6600] 기준은 합배송이 주황일 때 "합배송"을 잘못 잡던 버그(예 260607002) → 폐기.
   - 셋 다 없으면 ordTy='' → orderRecords에서 대행종류 미포함(기존값 보존).
   v2.9 (2026-06-14):
   - [대행유형 → Orders.대행종류] o.주문구분(=ordTy)을 Orders.대행종류로 저장.
     이전엔 parseOrderRow가 주문구분을 담았으나 push 화이트리스트(orderRecords)에 없어 드롭 → 대행종류 항상 빈값이었음.
     orderRecords에 `if(o.주문구분) fields['대행종류']=o.주문구분;` 조건부 1줄 추가(값 있을 때만, 기존 보존).
     용도: 인보이스 도구의 통관 신고자(수입자/Notify) 양식 분기 — 구매대행(TALE KOREA 수입자) vs 배송/결제대행(고객 수입자).
   - [첫 실행 확인 로그] 추출된 대행종류 분포를 console.log → "구매대행/배송대행/결제대행"인지 눈 확인.
   - 조건부 추가라 기존 추출/저장 무영향. 기존 대행종류 빈값 주문은 재추출 시 채워짐.
   ------------------------------------------------------------
   ★ 실행: F12 콘솔에 통째로 붙여넣기 + 엔터 (Tampermonkey/확장/설치 불필요)
     알리피드가 확장/유저스크립트를 차단해도 콘솔 직접 입력은 정상 동작.

   v2.5.3 재설계 (2026-06-06):
   - [선적일 파싱 — 색상 의존 폐기, 시간 유무 기준]
     사장님 핵심 발상: cells.eq(12) 5줄 중 "시간(HH:MM) 없이 YYYY-MM-DD 단독"인 줄이
     유일하게 실제출고요청일(=선적일). 나머지 4개(등록/수정/입고완료/출고등록)는 모두 시간 포함.
     → color:blue 매칭 폐기, 시간 유무로만 판정 → UI 색상 표기 변경에 무관.
     알고리즘: HTML 주석 제거 → <br> split → tag 제거 후 plain text →
              시간 없는 + 날짜 있는 줄만 후보 → 0개 빈값, N개 마지막(셀 맨 아래).
     v2.5.2 색상 기준이 AP2726 6/5·6/9 재추출에서도 안 잡힌 후 재설계.

   v2.5.2 패치 (2026-06-06) — v2.5.3로 대체됨:
   - [선적일 빈 주석 가로채기 fix] 알리피드 일부 행에서 진짜 blue 선적일 옆에
     "color:blue 빈 <b>"가 든 HTML 주석이 붙어 1순위 파싱이 빈값을 잡던 버그.
     실제 케이스: <b style="color:blue">2026-06-05</b><br><!--<b style="color:blue"></b>-->
     해결: 파싱 전 HTML 주석 통째 제거 + blue fragment 안 plain text 비면 skip.
     영향: AP2726 6/5·6/9 11건 등 sailDate=null 케이스 재추출 시 정상 채움.

   v2.5.1 추가 (2026-06-01):
   - [선적일 추출] cells.eq(12) 표 12번 셀에서 "실제출고요청일=선적일" 추출.
     셀 5줄(<br> 구분, 라벨 없음): 등록 / 수정 / 입고완료 / 출고등록 / 출고요청(=선적일, 시간없는 blue 날짜).
     식별: 1순위 color:blue + 시간 없는 YYYY-MM-DD / 2순위 시간 없는 마지막 날짜 / 3순위 dateLines 마지막.
     미완료(선적일 없음) → 빈값 → Orders.fields 미포함 (기존값 보존, (B) 가드 호환).
     normalizeDateInline으로 엑셀 경로(도구 line 12155)와 ISO 형식 일치.
     인보이스 도구의 메인/보관함 분기(선적일+7일 ≥ 오늘) 전제 데이터.

   v2.5 추가 (2026-05-22):
   - 콘솔 1회 실행 → 전 페이지(보통 1~3) 자동 순회. 새로고침 0회.
   - 페이지 넘김을 새로고침 대신 same-origin GET fetch로 백그라운드 조회:
       ./Acting_S.asp?<#frmSearch 직렬화>&shPageSize=100&shGo=N
       (fnPageMv 실제 코드 확인: method=get, action=./Acting_S.asp,
        페이지번호=input[name='shGo'], 폼=#frmSearch)
   - PAGE 자동 100 (shPageSize=100) → 225건이면 3페이지로 끝.
   - 전 페이지 orders를 모두 모은 뒤 "1회" 업로드 → 사서함이 페이지 경계에
     걸쳐도 사서함별 통계가 정확 (v2.3의 한 화면=1회 업로드 구조 그대로 재사용).
   - EUC-KR 방어: arrayBuffer + TextDecoder(document.characterSet)로 디코딩.
   - parseOrderRow는 진입 셀렉터만 $root.find(...)로 컨텍스트화 — 필드 추출 규칙은 불변.

   v2.3 기능 (전부 보존):
   - 다중 사서함 일괄 처리: 출고요청 탭에서 사서함 비우고 검색하면
     한 화면의 여러 사서함을 자동으로 그룹화해서 모두 업로드
   - 사서함별 Shipments 레코드 자동 생성 (사서함 키 upsert)
   - Orders는 각자 자기 사서함의 Shipment에 정확히 연결됨
   - 결과 화면에 사서함별 통계 표시
   v2.2 기능:
   - 추출 시점에 ProductHistory 자동 매칭
   - Level 1 (URL 정확 매칭): 영문명/HS/Material 자동 채움 + 관세사확정=true
   - Level 2 (한국어명 키워드 70%+): 미리 채움 + 관세사확정=false (확인 필요)
   - 추출 즉시 학습 데이터 반영
   v2.1 추가:
   - 제품 링크 (1688/Taobao URL) 추출 → Products."제품링크" 저장
   - 관세사 매칭 시스템(v2.9)의 핵심 데이터
   v2.0 추가:
   - 추출 후 Airtable에 자동 푸시
   - Shipments / Orders / Products / Suppliers 4개 테이블 자동 업데이트
   - 상품 이미지는 URL로 첨부 (Airtable 서버가 fetch)
   - PAT는 sessionStorage에 임시 저장 (탭 닫으면 삭제)
   v1.2 기능 유지 (모든 파싱 보정 포함)
   대상: alipeed.com/Admin/Acting/Acting_S.asp
   ============================================================ */
(async function(){
  'use strict';
  // ===== v2.8 (2026-06): 재질(Material) 확인 — mtr_Nm_{ordSeq}_{proSeq}(ProListMng_L.asp)에서 파싱→Products.Material. (v2.6~ 기존 동작, v2.8 명시) =====
  // ===== v2.7 (2026-06): 선적 단위 분리 — 키 {AP번호}-{선적일YYMMDD} =====
  //   실행 시작 시 선적일(YYMMDD) prompt → 그 선적분만 추출. 한 실행 = 한 선적분.
  //   Shipments.선적일(Date)·고객사서함(AP원본) 신규 필드 기록 — ★실행 전 Airtable에 두 필드 생성 필수.
  //   ★알리피드 출고완료 전환은 직원 수동 (SOP-01 잠금 1, v2.10 자동전환 사고 패턴 금지).

  var $ = window.jQuery || window.$;
  if (!$) {
    alert('이 페이지에 jQuery가 없습니다.\n알리피드 대행종합관리 페이지에서 실행해주세요.');
    return;
  }

  if (location.hostname.indexOf('alipeed') < 0) {
    if (!confirm('알리피드 페이지가 아닌 것 같습니다. 그래도 실행할까요?')) return;
  }

  // ===== 버전 단일 소스 — 기능 변경 시 헤더 버전과 함께 이 값을 올린다 =====
  var EXTRACTOR_VERSION = 'v2.9.10';   // ★파일명·헤더와 항상 일치시킬 것
  // ===== v2.9.3 선적일 = 추출 주문의 실제출고요청일에서 자동 도출 (prompt 수동입력 폐지) =====
  //   키 = {AP번호}-{선적일YYMMDD}. 선적일은 추출 완료 후 deriveShipDate()가 채운다(아래 후처리 .then).
  //   ★사람이 날짜를 타이핑하지 않음 → 날짜 오타 휴먼에러 근본 차단.
  var SHIP_DATE_ISO = '';      // 추출 후 deriveShipDate()가 설정 (closure로 pushToAirtable에서 사용)
  var SHIP_DATE_YYMMDD = '';   // 복합키 suffix — 동일
  console.log('[추출기 ' + EXTRACTOR_VERSION + '] 선적일 자동 도출 모드 — 주문 실제출고요청일에서 결정(수동 입력 없음).');

  // ===== v2.5 fetch 순회 설정 =====
  var TARGET_PAGE_SIZE = 100;   // PAGE 자동 100
  var MAX_PAGE = 50;            // 무한루프 방지 가드
  var PAGE_DELAY = 400;         // 페이지당 대기(ms) — 서버 보호

  // 현재 검색 폼(#frmSearch)의 모든 조건을 GET 쿼리로 직렬화. (fnPageMv가 제출하는 그 폼)
  var $searchForm = $('#frmSearch');
  var baseQuery = $searchForm.length ? $searchForm.serialize() : location.search.replace(/^\?/, '');

  // 지정 페이지 HTML을 same-origin GET fetch (새로고침 없음). EUC-KR 방어 디코딩.
  async function fetchPageHtml(pageNo) {
    var params = new URLSearchParams(baseQuery);
    params.set('shPageSize', String(TARGET_PAGE_SIZE));
    params.set('shGo', String(pageNo));
    var url = './Acting_S.asp?' + params.toString();
    var r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(pageNo + '페이지 로드 실패 (HTTP ' + r.status + ')');
    var buf = await r.arrayBuffer();
    var ct = r.headers.get('content-type') || '';
    var cs = (ct.match(/charset=([\w-]+)/i) || [])[1] || document.characterSet || 'utf-8';
    try { return new TextDecoder(cs).decode(buf); }
    catch (e) { return new TextDecoder('euc-kr').decode(buf); }
  }

  // 진행상황 표시
  var $progress = $('<div>').css({
    position: 'fixed', top: '20px', right: '20px', zIndex: 99999,
    background: '#0c1929', color: '#c9a449', padding: '16px 24px',
    border: '1px solid #c9a449', borderRadius: '4px',
    fontFamily: '-apple-system, sans-serif', fontSize: '13px',
    boxShadow: '0 8px 24px rgba(0,0,0,.4)', minWidth: '260px',
    letterSpacing: '0.05em'
  }).html('<div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9bb5d6;margin-bottom:6px">ALIPEED EXTRACTOR v2.5 · 콘솔 fetch순회</div><div id="alipeedProgressMsg">시작... 전 페이지 조회 준비</div>').appendTo('body');

  function setMsg(s){ $('#alipeedProgressMsg').text(s); }

  function clean(s){ return (s||'').replace(/\s+/g,' ').trim(); }
  function num(s){ return parseFloat(String(s||'').replace(/[^\d.-]/g,'')) || 0; }
  function intNum(s){ return parseInt(String(s||'').replace(/[^\d-]/g,''), 10) || 0; }

  // v2.5.1 (2026-06-01): 도구 line 11745 normalizeDate와 동일 로직 (추출기 내장, 도구 의존 X).
  //   엑셀 경로 normalizeDate(row['출고 요청일'])와 ISO 형식 일치 보장.
  function normalizeDateInline(raw) {
    if (!raw) return '';
    var s = String(raw).replace(/[^0-9]/g, '');
    if (s.length === 8) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6);
    if (s.length === 6) return '20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4);
    return String(raw).trim();
  }

  // ===== 리스트 행 파서 (v2.5: 진입 셀렉터만 $root.find로 컨텍스트화 — 페이지별 fetch HTML 파싱용) =====
  function parseOrderRow($root, seq) {
    var $cb = $root.find('input[name="chkORD_SEQ"][value="'+seq+'"]').first();
    var $row1 = $cb.closest('tr');
    var $row2 = $row1.next('tr');
    var cells = $row1.children('td');

    // [1] 주문번호 + 센터
    var ordNoCell = cells.eq(1);
    var ordNo = clean(ordNoCell.find('.black1.bold').first().text());
    // 물류센터 추출: 주문번호 다음 <br/> 뒤에 오는 한글 (예: "웨이하이")
    var center = '';
    var ordNoHtml = ordNoCell.html() || '';
    var centerHtmlMatch = ordNoHtml.match(/<br\s*\/?>\s*([가-힣]{2,}(?:\([^)]+\))?)/i);
    if (centerHtmlMatch) {
      center = centerHtmlMatch[1].replace(/&nbsp;/g, '').trim();
    } else {
      // 폴백: 텍스트 기반
      var ordNoTextClone = ordNoCell.clone();
      ordNoTextClone.find('button, span.whGraBtn, input, span.red1').remove();
      var centerTextMatch = clean(ordNoTextClone.text()).replace(ordNo, '').match(/([가-힣]{2,})/);
      if (centerTextMatch) center = centerTextMatch[1];
    }

    // [2] 주문구분 / 배송방식 / 통관 / 출고
    var ordTyCell = cells.eq(2);
    var ordTyText = clean(ordTyCell.text());
    // [v2.9.1] 대행유형 = 텍스트 매칭만(색상 ff6600 의존 폐기). cell2 전체 텍스트에서
    //   "구매대행/배송대행/결제대행" 세 단어만 화이트리스트로 선택. 합배송·단독배송·복사본·LCL·통관 등은 전부 무시.
    //   셋 다 없으면 빈값('') → orderRecords에서 대행종류 미포함(기존값 보존).
    var _agentMatch = ordTyText.match(/(구매대행|배송대행|결제대행)/);
    var ordTy = _agentMatch ? _agentMatch[1] : '';
    // [v2.9.5] ★대행종류 소스 = 물류센터 대괄호(알리피드 변경: 주문구분→물류센터). 대·소괄호 모두 대응(미래 변경 대비).
    //   raw HTML 예: `<br>웨이하이[배송대행]&nbsp;`. 매핑: [구매대행]→테일코리아 수입자 / [결제대행]·[배송대행]→실화주.
    //   ★물류센터 우선 → 구매대행 오판 차단(주문구분엔 구매대행 없고 결제/배송만이라, 주문구분만 보면 구매대행이 실화주로 오판).
    //   물류센터에 대행종류 없으면(옛 데이터) 주문구분(ordTy) 폴백 — 하위호환.
    var _centerAgentMatch = ordNoHtml.match(/[\[\(]\s*(구매대행|결제대행|배송대행)\s*[\]\)]/);
    var agentType = _centerAgentMatch ? _centerAgentMatch[1] : ordTy;
    var dlvrType = '';
    var dlvrMatch = ordTyText.match(/(LCL|FCL|항공|특송)\([^)]+\)/);
    if (dlvrMatch) dlvrType = dlvrMatch[0];
    var customsType = '';
    if (ordTyText.indexOf('사업자통관') >= 0) customsType = '사업자통관';
    else if (ordTyText.indexOf('개인통관') >= 0) customsType = '개인통관';
    // [v2.9.8] 전자상거래 트랙 자동판정 — "전자상거래" OR "항공특송" 포함(5종: 전자상거래(사업자/개인)-해운/-항공, 항공특송(사업자)).
    //   ★v2.9.7은 "전자상거래"만 → 항공특송(사업자) 놓침 → "항공특송" 추가. 부분매칭, 대행종류·통관유형과 독립축.
    //   사서함 레벨 통관트랙='전자상거래' 저장의 원천 플래그(Shipments upsert에서 OR 집계).
    var isEcommerce = ordTyText.indexOf('전자상거래') >= 0 || ordTyText.indexOf('항공특송') >= 0;
    // [v2.9.8] 운송수단 판정(전자상거래 트랙 내 항공·해상 분리 키용). 항공 우선(항공/특송/항공특송), else 해운/해상.
    //   ★현 dlvrType 정규식(LCL/FCL/항공/특송)은 "해운" 미매칭 → 별도 판정. 무역엔 미사용(전자상거래 그룹키에만).
    var shipMode = /항공|특송/.test(ordTyText) ? '항공' : (/해운|해상/.test(ordTyText) ? '해운' : '');
    // [v2.9.9] 통관유형 5종 완전 분리 — ordTyText에서 (전자상거래|항공특송)+(사업자|개인)+(해운|항공|특송) 파생.
    //   사업자/개인 = 계산방식 결정 요소. 통관구분 = 사서함 그룹키 구분자(정규화, 한글만·괄호/하이픈 제거).
    //   ★항공특송은 유형=특송이라 '항공특송사업자'로 → '전자상거래사업자항공'과 다른 키(병합 방지).
    var bizPersonal = /사업자/.test(ordTyText) ? '사업자' : (/개인/.test(ordTyText) ? '개인' : '');
    var customsBucket = '';
    if (isEcommerce) {
      if (ordTyText.indexOf('항공특송') >= 0) customsBucket = '항공특송' + bizPersonal;                 // 항공특송사업자
      else if (ordTyText.indexOf('전자상거래') >= 0) customsBucket = '전자상거래' + bizPersonal + shipMode; // 전자상거래사업자해운
    }

    // [3] 사서함, 회원명, 수취인
    var memCell = cells.eq(3);
    var saseom = clean(memCell.find('.en10').first().text()).replace('#','').trim();
    var memTooltip = memCell.find('a.easyui-tooltip').first().text().trim();
    var memCellText = memCell.clone();
    memCellText.find('input,button,span.whGraBtn,a.tipTrack,b').remove();
    var rawNames = clean(memCellText.text()).replace('#'+saseom,'').replace(saseom,'');
    var nameParts = rawNames.split('|').map(clean).filter(Boolean);
    var memberName = memTooltip || nameParts[0] || '';
    var receiver = nameParts.length > 1 ? nameParts[nameParts.length-1] : nameParts[0] || '';

    // 합배송 목록 - 행 전체에서 찾기 (cells.eq(3)에 의존하지 않음)
    // 합배송 tipTrack의 title은 "260420009,260420010,260420011," 형식
    var hapList = [];
    $row1.find('a.tipTrack').each(function(){
      if (hapList.length) return;
      var t = ($(this).attr('title') || '').replace(/\s/g, '');
      // 최소 2개 이상의 6자리 이상 숫자가 콤마로 구분된 패턴 (trailing comma 허용)
      if (/^\d{6,}(,\d{6,})+,?$/.test(t)) {
        hapList = t.split(',').map(clean).filter(function(x){ return /^\d{6,}$/.test(x); });
      }
    });

    // [5] 오더넘버 / 트래킹
    var trkCell = cells.eq(5);
    var orderNumber = '';

    // 방법 1: tipTrack title에서 추출 (트래킹 정보/합배송 목록 제외)
    trkCell.find('a.tipTrack').each(function(){
      if (orderNumber) return;
      var t = $(this).attr('title') || '';
      // 트래킹사 이름이 포함된 title은 스킵 (트래킹 상세 tooltip)
      if (/韵达|圆通|顺丰|中通|申通|快递|快运|중국내륙|宅急便|JT|YT/.test(t) && t.indexOf(':') >= 0) return;
      // 합배송 목록 패턴은 스킵
      var tStripped = t.replace(/\s/g, '');
      if (/^\d+(,\d+){2,},?$/.test(tStripped)) return;
      // 15자리 이상 숫자 매치
      var m = t.match(/(\d{15,})/);
      if (m) orderNumber = m[1];
      else {
        // 링크 자체 텍스트
        var inner = clean($(this).text());
        if (/^\d{15,}$/.test(inner)) orderNumber = inner;
      }
    });

    // 방법 2: 셀의 HTML에서 직접 O: 패턴 찾기 (HTML 엔티티 정규화 후)
    if (!orderNumber) {
      var rawHtml = (trkCell.html() || '')
        .replace(/&lt;BR&gt;/gi, ' ')
        .replace(/&lt;br&gt;/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      var oMatch = rawHtml.match(/O\s*:\s*[^\d]*?(\d{15,})/);
      if (oMatch) orderNumber = oMatch[1];
    }

    // 방법 3: 텍스트 폴백
    if (!orderNumber) {
      var oTextMatch = clean(trkCell.text()).match(/O\s*:\s*(\d{15,})/);
      if (oTextMatch) orderNumber = oTextMatch[1];
    }

    var trackingCo = '', trackingNo = '';
    var trkLink = trkCell.find('a[onclick*="fnDlvrShDirect"]').first();
    if (trkLink.length) {
      var oc = trkLink.attr('onclick') || '';
      var dm = oc.match(/fnDlvrShDirect\(['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\)/);
      if (dm) { trackingCo = dm[1]; trackingNo = dm[2]; }
    }
    // 두 번째 트래킹 (tipTrack title에서 추출 - 다양한 택배사 지원)
    var altTracking = '';
    var altCompany = '';
    trkCell.find('a.tipTrack').each(function(){
      if (altTracking) return;
      var t = $(this).attr('title') || '';
      // 트래킹 상세 tooltip 패턴: "회사명 : 운송장 : 날짜"
      // <br>로 구분된 여러 트래킹 정보 중 마지막을 선호 (보통 실제 배송 트래킹)
      var lines = t.split(/<br\s*\/?>/i).map(clean).filter(Boolean);
      for (var i = lines.length - 1; i >= 0; i--) {
        var line = lines[i];
        var m = line.match(/(韵达快运|圆通快递|顺丰|中通|申通|JT|YT|宅急便)\s*:\s*(\S+)\s*:/);
        if (m && m[2] && m[2] !== '_' && m[2].length > 3) {
          altCompany = m[1];
          altTracking = m[2];
          break;
        }
      }
    });

    // [6] 수량 / 총액CNY / 환율
    var qtyCell = cells.eq(6);
    var qtyText = clean(qtyCell.text());
    var qty = intNum((qtyText.match(/^(\d+)/)||[])[1]);
    var totalCny = num((qtyText.match(/￥([\d,.]+)/)||[])[1]);
    var rate = num((qtyText.match(/환율\s*:\s*([\d.]+)/)||[])[1]);

    // [7] 현지배송비
    var localShipCny = num((clean(cells.eq(7).text()).match(/￥([\d,.]+)/)||[])[1]);

    // [8] 결제금액KRW
    var payCell = cells.eq(8);
    var paymentText = clean(payCell.text());
    var paymentKrw = intNum((paymentText.match(/([\d,]+)\s*원/)||[])[1]);
    var paymentType = clean(payCell.find('STRONG').first().text());
    var hasVat = payCell.text().indexOf('부가세') >= 0;

    // [9] 추가결제금액
    var addPayCell = cells.eq(9);
    var addPayText = clean(addPayCell.text());
    var addPaymentKrw = intNum((addPayText.match(/([\d,]+)\s*원/)||[])[1]);

    // [10] 운송장
    var ivcNo = clean(cells.eq(10).text());

    // [11] 입고/주문상태
    var statusCell = cells.eq(11);
    var arvStatus = clean(statusCell.find('.red1.bold').first().text());
    var ordStatusEls = statusCell.find('.bold').filter(function(){
      return !$(this).hasClass('red1');
    });
    var ordStatus = clean(ordStatusEls.first().text());

    // [12] 일자들 (등록 / 수정 / 입고완료 / 출고등록 / 출고요청=선적일)
    //   알리피드 표 5줄 <br> 구분, 라벨 없음. 각 줄 색상으로 의미 구분:
    //     1줄 검정 = 등록, 2줄 red = 수정, 3줄 #337dff = 입고완료,
    //     4줄 rgb(54,213,110) = 출고등록, 5줄(마지막) blue 시간없음 = 실제출고요청일=선적일
    var dateCell = cells.eq(12);
    var dateLines = dateCell.text().split('\n').map(clean).filter(Boolean);

    // v2.5.3 (2026-06-06): 선적일 파싱 — 색상 의존 폐기, 시간 유무 기준 단순화
    //   가정: cells.eq(12) 5줄 중 "시간(HH:MM) 없이 YYYY-MM-DD 단독"인 줄이 유일하게
    //   실제출고요청일(=선적일). 나머지 4줄(등록/수정/입고완료/출고등록)은 모두 시간 포함 이벤트 시각.
    //   v2.5.1~v2.5.2의 color:blue 매칭은 알리피드 UI 색상 표기 다양성·빈 주석 등으로 실패.
    //   시간 유무는 데이터 본질(이벤트 vs 사장님 입력)에 직접 기반 → UI 변경에 무관.
    //
    //   알고리즘:
    //     1) HTML 주석 제거 (빈 주석 안 날짜 토큰이 후보에 안 들어가게).
    //     2) <br>로 fragment 분리 → tag 벗기고 plain text만 → 빈 줄 제외.
    //     3) 시간(HH:MM) 없고 + 날짜(YYYY-MM-DD) 있는 줄만 후보.
    //     4) 후보 0개 → 빈값 (선적일 미입력 = 미완료, 기존값 보존).
    //        후보 N개 → 마지막 (셀 맨 아래 = 실제출고요청일 위치).
    //   미완료 빈값 케이스 보존: fields에 안 넣음 → 기존값 그대로 ((B) 가드 호환).
    var sailDate = '';
    var cleanHtml = (dateCell.html() || '').replace(/<!--[\s\S]*?-->/g, '');
    var fragments = cleanHtml
      .split(/<br\s*\/?>/i)
      .map(function(f){ return f.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
    var DATE_ONLY = /(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/;
    var HAS_TIME  = /\d{1,2}:\d{2}/;
    var candidates = [];
    for (var fi = 0; fi < fragments.length; fi++) {
      var frag = fragments[fi];
      if (HAS_TIME.test(frag)) continue;
      var m = frag.match(DATE_ONLY);
      if (!m) continue;
      candidates.push(normalizeDateInline(m[0]));
    }
    if (candidates.length) sailDate = candidates[candidates.length - 1];

    // ===== Row 2 =====
    var attrSvc = $row2.find('input[type="text"]').eq(0).val() || '';
    var centerReq = $row2.find('input[type="text"]').eq(1).val() || '';
    var cargo = {
      카톤수: num($row2.find('#CARGO_BOX_CNT_'+seq).val()),
      무게KG: num($row2.find('#CARGO_WT_'+seq).val()),
      부피CBM: num($row2.find('#CARGO_CBM_'+seq).val()),
      가로cm: num($row2.find('#CARGO_WIDTH_'+seq).val()),
      세로cm: num($row2.find('#CARGO_VER_'+seq).val()),
      높이cm: num($row2.find('#CARGO_HEIGHT_'+seq).val())
    };
    var memo = $row2.find('#MngMemo'+seq).val() || '';
    var boxCnt = intNum($row2.find('#BoxCnt'+seq).val()) || 1;

    return {
      ord_seq: seq,
      주문번호: ordNo,
      물류센터: center,
      주문구분: agentType,   // [v2.9.5] 대행종류 소스 = 물류센터 대괄호 우선(agentType) → Orders.대행종류로 저장(orderRecords). 도구 수입자 분기 자동 파생.
      배송방식: dlvrType,
      통관: customsType,
      전자상거래: isEcommerce,   // [v2.9.7] 전자상거래 트랙 플래그 → Shipments.통관트랙='전자상거래' 사서함 OR 집계 원천.
      운송수단: shipMode,        // [v2.9.8] '항공'/'해운'/'' — 전자상거래 그룹키 분리용(무역 미사용).
      통관구분: customsBucket,   // [v2.9.9] 5종 정규화 키(전자상거래사업자해운/…/항공특송사업자) — 사서함 그룹키 구분자.
      사업자개인: bizPersonal,   // [v2.9.9] '사업자'/'개인'/'' — 계산방식 결정(필드 있으면 저장).
      사서함: saseom ? 'AP'+saseom.replace(/^AP/,'') : '',
      회원명: memberName,
      수취인: receiver,
      합배송_주문번호목록: hapList,
      오더넘버: orderNumber,
      트래킹사: trackingCo,
      트래킹번호: trackingNo,
      트래킹_보조사: altCompany,
      트래킹_보조: altTracking,
      총수량: qty,
      총액CNY: totalCny,
      현지배송비CNY: localShipCny,
      환율: rate,
      결제금액KRW: paymentKrw,
      결제구분: paymentType,
      부가세: hasVat,
      추가결제KRW: addPaymentKrw,
      운송장번호: ivcNo,
      상품입고상태: arvStatus,
      주문상태: ordStatus,
      일자: dateLines,
      실제출고요청일: sailDate,   // v2.5.1: 선적일 (cells.eq(12) 마지막 줄 blue, 빈값 가능)
      부가서비스: attrSvc,
      물류센터요청사항: centerReq,
      화물입고정보: cargo,
      관리자메모: memo,
      박스수: boxCnt,
      상품: []
    };
  }

  // ===== 상품 상세 파서 (AJAX 응답 HTML) =====
  function parseProductDetail(html, ordSeq) {
    var $d = $('<div>').html(html);
    var products = [];
    var seenSeqs = {};

    // hs_code_{ordSeq}_{proSeq} 인풋들로 상품 발견
    $d.find('input[id^="hs_code_'+ordSeq+'_"]').each(function() {
      var $hs = $(this);
      var idMatch = ($hs.attr('id') || '').match(/^hs_code_\d+_(\d+)$/);
      if (!idMatch) return;
      var proSeq = idMatch[1];
      if (seenSeqs[proSeq]) return;
      seenSeqs[proSeq] = true;

      var $row = $hs.closest('tr');
      var rowText = clean($row.text());

      // 같은 proSeq의 다른 인풋 값들
      var hsCode = $hs.val() || '';
      var ivcNm = $d.find('#ivc_Nm_'+ordSeq+'_'+proSeq).val() || '';
      var mtrNm = $d.find('#mtr_Nm_'+ordSeq+'_'+proSeq).val() || '';

      // 상품명 (통관품목) - HTML 기반으로 한글/영문 분리
      var productNameKr = '';
      var productNameEn = '';
      var productLink = '';

      // 영문명 a.bold 태그에서 href 추출 (1688/Taobao 제품 페이지 링크)
      var $boldLink = $row.find('a.bold').first();
      if ($boldLink.length > 0) {
        productLink = $boldLink.attr('href') || '';
        // 상대 URL이면 절대 URL로
        if (productLink && !/^https?:\/\//.test(productLink)) {
          var a = document.createElement('a');
          a.href = productLink;
          productLink = a.href;
        }
      }

      $row.find('td').each(function(idx){
        if (productNameKr || productNameEn) return false;
        var $td = $(this);
        // 이미지/입력/버튼/링크 셀 스킵
        if ($td.find('img, input, button, a[onclick]').length > 0) return;
        var html = $td.html() || '';
        if (!html || html.length > 500) return;
        var text = clean($td.text());
        if (!text || text.length > 200 || text.length < 3) return;
        // 한글 + (영문 또는 <br>) 둘 다 있어야 통관품명 셀로 간주
        var hasKr = /[가-힣]/.test(text);
        var hasEn = /[a-zA-Z]/.test(text);
        var hasBr = /<br\s*\/?>/i.test(html);
        if (!hasKr || (!hasEn && !hasBr)) return;
        // 금액 패턴이 있는 셀은 스킵
        if (/[¥￥₩￦]|=\s*[\d,.]+/.test(text)) return;

        // <br>로 분리
        var parts = html.split(/<br\s*\/?>/i).map(function(p){
          // HTML 태그 제거 후 텍스트만
          var $tmp = $('<div>').html(p);
          return clean($tmp.text());
        }).filter(Boolean);

        // 한글 라인 / 영문 라인 분류
        parts.forEach(function(p){
          if (!p) return;
          if (/[가-힣]/.test(p) && !productNameKr) {
            productNameKr = p;
          } else if (/^[\x20-\x7E]+$/.test(p) && /[a-zA-Z]/.test(p) && !productNameEn) {
            // 순수 ASCII + 영문자 포함
            productNameEn = p;
          }
        });
      });

      // 단가/수량/합계 추출 (위안화 / 한화 칼럼)
      var priceCny = 0, qty = 0, totalCny = 0;
      var priceKrw = 0, totalKrw = 0;
      var localShipCny = 0, commissionCny = 0;
      var localShipKrw = 0, commissionKrw = 0;

      $row.find('td').each(function(){
        var t = clean($(this).text());
        // 위안화 패턴: "9.41 * 1 = ¥9.41" + "¥0.00 * ¥4.00"
        var cnyMatch = t.match(/([\d,.]+)\s*\*\s*([\d,]+)\s*=\s*￥([\d,.]+)/);
        if (cnyMatch && !priceCny) {
          priceCny = num(cnyMatch[1]);
          qty = intNum(cnyMatch[2]);
          totalCny = num(cnyMatch[3]);
          // 추가 ￥값 (현지배송비 * 수수료)
          var extraCny = t.match(/￥([\d,.]+)\s*\*\s*￥([\d,.]+)/);
          if (extraCny) {
            localShipCny = num(extraCny[1]);
            commissionCny = num(extraCny[2]);
          }
        }
        // 한화 패턴: "2,070.20 * 1 = ₩2,070.20" 또는 "￦2,070.20" 또는 "W2,070.20"
        var krwMatch = t.match(/([\d,.]+)\s*\*\s*[\d,]+\s*=\s*[₩￦W]([\d,.]+)/);
        if (krwMatch && !priceKrw) {
          priceKrw = num(krwMatch[1]);
          totalKrw = num(krwMatch[2]);
          var extraKrw = t.match(/[₩￦W]([\d,.]+)\s*\*\s*[₩￦W]([\d,.]+)/);
          if (extraKrw) {
            localShipKrw = num(extraKrw[1]);
            commissionKrw = num(extraKrw[2]);
          }
        }
      });

      // v2.5 (포팅 from v2.10, 2026-06-01): 구매수수료CNY/KRW 폴백
      //   v2.9 검증에서 발견: Products.구매수수료CNY 합 2.60 — 거의 다 0 저장됨.
      //   원인 가설: HTML 구조 변경으로 "현지배송비 * 수수료" 셀이 단가 셀과 분리됐을 가능성.
      //   보강: 단가 td에서 못 잡힌 경우만 row 전체 텍스트에서 한 번 더 시도.
      //   안전책: 추출 값이 합계(totalCny)보다 약간 큰 범위(<+100)일 때만 채택 — 잘못 잡기 방지.
      //   ※ v2.10의 [자동 상태전환]·[ensureSchema]는 가져오지 않음 (현 워크플로우 호환성/스키마 안정).
      if (priceCny > 0 && commissionCny === 0) {
        var rowText = clean($row.text());
        var rowExtra = rowText.match(/￥([\d,.]+)\s*\*\s*￥([\d,.]+)/);
        if (rowExtra) {
          var ls = num(rowExtra[1]);
          var cm = num(rowExtra[2]);
          if (ls < totalCny + 100 && cm < totalCny + 100) {
            localShipCny = ls;
            commissionCny = cm;
          }
        }
      }
      if (priceKrw > 0 && commissionKrw === 0) {
        var rowTextKrw = clean($row.text());
        var rowExtraKrw = rowTextKrw.match(/[₩￦W]([\d,.]+)\s*\*\s*[₩￦W]([\d,.]+)/);
        if (rowExtraKrw) {
          var lsk = num(rowExtraKrw[1]);
          var cmk = num(rowExtraKrw[2]);
          if (lsk < totalKrw + 1000 && cmk < totalKrw + 1000) {
            localShipKrw = lsk;
            commissionKrw = cmk;
          }
        }
      }

      // 색상/사이즈 - 中文 색상 한자 필수 + 트래킹 패턴 제외
      var colorSize = '';
      $row.find('td').each(function(){
        if (colorSize) return false;
        var $td = $(this);
        if ($td.find('img, input, button').length > 0) return;
        var t = clean($td.text());
        if (!t || t.length > 100) return;
        // 스킵 패턴: 트래킹사명, 실사보기, 금액
        if (/韵达|圆通|顺丰|中通|申通|快递|快运|실사보기|중국내륙|宅急便|JT3\d{10,}|YT\d{10,}/.test(t)) return;
        if (/[¥￥₩￦]/.test(t)) return;
        if (/^\d+$/.test(t)) return; // 순수 숫자 스킵
        if (/^=\s*상태/.test(t)) return; // 상태변경 셀 스킵
        // 색상 한자 매치 (色 또는 일반적인 사이즈 표기)
        if (/色/.test(t)) {
          colorSize = t;
        }
      });

      // 묶음번호 / 수수료율 (보통 "55233 4.00¥" 형태)
      var bundleNo = '', feeRate = '';
      $row.find('td').each(function(){
        var t = clean($(this).text());
        var bm = t.match(/^(\d{5,})\s+([\d.]+)\s*[¥￥]/);
        if (bm && !bundleNo) {
          bundleNo = bm[1];
          feeRate = bm[2];
        }
      });

      // ===== 이미지 추출 (v1.1) =====
      var images = [];
      $row.find('img').each(function() {
        var src = $(this).attr('src') || $(this).attr('data-src') || $(this).attr('data-original') || '';
        if (!src) return;
        // 알리피드 UI 아이콘/스페이서 제외
        if (/spacer|placeholder|loading|blank|1x1|\.gif$/i.test(src)) return;
        if (/\/image\/Ext\/|\/Image\/Common\//i.test(src)) return;
        // 너무 작은 아이콘 제외 (16x16 등)
        var w = parseInt($(this).attr('width') || $(this).css('width') || '0', 10);
        if (w > 0 && w < 30) return;
        // 절대 URL로 변환
        var absUrl = src;
        if (!/^https?:\/\//.test(src)) {
          var a = document.createElement('a');
          a.href = src;
          absUrl = a.href;
        }
        images.push({ url: absUrl, base64: null });
      });

      products.push({
        pro_seq: proSeq,
        묶음번호: bundleNo,
        수수료율CNY: num(feeRate),
        통관품명_한글: productNameKr,
        통관품명_영문: productNameEn,
        제품링크: productLink,
        hs_code: hsCode,
        invoice_description: ivcNm,
        material: mtrNm,
        색상사이즈: colorSize,
        단가CNY: priceCny,
        수량: qty,
        합계CNY: totalCny,
        현지배송비CNY: localShipCny,
        구매수수료CNY: commissionCny,
        단가KRW: priceKrw,
        합계KRW: totalKrw,
        현지배송비KRW: localShipKrw,
        구매수수료KRW: commissionKrw,
        이미지: images
      });
    });

    if (!products.length) {
      // fallback: 상세 HTML이 비어있거나 파싱 실패
      var rawText = clean($d.text()).substring(0, 300);
      products.push({
        _warning: '상품 정보를 찾지 못했습니다. AJAX 응답 확인 필요.',
        _raw_preview: rawText,
        _html_length: html.length
      });
    }

    return products;
  }

  // ===== 메인 실행 =====
  // ── 1단계 (v2.5): PAGE=100 + shGo 순회로 전 페이지를 fetch → orders 누적 (새로고침 0회) ──
  var orders = [];
  var pageInfo = [];   // [{page, count}]
  try {
    for (var p = 1; p <= MAX_PAGE; p++) {
      setMsg('1단계: ' + p + '페이지 받는 중... (누적 ' + orders.length + '건)');
      var pageHtml = await fetchPageHtml(p);
      var $root = $('<div>').html(pageHtml);
      var pageSeqs = $root.find('input[name="chkORD_SEQ"]').map(function(){ return $(this).val(); }).get();
      if (!pageSeqs.length) break;   // 더 이상 주문 없음 → 끝
      pageSeqs.forEach(function(seq){ orders.push(parseOrderRow($root, seq)); });
      pageInfo.push({ page: p, count: pageSeqs.length });
      console.log('[알리피드 v2.5] ' + p + '페이지: ' + pageSeqs.length + '건 (누적 ' + orders.length + ')');
      setMsg('1단계: ' + p + '페이지 ' + pageSeqs.length + '건 (누적 ' + orders.length + ')');
      await new Promise(function(r){ setTimeout(r, PAGE_DELAY); });   // 서버 보호
      if (pageSeqs.length < TARGET_PAGE_SIZE) break;   // 100건 미만 = 마지막 페이지
    }
  } catch(e) {
    $progress.css('background','#3a1010').css('border-color','#c33').css('color','#ffaaaa');
    setMsg('페이지 순회 오류: ' + e.message + ' (' + orders.length + '건까지 받음)');
    setTimeout(function(){ $progress.remove(); }, 10000);
    console.error('[알리피드 v2.5] 순회 중단:', e);
    return;
  }

  if (!orders.length) {
    $progress.css('background','#3a1010').css('border-color','#c33').css('color','#ffaaaa');
    setMsg('주문이 없습니다. 사서함번호로 검색했는지 확인하세요.');
    setTimeout(function(){ $progress.remove(); }, 6000);
    return;
  }
  console.log('[알리피드 v2.5] 전 페이지 수집 완료: ' + pageInfo.length + '페이지 / ' + orders.length + '건');

  setMsg('2단계: 상품 상세 로드 시작... (' + pageInfo.length + '페이지 / ' + orders.length + '건)');
  var done = 0;
  var detailPromises = orders.map(function(o) {
    return $.ajax({
      url: '/Library/Html/Acting/ProListMng_L.asp',
      data: { sViewYN: 'Y', sOrdSeq: o.ord_seq, shType: '', shValue: '' },
      method: 'GET',
      dataType: 'html',
      cache: false
    }).then(function(html) {
      o.상품 = parseProductDetail(html, o.ord_seq);
    }).fail(function(xhr) {
      o.상품 = [{ _error: '상세 로드 실패: HTTP ' + xhr.status }];
    }).always(function(){
      done++;
      setMsg('상품 상세 로드: ' + done + '/' + orders.length);
    });
  });

  // ===== Phase 3 (v1.1): 이미지 fetch + base64 변환 =====
  function fetchImageAsBase64(url) {
    return fetch(url, { credentials: 'include' })
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.blob();
      })
      .then(function(blob) {
        // 너무 큰 이미지 (2MB 초과) 는 스킵
        if (blob.size > 2 * 1024 * 1024) {
          throw new Error('이미지 너무 큼 (' + Math.round(blob.size/1024) + 'KB)');
        }
        return new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onloadend = function() { resolve(reader.result); };
          reader.onerror = function() { reject(new Error('FileReader 실패')); };
          reader.readAsDataURL(blob);
        });
      });
  }

  function fetchAllImages(orders, onProgress) {
    var allImages = [];
    orders.forEach(function(o) {
      (o.상품 || []).forEach(function(p) {
        (p.이미지 || []).forEach(function(img) {
          allImages.push(img);
        });
      });
    });

    var total = allImages.length;
    if (!total) return Promise.resolve({ total: 0, ok: 0, fail: 0 });

    var done = 0, ok = 0, fail = 0;
    var concurrency = 4;
    var queue = allImages.slice();

    return new Promise(function(resolve) {
      function worker() {
        if (!queue.length) {
          if (done === total) resolve({ total: total, ok: ok, fail: fail });
          return;
        }
        var img = queue.shift();
        fetchImageAsBase64(img.url).then(function(b64) {
          img.base64 = b64;
          ok++;
        }).catch(function(e) {
          img.base64 = null;
          img.error = String(e.message || e);
          fail++;
        }).then(function() {
          done++;
          if (onProgress) onProgress(done, total);
          worker();
        });
      }
      for (var i = 0; i < Math.min(concurrency, total); i++) worker();
    });
  }

  // [v2.6] 도착지 자동추출 — 주문별 수취인정보 팝업(OrdDeli_A.asp?sOrdSeq) 순차 fetch. utf-8(디코딩 변환 불필요).
  //   ord_seq = chkORD_SEQ값 = sOrdSeq(검증: 260604006→88057). 기존 추출 로직 무관 — 필드만 추가.
  async function fetchDeliveryInfo(orders) {
    var DELAY = 250;   // 주문당 대기(ms) — 과호출 방지(fetch순회 패턴)
    var done = 0;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      try {
        var resp = await fetch('/Admin/Acting/OrdDeli_A.asp?sOrdSeq=' + o.ord_seq, { credentials: 'include' });
        var html = await resp.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var rows = doc.querySelectorAll('table.board_list tr');
        rows.forEach(function(tr) {
          var cells = tr.querySelectorAll('th, td');
          if (cells.length < 2) return;
          var label = (cells[0].textContent || '').replace(/\u00A0/g, ' ').trim();
          var value = (cells[1].textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
          if (label === '수취인주소' && value) o.수취인주소 = value;
          else if (label === '연락처' && value) o.연락처 = value;
          else if (label === '배송요청사항' && value) o.배송요청사항 = value;
          else if (label === '배송방법' && value) o.배송방법 = value;
        });
      } catch (e) {
        // 주소 파싱 실패 → 해당 주문 주소만 미설정, 다른 필드 영향 0
        console.warn('[v2.6 도착지] sOrdSeq=' + o.ord_seq + ' 실패:', e.message);
      }
      done++;
      setMsg('도착지 추출: ' + done + '/' + orders.length);
      await new Promise(function(r){ setTimeout(r, DELAY); });
    }
  }

  Promise.all(detailPromises).then(function() {
    return fetchDeliveryInfo(orders);   // [v2.6] 도착지/연락처/배송요청 순차 추출 (이미지 단계 전)
  }).then(function() {
    // ===== Phase 3 시작 =====
    var totalImgs = orders.reduce(function(s,o){
      return s + (o.상품 || []).reduce(function(s2,p){ return s2 + (p.이미지||[]).length; }, 0);
    }, 0);

    if (totalImgs === 0) {
      setMsg('이미지 없음. 결과 창 여는 중...');
      return { total: 0, ok: 0, fail: 0 };
    }

    setMsg('3단계: 이미지 ' + totalImgs + '장 다운로드 중...');
    return fetchAllImages(orders, function(d, t) {
      setMsg('이미지: ' + d + '/' + t);
    });
  }).then(function(imgStats) {
    setMsg('완료. 결과 창 여는 중...');

    // v2.3: 사서함별로 그룹화
    var fallbackSaseom = 'AP' + ($('#shPost').val() || '?');
    var ordersBySaseom = {};
    orders.forEach(function(o) {
      var ap = o.사서함 || fallbackSaseom;
      // [v2.9.9] 전자상거래는 AP+통관구분(5종)으로 완전 분리 그룹핑(사업자/개인·해운/항공·특송 각각 별도 Shipment).
      //   무역은 AP만(현행 무변경, 키 바이트 동일). 그룹키 접미(-전자상거래사업자해운 등)는 shipmentRecords에서 rawAP·복합키로 분해.
      //   키 끝은 -YYMMDD 유지(base 복원 안전). ★항공특송사업자 ≠ 전자상거래사업자항공 → 다른 키(병합 방지).
      var s = (o.전자상거래 && o.통관구분) ? (ap + '-' + o.통관구분) : ap;
      if (!ordersBySaseom[s]) ordersBySaseom[s] = [];
      ordersBySaseom[s].push(o);
    });
    var saseomList = Object.keys(ordersBySaseom).sort();

    // [v2.9.3] ★선적일 자동 도출 — 추출 주문의 실제출고요청일에서 결정 (prompt 수동입력 폐지, 휴먼에러 근본 차단).
    //   SHIP_DATE_ISO / SHIP_DATE_YYMMDD(상위 스코프 closure)를 여기서 설정 → pushToAirtable가 사용.
    (function deriveShipDate(){
      var withDate = orders.filter(function(o){ return o && o.실제출고요청일; });
      var empties = orders.length - withDate.length;
      // 빈 날짜 처리: 과반이면 차단, 소수면 경고+제외(도출 미반영, 저장은 빈값 유지)
      if (empties > 0) {
        var emptyList = orders.filter(function(o){ return !(o && o.실제출고요청일); }).map(function(o){ return o.주문번호 || '?'; });
        if (empties > orders.length / 2) {
          alert('⛔ 선적일(실제출고요청일) 빈 주문이 과반입니다 (' + empties + '/' + orders.length + ').\n예: ' + emptyList.slice(0,8).join(', ') + (emptyList.length>8?(' 외 '+(emptyList.length-8)+'건'):'') + '\n\n출고요청(선적일) 확정 후 다시 추출하세요. 중단합니다.');
          throw new Error('[v2.9.3] 선적일 빈값 과반 — 중단 (' + empties + '/' + orders.length + ')');
        }
        console.warn('[v2.9.3] 선적일 빈 주문 ' + empties + '건 — 도출에서 제외(저장 시 실제출고요청일 빈값 유지):', emptyList);
      }
      if (!withDate.length) { alert('⛔ 실제출고요청일이 있는 주문이 없습니다 — 선적일 도출 불가. 중단합니다.'); throw new Error('[v2.9.3] 선적일 도출 불가(전부 빈값)'); }
      // 날짜 분포 집계
      var dist = {};
      withDate.forEach(function(o){ var d = String(o.실제출고요청일).slice(0,10); dist[d] = (dist[d]||0)+1; });
      var dates = Object.keys(dist).sort();
      // 여러 날짜 섞임 → 차단
      if (dates.length > 1) {
        var dstr = dates.map(function(d){ return '  ' + d + ': ' + dist[d] + '건'; }).join('\n');
        alert('⛔ 추출 주문에 선적일(실제출고요청일)이 여러 날짜로 섞여 있습니다 — 한 선적분이 아닙니다.\n\n' + dstr + '\n\n알리피드 검색을 한 날짜로 좁힌 뒤 날짜별로 1회씩 분리 추출하세요. 중단합니다.');
        throw new Error('[v2.9.3] 선적일 혼재 — 중단: ' + dates.join(', '));
      }
      // 단일 날짜 확정
      var iso = dates[0];                          // YYYY-MM-DD
      var yymmdd = iso.slice(2).replace(/-/g, ''); // YYMMDD
      // [참고] 검색필터 날짜 교차확인 — #frmSearch 값에서 날짜 패턴 탐지, 다르면 경고문만 추가(차단 X)
      var filterNote = '';
      try {
        var fdates = [];
        $('#frmSearch').serializeArray().forEach(function(x){
          var v = String(x.value || '');
          var m1 = v.match(/20\d{2}-\d{2}-\d{2}/);
          var m2 = v.match(/^20\d{6}$/);
          if (m1) fdates.push(m1[0]);
          else if (m2) fdates.push(m2[0].slice(0,4) + '-' + m2[0].slice(4,6) + '-' + m2[0].slice(6,8));
        });
        var fdSet = Array.from(new Set(fdates));
        if (fdSet.length && fdSet.indexOf(iso) === -1) filterNote = '\n⚠ 검색필터 날짜(' + fdSet.join(', ') + ')와 추출 선적일(' + iso + ')이 다릅니다 — 참고.';
      } catch (e) { /* 필터 날짜 없음/구조 다름 → 교차확인 스킵 */ }
      // 확정 확인 (수동 입력 아님 — 확인만)
      var emptyTag = empties > 0 ? ('\n(선적일 빈 주문 ' + empties + '건은 도출 제외)') : '';
      if (!confirm('[추출기 ' + EXTRACTOR_VERSION + '] 선적일 자동 도출\n\n선적일 = ' + iso + ' (주문 ' + dist[iso] + '건 전부 동일)' + emptyTag + filterNote + '\n\n이 선적일로 Shipment를 만들고 진행할까요?')) {
        alert('중단됨 — 선적일 확인에서 취소.'); throw new Error('[v2.9.3] 선적일 확인 취소');
      }
      SHIP_DATE_ISO = iso;
      SHIP_DATE_YYMMDD = yymmdd;
      console.log('[v2.9.3] 선적일 자동 확정: ' + SHIP_DATE_ISO + ' (suffix ' + SHIP_DATE_YYMMDD + ')');
    })();

    // v2.3: 사서함별 통계 계산 (결과 화면 + Shipment 메모용)
    var statsBySaseom = {};
    saseomList.forEach(function(s) {
      var arr = ordersBySaseom[s];
      statsBySaseom[s] = {
        주문수: arr.length,
        상품수: arr.reduce(function(sum, o){ return sum + (o.상품 || []).length; }, 0),
        총수량: arr.reduce(function(sum, o){ return sum + (o.총수량 || 0); }, 0),
        총액CNY: Math.round(arr.reduce(function(sum, o){ return sum + (o.총액CNY || 0) + (o.현지배송비CNY || 0); }, 0) * 100) / 100,
        결제금액KRW: arr.reduce(function(sum, o){ return sum + (o.결제금액KRW || 0) + (o.추가결제KRW || 0); }, 0),
        무게KG: Math.round(arr.reduce(function(sum, o){ return sum + ((o.화물입고정보||{}).무게KG || 0); }, 0) * 100) / 100,
        부피CBM: Math.round(arr.reduce(function(sum, o){ return sum + ((o.화물입고정보||{}).부피CBM || 0); }, 0) * 1000) / 1000,
        환율: (arr[0] || {}).환율 || 0,
        전자상거래: arr.some(function(o){ return o.전자상거래; }),   // [v2.9.7] OR 집계 — 사서함 주문 중 하나라도 전자상거래면 사서함=전자상거래(안전측).
        사업자개인: (arr.filter(function(o){ return o.전자상거래 && o.사업자개인; })[0] || {}).사업자개인 || ''   // [v2.9.10] 전자상거래 그룹은 통관구분(사업자/개인 포함)으로 분리 → 동일값. 첫 전자상거래 주문값 채택.
      };
    });

    // 전체 합계 (모든 사서함 통합)
    var totalQty = orders.reduce(function(s,o){ return s + (o.총수량 || 0); }, 0);
    var totalProducts = orders.reduce(function(s,o){ return s + (o.상품 || []).length; }, 0);
    var totalPaymentKrw = orders.reduce(function(s,o){ return s + (o.결제금액KRW || 0) + (o.추가결제KRW || 0); }, 0);
    var totalCny = orders.reduce(function(s,o){ return s + (o.총액CNY || 0) + (o.현지배송비CNY || 0); }, 0);
    var totalCbm = orders.reduce(function(s,o){ return s + ((o.화물입고정보||{}).부피CBM || 0); }, 0);
    var totalKg = orders.reduce(function(s,o){ return s + ((o.화물입고정보||{}).무게KG || 0); }, 0);

    // 파일명/타이틀용 대표 사서함 (1개면 그것, 여러 개면 "다중")
    var saseom = saseomList.length === 1 ? saseomList[0] : ('다중_' + saseomList.length + '개');

    var result = {
      meta: {
        사서함_대표: saseom,
        사서함목록: saseomList,
        사서함수: saseomList.length,
        사서함별통계: statsBySaseom,
        수집일시: new Date().toISOString(),
        URL: location.href,
        주문수: orders.length,
        총상품수: totalProducts,
        총수량: totalQty,
        총액CNY: Math.round(totalCny * 100) / 100,
        총결제금액KRW: totalPaymentKrw,
        총무게KG: Math.round(totalKg * 100) / 100,
        총부피CBM: Math.round(totalCbm * 1000) / 1000,
        이미지_전체: (imgStats || {}).total || 0,
        이미지_변환성공: (imgStats || {}).ok || 0,
        이미지_실패: (imgStats || {}).fail || 0
      },
      주문: orders
    };

    var json = JSON.stringify(result, null, 2);

    // ========== Phase 4 (v2): Airtable 자동 푸시 ==========
    var AT_BASE_ID = 'appGdGsw2NmQqgE95';
    var AT_TABLES = {
      Shipments: 'tbl57cGPE8M67XFXE',
      Suppliers: 'tbl5PW2rZJJgdUuy9',
      Orders: 'tblGykcNaMArMQTCE',
      Products: 'tblwvS4CJgQsDmt1O',
      HSMapping: 'tblKGJE2B7HKP3NiO',
      ProductHistory: ''  // 런타임에 발견
    };

    function getOrPromptPAT() {
      var pat = sessionStorage.getItem('alipeed_airtable_pat');
      if (pat && pat.indexOf('pat') === 0) return pat;
      pat = prompt('Airtable Personal Access Token을 입력하세요\n(pat... 형식, sessionStorage에 저장됨, 탭 닫으면 삭제):');
      if (!pat || pat.indexOf('pat') !== 0) {
        alert('유효한 PAT가 아닙니다. Airtable 푸시 스킵.');
        return null;
      }
      sessionStorage.setItem('alipeed_airtable_pat', pat.trim());
      return pat.trim();
    }

    function atApiCall(pat, method, path, body) {
      return fetch('https://api.airtable.com/v0' + path, {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + pat,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      }).then(function(r) {
        if (!r.ok) {
          return r.text().then(function(t) {
            throw new Error('Airtable ' + r.status + ': ' + t.substring(0, 200));
          });
        }
        return r.json();
      });
    }

    function atSleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

    // Upsert: fieldsToMergeOn 기준으로 있으면 update, 없으면 create
    function atUpsert(pat, tableId, records, mergeOnFields, typecast) {
      var body = {
        performUpsert: { fieldsToMergeOn: mergeOnFields },
        records: records
      };
      if (typecast) body.typecast = true;
      return atApiCall(pat, 'PATCH', '/' + AT_BASE_ID + '/' + tableId, body);
    }

    // v2.5+ (B) 가드: 키 값 배열로 기존 레코드 존재 여부 조회 → 다운그레이드 금지용.
    //   tableId/fieldName/values → { value: existingFieldsObj } 맵 반환.
    //   값 없는 항목은 맵에 없음(=신규).
    //   extraFields (옵션): 키 외에 추가로 가져올 필드(예: '주문상태'). 동결 가드 판정용.
    function atFetchExistingByKey(pat, tableId, fieldName, values, extraFields) {
      var out = {};
      var unique = Array.from(new Set((values || []).filter(function(v){ return v != null && v !== ''; })));
      if (!unique.length) return Promise.resolve(out);
      // 50개씩 OR 필터로 batch (filterByFormula 길이 한도 대비)
      var chunks = [];
      for (var i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
      function escVal(v){ return String(v).replace(/"/g, '\\"'); }
      return chunks.reduce(function(chain, chunk) {
        return chain.then(function() {
          var formula = 'OR(' + chunk.map(function(v){ return '{' + fieldName + '}="' + escVal(v) + '"'; }).join(',') + ')';
          var url = 'https://api.airtable.com/v0/' + AT_BASE_ID + '/' + tableId
            + '?pageSize=100&filterByFormula=' + encodeURIComponent(formula);
          // fields 한정으로 응답 가볍게 (mergeOn 키 + extraFields)
          url += '&fields%5B%5D=' + encodeURIComponent(fieldName);
          (extraFields || []).forEach(function(f) {
            url += '&fields%5B%5D=' + encodeURIComponent(f);
          });
          return fetch(url, { headers: { 'Authorization': 'Bearer ' + pat } })
            .then(function(r) { return r.ok ? r.json() : { records: [] }; })
            .then(function(data) {
              (data.records || []).forEach(function(rec) {
                var k = rec.fields[fieldName];
                if (k != null) out[k] = rec.fields;
              });
            });
        });
      }, Promise.resolve()).then(function() { return out; });
    }

    // v3.2.39 #3 동결 가드 — 출고요청 이후 단계 = 스킵.
    //   Orders.주문상태 ∈ {'출고요청', '', undefined} → 갱신 OK (백필 가능)
    //   그 외 ('배송중', '완료' 등) → 그 주문 + 소속 상품 upsert 배치에서 제외.
    function isOrderStatusFrozen(existingFields) {
      if (!existingFields) return false;   // 신규 → 동결 X
      var st = String(existingFields['주문상태'] || '').trim();
      return st !== '' && st !== '출고요청';
    }

    // 관리자메모에서 한자 공급사명 추출 (예: "piao  骄华电子科技   14,751" → "骄华电子科技")
    function extractSupplierName(memo) {
      if (!memo) return '';
      // "piao" / "hua" 같은 직원명 단어 제거 후 첫 한자 단어 추출
      var cleaned = memo.replace(/\b(piao|hua|lia|jin)\b/gi, '').trim();
      var m = cleaned.match(/([\u4e00-\u9fff][\u4e00-\u9fff\w]{1,30})/);
      return m ? m[1].trim() : '';
    }

    function pushToAirtable() {
      // [v2.9.3] 가드 A(입력↔원본 대조) 제거 — 선적일을 원본 실제출고요청일에서 자동 도출(deriveShipDate)하므로
      //   입력=원본이 구조적으로 보장됨 → 대조 불필요. (혼재/빈값 차단은 deriveShipDate가 이미 처리.)
      var pat = getOrPromptPAT();
      if (!pat) return Promise.resolve({ pushed: false });

      var stats = { shipment: 0, orders: 0, products: 0, suppliers: 0, errors: [] };

      setMsg('Airtable: Shipment ' + saseomList.length + '개 업로드 중...');

      // ── 1) Shipments upsert (v2.3: 사서함별로 1개씩) ──
      // v2.5 (B) 가드: 기존 사서함은 도구 워크플로우 단계(Shipments.상태) + 출고요청일을 보존.
      //   재추출이 "관세사확정완료/통관중/배송중" 등을 '출고요청'으로 다운그레이드하던 #3 버그 차단.
      var today = new Date().toISOString().slice(0, 10);
      var compositeList = saseomList.map(function(s){ return s + '-' + SHIP_DATE_YYMMDD; });   // v2.7 복합키
      return atFetchExistingByKey(pat, AT_TABLES.Shipments, '사서함', compositeList)
       .then(function(existingShipMap) {
        var shipmentRecords = saseomList.map(function(s) {
          var st = statsBySaseom[s];
          // [v2.9.8] 복합키 = s + '-' + YYMMDD (끝 -YYMMDD 유지 → base 복원 replace(/-\d{6}$/) 정상).
          //   전자상거래 그룹키 s='AP2197-전자상거래사업자해운' → 복합키 'AP2197-전자상거래사업자해운-260715'. 무역 s='AP2197' → 'AP2197-260715'(무변경).
          var compositeKey = s + '-' + SHIP_DATE_YYMMDD;   // v2.7 {AP번호}-{선적일YYMMDD}
          // [v2.9.9] 고객사서함 = 원본 AP(통관구분 접미 제거) — base 복원 폴백이 s를 파싱하지 않도록 원본 AP를 우선 저장.
          //   접미 = -전자상거래…/-항공특송… (한글) → AP('AP'+숫자)엔 없어 오매칭 없음. 무역 s는 접미 없어 rawAP=s(무변경).
          var rawAP = s.replace(/-(전자상거래|항공특송)[가-힣]*$/, '');
          var fields = {
            '사서함': compositeKey,
            '선적일': SHIP_DATE_ISO,        // v2.7 키 suffix 원천 (Date)
            '고객사서함': rawAP,            // v2.7 AP원본 (Customers 자동채움 키) — [v2.9.8] 운송수단 접미 제외 원본 AP
            '환율CNY_KRW': st.환율,
            '알리피드URL': result.meta.URL,
            '메모': '주문 ' + st.주문수 + '건 / 상품 ' + st.상품수 + '개 / 무게 ' + st.무게KG + 'KG / 부피 ' + st.부피CBM + 'CBM'
          };
          // [v2.9.7] 전자상거래 트랙 자동태그 — 사서함에 전자상거래 주문 하나라도 있으면 통관트랙='전자상거래'.
          //   ecommerce-tool 자체추출(line 16343)과 값 정확 일치(문자열 동일). 무역 건은 키 미포함=빈값 유지(회귀0).
          //   Products 아닌 Shipments 스키마 필드 '통관트랙'(singleSelect) — typecast:true로 옵션 자동수용(§2.5 422 방지).
          if (st.전자상거래) fields['통관트랙'] = '전자상거래';
          // [v2.9.10] 사업자개인 저장 — 전자상거래 계산방식 결정 요소. Shipments.사업자개인(Single select, 옵션 사업자/개인).
          //   전자상거래 건 + 값 있을 때만(무역은 미포함=빈값 유지, 회귀0). typecast:true로 옵션 자동수용(§2.5 422 방지).
          if (st.전자상거래 && st.사업자개인) fields['사업자개인'] = st.사업자개인;
          // (B) 가드: 신규 선적건(복합키)에만 워크플로우 초기값. 기존은 보존(상태·출고요청일 다운그레이드 차단).
          if (!existingShipMap[compositeKey]) {
            fields['출고요청일'] = today;
            fields['상태'] = '출고요청';
          }
          return { fields: fields };
        });

        // 배치 처리 (Airtable batch limit = 10)
        var shipBatches = [];
        for (var si = 0; si < shipmentRecords.length; si += 10) {
          shipBatches.push(shipmentRecords.slice(si, si + 10));
        }

        var allShipmentResults = [];
        var shipChain = Promise.resolve();
        shipBatches.forEach(function(batch) {
          shipChain = shipChain.then(function() {
            return atUpsert(pat, AT_TABLES.Shipments, batch, ['사서함'], true)
              .then(function(r) {
                allShipmentResults = allShipmentResults.concat(r.records);
              })
              .then(function() { return atSleep(250); });
          });
        });

        return shipChain
        .then(function() {
          stats.shipment = allShipmentResults.length;
          // 사서함 → shipmentId 매핑 (Orders에서 쓸 것)
          var shipIdBySaseom = {};
          allShipmentResults.forEach(function(r) {
            // v2.7: Shipment명=복합키. Orders는 base saseom으로 링크 → suffix 제거해 매핑.
            var baseS = String(r.fields['사서함'] || '').replace(/-\d{6}$/, '');
            shipIdBySaseom[baseS] = r.id;
          });

          // ── 2) Suppliers 추출 + upsert ──
          var supplierMap = {}; // 한자명 → true
          orders.forEach(function(o) {
            var name = extractSupplierName(o.관리자메모);
            if (name) supplierMap[name] = true;
          });
          var supplierNames = Object.keys(supplierMap);

          setMsg('Airtable: 공급사 ' + supplierNames.length + '개 업로드 중...');

          var supplierRecords = supplierNames.map(function(name) {
            return { fields: { '한자명': name } };
          });

          if (!supplierRecords.length) return { shipIdBySaseom: shipIdBySaseom, supplierIdByName: {} };

          // Airtable batch limit = 10
          var supplierBatches = [];
          for (var i = 0; i < supplierRecords.length; i += 10) {
            supplierBatches.push(supplierRecords.slice(i, i + 10));
          }

          var allSupplierResults = [];
          var supplierChain = Promise.resolve();
          supplierBatches.forEach(function(batch) {
            supplierChain = supplierChain.then(function() {
              return atUpsert(pat, AT_TABLES.Suppliers, batch, ['한자명'], true)
                .then(function(r) {
                  allSupplierResults = allSupplierResults.concat(r.records);
                })
                .then(function() { return atSleep(250); });
            });
          });

          return supplierChain.then(function() {
            stats.suppliers = allSupplierResults.length;
            var supplierIdByName = {};
            allSupplierResults.forEach(function(r) {
              supplierIdByName[r.fields['한자명']] = r.id;
            });
            return { shipIdBySaseom: shipIdBySaseom, supplierIdByName: supplierIdByName };
          });
        });
       })  // ← v2.5 (B) 가드: Shipments fetchExistingByKey 래퍼 닫기
        .then(function(ctx) {
          // ── 3) Orders upsert ──
          // v2.5 (B) 가드: 기존 주문이면 '주문상태'를 덮지 않음 (도구 워크플로우 보존).
          // v3.2.39 #3 동결 가드: 기존 주문이 '출고요청' 외 단계면 → 그 주문+소속 상품 전체 스킵.
          //   데이터 필드(수량·금액·트래킹 등)는 평소대로 갱신 — 단 출고요청 단계까지만.
          setMsg('Airtable: 주문 ' + orders.length + '개 업로드 중...');

          var orderNos = orders.map(function(o) { return o.주문번호; });
          return atFetchExistingByKey(pat, AT_TABLES.Orders, '주문번호', orderNos, ['주문상태', 'Shipment'])
           .then(function(existingOrderMap) {
            // === v3.2.39 #3 동결: 출고요청 이후 단계 주문 → orders 배열에서 제거 ===
            var frozenList = [];
            var liveOrders = orders.filter(function(o) {
              var ex = existingOrderMap[o.주문번호];
              if (isOrderStatusFrozen(ex)) {
                frozenList.push({ 주문번호: o.주문번호, 주문상태: String(ex['주문상태']).trim() });
                return false;
              }
              return true;
            });
            // 결과창/로그용 통계
            stats.frozen = frozenList;
            if (frozenList.length) {
              setMsg('보호(스킵) ' + frozenList.length + '건 (출고요청 이후 단계): '
                + frozenList.slice(0, 3).map(function(f){ return f.주문번호 + '=' + f.주문상태; }).join(', ')
                + (frozenList.length > 3 ? ' ...외 ' + (frozenList.length - 3) + '건' : ''));
            }
            // 이후 orderRecords·productRecords 빌드에 쓰이는 orders 변수를 liveOrders로 교체
            orders = liveOrders;
            // 다 동결된 경우 — 사서함만 메모 갱신하고 끝
            if (!orders.length) {
              stats.orders = 0;
              return { ctx: ctx, orderIdByNum: {} };
            }
            // [v2.9.2 가드 C] Shipment 링크 이동 방지 — 기존 주문이 ★다른★ 복합키 Shipment에 연결돼 있으면 무조건 안 덮음.
            //   이동 대상(주문번호) 집계 → confirm. 승인 시 _allowMove=true(이동 허용), 거절 시 false(기존 링크 보존).
            //   같은 Shipment(동일 날짜 재추출) = 이동 아님 → 무경고. (D 검토안=출고요청 보존을 거절 경로로 흡수.)
            var _moveSet = {};   // 주문번호 → {from:[기존ID], to:신ID}
            orders.forEach(function(o) {
              var ex = existingOrderMap[o.주문번호];
              if (!ex) return;   // 신규 주문 → 이동 아님
              var curLink = ex['Shipment'];
              if (!Array.isArray(curLink) || !curLink.length) return;   // 기존 링크 없음 → 이동 아님
              var oSaseom = o.사서함 || fallbackSaseom;
              var newShipId = ctx.shipIdBySaseom[oSaseom];
              if (newShipId && curLink.indexOf(newShipId) === -1) {
                _moveSet[o.주문번호] = { from: curLink, to: newShipId };   // 다른 Shipment에 연결됨 → 이동 후보
              }
            });
            var _moveNos = Object.keys(_moveSet);
            var _allowMove = true;
            if (_moveNos.length) {
              _allowMove = confirm('[가드 C] 기존 주문 ' + _moveNos.length + '건이 ★다른 선적분(Shipment)★에 이미 연결돼 있습니다.\n이번 실행(선적일 ' + SHIP_DATE_ISO + ')으로 옮기면 옛 선적분에서 빠집니다.\n예: ' + _moveNos.slice(0,5).join(', ') + (_moveNos.length>5?(' 외 '+(_moveNos.length-5)+'건'):'') + '\n\n[확인]=새 선적분으로 이동  /  [취소]=기존 링크 보존(이동 안 함)\n\n이동할까요? (날짜 오타라면 취소 권장)');
              if (!_allowMove) console.warn('[가드 C] 이동 거절 — ' + _moveNos.length + '건 기존 Shipment 링크 보존(Shipment 필드 미포함)');
            }
            var orderRecords = orders.map(function(o) {
              var cargo = o.화물입고정보 || {};
              // v2.3: 각 주문이 자기 사서함의 Shipment에 연결되도록
              var orderSaseom = o.사서함 || fallbackSaseom;
              var orderShipId = ctx.shipIdBySaseom[orderSaseom];
              // [v2.9.2 가드 C] 이동 거절 주문은 Shipment 필드를 빼서 기존 링크 보존(아래 _skipShip 처리).
              var _skipShip = (!_allowMove && _moveSet[o.주문번호]);
              var fields = {
                '주문번호': o.주문번호,
                'Shipment': orderShipId ? [orderShipId] : [],
                'ord_seq': o.ord_seq,
                '회원명': o.회원명,
                '수취인': o.수취인,
                '물류센터': o.물류센터,
                '합배송_주문번호목록': (o.합배송_주문번호목록 || []).join(', '),
                '오더넘버': o.오더넘버,
                '트래킹사': o.트래킹사,
                '트래킹번호': o.트래킹번호,
                '트래킹_보조사': o.트래킹_보조사,
                '트래킹_보조': o.트래킹_보조,
                '총수량': o.총수량,
                '총액CNY': o.총액CNY,
                '현지배송비CNY': o.현지배송비CNY,
                '환율': o.환율,
                '결제금액KRW': o.결제금액KRW,
                '결제구분': o.결제구분,
                '부가세': !!o.부가세,
                '추가결제KRW': o.추가결제KRW || 0,
                '상품입고상태': o.상품입고상태 || '입고완료',
                '부가서비스': o.부가서비스 || '',
                '물류센터요청사항': o.물류센터요청사항 || '',
                '화물입고_카톤수': cargo.카톤수 || 0,
                '화물입고_무게KG': cargo.무게KG || 0,
                '화물입고_부피CBM': cargo.부피CBM || 0,
                '관리자메모': o.관리자메모 || '',
                '박스수': o.박스수 || 1
              };
              // v2.5.1: 선적일 — 값 있을 때만 fields에 넣음 (빈값이면 미포함 → 기존값 보존)
              if (o.실제출고요청일) {
                fields['실제출고요청일'] = o.실제출고요청일;
              }
              // (B) 가드: 신규 주문에만 주문상태 기록. 기존은 보존.
              if (!existingOrderMap[o.주문번호]) {
                fields['주문상태'] = o.주문상태 || '출고요청';
              }
              // [v2.6] 도착지 자동추출 — 값 있을 때만 기록(빈값이면 기존 보존). 기존 필드만 사용(생성 금지).
              if (o.수취인주소) fields['수취인주소'] = o.수취인주소;
              if (o.연락처) fields['연락처'] = o.연락처;
              if (o.배송요청사항) fields['배송요청사항'] = o.배송요청사항;
              if (o.배송방법) fields['배송방법'] = o.배송방법;
              // [v2.9] 대행유형 → Orders.대행종류 (o.주문구분 = cell2 텍스트 매칭 "구매/배송/결제대행", v2.9.1). 값 있을 때만(기존 보존).
              //   ★ 인보이스 도구의 통관 신고자(수입자/Notify) 양식 분기(구매대행 vs 배송/결제대행)에 사용.
              if (o.주문구분) fields['대행종류'] = o.주문구분;
              // [v2.9.2 가드 C] 이동 거절(_skipShip) → Shipment 필드 제거 = 기존 링크 보존(덮어쓰기 안 함).
              if (_skipShip) delete fields['Shipment'];
              return { fields: fields };
            });

            // [v2.9] 첫 실행 확인용 — 추출된 대행종류(=cell2 텍스트 매칭 "구매/배송/결제대행", o.주문구분) 분포 로그.
            //   ★ "구매대행/배송대행/결제대행"으로 찍히는지 눈으로 확인. 다른 값이면 매핑 소스(parseOrderRow의 ordTy) 교체.
            try {
              var _agentDist = {};
              orders.forEach(function(o){ var v = (o.주문구분 || '(빈값)'); _agentDist[v] = (_agentDist[v] || 0) + 1; });
              console.log('[v2.9 대행종류 확인] Orders.대행종류 저장값 분포:', _agentDist,
                '\n  → 예상: {구매대행, 배송대행, 결제대행}만(텍스트 매칭). 합배송/단독배송 등이 섞이면 안 됨.');
            } catch (e) { /* 로그 실패 무시 */ }

            var orderBatches = [];
            for (var i = 0; i < orderRecords.length; i += 10) {
              orderBatches.push(orderRecords.slice(i, i + 10));
            }

            var allOrderResults = [];
            var orderChain = Promise.resolve();
            orderBatches.forEach(function(batch) {
              orderChain = orderChain.then(function() {
                return atUpsert(pat, AT_TABLES.Orders, batch, ['주문번호'], true)
                  .then(function(r) {
                    allOrderResults = allOrderResults.concat(r.records);
                  })
                  .then(function() { return atSleep(250); });
              });
            });

            return orderChain.then(function() {
              stats.orders = allOrderResults.length;
              var orderIdByNum = {};
              allOrderResults.forEach(function(r) {
                orderIdByNum[r.fields['주문번호']] = r.id;
              });
              return { ctx: ctx, orderIdByNum: orderIdByNum };
            });
           });  // ← Orders fetchExistingByKey 래퍼 닫기
        })
        .then(function(state) {
          // ── 4) Products upsert ──

          // v2.2: ProductHistory 캐시 로드 (자동 매칭용)
          setMsg('학습 데이터 로드 중...');

          // Meta API로 ProductHistory 테이블 찾기
          var metaUrl = 'https://api.airtable.com/v0/meta/bases/' + AT_BASE_ID + '/tables';
          return fetch(metaUrl, {
            headers: { 'Authorization': 'Bearer ' + pat }
          })
          .then(function(r) { return r.ok ? r.json() : { tables: [] }; })
          .catch(function() { return { tables: [] }; })
          .then(function(meta) {
            var tables = meta.tables || [];
            var phTable = null;
            for (var ti = 0; ti < tables.length; ti++) {
              if (tables[ti].name === 'ProductHistory') {
                phTable = tables[ti];
                AT_TABLES.ProductHistory = tables[ti].id;
                break;
              }
            }

            if (!AT_TABLES.ProductHistory) {
              state.productHistory = [];
              return state;
            }

            // ProductHistory 레코드 페이지네이션 로드
            function loadPage(offset, acc) {
              var url = 'https://api.airtable.com/v0/' + AT_BASE_ID + '/' + AT_TABLES.ProductHistory + '?pageSize=100' + (offset ? '&offset=' + offset : '');
              return fetch(url, { headers: { 'Authorization': 'Bearer ' + pat } })
                .then(function(r) { return r.ok ? r.json() : { records: [] }; })
                .then(function(data) {
                  var combined = acc.concat(data.records || []);
                  if (data.offset) return loadPage(data.offset, combined);
                  return combined;
                });
            }

            return loadPage(null, []).then(function(records) {
              state.productHistory = records.map(function(r) {
                return {
                  제품링크: (r.fields['제품링크'] || '').trim(),
                  한국어명: r.fields['한국어명'] || '',
                  한국어명_별칭: r.fields['한국어명_별칭'] || '',
                  영문명: r.fields['영문명'] || '',
                  HS코드: r.fields['HS코드'] || '',
                  Material: r.fields['Material'] || '',
                  적용FTA: r.fields['적용FTA'] || '없음',
                  사용횟수: r.fields['사용횟수'] || 0
                };
              });
              return state;
            })
            .catch(function() {
              state.productHistory = [];
              return state;
            });
          });
        })
        .then(function(state) {
          var phCache = state.productHistory || [];
          var matchExact = 0;
          var matchSimilar = 0;

          // 키워드 추출 함수
          function extractKW(name) {
            if (!name) return [];
            var cleaned = (name + '').replace(/[^\uAC00-\uD7AF\u3131-\u318E\w\s]/g, ' ');
            var tokens = cleaned.split(/\s+/).filter(function(t){ return t.length >= 2; });
            return tokens.filter(function(t, i){ return tokens.indexOf(t) === i; }).slice(0, 10);
          }

          // 매칭 시도
          // [v2.9.5] 고유 상품 detail URL만 매칭 키로 허용. 공용 이미지/에디터/alicdn URL은 비고유 → broadcast 오염 방지.
          function isUniqueProductUrl(u) {
            u = String(u || '').trim().toLowerCase();
            if (!u) return false;
            if (/\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/.test(u)) return false;     // 이미지 파일
            if (/\/editor\/|edt_|\/upfile\//.test(u)) return false;            // 업로드/에디터 이미지
            if (/alicdn\.com|cbu01\.|gw\.alicdn|\/img\./.test(u)) return false; // alicdn 이미지 CDN
            return /(detail\.1688\.com|item\.taobao\.com|detail\.tmall\.com|1688\.com\/offer|\/item\.htm|\/offer\/)/.test(u);
          }
          function matchFromHistory(link, koName) {
            var lk = (link || '').trim();
            var nm = (koName || '').trim();

            // Level 1: URL 정확 매칭 — [v2.9.5] 고유 상품 URL만(공용 이미지 URL은 제외 → broadcast 오염 차단)
            if (lk && isUniqueProductUrl(lk)) {
              for (var i = 0; i < phCache.length; i++) {
                if (phCache[i].제품링크 === lk) {
                  return { level: 'exact', data: phCache[i] };
                }
              }
            }

            // Level 2: 키워드 매칭
            if (nm) {
              var keywords = extractKW(nm);
              if (keywords.length > 0) {
                var best = null;
                var bestScore = 0;
                for (var j = 0; j < phCache.length; j++) {
                  var c = phCache[j];
                  if (!c.영문명 || !c.HS코드) continue;
                  var combined = (c.한국어명 + ' ' + c.한국어명_별칭).toLowerCase();
                  var matched = 0;
                  for (var k = 0; k < keywords.length; k++) {
                    if (combined.indexOf(keywords[k].toLowerCase()) >= 0) matched++;
                  }
                  var score = matched / keywords.length;
                  if (score >= 0.7 && score > bestScore) {
                    bestScore = score;
                    best = { level: 'similar', data: c, score: score };
                  }
                }
                if (best) return best;
              }
            }

            return null;
          }

          // Products 빌드 with 매칭
          var allProducts = [];
          var today = new Date().toISOString().slice(0, 10);
          orders.forEach(function(o) {
            (o.상품 || []).forEach(function(p) {
              if (p._error || p._warning) return;
              var productId = o.주문번호 + '_' + p.pro_seq;
              var supplierName = extractSupplierName(o.관리자메모);
              var supplierId = supplierName ? state.ctx.supplierIdByName[supplierName] : null;
              var fields = {
                '상품ID': productId,
                'Order': [state.orderIdByNum[o.주문번호]],
                'pro_seq': p.pro_seq,
                '묶음번호': p.묶음번호 || '',
                '수수료율CNY': p.수수료율CNY || 0,
                '통관품명_한글': p.통관품명_한글 || '',
                '통관품명_영문': p.통관품명_영문 || '',
                'HS코드': p.hs_code || '',
                'Description': p.invoice_description || p.통관품명_영문 || '',
                'Material': p.material || '',
                '색상사이즈': p.색상사이즈 || '',
                '단가CNY': p.단가CNY || 0,
                '수량': p.수량 || 0,
                '합계CNY': p.합계CNY || 0,
                '단가KRW': p.단가KRW || 0,
                '합계KRW': p.합계KRW || 0,
                // [v2.9.6] 구매수수료CNY 매핑 복구 — 파싱(line 644 p.구매수수료CNY)은 됐으나
                //   이 fields에 키가 없어 무조건 0 저장되던 버그. Products 스키마엔 '구매수수료CNY'(precision4)만
                //   존재 → CNY만 매핑. '현지배송비CNY'(Orders 전용·2026-05-29 422 진범)·'구매수수료KRW'(스키마 없음)는 미포함.
                '구매수수료CNY': p.구매수수료CNY || 0
              };
              // v2.1: 제품 링크 (1688/Taobao URL) — 관세사 매칭의 핵심
              if (p.제품링크) {
                fields['제품링크'] = p.제품링크;
              }

              // v2.2: ProductHistory 자동 매칭
              var match = matchFromHistory(p.제품링크, p.통관품명_한글);
              if (match) {
                var phData = match.data;
                // [v2.9.5] ★exact·similar 모두 빈칸만 채움(onlyEmpty) + 관세사확정 자동설정 금지(사람만).
                //   덮어쓰기·자동확정 폐지 → broadcast 오염(다른 제품 영문명 덮임) 근본 차단. 자동매칭은 "추천"까지만.
                if (!fields['통관품명_영문'] && phData.영문명) { fields['통관품명_영문'] = phData.영문명; fields['Description'] = phData.영문명; }
                if (!fields['HS코드'] && phData.HS코드) fields['HS코드'] = phData.HS코드;
                if (!fields['Material'] && phData.Material) fields['Material'] = phData.Material;
                if (!fields['적용FTA'] && phData.적용FTA) fields['적용FTA'] = phData.적용FTA;
                if (match.level === 'exact') { fields['관세사메모'] = '자동매칭 추천 (이전 ' + phData.사용횟수 + '회 · 빈칸만 채움, 관세사 확정 필요)'; matchExact++; }
                else { fields['관세사메모'] = '유사 매칭 추천 (' + Math.round(match.score * 100) + '% 일치) - 확인 필요'; matchSimilar++; }
              }

              // 이미지 첨부 (Airtable이 URL fetch)
              var imgs = (p.이미지 || []).filter(function(i){ return i.url; });
              if (imgs.length) {
                fields['상품이미지'] = imgs.map(function(i){ return { url: i.url }; });
                fields['이미지URL'] = imgs[0].url;
              }
              if (supplierId) fields['Supplier'] = [supplierId];
              // 영문명 정리: 알리피드 통관품목 영문명 끝에 항상 붙는 " /" 제거 (맨 끝 슬래시 1개만, 중간 슬래시 보존).
              // 두 영문명 컬럼(Description + 통관품명_영문)에 적용. split('/') 류 금지(예 "A/B cable" 파괴).
              // 기존 Airtable 데이터는 불변(앞으로 추출분만). push 직전 분기 밖 → 모든 추출 제품이 거침.
              fields['Description'] = String(fields['Description'] || '').replace(/\s*\/\s*$/, '').trim();
              fields['통관품명_영문'] = String(fields['통관품명_영문'] || '').replace(/\s*\/\s*$/, '').trim();
              allProducts.push({ fields: fields });
            });
          });

          // 매칭 결과 로그
          if (matchExact > 0 || matchSimilar > 0) {
            setMsg('학습 매칭: 정확 ' + matchExact + ' / 유사 ' + matchSimilar);
          }
          stats.matchExact = matchExact;
          stats.matchSimilar = matchSimilar;

          if (!allProducts.length) {
            return { allProducts: 0 };
          }

          // v2.5 (포팅 from v2.10, 2026-06-01): 구매수수료CNY 분포 디버그 로그.
          //   commission 폴백 효과 확인용 — 콘솔 그룹에 추출 통계 출력.
          //   사장님이 재추출 후 console.group([commission 분포])를 펼쳐 결과 확인.
          (function debugCommission() {
            // [v2.9.6] ★파싱 원본(p)에서 읽는다 — 업로드 fields가 아님.
            //   구버전은 fields['구매수수료CNY']를 읽어 매핑 누락 시 항상 0(가짜 지표)이었음.
            //   여기선 orders[].상품[].구매수수료CNY(parseProductDetail 산출값)를 직접 집계 →
            //   "파싱 성공 여부"를 매핑·스키마와 무관하게 관측(팝업 파서 필요 판단 근거).
            var parsed = [];
            orders.forEach(function(o){ (o.상품 || []).forEach(function(p){ if (!p._error && !p._warning) parsed.push(p); }); });
            var cnyVals = parsed.map(function(p){ return parseFloat(p['구매수수료CNY']) || 0; });
            var nz = cnyVals.filter(function(v){ return v > 0; });
            var krwVals = parsed.map(function(p){ return parseFloat(p['구매수수료KRW']) || 0; });
            var nzKrw = krwVals.filter(function(v){ return v > 0; });
            console.group('[v2.5 commission 분포]');
            console.log('전체 제품 수    :', cnyVals.length);
            console.log('구매수수료CNY > 0 :', nz.length, '/', cnyVals.length, '(' + (cnyVals.length ? Math.round(nz.length/cnyVals.length*100) : 0) + '%)');
            console.log('구매수수료CNY 합  :', cnyVals.reduce(function(a,b){return a+b;}, 0).toFixed(4));
            console.log('구매수수료CNY 평균:', nz.length ? (nz.reduce(function(a,b){return a+b;}, 0)/nz.length).toFixed(4) : '-');
            console.log('구매수수료CNY 최댓:', cnyVals.length ? Math.max.apply(null, cnyVals).toFixed(4) : '-');
            console.log('(참고) 구매수수료KRW 합 :', krwVals.reduce(function(a,b){return a+b;}, 0));
            console.log('(참고) 구매수수료KRW>0 :', nzKrw.length, '/', krwVals.length);
            console.log('↑ CNY 합과 KRW 합 둘 다 0에 가까우면 추출 단계 문제, KRW만 잘 잡히면 환산 문제');
            console.groupEnd();
          })();

          setMsg('Airtable: 상품 ' + allProducts.length + '개 업로드 중...');

          var productBatches = [];
          for (var i = 0; i < allProducts.length; i += 10) {
            productBatches.push(allProducts.slice(i, i + 10));
          }

          var productCount = 0;
          var prodChain = Promise.resolve();
          productBatches.forEach(function(batch, idx) {
            prodChain = prodChain.then(function() {
              setMsg('Airtable: 상품 배치 ' + (idx + 1) + '/' + productBatches.length);
              return atUpsert(pat, AT_TABLES.Products, batch, ['상품ID'], true)
                .then(function(r) { productCount += r.records.length; })
                .then(function() { return atSleep(300); });
            });
          });

          return prodChain.then(function() {
            stats.products = productCount;
            return { allProducts: productCount };
          });
        })
        .then(function() {
          return { pushed: true, stats: stats };
        });
    }

    var airtablePromise = pushToAirtable().catch(function(e) {
      console.error('Airtable push error:', e);
      return { pushed: false, error: e.message };
    });
    // ========== Airtable 푸시 끝 ==========

    // 결과 창은 Airtable 푸시 완료까지 대기
    airtablePromise.then(function(atResult) {
      var atBanner = '';
      if (atResult && atResult.pushed) {
        var s = atResult.stats;
        // v3.2.39 #3 동결 가드: 보호(스킵) 통계
        var frozenN = (s.frozen && s.frozen.length) || 0;
        var frozenDetail = '';
        if (frozenN > 0) {
          frozenDetail = '<div style="margin-top:8px;padding:8px 10px;background:rgba(200,150,50,.15);border-left:3px solid #c9a449;border-radius:3px;font-size:11px;color:#e8d099">' +
            '🛡 <strong>보호(스킵) ' + frozenN + '건</strong> — 출고요청 이후 단계 주문은 동결됨:<br>' +
            s.frozen.map(function(f){ return '<span style="font-family:JetBrains Mono,monospace;margin-right:8px">' + f.주문번호 + '=' + f.주문상태 + '</span>'; }).join('') +
            '</div>';
        }
        atBanner = '<div style="background:#1a3a1a;border:1px solid #5a8a3a;padding:14px 18px;border-radius:4px;margin:0 0 18px;color:#a8d878">' +
          '<div style="font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#7eb878;margin-bottom:6px">Airtable 업로드 완료</div>' +
          '<div style="display:flex;gap:24px;font-size:14px;color:#d4f0c8">' +
          '<span>Shipment <strong>' + s.shipment + '</strong></span>' +
          '<span>주문 <strong>' + s.orders + '</strong></span>' +
          '<span>상품 <strong>' + s.products + '</strong></span>' +
          '<span>공급사 <strong>' + s.suppliers + '</strong></span>' +
          (frozenN > 0 ? '<span style="color:#e8d099">보호 <strong>' + frozenN + '</strong></span>' : '') +
          '</div>' +
          frozenDetail +
          '<a href="https://airtable.com/' + AT_BASE_ID + '" target="_blank" style="color:#c9a449;font-size:12px;text-decoration:none;margin-top:8px;display:inline-block">→ Airtable 베이스 열기</a>' +
          '</div>';
      } else if (atResult && atResult.error) {
        atBanner = '<div style="background:#3a1010;border:1px solid #c33;padding:14px 18px;border-radius:4px;margin:0 0 18px;color:#ffaaaa">' +
          '<div style="font-family:JetBrains Mono,monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#ff7b72;margin-bottom:6px">Airtable 업로드 실패</div>' +
          '<div style="font-size:12px;font-family:JetBrains Mono,monospace;color:#ffaaaa;word-break:break-all">' + atResult.error + '</div>' +
          '<div style="font-size:11px;color:#ffaaaa;margin-top:6px;opacity:.7">JSON은 아래에서 수동으로 확인 가능합니다.</div>' +
          '</div>';
      } else {
        atBanner = '<div style="background:#2a1a3a;border:1px solid #6a4a8a;padding:14px 18px;border-radius:4px;margin:0 0 18px;color:#d8b8ee">' +
          '<div style="font-size:12px">Airtable 푸시 건너뜀 (PAT 입력 안 됨)</div></div>';
      }
      renderResultWindow(atBanner);
    });

    function renderResultWindow(atBanner) {

    // v2.3: 사서함별 요약 박스 (사서함이 2개 이상일 때만)
    var saseomSummary = '';
    if (saseomList.length > 1) {
      saseomSummary = '<div style="margin:0 0 18px;padding:14px 18px;background:rgba(20,40,64,.4);border:1px solid rgba(244,236,216,.1);border-radius:4px">' +
        '<div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9bb5d6;margin-bottom:10px;font-family:JetBrains Mono,monospace">사서함별 요약 (' + saseomList.length + '개)</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;font-family:JetBrains Mono,monospace">' +
        '<thead><tr style="border-bottom:1px solid rgba(244,236,216,.15);color:#9bb5d6">' +
          '<th style="text-align:left;padding:6px 8px;font-weight:400">사서함</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">주문</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">상품</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">수량</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">CNY</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">KRW</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">KG</th>' +
          '<th style="text-align:right;padding:6px 8px;font-weight:400">CBM</th>' +
        '</tr></thead><tbody>' +
        saseomList.map(function(s) {
          var st = statsBySaseom[s];
          return '<tr style="border-bottom:1px solid rgba(244,236,216,.05)">' +
            '<td style="padding:6px 8px;color:#c9a449">' + s + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">' + st.주문수 + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">' + st.상품수 + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">' + st.총수량.toLocaleString() + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">¥' + st.총액CNY.toLocaleString() + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">₩' + st.결제금액KRW.toLocaleString() + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">' + st.무게KG + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#f4ecd8">' + st.부피CBM + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    // 이미지 갤러리 HTML 빌더
    function buildGalleryHtml(orders) {
      var items = [];
      orders.forEach(function(o) {
        (o.상품 || []).forEach(function(p) {
          (p.이미지 || []).forEach(function(img) {
            var src = img.base64 || img.url;
            if (!src) return;
            var label = (o.주문번호 || '') + ' · ' + (p.색상사이즈 || p.통관품명_영문 || '');
            items.push({ src: src, label: label, ok: !!img.base64, error: img.error });
          });
        });
      });
      if (!items.length) return '';
      var grid = items.map(function(it) {
        var border = it.ok ? '1px solid rgba(201,164,73,.3)' : '1px dashed #cc7777';
        return '<div style="background:#0c1929;border:' + border + ';border-radius:4px;padding:8px;text-align:center">' +
          '<img src="' + it.src + '" style="max-width:100%;max-height:80px;border-radius:2px;display:block;margin:0 auto 6px"/>' +
          '<div style="font-size:9px;color:#9bb5d6;font-family:JetBrains Mono,monospace;word-break:break-all">' + it.label + (it.error ? ' · ' + it.error : '') + '</div>' +
          '</div>';
      }).join('');
      return '<div id="gallery" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin:18px 0;padding:14px;background:rgba(20,40,64,.4);border-radius:4px">' + grid + '</div>';
    }

    // 결과 창
    var w = window.open('', 'alipeed_result_' + Date.now(), 'width=1100,height=820,scrollbars=yes');
    if (!w) {
      $progress.css('background','#3a1010').css('border-color','#c33').css('color','#ffaaaa');
      setMsg('팝업 차단됨! 클립보드에 JSON 복사함.');
      navigator.clipboard.writeText(json);
      setTimeout(function(){ $progress.remove(); }, 6000);
      return;
    }

    var fname = 'alipeed_' + saseom + '_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '.json';
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + saseom + ' 추출결과 (' + orders.length + '건)</title>' +
      '<style>' +
      'body{margin:0;padding:30px;background:#0c1929;color:#f4ecd8;font-family:-apple-system,BlinkMacSystemFont,sans-serif}' +
      'h1{font-family:"Cormorant Garamond",serif;font-weight:500;font-size:32px;margin:0 0 6px;letter-spacing:-0.01em}' +
      'h1 em{color:#c9a449;font-style:italic}' +
      '.stats{display:flex;gap:32px;flex-wrap:wrap;padding:16px 0 24px;border-bottom:1px solid rgba(244,236,216,.1);margin-bottom:20px}' +
      '.stat{}' +
      '.stat-l{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9bb5d6;display:block;margin-bottom:2px;font-family:"JetBrains Mono",monospace}' +
      '.stat-v{font-size:22px;color:#f4ecd8;font-family:"Cormorant Garamond",serif;font-weight:500}' +
      '.stat-v small{font-size:13px;color:#9bb5d6;margin-left:4px}' +
      'button{background:transparent;color:#c9a449;border:1px solid #b08a3a;padding:9px 20px;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;cursor:pointer;border-radius:2px;margin-right:8px}' +
      'button:hover{background:#c9a449;color:#0c1929}' +
      'pre{background:#142840;border:1px solid rgba(244,236,216,.1);padding:18px;border-radius:4px;font-family:"JetBrains Mono",monospace;font-size:11px;line-height:1.55;overflow:auto;max-height:65vh;color:#f4ecd8}' +
      '.toolbar{margin:14px 0 18px}' +
      '</style></head><body>' +
      '<h1>' + (saseomList.length === 1 ? saseom : '다중 사서함') + ' <em>추출 결과</em></h1>' +
      (saseomList.length > 1
        ? '<div style="font-size:13px;color:#9bb5d6;margin:0 0 14px;font-family:JetBrains Mono,monospace">' + saseomList.join(' · ') + '</div>'
        : '') +
      atBanner +
      '<div class="stats">' +
        '<div class="stat"><span class="stat-l">사서함</span><span class="stat-v">' + saseomList.length + '<small>개</small></span></div>' +
        '<div class="stat"><span class="stat-l">주문</span><span class="stat-v">' + orders.length + '<small>건</small></span></div>' +
        '<div class="stat"><span class="stat-l">상품</span><span class="stat-v">' + totalProducts + '<small>개</small></span></div>' +
        '<div class="stat"><span class="stat-l">총 수량</span><span class="stat-v">' + totalQty.toLocaleString() + '</span></div>' +
        '<div class="stat"><span class="stat-l">CNY</span><span class="stat-v">¥' + result.meta.총액CNY.toLocaleString() + '</span></div>' +
        '<div class="stat"><span class="stat-l">KRW</span><span class="stat-v">₩' + totalPaymentKrw.toLocaleString() + '</span></div>' +
        '<div class="stat"><span class="stat-l">중량</span><span class="stat-v">' + result.meta.총무게KG + '<small>kg</small></span></div>' +
        '<div class="stat"><span class="stat-l">부피</span><span class="stat-v">' + result.meta.총부피CBM + '<small>cbm</small></span></div>' +
        '<div class="stat"><span class="stat-l">이미지</span><span class="stat-v" style="color:' + (result.meta.이미지_실패 > 0 ? '#e8a04c' : '#c9a449') + '">' + result.meta.이미지_변환성공 + '<small>/' + result.meta.이미지_전체 + '</small></span></div>' +
      '</div>' +
      saseomSummary +
      '<div class="toolbar">' +
        '<button onclick="navigator.clipboard.writeText(document.getElementById(\'j\').textContent).then(function(){this.textContent=\'복사됨 ✓\'}.bind(this))">📋 클립보드 복사</button>' +
        '<button onclick="var b=new Blob([document.getElementById(\'j\').textContent],{type:\'application/json\'});var a=document.createElement(\'a\');a.href=URL.createObjectURL(b);a.download=\'' + fname + '\';a.click()">💾 JSON 다운로드</button>' +
        '<button onclick="document.getElementById(\'gallery\').style.display=document.getElementById(\'gallery\').style.display===\'none\'?\'grid\':\'none\'">🖼 이미지 토글</button>' +
      '</div>' +
      buildGalleryHtml(orders) +
      '<pre id="j">' + json.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</pre>' +
      '</body></html>';

    w.document.open();
    w.document.write(html);
    w.document.close();

    $progress.css('background','#1a3a1a').css('border-color','#5a8a3a').css('color','#a8d878');
    setMsg('✓ ' + SHIP_DATE_YYMMDD + ' 선적분 완료! Shipment ' + saseomList.length + ' / 주문 ' + orders.length + ' / 상품 ' + totalProducts + '개');
    setTimeout(function(){ $progress.remove(); }, 3000);

    } // end renderResultWindow

  }).catch(function(e) {
    $progress.css('background','#3a1010').css('border-color','#c33').css('color','#ffaaaa');
    setMsg('오류: ' + (e.message || e));
    setTimeout(function(){ $progress.remove(); }, 8000);
    console.error('Alipeed extractor error:', e);
  });

})();