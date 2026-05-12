// 관세사 페이지 API
// GET  /api/customs?ship=recXXX → 사서함 + 제품 목록
// POST /api/customs → 제품 확정 저장 (학습 데이터 누적)

const { atRequest, atListAll, handleCors, readBody, TABLES } = require('./_lib');

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
    console.error('Customs API error:', e);
    res.status(500).json({ error: e.message });
  }
};

async function handleGet(req, res) {
  const shipId = req.query.ship;
  if (!shipId || !shipId.startsWith('rec')) {
    return res.status(400).json({ error: 'Invalid shipment id' });
  }

  // 1. 사서함 정보
  const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipId}`);
  const shipName = ship.fields['사서함'];
  const status = ship.fields['상태'];

  if (!['관세사확정대기', '관세사확정완료'].includes(status)) {
    return res.status(403).json({ error: '이 사서함은 관세사 확정 단계가 아닙니다. (상태: ' + status + ')' });
  }

  // 2. Orders 조회 (Shipment 단수형 필드)
  const orderUrl = `/${TABLES.Orders}?filterByFormula=${encodeURIComponent(`SEARCH('${shipName}',ARRAYJOIN({Shipment}))`)}`;
  const orders = await atListAll(orderUrl);

  // 3. Product IDs 수집
  const prodIds = [];
  orders.forEach(o => {
    (o.fields['Products'] || []).forEach(pid => prodIds.push(pid));
  });

  if (prodIds.length === 0) {
    return res.json({ shipment: ship, products: [], history: [], hsDict: getHsDict() });
  }

  // 4. Products 조회
  const prodFilter = 'OR(' + prodIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
  const products = await atListAll(`/${TABLES.Products}?filterByFormula=${encodeURIComponent(prodFilter)}`);

  // 5. ProductHistory 조회 (자동 매칭용)
  let history = [];
  try {
    // ProductHistory 테이블 찾기
    const meta = await atRequest('GET', `/meta/bases/${require('./_lib').BASE_ID}/tables`);
    const phTable = (meta.tables || []).find(t => t.name === 'ProductHistory');
    if (phTable) {
      history = await atListAll(`/${phTable.id}?pageSize=100`);
    }
  } catch (e) {
    console.log('ProductHistory not found, skipping');
  }

  res.json({
    shipment: ship,
    products: products,
    history: history,
    hsDict: getHsDict()
  });
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const { shipmentId, products, customsName } = body;

  if (!shipmentId || !products || !Array.isArray(products)) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const updates = [];
  const historyUpdates = [];

  for (const p of products) {
    if (!p.id || !p.영문명 || !p.HS코드) continue;

    // Products 업데이트
    updates.push({
      id: p.id,
      fields: {
        '통관품명_영문': p.영문명,
        'Description': p.영문명,
        'HS코드': p.HS코드,
        'Material': p.Material || '',
        '관세사확정': true,
        '관세사확정일시': today,
        '관세사메모': p.메모 || ''
      }
    });

    // ProductHistory 누적 데이터 (간소화 - 메인 도구가 본격 누적)
    historyUpdates.push({
      제품링크: p.제품링크 || '',
      한국어명: p.한국어명 || '',
      영문명: p.영문명,
      HS코드: p.HS코드,
      Material: p.Material || '',
      관세사: customsName || ''
    });
  }

  // Products 배치 업데이트
  for (let i = 0; i < updates.length; i += 10) {
    await atRequest('PATCH', `/${TABLES.Products}`, {
      records: updates.slice(i, i + 10)
    });
  }

  // Shipment 상태 변경
  await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
    fields: { '상태': '관세사확정완료' }
  });

  res.json({
    success: true,
    confirmed: updates.length,
    message: `${updates.length}개 제품 확정 완료. 사서함이 "관세사확정완료" 상태로 변경되었습니다.`
  });
}

// 175개 HS 사전은 메인 도구에 있음. 외부 페이지는 핵심 항목만 가지고 운영.
// 더 확실한 방법: 메인 도구가 한 번 동기화 시키거나, 별도 API 호출
function getHsDict() {
  // 자주 사용되는 HS 코드 일부 (운영하면서 확장 예정)
  return {
    '6116.10-0000': { en: 'Gloves, mittens and mitts, knitted, impregnated with plastics or rubber', material: 'cotton', base: 13, kc: 0, apta: 8 },
    '8518.30-0000': { en: 'Headphones and earphones, whether or not combined with a microphone', material: 'plastic', base: 8, kc: 0, apta: 5 },
    '3923.21-0000': { en: 'Sacks and bags of polymers of ethylene', material: 'plastic', base: 8, kc: 0, apta: 5 },
    '6109.10-0000': { en: 'T-shirts, singlets and other vests, of cotton, knitted', material: 'cotton', base: 13, kc: 0, apta: 8 },
    '6104.43-0000': { en: 'Dresses, of synthetic fibres, knitted', material: 'synthetic fibre', base: 13, kc: 0, apta: 8 }
  };
}
