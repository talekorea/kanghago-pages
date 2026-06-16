// 유니패스(UNIPASS) 수입물품 보세구역 반출신고 정보 프록시 — v3.2.0 Phase 7 (2026-05-30)
//
// POST /api/unipass-bonded
//   body: { blNo: '...' or cargoMgmtNo: '...' }
//   returns: { ok, bondedWarehouse:{ name, code, address }, stages:[...], raw }
//
// 사장님 요구:
//   1. BL번호 또는 화물관리번호 입력
//   2. 유니패스 "수입물품 보세구역 반출신고" API 호출
//   3. 처리단계 목록에서 ★ "반출입(처리)내용" == "보세운송 반입" ★ 행 찾기
//   4. 그 행의 장치장명 = 출발지 보세창고 (기사님 갈 곳)
//   5. 장치장코드 → 주소 매핑 (정적 테이블)
//
// 화면 예시 (사장님 캡처):
//   처리단계 18: 반입신고 + (주)동방 인천 물류센터 + "보세운송 반입" → ★ 출발지
//   처리단계 16: 반입신고 + 인천항국제여객부두 보세창고 + "입항 반입"   ← 1차 임시 (X)
//
// 환경변수: UNIPASS_API_KEY (이미 환율 서버용으로 발급 진행 중 — 같은 키 재사용 가능)
//
// 유니패스 endpoint (작동 검증):
//   https://unipass.customs.go.kr:38010/ext/rest/cargCsclPrgsInfoQry/retrieveCargCsclPrgsInfo
//     ?crkyCn=<인증키>&hblNo=<HBL>&blYy=<연도>
//   또는 cargMtNo=<화물관리번호>

const { handleCors, readBody } = require('./_lib');

const UNIPASS_ENDPOINT = 'https://unipass.customs.go.kr:38010/ext/rest/cargCsclPrgsInfoQry/retrieveCargCsclPrgsInfo';

// 장치장 코드 → 주소 매핑 (정적 테이블 — 사장님이 자주 만나는 보세창고만 우선)
// 추가 코드가 발견되면 사장님이 여기에 한 줄씩 추가 (또는 별도 JSON으로 분리)
const WAREHOUSE_MAP = {
  '02086021': { name: '(주)동방 인천 물류센터', address: '인천광역시 중구 항동7가 1-32', phone: '032-880-1300' },
  '02077017': { name: '인천항국제여객부두 컨테이너 보세창고', address: '인천광역시 중구 연안부두로 70', phone: '032-880-7114' },
  // ↓ 추가 시 형식: '코드': { name:'...', address:'...', phone:'...' }
};

// XML 응답에서 처리단계 추출 (간단 정규식 파싱 — 유니패스 응답이 안정적이라 XML 라이브러리 불필요)
function parseUnipassXml(xmlText) {
  const stages = [];
  // 각 <cargCsclPrgsInfoDtlQryVo> 블록 추출
  const dtlMatches = xmlText.match(/<cargCsclPrgsInfoDtlQryVo>[\s\S]*?<\/cargCsclPrgsInfoDtlQryVo>/g) || [];
  for (const block of dtlMatches) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1].trim() : '';
    };
    stages.push({
      순번: parseInt(get('prcsSqno')) || 0,
      처리일시: get('prcsDttm'),
      처리내용: get('cargTrcnRelaBsopTpcd') || get('rlbrCn') || get('csclPrgsStCd'),
      장치장명: get('shedNm'),
      장치장코드: get('shedSgn') || get('shedNo'),
      반출입내용: get('rlbrCn') || get('cargTrcnRelaBsopTpcd'),
      raw: block,
    });
  }
  return stages;
}

