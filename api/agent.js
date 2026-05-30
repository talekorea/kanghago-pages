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
// 작업2: 아태세율(E1, APTA) 추가 + 관세사확정일시 + 사용횟수/마지막사용일시(자동완성 누적)
const ALLOWED_PRODUCT_FIELDS = new Set([
  'Description', '영문명', 'HS코드', '적용FTA', '기본세율', 'FTA_한중',
  'FTA_RCEP중국', '아태세율', 'Material', '재질', '관세사확정',
  '관세사확정일시', '관세사메모', '통관품명_영문', '품명_확정',
  '사용횟수', '마지막사용일시',
  '적용세율', '추천FTA',   // FTA 자동 추천: 적용세율 + 추천 추적 (관세사 변경 여부)
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
  const hdr = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/customs_agents?id=eq.${userId}&select=id,email,name,active`, { headers: hdr });
  if (!r.ok) { const err = new Error('관세사 조회 실패'); err.status = 500; throw err; }
  let rows = await r.json();
  let matchedByEmail = false;
  // I3: id 매칭 실패 시 email 폴백 — auth user id 불일치(재초대 등)로 권한 인식 끊기는 문제 복구
  if (!rows.length && email) {
    const r2 = await fetch(
      `${SUPABASE_URL}/rest/v1/customs_agents?email=eq.${encodeURIComponent(email)}&select=id,email,name,active`,
      { headers: hdr });
    if (r2.ok) { rows = await r2.json(); matchedByEmail = rows.length > 0; }
  }
  if (!rows.length) {
    const err = new Error('등록되지 않은 관세사입니다 (강하고 관리자에게 계정 발급 요청)');
    err.status = 403; throw err;
  }
  const agent = rows[0];
  if (!agent.active) {
    const err = new Error('비활성 관세사 계정입니다'); err.status = 403; throw err;
  }
  // last_login_at 갱신 (id 또는 email 기준 — 실패해도 진행)
  const filter = matchedByEmail ? `email=eq.${encodeURIComponent(email)}` : `id=eq.${userId}`;
  fetch(`${SUPABASE_URL}/rest/v1/customs_agents?${filter}`, {
    method: 'PATCH',
    headers: { ...hdr, 'Content-Type': 'application/json' },
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

// ===== 학습 엔진 (관세사 확정 시 ProductHistory + HSMapping 누적) =====
// 인보이스 도구 learnFromConfirmation + saveAll hsToUpsert 규칙을 백엔드로 이식.
// 학습은 부가 작업 — 실패해도 product_patch(Products 저장)는 성공 유지(throw 안 함).
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

// HS 키: 인보이스 도구 makeHsKey와 동일 정규화 (영문명 끝 슬래시 무시 + 소문자, 재질 소문자)
function makeHsKey(description, material) {
  const d = String(description || '').replace(/\s*\/\s*$/, '').trim().toLowerCase();
  const m = String(material || '').trim().toLowerCase();
  return d + '|' + m;
}

// ProductHistory 테이블 ID — _lib TABLES에 없어 meta API로 1회 발견 + 모듈 캐시
let _phTableId;   // undefined=미조회, null=없음, 'tbl..'=발견
async function getProductHistoryTableId() {
  if (_phTableId !== undefined) return _phTableId;
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` },
    });
    if (!r.ok) { _phTableId = null; return null; }
    const meta = await r.json();
    const t = (meta.tables || []).find(x => x.name === 'ProductHistory');
    _phTableId = t ? t.id : null;
  } catch (e) { console.warn('[learn] ProductHistory ID 조회 실패:', e.message); _phTableId = null; }
  return _phTableId;
}

