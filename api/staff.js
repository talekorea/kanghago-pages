// 직원 포털 API — Supabase Auth 기반 (도구 v3.2.42 inline 로그인 게이트용)
//
// 인증: Authorization: Bearer <Supabase access_token (JWT)>
//   → Supabase Auth /auth/v1/user 로 검증 → staff_users 조회 → active 확인 → role 반환
//
// 엔드포인트:
//   GET /api/staff?op=me  → { staff: { email, name, role, active } }
//
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY
//   (브라우저용 anon key는 /api/agent-config.js로 공유 — 관세사 포털과 동일)

const { handleCors } = require('./_lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

// staff_users 조회 + active 확인 — last_login_at 자동 갱신 (관세사 패턴과 동일)
async function loadStaff(userId, email) {
  const hdr = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_users?id=eq.${userId}&select=id,email,name,role,active`,
    { headers: hdr }
  );
  if (!r.ok) { const err = new Error('직원 조회 실패'); err.status = 500; throw err; }
  let rows = await r.json();
  let matchedByEmail = false;
  // id 매칭 실패 시 email 폴백 (auth user id 재발급 등 권한 인식 끊김 복구 — agent.js loadAgent 패턴 차용)
  if (!rows.length && email) {
    const r2 = await fetch(
      `${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=id,email,name,role,active`,
      { headers: hdr }
    );
    if (r2.ok) { rows = await r2.json(); matchedByEmail = rows.length > 0; }
  }
  if (!rows.length) {
    const err = new Error('등록되지 않은 직원입니다 (강하고 관리자에게 계정 발급 요청)');
    err.status = 403; throw err;
  }
  const staff = rows[0];
  if (!staff.active) {
    const err = new Error('비활성 직원 계정입니다'); err.status = 403; throw err;
  }
  // last_login_at 갱신 (실패해도 진행)
  const filter = matchedByEmail ? `email=eq.${encodeURIComponent(email)}` : `id=eq.${userId}`;
  fetch(`${SUPABASE_URL}/rest/v1/staff_users?${filter}`, {
    method: 'PATCH',
    headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_login_at: new Date().toISOString() }),
  }).catch(() => {});
  return staff;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  try {
    const authH = req.headers.authorization || req.headers.Authorization || '';
    const user = await verifySupabaseToken(authH);
    const staff = await loadStaff(user.id, user.email);

    if (req.method === 'GET' && (req.query.op === 'me' || !req.query.op)) {
      return res.json({
        staff: {
          email: staff.email,
          name: staff.name,
          role: staff.role,   // 'admin' | 'staff'
          active: staff.active,
        },
      });
    }
    return res.status(400).json({ error: 'Unknown op' });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || String(e) });
  }
};
