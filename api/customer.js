// 고객 페이지 API
// GET  /api/customer?t=token&ship=recXXX → 사서함 + 제품 + 박스 + 고객정보
// POST /api/customer → 고객 응답 저장 (FTA / 배송방식 / 수취 / 특이사항)

const { atRequest, atListAll, handleCors, readBody, TABLES, BASE_ID } = require('./_lib');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    if (req.method === 'GET') {
      // [배송정보 1차 — 2026-06-30] 고객 셀프 배송정보 등록(읽기). 기존 고객페이지 GET와 분리.
      if (req.query.op === 'customer_delivery_get') return await handleDeliveryGet(req, res);
      return await handleGet(req, res);
    }
    if (req.method === 'POST') {
      const _b = await readBody(req);
      if (_b.op === 'customer_delivery_save') return await handleDeliverySave(req, res, _b);
      return await handlePost(req, res);
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('Customer API error:', e);
    res.status(500).json({ error: e.message });
  }
};

async function handleGet(req, res) {
  const shipId = req.query.ship;
  const token = req.query.t;

  if (!shipId || !shipId.startsWith('rec')) {
    return res.status(400).json({ error: 'Invalid shipment id' });
  }
  if (!token || token.length < 16) {
    return res.status(401).json({ error: '유효하지 않은 접근 토큰입니다.' });
  }

  // 1. 사서함 조회 + 토큰 검증
  const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipId}`);
  const savedToken = ship.fields['고객토큰'];
  const expDate = ship.fields['고객토큰만료일'];

  if (!savedToken || savedToken !== token) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }

  if (expDate) {
    const exp = new Date(expDate);
    exp.setHours(23, 59, 59); // 만료일 그날 끝까지 유효
    if (exp < new Date()) {
      return res.status(403).json({ error: '링크가 만료되었습니다 (만료일: ' + expDate + '). 강하고 무역에 재발송 요청해 주세요.' });
    }
  }

  const shipName = ship.fields['사서함'];

  // 2. Orders 조회
  const orderUrl = `/${TABLES.Orders}?filterByFormula=${encodeURIComponent(`SEARCH('${shipName}',ARRAYJOIN({Shipment}))`)}`;
  const orders = await atListAll(orderUrl);

  // 3. Products 조회
  const prodIds = [];
  orders.forEach(o => (o.fields['Products'] || []).forEach(pid => prodIds.push(pid)));

  let products = [];
  if (prodIds.length > 0) {
    const prodFilter = 'OR(' + prodIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    products = await atListAll(`/${TABLES.Products}?filterByFormula=${encodeURIComponent(prodFilter)}`);
  }

  // 4. Boxes 조회
  const boxFilter = `SEARCH('${shipName}',ARRAYJOIN({Shipment}))`;
  let boxes = [];
  try {
    boxes = await atListAll(`/${TABLES.Boxes}?filterByFormula=${encodeURIComponent(boxFilter)}`);
  } catch (e) {
    console.log('Boxes fetch failed:', e.message);
  }

  // 4-1. BoxAssignments 조회 (박스-제품 매핑)
  let boxAssignments = [];
  if (boxes.length > 0) {
    const boxIds = boxes.map(b => b.id);
    const baFilter = 'OR(' + boxIds.map(id => `SEARCH('${id}',ARRAYJOIN({Box}))`).join(',') + ')';
    try {
      boxAssignments = await atListAll(`/${TABLES.BoxAssignments}?filterByFormula=${encodeURIComponent(baFilter)}`);
    } catch (e) {
      console.log('BoxAssignments fetch failed:', e.message);
    }
  }

  // 5. Customers 정보 조회 (Customers 테이블이 있으면)
  let customer = null;
  try {
    const meta = await atRequest('GET', `/meta/bases/${BASE_ID}/tables`);
    const custTable = (meta.tables || []).find(t => t.name === 'Customers');
    if (custTable) {
      const custUrl = `/${custTable.id}?filterByFormula=${encodeURIComponent(`{사서함번호}='${shipName}'`)}&maxRecords=1`;
      const custRes = await atRequest('GET', custUrl);
      customer = (custRes.records && custRes.records[0]) || null;
    }
  } catch (e) {
    console.log('Customer fetch skipped:', e.message);
  }

  // [v3.2.81] ★응답 화이트리스트 — 고객 수취정보 확인/응답에 쓰는 필드만 반환. 전체 덤프 폐기(신규 필드 자동 비노출).
  //   ★제외: 고객토큰(인증만 사용, 노출X)·청구금액/영세율/VAT/청구_*/해운비원가(마진 역산 차단)·발행주체/결제방식/외부거래ID/페이앱_*·BL/CO/PI/면허파일·통관단계·메모·마스터BL파일 등.
  //   토큰 검증은 위에서 full fields로 이미 수행됨.
  const CUST_SHIP_WL = ['사서함', '상태', '고객응답일시', '배송방식', '선택FTA', '원산지증명서신청', '특이사항', '수취_수취인', '수취_회사', '수취_전화', '수취_주소', '수취_우편번호', '수취_통관부호', '환율CNY_USD', '환율USD_KRW'];
  if (ship && ship.fields) { const _o = {}; for (const k of CUST_SHIP_WL) { if (ship.fields[k] !== undefined) _o[k] = ship.fields[k]; } ship.fields = _o; }

  res.json({
    shipment: ship,
    products: products,
    boxes: boxes,
    boxAssignments: boxAssignments,
    customer: customer
  });
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const { shipmentId, token, response } = body;

  if (!shipmentId || !token || !response) {
    return res.status(400).json({ error: '필수 정보 누락' });
  }

  // 토큰 재검증
  const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
  if (ship.fields['고객토큰'] !== token) {
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }

  const today = new Date().toISOString();
  const rc = response.customer || {};

  // 작업1 안전망: Customers 사전 조회 → 수취_* 빈값일 때 폴백
  const shipName = ship.fields['사서함'];
  let custFields = {}, existingCust = null, custTable = null;
  try {
    const meta = await atRequest('GET', `/meta/bases/${BASE_ID}/tables`);
    custTable = (meta.tables || []).find(t => t.name === 'Customers');
    if (custTable) {
      const r = await atRequest('GET',
        `/${custTable.id}?filterByFormula=${encodeURIComponent(`{사서함번호}='${shipName}'`)}&maxRecords=1`);
      existingCust = r.records && r.records[0];
      if (existingCust) custFields = existingCust.fields || {};
    }
  } catch (e) { console.log('Customers 사전 조회 warning:', e.message); }

  const safe = (rcVal, ...cKeys) => {
    if (rcVal && String(rcVal).trim()) return rcVal;
    for (const k of cKeys) { const v = custFields[k]; if (v && String(v).trim()) return v; }
    return '';
  };

  // 1. Shipments — 고객 응답 + 수취정보 (3-Tier + 안전망)
  const shipFields = {
    '고객응답일시': today.slice(0, 10),
    '선택FTA': response.fta || '미선택',
    '배송방식': response.deliveryType || '미선택',
    '원산지증명서신청': !!response.coRequested,
    '특이사항': response.note || '',
    '수취_수취인':   safe(rc.name,      '회원명'),
    '수취_회사':     safe(rc.company,   '회사명'),
    '수취_전화':     safe(rc.phone,     '연락처', '전화번호'),
    '수취_주소':     safe(rc.address,   '주소'),
    '수취_우편번호': safe(rc.zipcode,   '우편번호'),
    '수취_통관부호': safe(rc.customsId, '통관고유부호')
  };

  await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
    fields: shipFields,
    typecast: true
  });

  // 2. Customers — 3-Tier: 회원 정보 불변, 마지막사용일만 갱신
  if (custTable && existingCust) {
    try {
      await atRequest('PATCH', `/${custTable.id}/${existingCust.id}`, {
        fields: { '마지막사용일': today.slice(0, 10) }
      });
    } catch (e) { console.log('Customer 마지막사용일 갱신 warning:', e.message); }
  }

  res.json({
    success: true,
    message: '응답이 정상적으로 저장되었습니다. 강하고 무역이 곧 진행 안내드리겠습니다.'
  });
}

// ===== [배송정보 1단계 — 고객 셀프 등록] 2026-06-30 =====
//   보안: 기존 고객페이지와 동일 토큰 모델(고객토큰 일치 + 고객토큰만료일 만료 + 토큰 ≥16자). invoice-view raw mailbox 패턴 미사용.
//   모드: Shipments.배송방식(택배/화물/밀크런) 단일. 쓰기 WL은 모드별 — 통관·금액·발행 필드 PATCH 불가(WL 밖 reject).

// 토큰 검증 단일 함수 — 통과 시 {ship}, 실패 시 {err:[status,msg]}.
async function validateDeliveryToken(shipId, token) {
  if (!shipId || !String(shipId).startsWith('rec')) return { err: [400, 'Invalid shipment id'] };
  if (!token || String(token).length < 16) return { err: [401, '유효하지 않은 접근 토큰입니다.'] };
  const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipId}`);
  const savedToken = ship.fields['고객토큰'];
  const expDate = ship.fields['고객토큰만료일'];
  if (!savedToken || savedToken !== token) return { err: [401, '유효하지 않은 토큰입니다.'] };
  if (expDate) {
    const exp = new Date(expDate); exp.setHours(23, 59, 59);   // 만료일 그날 끝까지 유효
    if (exp < new Date()) return { err: [403, '링크가 만료되었습니다 (만료일: ' + expDate + '). 강하고 무역에 재발송 요청해 주세요.'] };
  }
  return { ship };
}