async function learnFromConfirmation(pd) {
  // 1) ProductHistory upsert (제품링크 키 / 사용횟수+1 / 한국어명 변형은 별칭 누적)
  try {
    const phId = await getProductHistoryTableId();
    if (phId) {
      const today = new Date().toISOString().slice(0, 10);
      const link = String(pd.제품링크 || '').trim();
      let existing = null;
      if (link) {
        const f = `{제품링크}='${link.replace(/'/g, "\\'")}'`;
        const recs = await atListAll(`/${phId}?filterByFormula=${encodeURIComponent(f)}&maxRecords=1`);
        existing = recs[0] || null;
      }
      const fields = {
        '제품링크': link,
        '한국어명': pd.한국어명 || '',
        '영문명': pd.영문명 || '',
        'HS코드': pd.HS코드 || '',
        'Material': pd.Material || '',
        '적용FTA': pd.적용FTA || '없음',
        '마지막사용일': today,
        '확정한관세사': pd.관세사 || '',
      };
      if (existing) {
        const ef = existing.fields || {};
        if (pd.한국어명 && pd.한국어명 !== ef['한국어명']) {
          const aliases = (ef['한국어명_별칭'] || '').split('\n').filter(Boolean);
          if (ef['한국어명'] && !aliases.includes(ef['한국어명'])) aliases.push(ef['한국어명']);
          fields['한국어명_별칭'] = aliases.join('\n');
        }
        fields['사용횟수'] = (ef['사용횟수'] || 0) + 1;
        await atRequest('PATCH', `/${phId}/${existing.id}`, { fields, typecast: true });
      } else {
        fields['사용횟수'] = 1;
        fields['첫사용일'] = today;
        await atRequest('POST', `/${phId}`, { fields, typecast: true });
      }
    }
  } catch (e) { console.warn('[learn] ProductHistory 누적 실패:', e.message); }

  // 2) HSMapping upsert (키=영문명+재질 → HS코드 + 세율 기본/한중/RCEP/아태). 사용횟수는 보존(performUpsert는 제공 필드만 갱신)
  try {
    const desc = String(pd.영문명 || '').trim();
    const code = String(pd.HS코드 || '').trim();
    if (desc && code) {
      const fields = {
        '키': makeHsKey(desc, pd.Material),
        'Description': desc,
        'Material': pd.Material || '',
        'HS코드': code,
        '통관품명_한글': pd.한국어명 || '',
        '마지막사용일': new Date().toISOString().slice(0, 10),
      };
      // 세율: 값 있을 때만 (아태세율 포함, RCEP와 분리 — 각자 자기 키)
      if (pd.기본세율 != null && pd.기본세율 !== '') fields['기본세율'] = parseFloat(pd.기본세율);
      if (pd.FTA_한중 != null && pd.FTA_한중 !== '') fields['FTA_한중'] = parseFloat(pd.FTA_한중);
      if (pd.FTA_RCEP중국 != null && pd.FTA_RCEP중국 !== '') fields['FTA_RCEP중국'] = parseFloat(pd.FTA_RCEP중국);
      if (pd.아태세율 != null && pd.아태세율 !== '') fields['아태세율'] = parseFloat(pd.아태세율);
      await atRequest('PATCH', `/${TABLES.HSMapping}`, {
        performUpsert: { fieldsToMergeOn: ['키'] },
        typecast: true,
        records: [{ fields }],
      });
    }
  } catch (e) { console.warn('[learn] HSMapping 누적 실패:', e.message); }
}

// ===== Stage 2: 관리자(사장님) op — Authorization: Admin <ADMIN_INVITE_TOKEN> =====
const ADMIN_TOKEN = process.env.ADMIN_INVITE_TOKEN;

function verifyAdmin(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  if (!h.startsWith('Admin ')) { const e = new Error('관리자 인증 필요'); e.status = 401; throw e; }
  if (!ADMIN_TOKEN) { const e = new Error('ADMIN_INVITE_TOKEN 환경변수 미설정'); e.status = 500; throw e; }
  if (h.slice(6) !== ADMIN_TOKEN) { const e = new Error('관리자 토큰 불일치'); e.status = 403; throw e; }
}

// I3: 초대 클릭 후 바로 대시보드로 (redirect_to 미설정 시 Supabase Site URL로 빠져 세션 처리 실패 → 재인증 반복 원인)
const AGENT_DASHBOARD_URL = 'https://kanghago-pages.vercel.app/agent-dashboard.html';

