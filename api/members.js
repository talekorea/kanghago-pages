// 강하고 v2.0 회원(화주) API — Supabase Auth 기반, 관리자 승인제
//
// 회원 op (Authorization: Bearer <Supabase JWT>):
//   POST /api/members { op:'signup', company_name, business_number, contact_name, phone }
//        → members upsert (status: pending) — Auth signUp은 브라우저에서 먼저 수행
//   GET  /api/members?op=me  → 본인 회원 정보 + last_login 갱신
//
// 관리자 op (Authorization: Admin <ADMIN_INVITE_TOKEN>):
//   GET  /api/members?op=list&status=pending|active|all  → 회원 목록
//   POST /api/members { op:'admin_update', memberId, fields }  → 화이트리스트 PATCH
//
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_INVITE_TOKEN

const { handleCors, readBody } = require('./_lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_INVITE_TOKEN;

// 관리자 PATCH 허용 필드 화이트리스트
const ALLOWED_ADMIN_FIELDS = new Set(['status', 'notes', 'approved_at', 'approved_by', 'deposit_krw']);
const VALID_STATUS = new Set(['pending', 'active', 'rejected', 'suspended']);

async function verifySupabaseToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const e = new Error('Authorization Bearer 토큰 필요'); e.status = 401; throw e;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const e = new Error('Supabase 환경변수 미설정'); e.status = 500; throw e;
  }
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) { const e = new Error('유효하지 않은 토큰 (재로그인 필요)'); e.status = 401; throw e; }
  return await r.json();
}

function verifyAdmin(authH) {
  if (!ADMIN_TOKEN) { const e = new Error('ADMIN_INVITE_TOKEN 미설정'); e.status = 500; throw e; }
  if (authH.slice(6) !== ADMIN_TOKEN) { const e = new Error('관리자 토큰 불일치'); e.status = 403; throw e; }
}

async function sbRest(method, path, body, prefer) {
  const headers = {
    'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const authH = req.headers.authorization || req.headers.Authorization || '';

    // ===== 관리자 op =====
    if (authH.startsWith('Admin ')) {
      verifyAdmin(authH);

      if (req.method === 'GET' && req.query.op === 'list') {
        const status = req.query.status || 'pending';
        let filter = '';
        if (status !== 'all') filter = `&status=eq.${encodeURIComponent(status)}`;
        const rows = await sbRest('GET',
          `/members?select=*&order=created_at.desc${filter}`);
        return res.json({ members: rows || [] });
      }

      if (req.method === 'GET' && req.query.op === 'deposit_requests') {
        // H9: 입금 신청 목록 (확인 대기)
        const rows = await sbRest('GET',
          `/member_deposits?kind=eq.topup_request&select=*&order=created_at.desc`);
        return res.json({ deposits: rows || [] });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.op === 'confirm_deposit') {
          // H9: 입금 확인 → members.deposit_krw 증가 + 신청 행을 topup(확정)으로 전환
          const { depositId, memberId, amount_krw } = body;
          const amt = parseFloat(amount_krw) || 0;
          if (!depositId || !memberId || amt <= 0) return res.status(400).json({ error: 'depositId/memberId/amount_krw 필수' });
          // 현재 예치금 조회 후 증가
          const mrows = await sbRest('GET', `/members?id=eq.${memberId}&select=deposit_krw`);
          const cur = (mrows && mrows[0] && parseFloat(mrows[0].deposit_krw)) || 0;
          await sbRest('PATCH', `/members?id=eq.${memberId}`, { deposit_krw: cur + amt });
          // 신청 행 → 확정(topup)으로 전환
          await sbRest('PATCH', `/member_deposits?id=eq.${depositId}`, { kind: 'topup' });
          return res.json({ ok: true, newBalance: cur + amt });
        }
        if (body.op === 'admin_update') {
          const { memberId, fields } = body;
          if (!memberId || !fields) return res.status(400).json({ error: 'memberId + fields 필수' });
          const safe = {};
          const rejected = [];
          for (const k of Object.keys(fields)) {
            if (ALLOWED_ADMIN_FIELDS.has(k)) safe[k] = fields[k];
            else rejected.push(k);
          }
          if (safe.status && !VALID_STATUS.has(safe.status)) {
            return res.status(400).json({ error: '잘못된 status: ' + safe.status });
          }
          // 승인 시 approved_at 자동 채움
          if (safe.status === 'active' && !safe.approved_at) safe.approved_at = new Date().toISOString();
          if (!Object.keys(safe).length) return res.status(400).json({ error: '허용 필드 없음', rejected });
          const updated = await sbRest('PATCH', `/members?id=eq.${memberId}`, safe, 'return=representation');
          return res.json({ ok: true, member: Array.isArray(updated) ? updated[0] : updated, rejected });
        }
        return res.status(400).json({ error: 'Unknown admin op' });
      }
      return res.status(400).json({ error: 'Unknown admin op' });
    }

    // ===== 회원 op (Bearer JWT) =====
    const user = await verifySupabaseToken(authH);

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.op === 'update_profile') {
        // H8: 회원 본인 정보 수정 (이메일/status/예치금 제외 — 화이트리스트)
        const ALLOWED = new Set(['company_name', 'business_number', 'contact_name', 'phone']);
        const safe = {};
        const f = body.fields || {};
        for (const k of Object.keys(f)) { if (ALLOWED.has(k)) safe[k] = f[k]; }
        if (!Object.keys(safe).length) return res.status(400).json({ error: '수정할 항목 없음' });
        const updated = await sbRest('PATCH', `/members?id=eq.${user.id}`, safe, 'return=representation');
        return res.json({ ok: true, member: Array.isArray(updated) ? updated[0] : updated });
      }
      if (body.op === 'deposit_request') {
        // H9: 예치금 입금 신청 (member_deposits에 kind='topup_request'로 기록)
        const amount = parseFloat(body.amount_krw) || 0;
        if (amount <= 0) return res.status(400).json({ error: '입금 예정 금액을 입력하세요' });
        const row = {
          member_id: user.id,
          amount_krw: amount,            // 신청 금액 (양수, 확정 전)
          kind: 'topup_request',
          memo: (body.memo || '').slice(0, 500),
          created_by: user.email,
        };
        const created = await sbRest('POST', `/member_deposits`, row, 'return=representation');
        return res.json({ ok: true, deposit: Array.isArray(created) ? created[0] : created });
      }
      if (body.op === 'signup') {
        // Auth signUp은 브라우저에서 먼저 수행됨 → user.id 검증된 상태로 members upsert
        const row = {
          id: user.id,
          email: user.email,
          company_name: body.company_name || null,
          business_number: body.business_number || null,
          contact_name: body.contact_name || null,
          phone: body.phone || null,
          status: 'pending',
        };
        const created = await sbRest('POST', `/members?on_conflict=id`, row,
          'return=representation,resolution=merge-duplicates');
        return res.json({ ok: true, member: Array.isArray(created) ? created[0] : created });
      }
      return res.status(400).json({ error: 'Unknown op' });
    }

    if (req.method === 'GET' && (req.query.op === 'me' || !req.query.op)) {
      const rows = await sbRest('GET', `/members?id=eq.${user.id}&select=*`);
      const member = (rows || [])[0];
      if (!member) return res.status(404).json({ error: '회원 정보 없음 — 가입을 완료해 주세요', notFound: true });
      // last_login 갱신 (실패해도 진행)
      sbRest('PATCH', `/members?id=eq.${user.id}`, { last_login_at: new Date().toISOString() }).catch(() => {});
      return res.json({ member });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[members] error:', e);
    res.status(status).json({ error: e.message || String(e) });
  }
};
