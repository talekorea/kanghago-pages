// 고객 페이지 API
// GET  /api/customer?t=token&ship=recXXX → 사서함 + 제품 + 박스 + 고객정보
// POST /api/customer → 고객 응답 저장 (FTA / 배송방식 / 수취 / 특이사항)

const { atRequest, atListAll, handleCors, readBody, TABLES, BASE_ID } = require('./_lib');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }
    if (req.method === 'POST') {
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

  // 1. Shipments 업데이트 (고객 응답 + 이번 배송 수취정보 — P0-A 3-Tier)
  const rc = response.customer || {};
  const shipFields = {
    '고객응답일시': today.slice(0, 10),
    '선택FTA': response.fta || '미선택',
    '배송방식': response.deliveryType || '미선택',
    '원산지증명서신청': !!response.coRequested,
    '특이사항': response.note || '',
    '수취_수취인': rc.name || '',
    '수취_회사': rc.company || '',
    '수취_전화': rc.phone || '',
    '수취_주소': rc.address || '',
    '수취_우편번호': rc.zipcode || '',
    '수취_통관부호': rc.customsId || ''
  };

  await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
    fields: shipFields,
    typecast: true
  });

  // 2. Customers — P0-A 3-Tier: 회원 정보 불변. 마지막사용일만 갱신.
  try {
    const meta = await atRequest('GET', `/meta/bases/${BASE_ID}/tables`);
    const custTable = (meta.tables || []).find(t => t.name === 'Customers');
    if (custTable) {
      const shipName = ship.fields['사서함'];
      const custUrl = `/${custTable.id}?filterByFormula=${encodeURIComponent(`{사서함번호}='${shipName}'`)}&maxRecords=1`;
      const existRes = await atRequest('GET', custUrl);
      const existingCust = existRes.records && existRes.records[0];
      if (existingCust) {
        await atRequest('PATCH', `/${custTable.id}/${existingCust.id}`, {
          fields: { '마지막사용일': today.slice(0, 10) }
        });
      }
    }
  } catch (e) {
    console.log('Customer 마지막사용일 갱신 warning:', e.message);
  }

  res.json({
    success: true,
    message: '응답이 정상적으로 저장되었습니다. 강하고 무역이 곧 진행 안내드리겠습니다.'
  });
}