async function adminInviteAgent(email, name) {
  // 1) Supabase Auth — 초대 (계정 신규 생성). redirect_to를 대시보드로 명시
  const r1 = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, data: { name }, redirect_to: AGENT_DASHBOARD_URL }),
  });
  const auth = await r1.json();
  if (!r1.ok) {
    // 이미 존재하는 사용자 — get user 시도
    if (r1.status === 422 || (auth.msg || auth.error || '').includes('already')) {
      const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?filter=email=eq.${encodeURIComponent(email)}`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      });
      const data = await list.json();
      const existing = (data.users || [])[0];
      if (!existing) throw new Error('초대 실패 + 기존 사용자 조회 실패: ' + JSON.stringify(auth));
      // 기존 사용자 — customs_agents에만 등록
      return await upsertCustomsAgent(existing.id, email, name);
    }
    throw new Error('Supabase invite 실패: ' + (auth.msg || auth.error || r1.status));
  }
  const userId = auth.id || (auth.user && auth.user.id);
  if (!userId) throw new Error('초대 응답에 user.id 없음');
  return await upsertCustomsAgent(userId, email, name);
}

async function upsertCustomsAgent(userId, email, name) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/customs_agents?on_conflict=id`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify({ id: userId, email, name: name || null, active: true }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('customs_agents upsert 실패: ' + JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

async function adminListAgents() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/customs_agents?select=id,email,name,active,created_at,last_login_at&order=created_at.desc`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error('관세사 목록 조회 실패 HTTP ' + r.status);
  return await r.json();
}

async function adminToggleAgent(agentId, active) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/customs_agents?id=eq.${agentId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation',
    },
    body: JSON.stringify({ active: !!active }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('관세사 활성 토글 실패: ' + JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

// ===== 계획 1단계: 비밀번호 방식 (매직링크 admin_invite와 공존 — 롤백 경로 유지) =====
// 이메일로 auth 사용자 조회 (admin API)
// 주의: GoTrue /admin/users 의 ?filter= 는 신뢰성이 없어(빈 결과 반환) 사용 금지.
//   → 사용자 목록을 page 순회하며 이메일 정확 매칭(소문자 비교)으로 찾는다.
async function findAuthUserByEmail(email) {
  const target = (email || '').trim().toLowerCase();
  if (!target) return null;
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error('Auth 사용자 목록 조회 실패 HTTP ' + r.status);
    const data = await r.json();
    const users = Array.isArray(data) ? data : (data.users || []);
    const hit = users.find(u => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) break;  // 마지막 페이지
  }
  return null;
}

// 기존 auth 사용자 비밀번호 설정/재설정 (admin API) — email_confirm:true로 비번 로그인 가능 보장
async function adminSetUserPassword(userId, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, email_confirm: true }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('비밀번호 설정 실패: ' + JSON.stringify(data));
  return data;
}

// 비밀번호 포함 관세사 신규 생성 (이미 존재하면 비번만 설정) + customs_agents 등록(active:true)
async function adminCreateAgentWithPassword(email, name, password) {
  const r1 = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }),
  });
  const auth = await r1.json();
  if (!r1.ok) {
    const exists = r1.status === 422 || /already|exist|registered/i.test(auth.msg || auth.error_description || auth.error || '');
    if (exists) {
      const existing = await findAuthUserByEmail(email);
      if (!existing) throw new Error('생성 실패 + 기존 사용자 조회 실패: ' + JSON.stringify(auth));
      await adminSetUserPassword(existing.id, password);   // 기존 계정에 비밀번호 부여
      return await upsertCustomsAgent(existing.id, email, name);
    }
    throw new Error('Supabase 사용자 생성 실패: ' + (auth.msg || auth.error_description || auth.error || r1.status));
  }
  const userId = auth.id || (auth.user && auth.user.id);
  if (!userId) throw new Error('생성 응답에 user.id 없음');
  return await upsertCustomsAgent(userId, email, name);
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  try {
    // ===== 관리자 op (Authorization: Admin <token>) =====
    const authH = req.headers.authorization || req.headers.Authorization || '';
    if (authH.startsWith('Admin ')) {
      verifyAdmin(req);
      if (req.method === 'GET' && req.query.op === 'admin_list') {
        const agents = await adminListAgents();
        return res.json({ agents });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.op === 'admin_invite') {
          const { email, name } = body;
          if (!email) return res.status(400).json({ error: 'email 필수' });
          const agent = await adminInviteAgent(String(email).trim().toLowerCase(), name || null);
          return res.json({ ok: true, agent });
        }
        if (body.op === 'admin_toggle') {
          const { agentId, active } = body;
          if (!agentId) return res.status(400).json({ error: 'agentId 필수' });
          const agent = await adminToggleAgent(agentId, !!active);
          return res.json({ ok: true, agent });
        }
        // 계획 1단계: 비밀번호 포함 신규 생성 (매직링크 admin_invite와 공존)
        if (body.op === 'admin_create') {
          const { email, name, password } = body;
          if (!email) return res.status(400).json({ error: 'email 필수' });
          if (!password || String(password).length < 6) return res.status(400).json({ error: 'password 6자 이상 필수' });
          const agent = await adminCreateAgentWithPassword(String(email).trim().toLowerCase(), name || null, String(password));
          return res.json({ ok: true, agent });
        }
        // 계획 1단계: 기존 관세사 비밀번호 설정/재설정 (강지훈 등 기존 계정 마이그레이션용)
        if (body.op === 'admin_set_password') {
          const { email, agentId, password } = body;
          if (!password || String(password).length < 6) return res.status(400).json({ error: 'password 6자 이상 필수' });
          let userId = agentId, agentEmail = email;
          if (!userId) {
            if (!email) return res.status(400).json({ error: 'email 또는 agentId 필요' });
            const u = await findAuthUserByEmail(String(email).trim().toLowerCase());
            if (!u) return res.status(404).json({ error: '해당 이메일의 사용자 없음' });
            userId = u.id; agentEmail = u.email;
          }
          await adminSetUserPassword(userId, String(password));
          return res.json({ ok: true, userId, email: agentEmail });
        }
      }
      return res.status(400).json({ error: 'Unknown admin op' });
    }

    // ===== 관세사 op (Authorization: Bearer <Supabase JWT>) =====
    const user = await verifySupabaseToken(authH);
    const agent = await loadAgent(user.id, user.email);

    if (req.method === 'GET') {
      const op = req.query.op || 'me';
      if (op === 'me') {
        return res.json({ agent: { email: agent.email, name: agent.name, active: agent.active } });
      }
      if (op === 'list') {
        // v3.2.7+ (2026-05-30): filter 자체 제거 — 회의 결정 "모든 상태가 관세사 페이지에 표시·작업 가능".
        //   출고요청·박스확정·관세사확정대기·관세사확정완료·인보이스완료·통관중·통관완료·배송중·출고완료·입금완료 등 모두 list에.
        //   관세사 페이지의 탭이 시각 필터링 담당. API는 차단 안 함.
        const url = `/${TABLES.Shipments}?fields[]=사서함&fields[]=상태&fields[]=출고요청일`;
        const recs = await atListAll(url);
        return res.json({ count: recs.length, shipments: recs.map(r => ({ id: r.id, fields: r.fields })) });
      }
      if (op === 'search_products') {
        // 자동완성: 영문명/HS/한글명 부분 일치 → 사용횟수 DESC + 마지막사용일시 DESC
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ products: [] });
        const qEsc = q.toLowerCase().replace(/'/g, "\\'");
        const f = `OR(FIND('${qEsc}',LOWER({Description}&'')),FIND('${qEsc}',LOWER({HS코드}&'')),FIND('${qEsc}',LOWER({통관품명_한글}&'')))`;
        const url = `/${TABLES.Products}?filterByFormula=${encodeURIComponent(f)}`
          + `&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('사용횟수')}&sort%5B0%5D%5Bdirection%5D=desc`
          + `&sort%5B1%5D%5Bfield%5D=${encodeURIComponent('마지막사용일시')}&sort%5B1%5D%5Bdirection%5D=desc`
          + `&maxRecords=10`;
        let recs = [];
        try { recs = await atListAll(url); } catch (e) { console.warn('[agent search] ', e.message); }
        // 화이트리스트 필드만 반환 (관세사에게 노출 안전한 필드)
        const PICK = ['Description', '통관품명_한글', 'HS코드', 'Material', '기본세율', 'FTA_한중',
                      '아태세율', 'FTA_RCEP중국', '적용FTA', '사용횟수', '마지막사용일시', '이미지URL', '제품링크'];
        const safe = recs.map(r => {
          const out = {};
          PICK.forEach(k => { if (r.fields[k] !== undefined) out[k] = r.fields[k]; });
          return { id: r.id, fields: out };
        });
        return res.json({ products: safe });
      }
      if (op === 'hs_rates') {
        // HS코드 → HSMapping 세율 조회 (학습값 재사용). 세율 있는 행 우선, 사용횟수 많은 것.
        const code = String(req.query.code || '').trim();
        if (!code) return res.json({ rates: null });
        const f = `{HS코드}='${code.replace(/'/g, "\\'")}'`;
        let recs = [];
        try { recs = await atListAll(`/${TABLES.HSMapping}?filterByFormula=${encodeURIComponent(f)}`); }
        catch (e) { console.warn('[agent hs_rates]', e.message); }
        const withRates = recs.map(r => r.fields)
          .filter(rf => rf['기본세율'] != null || rf['FTA_한중'] != null || rf['아태세율'] != null)
          .sort((a, b) => (b['사용횟수'] || 0) - (a['사용횟수'] || 0));
        const rf = withRates[0] || (recs[0] && recs[0].fields);
        if (!rf) return res.json({ rates: null });
        return res.json({
          rates: {
            기본세율: rf['기본세율'] ?? null,
            FTA_한중: rf['FTA_한중'] ?? null,
            FTA_RCEP중국: rf['FTA_RCEP중국'] ?? null,
            아태세율: rf['아태세율'] ?? null,
          },
          description: rf['Description'] || rf['통관품명_영문'] || null,
        });
      }
      if (op === 'shipment') {
        const shipId = req.query.id;
        if (!shipId || !shipId.startsWith('rec')) return res.status(400).json({ error: 'Invalid shipment id' });
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipId}`);
        // v3.2.7+ (2026-05-30): 상태 기반 차단 전체 제거 — 회의 결정.
        //   "모든 상태가 관세사 페이지에 표시·작업 가능" (출고요청·관세사확정대기·관세사확정완료·강하고확정완료·출고완료 전부).
        //   관세사는 어느 단계든 상품 정보 확정 가능 (재확정·정정 케이스 대응).
        //   필요 시 정보 로깅: console.info('[agent op=shipment] 상태:', ship.fields['상태']);
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

      if (op === 'bump_usage') {
        // 자동완성 채움 시 매칭 원본의 사용횟수 +1 (사서함 검증 X — 사용횟수만)
        const { productId } = body;
        if (!productId) return res.status(400).json({ error: 'productId 필수' });
        try {
          const cur = await atRequest('GET', `/${TABLES.Products}/${productId}`);
          await atRequest('PATCH', `/${TABLES.Products}/${productId}`, {
            fields: {
              '사용횟수': ((cur.fields['사용횟수'] || 0) + 1),
              '마지막사용일시': new Date().toISOString().slice(0, 10),
            },
            typecast: true,
          });
        } catch (e) { console.warn('[agent bump_usage]', e.message); }
        return res.json({ ok: true });
      }

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
        // 영문명 두 필드 일치: Description 변경 시 통관품명_영문도 같은 값으로 동기화.
        // (인보이스 도구가 통관품명_영문≠Description일 때 Description을 옛값으로 되돌리던 파괴 방지)
        // Description을 안 바꾸는 저장이면 통관품명_영문도 안 건드림(불필요한 덮어쓰기 방지).
        if (safe['Description'] !== undefined && safe['통관품명_영문'] === undefined) {
          safe['통관품명_영문'] = safe['Description'];
        }
        // v3.2.7+ (2026-05-30): 상태 기반 차단 전체 제거 (회의 결정 — 모든 상태에서 작업 가능)
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
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
        // 학습 누적: 관세사 확정값이면 ProductHistory + HSMapping에 upsert (부가 작업 — 실패해도 저장은 성공)
        const uf = updated.fields || {};
        const bf = before.fields || {};
        if (uf['관세사확정'] === true) {
          await learnFromConfirmation({
            제품링크: bf['제품링크'],                              // 화이트리스트 외 — 기존 Products 값
            한국어명: bf['통관품명_한글'],                          // 화이트리스트 외 — 기존 Products 값
            영문명: uf['Description'] || uf['통관품명_영문'],        // 확정값
            HS코드: uf['HS코드'],
            Material: uf['Material'],
            적용FTA: uf['적용FTA'],
            기본세율: uf['기본세율'], FTA_한중: uf['FTA_한중'], FTA_RCEP중국: uf['FTA_RCEP중국'], 아태세율: uf['아태세율'],
            관세사: agent.email,
          });
        }
        return res.json({ ok: true, updated: updated.fields, rejected });
      }

      if (op === 'confirm_shipment') {
        const { shipmentId } = body;
        if (!shipmentId) return res.status(400).json({ error: 'shipmentId 누락' });
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
        // v3.2.7+ (2026-05-30): 상태 기반 차단 제거 — 어느 상태에서든 '관세사확정완료'로 전환 가능.
        //   회의 결정: "모든 상태가 관세사 페이지에 표시·작업 가능". 재확정 케이스도 대응.
        const prevStatus = ship.fields['상태'];
        await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
          fields: { '상태': '관세사확정완료' }, typecast: true,
        });
        await logAction(agent, shipmentId, null, { '상태': prevStatus }, { '상태': '관세사확정완료' });
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
