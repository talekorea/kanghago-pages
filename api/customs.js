// 관세사 페이지 API
// GET  /api/customs?ship=recXXX → 사서함 + 제품 목록
// POST /api/customs → 제품 확정 저장 (학습 데이터 누적)

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
    return res.json({ shipment: ship, products: [], history: [], hsDict: await getHsDict() });
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
    hsDict: await getHsDict()
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
  }

  // Products 배치 업데이트
  for (let i = 0; i < updates.length; i += 10) {
    await atRequest('PATCH', `/${TABLES.Products}`, {
      records: updates.slice(i, i + 10)
    });
  }

  // ProductHistory + HSMapping 학습 누적 (도구 v2.9.10의 learnFromConfirmation과 동일 로직)
  // Products 업데이트 실패해도 사서함 상태 변경은 진행하기 위해 try/catch로 보호
  try {
    await learnFromConfirmation(products, customsName, today);
  } catch (e) {
    console.error('learn step failed (continuing):', e.message);
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

// 도구 v2.9.10의 learnFromConfirmation 로직 (3603~3700번 줄)과 동기화
// ProductHistory: 제품링크 키로 upsert (한국어명_별칭, 사용횟수, 마지막사용일 누적)
// HSMapping: HS코드 키로 upsert (사용횟수, 마지막사용일 갱신)
async function learnFromConfirmation(products, customsName, today) {
  // ── 1) ProductHistory 누적 ──
  try {
    const meta = await atRequest('GET', `/meta/bases/${BASE_ID}/tables`);
    const phTable = (meta.tables || []).find(t => t.name === 'ProductHistory');
    if (phTable) {
      const phRecords = await atListAll(`/${phTable.id}?pageSize=100`);
      const byLink = {};
      phRecords.forEach(r => {
        const link = (r.fields['제품링크'] || '').trim();
        if (link) byLink[link] = r;
      });

      for (const p of products) {
        const link = (p.제품링크 || '').trim();
        if (!link || !p.영문명 || !p.HS코드) continue;

        const fields = {
          '제품링크': link,
          '한국어명': p.한국어명 || '',
          '영문명': p.영문명,
          'HS코드': p.HS코드,
          'Material': p.Material || '',
          '마지막사용일': today,
          '확정한관세사': customsName || ''
        };
        if (p.메모) fields['메모'] = p.메모;

        const existingRec = byLink[link];
        if (existingRec) {
          // 한국어명이 바뀌면 이전 이름을 별칭에 누적
          if (p.한국어명 && p.한국어명 !== existingRec.fields['한국어명']) {
            const aliases = (existingRec.fields['한국어명_별칭'] || '').split('\n').filter(Boolean);
            if (existingRec.fields['한국어명'] && !aliases.includes(existingRec.fields['한국어명'])) {
              aliases.push(existingRec.fields['한국어명']);
            }
            fields['한국어명_별칭'] = aliases.join('\n');
          }
          fields['사용횟수'] = (existingRec.fields['사용횟수'] || 0) + 1;
          try {
            await atRequest('PATCH', `/${phTable.id}/${existingRec.id}`, { fields });
          } catch (e) {
            console.log('PH update fail:', link, e.message);
          }
        } else {
          fields['사용횟수'] = 1;
          fields['첫사용일'] = today;
          try {
            await atRequest('POST', `/${phTable.id}`, { fields });
          } catch (e) {
            console.log('PH create fail:', link, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('ProductHistory learn error:', e.message);
  }

  // ── 2) HSMapping 누적 ──
  try {
    const hsRecords = await atListAll(`/${TABLES.HSMapping}?pageSize=100`);
    const byCode = {};
    hsRecords.forEach(r => {
      const code = (r.fields['HS코드'] || '').trim();
      if (code) byCode[code] = r;
    });

    for (const p of products) {
      const code = (p.HS코드 || '').trim();
      if (!code) continue;

      const existingRec = byCode[code];
      if (existingRec) {
        const cur = existingRec.fields['사용횟수'] || 0;
        try {
          await atRequest('PATCH', `/${TABLES.HSMapping}/${existingRec.id}`, {
            fields: { '사용횟수': cur + 1, '마지막사용일': today }
          });
        } catch (e) {
          console.log('HS update fail:', code, e.message);
        }
      } else {
        try {
          await atRequest('POST', `/${TABLES.HSMapping}`, {
            fields: {
              'HS코드': code,
              '영문명': p.영문명 || '',
              '한국어명': p.한국어명 || '',
              'Material': p.Material || '',
              '사용횟수': 1,
              '마지막사용일': today
            }
          });
        } catch (e) {
          console.log('HS create fail:', code, e.message);
        }
      }
    }
  } catch (e) {
    console.error('HSMapping learn error:', e.message);
  }
}

// HSMapping 테이블 전체를 Airtable에서 동적 로드 (관세사 페이지 자동완성용)
// 도구가 누적한 HS 사전(현재 175개+)을 그대로 활용. 실패 시 핵심 5개 폴백.
async function getHsDict() {
  try {
    const records = await atListAll(`/${TABLES.HSMapping}?pageSize=100`);
    const dict = {};
    for (const r of records) {
      const code = (r.fields['HS코드'] || '').trim();
      if (!code) continue;
      dict[code] = {
        en: r.fields['영문명'] || '',
        ko: r.fields['한국어명'] || r.fields['한글명'] || '',
        material: r.fields['Material'] || '',
        base: r.fields['기본세율'] || 0,
        kc: r.fields['FTA_한중'] || 0,
        apta: r.fields['FTA_아태'] || 0,
        uses: r.fields['사용횟수'] || 0
      };
    }
    if (Object.keys(dict).length > 0) return dict;
  } catch (e) {
    console.error('HSMapping load failed, using fallback:', e.message);
  }
  // 폴백: 핵심 5개만
  return {
    '6116.10-0000': { en: 'Gloves, mittens and mitts, knitted, impregnated with plastics or rubber', material: 'cotton', base: 13, kc: 0, apta: 8 },
    '8518.30-0000': { en: 'Headphones and earphones, whether or not combined with a microphone', material: 'plastic', base: 8, kc: 0, apta: 5 },
    '3923.21-0000': { en: 'Sacks and bags of polymers of ethylene', material: 'plastic', base: 8, kc: 0, apta: 5 },
    '6109.10-0000': { en: 'T-shirts, singlets and other vests, of cotton, knitted', material: 'cotton', base: 13, kc: 0, apta: 8 },
    '6104.43-0000': { en: 'Dresses, of synthetic fibres, knitted', material: 'synthetic fibre', base: 13, kc: 0, apta: 8 }
  };
}