// 모드 판별 — 택배면 '택배', 그 외(화물·밀크런·미선택)는 차량배송(화물 폼).
function deliveryMode(f) {
  return String((f || {})['배송방식'] || '').trim() === '택배' ? '택배' : '화물';
}

// 쓰기 WL — 모드별. 화물만 배송유형·하차지원 허용. 그 외 키는 전부 reject(통관·금액·발행 차단).
const DELIVERY_PATCH_WL = {
  '화물': new Set(['수취_수취인', '수취_회사', '수취_전화', '수취_주소', '수취_우편번호', '배송유형', '하차지원', '특이사항']),
  '택배': new Set(['수취_수취인', '수취_회사', '수취_전화', '수취_주소', '수취_우편번호', '특이사항']),
};

// op=customer_delivery_get — 토큰 검증 → 모드 + 기존 저장값(읽기 WL)만 반환.
async function handleDeliveryGet(req, res) {
  const v = await validateDeliveryToken(req.query.ship, req.query.t);
  if (v.err) return res.status(v.err[0]).json({ error: v.err[1] });
  const f = v.ship.fields || {};
  const READ_WL = ['배송방식', '수취_수취인', '수취_회사', '수취_전화', '수취_주소', '수취_우편번호', '특이사항', '배송유형', '하차지원', '상태'];
  const out = {}; for (const k of READ_WL) { if (f[k] !== undefined) out[k] = f[k]; }
  // [v3.2.219] 최종 IP(상업 인보이스·패킹) 다운로드 — 토큰 검증 통과한 ★이 사서함 것만. CO·BL·면허·마스터BL 등은 미제공(WL 밖).
  const _ip = Array.isArray(f['최종IP파일']) ? f['최종IP파일'] : [];
  const finalIp = _ip.map(a => ({ url: a.url, filename: a.filename || '최종IP.xlsx' })).filter(a => a.url);
  return res.json({ mode: deliveryMode(f), mailbox: f['사서함'] || '', fields: out, finalIp });
}

// op=customer_delivery_save — 토큰 재검증 → 모드별 쓰기 WL만 PATCH. 응답도 saved/rejected로 큐레이트.
async function handleDeliverySave(req, res, body) {
  const { shipmentId, token } = body;
  const fields = body.fields || {};
  const v = await validateDeliveryToken(shipmentId, token);
  if (v.err) return res.status(v.err[0]).json({ error: v.err[1] });
  const mode = deliveryMode(v.ship.fields);
  const wl = DELIVERY_PATCH_WL[mode] || new Set();
  const safe = {}, rejected = [];
  for (const k of Object.keys(fields)) { if (wl.has(k)) safe[k] = fields[k]; else rejected.push(k); }
  if (Object.keys(safe).length === 0) return res.status(400).json({ error: '허용 필드 없음', rejected });
  const updated = await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, { fields: safe, typecast: true });
  const echo = {}; Object.keys(safe).forEach(k => { echo[k] = (updated.fields || {})[k]; });
  return res.json({ ok: true, mode, saved: echo, rejected });
}