// [관리대상검사] 요약(기본정보) 블록 파싱 — Dtl 블록 제외 후 남는 cargCsclPrgsInfoQryVo.
//   관리대상검사여부(예: '반입후검사'/'즉시검사')는 상세단계가 아니라 이 요약 블록에 있음.
function parseSummary(xmlText) {
  const stripped = String(xmlText || '').replace(/<cargCsclPrgsInfoDtlQryVo>[\s\S]*?<\/cargCsclPrgsInfoDtlQryVo>/g, '');
  const all = {};
  let m; const re = /<([a-zA-Z][\w]*)>([^<]+)<\/\1>/g;
  while ((m = re.exec(stripped))) { if (!all[m[1]]) all[m[1]] = m[2].trim(); }
  // 관리대상검사여부 — UNIPASS 요약 태그 mtTrgtCargYnNm (예 '반입후검사'/'즉시검사'). 폴백: 값에 '검사' 포함 태그.
  let inspection = (all['mtTrgtCargYnNm'] || '').trim();
  if (!inspection || !/검사/.test(inspection)) {
    for (const k of Object.keys(all)) { if (/검사/.test(all[k])) { inspection = all[k].trim(); break; } }
  }
  // 'N'/'해당없음'/'비대상' 등 비검사 값은 빈값으로 정규화(검사 대상일 때만 노출)
  const isTarget = /검사/.test(inspection);
  return {
    inspection: isTarget ? inspection : '',           // 검사 대상이면 종류 문자열, 아니면 ''
    customsStatus: (all['csclPrgsStts'] || '').trim(), // 통관진행상태(부가) — 예 '수입신고전'
    cargoMgmtNo: (all['cargMtNo'] || '').trim(),       // 화물관리번호(부가)
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const apiKey = process.env.UNIPASS_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      error: 'UNIPASS_API_KEY 환경변수 미설정',
      hint: 'Vercel Settings → Environment Variables 에 UNIPASS_API_KEY 추가 후 재배포',
    });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid JSON body' }); }

  const { blNo, cargoMgmtNo, blYear } = body;
  if (!blNo && !cargoMgmtNo) {
    return res.status(400).json({ ok: false, error: 'blNo 또는 cargoMgmtNo 필요' });
  }

  // URL 조립
  const params = new URLSearchParams({ crkyCn: apiKey });
  if (cargoMgmtNo) {
    params.append('cargMtNo', cargoMgmtNo);
  } else {
    params.append('hblNo', blNo);
    params.append('blYy', blYear || String(new Date().getFullYear()));
  }
  const url = `${UNIPASS_ENDPOINT}?${params.toString()}`;

  let xmlText;
  try {
    const r = await fetch(url, { method: 'GET' });
    xmlText = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'UNIPASS HTTP ' + r.status, raw: xmlText.slice(0, 500) });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'fetch failed', detail: e.message });
  }

  // 에러 응답 체크
  if (xmlText.includes('<errYn>Y</errYn>') || xmlText.includes('<errMsg>')) {
    const errMsg = (xmlText.match(/<errMsg>([^<]*)<\/errMsg>/) || [])[1] || 'UNIPASS error';
    return res.status(502).json({ ok: false, error: errMsg, raw: xmlText.slice(0, 500) });
  }

  // 처리단계 파싱
  const stages = parseUnipassXml(xmlText);
  if (!stages.length) {
    return res.status(404).json({
      ok: false,
      error: '처리단계가 없습니다 (BL번호/화물관리번호 확인)',
      raw: xmlText.slice(0, 800),
    });
  }

  // ★ "보세운송 반입" 행 찾기 — 사장님 알고리즘 핵심
  const bondedTransport = stages.find(s =>
    String(s.반출입내용 || '').includes('보세운송 반입') ||
    String(s.처리내용 || '').includes('보세운송 반입')
  );

  // 매핑 검색
  let bondedWarehouse = null;
  if (bondedTransport) {
    const code = bondedTransport.장치장코드 || '';
    const mapped = WAREHOUSE_MAP[code];
    bondedWarehouse = {
      name: mapped ? mapped.name : bondedTransport.장치장명,
      code: code,
      address: mapped ? mapped.address : '(주소 매핑 미등록 — WAREHOUSE_MAP에 추가 필요)',
      phone: mapped ? mapped.phone : '',
      stage_seq: bondedTransport.순번,
      stage_time: bondedTransport.처리일시,
      _matched: !!mapped,
    };
  }

  // [관리대상검사] 요약 블록에서 검사여부 추출
  const summary = parseSummary(xmlText);

  return res.status(200).json({
    ok: true,
    bondedWarehouse,
    stages,
    stagesCount: stages.length,
    inspection: summary.inspection,                  // 관리대상검사: '반입후검사'/'즉시검사'/'' (비대상)
    customsStatus: summary.customsStatus,            // 통관진행상태 (부가)
    cargoMgmtNo: summary.cargoMgmtNo,                // 화물관리번호 (부가)
    queriedAt: new Date().toISOString(),
    note: bondedWarehouse
      ? (bondedWarehouse._matched
          ? '★ "보세운송 반입" 행 발견 + 주소 매핑 OK'
          : '★ "보세운송 반입" 행 발견 — 주소는 WAREHOUSE_MAP에 코드 ' + bondedWarehouse.code + ' 추가 필요')
      : '⚠ "보세운송 반입" 행이 아직 없음 — 통관 진행 중이라 데이터 미생성 가능',
  });
};
