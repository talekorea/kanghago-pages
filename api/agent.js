// Phase E: 관세사 포털 API (Supabase Auth 기반)
//
// 인증: Authorization: Bearer <Supabase access_token (JWT)>
//   → Supabase Auth /auth/v1/user 로 검증 → customs_agents 조회 → active 확인
//
// 엔드포인트 (op 라우팅 — 한 함수에서):
//   GET  /api/agent?op=me                       → 현재 관세사 정보
//   GET  /api/agent?op=list                     → 관세사확정대기/완료 사서함 목록
//   GET  /api/agent?op=shipment&id=recXXX       → 특정 사서함 + 제품 목록
//   POST /api/agent { op:'product_patch', shipmentId, productId, fields } → 제한된 필드만 PATCH
//   POST /api/agent { op:'confirm_shipment', shipmentId } → 사서함 상태 '관세사확정완료'
//
// PATCH 허용 필드 (그 외는 거부):
//   영문명 (Description) · HS코드 · 적용FTA · 기본세율 · FTA_한중 · Material · 관세사확정
//
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY, AIRTABLE_PAT, AIRTABLE_BASE_ID

const { handleCors, readBody, atRequest, atListAll, TABLES, BASE_ID } = require('./_lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// PATCH 가능 필드 화이트리스트 (Products 테이블)
const ALLOWED_PRODUCT_FIELDS = new Set([
  'Description', '영문명', 'HS코드', '적용FTA', '기본세율', 'FTA_한중',
  'FTA_RCEP중국', 'Material', '재질', '관세사확정', '통관품명_영문', '품명_확정',
]);

// Supabase Auth: access_token 검증 → user 객체
async function verifySupabaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Authorization Bearer 토큰 필요'); err.status = 401; throw err;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const err = new Error('Supabase 환경변수 미설정'); err.status = 500; throw err;
  }
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) {
    const err = new Error('유효하지 않은 토큰입니다 (재로그인 필요)'); err.status = 401; throw err;
  }
  return await r.json();  // { id, email, ... }
}

// customs_agents 조회 + active 확인 — last_login_at 자동 갱신
async function loadAgent(userId, email) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/customs_agents?id=eq.${userId}&select=id,email,name,active`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!r.ok) { const err = new Error('관세사 조회 실패'); err.status = 500; throw err; }
  const rows = await r.json();
  if (!rows.length) {
    const err = new Error('등록되지 않은 관세사입니다 (강하고 관리자에게 계정 발급 요청)');
    err.status = 403; throw err;
  }
  const agent = rows[0];
  if (!agent.active) {
    const err = new Error('비활성 관세사 계정입니다'); err.status = 403; throw err;
  }
  // last_login_at 갱신 (실패해도 진행)
  fetch(`${SUPABASE_URL}/rest/v1/customs_agents?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_login_at: new Date().toISOString() }),
  }).catch(() => {});
  return agent;
}

// 감사 로그 (실패해도 진행 — 비핵심)
async function logAction(agent, shipmentId, productId, before, after) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/customs_actions`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id, agent_email: agent.email,
        shipment_id: shipmentId, product_id: productId,
        fields_before: before, fields_after: after,
      }),
    });
  } catch (e) { console.warn('[agent] audit log 실패:', e.message); }
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  try {
    const user = await verifySupabaseToken(req.headers.authorization || req.headers.Authorization);
    const agent = await loadAgent(user.id, user.email);

    if (req.method === 'GET') {
      const op = req.query.op || 'me';
      if (op === 'me') {
        return res.json({ agent: { email: agent.email, name: agent.name, active: agent.active } });
      }
      if (op === 'list') {
        // 관세사확정대기/완료 사서함 목록
        const filter = encodeURIComponent('OR({상태}="관세사확정대기",{상태}="관세사확정완료")');
        const url = `/${TABLES.Shipments}?filterByFormula=${filter}&fields[]=사서함&fields[]=상태&fields[]=출고요청일`;
        const recs = await atListAll(url);
        return res.json({ count: recs.length, shipments: recs.map(r => ({ id: r.id, fields: r.fields })) });
      }
      if (op === 'shipment') {
        const shipId = req.query.id;
        if (!shipId || !shipId.startsWith('rec')) return res.status(400).json({ error: 'Invalid shipment id' });
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipId}`);
        if (!['관세사확정대기', '관세사확정완료'].includes(ship.fields['상태'])) {
          return res.status(403).json({ error: '관세사 작업 대상이 아닙니다 (상태: ' + ship.fields['상태'] + ')' });
        }
        const shipName = ship.fields['사서함'];
        const orderUrl = `/${TABLES.Orders}?filterByFormula=${encodeURIComponent(`SEARCH('${shipName}',ARRAYJOIN({Shipment}))`)}`;
        const orders = await atListAll(orderUrl);
        const prodIds = [];
        orders.forEach(o => (o.fields['Products'] || []).forEach(pid => prodIds.push(pid)));
        let products = [];
        if (prodIds.length) {
          const filter = 'OR(' + prodIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
          products = await atListAll(`/${TABLES.Products}?filterByFormula=${encodeURIComponent(filter)}`);
        }
        return res.json({ shipment: ship, products, orders });
      }
      return res.status(400).json({ error: 'Unknown op' });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const op = body.op;

      if (op === 'product_patch') {
        const { shipmentId, productId, fields } = body;
        if (!shipmentId || !productId || !fields) return res.status(400).json({ error: '필수 정보 누락' });
        // 화이트리스트 검증
        const safe = {};
        const rejected = [];
        for (const k of Object.keys(fields)) {
          if (ALLOWED_PRODUCT_FIELDS.has(k)) safe[k] = fields[k];
          else rejected.push(k);
        }
        if (Object.keys(safe).length === 0) {
          return res.status(400).json({ error: '허용 필드 없음', rejected });
        }
        // 사서함 상태 검증
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
        if (!['관세사확정대기', '관세사확정완료'].includes(ship.fields['상태'])) {
          return res.status(403).json({ error: '관세사 작업 대상이 아닙니다' });
        }
        // 변경 전 상태 조회 (감사 로그)
        const before = await atRequest('GET', `/${TABLES.Products}/${productId}`);
        const beforeSafe = {};
        Object.keys(safe).forEach(k => { beforeSafe[k] = before.fields[k]; });
        // PATCH
        const updated = await atRequest('PATCH', `/${TABLES.Products}/${productId}`, {
          fields: safe, typecast: true,
        });
        // 감사 로그
        await logAction(agent, shipmentId, productId, beforeSafe, safe);
        return res.json({ ok: true, updated: updated.fields, rejected });
      }

      if (op === 'confirm_shipment') {
        const { shipmentId } = body;
        if (!shipmentId) return res.status(400).json({ error: 'shipmentId 누락' });
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
        if (ship.fields['상태'] !== '관세사확정대기') {
          return res.status(409).json({ error: '상태 불일치 — 현재: ' + ship.fields['상태'] });
        }
        await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
          fields: { '상태': '관세사확정완료' }, typecast: true,
        });
        await logAction(agent, shipmentId, null, { '상태': '관세사확정대기' }, { '상태': '관세사확정완료' });
        return res.json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown op' });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[agent] error:', e);
    res.status(status).json({ error: e.message || String(e) });
  }
};
