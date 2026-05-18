// 통관 상담 API (v3.0.0 — Supabase consultations 양방향 토글)
// GET  /api/consultation?c=shortId        → 상담 데이터 조회 (고객 페이지용)
// POST /api/consultation { c, response }   → 고객 확정 저장 (customer_approved 토글)
//
// Supabase 키는 Vercel 환경 변수에만 저장 — 페이지 소스/URL 노출 X
//   SUPABASE_URL          예: https://xxxxxxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role (sb_secret_*) 키 — 서버 전용
//
// 작업자 도구(인보이스 통합 v3.0.0)는 Supabase REST에 직접 INSERT.
// 이 엔드포인트는 고객 페이지(customer.html)의 조회/확정 전용.

const { handleCors, readBody } = require('./_lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Supabase PostgREST 요청
async function sbRequest(method, path, opts) {
  opts = opts || {};
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY 환경 변수가 설정되지 않았습니다');
  }
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (opts.prefer) headers['Prefer'] = opts.prefer;

  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// short_id 형식 검증 (도구 generateShortId: 12자 nanoid)
function isValidShortId(c) {
  return typeof c === 'string' && /^[0-9a-zA-Z]{8,24}$/.test(c);
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('Consultation API error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다. 강하고 무역에 문의해 주세요.' });
  }
};

// 상담 조회
async function handleGet(req, res) {
  const c = req.query.c;
  if (!isValidShortId(c)) {
    return res.status(400).json({ error: '잘못된 접근입니다. 강하고 무역에서 받은 정확한 링크로 다시 접속해 주세요.' });
  }

  const select = [
    'short_id', 'airtable_sid', 'mailbox_id', 'payload',
    'customs_approved', 'customs_approved_at',
    'customer_approved', 'customer_approved_at', 'customer_data',
    'finalized', 'finalized_at', 'created_at', 'expires_at',
  ].join(',');

  const rows = await sbRequest('GET',
    `/consultations?short_id=eq.${encodeURIComponent(c)}&select=${select}&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;

  if (!row) {
    return res.status(404).json({ error: '존재하지 않는 상담 링크입니다. 강하고 무역에 문의해 주세요.' });
  }

  // 만료 검사
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    const expStr = new Date(row.expires_at).toLocaleDateString('ko-KR');
    return res.status(410).json({
      error: `이 링크는 만료되었습니다 (만료일: ${expStr}). 강하고 무역에 재발송 요청해 주세요.`,
      expired: true,
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ consultation: row });
}

// 고객 확정 저장
async function handlePost(req, res) {
  const body = await readBody(req);
  const { c, response } = body || {};

  if (!isValidShortId(c)) {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }
  if (!response || typeof response !== 'object') {
    return res.status(400).json({ error: '응답 데이터가 없습니다.' });
  }

  // 현재 상태 확인 (404 / 410 / 409 구분용)
  const rows = await sbRequest('GET',
    `/consultations?short_id=eq.${encodeURIComponent(c)}&select=short_id,customer_approved,expires_at&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;

  if (!row) {
    return res.status(404).json({ error: '존재하지 않는 상담 링크입니다.' });
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: '링크가 만료되어 제출할 수 없습니다. 강하고 무역에 재발송 요청해 주세요.' });
  }
  if (row.customer_approved) {
    return res.status(409).json({ error: '이미 응답을 제출하셨습니다.', alreadyApproved: true });
  }

  // 고객 확정 — customer_approved=false 인 행만 UPDATE (중복 제출 방지)
  // 양쪽(customs+customer) 확정 시 DB 트리거가 finalized 자동 설정
  const updated = await sbRequest('PATCH',
    `/consultations?short_id=eq.${encodeURIComponent(c)}&customer_approved=is.false`,
    {
      body: {
        customer_approved: true,
        customer_approved_at: new Date().toISOString(),
        customer_data: response,
      },
      prefer: 'return=representation',
    }
  );
  const result = Array.isArray(updated) ? updated[0] : updated;

  if (!result) {
    // 그 사이 다른 제출이 먼저 처리됨
    return res.status(409).json({ error: '이미 응답을 제출하셨습니다.', alreadyApproved: true });
  }

  res.json({
    success: true,
    finalized: !!result.finalized,
    customs_approved: !!result.customs_approved,
    message: result.finalized
      ? '양쪽 확정이 완료되었습니다. 강하고 무역이 곧 진행 안내드리겠습니다.'
      : '응답이 정상 저장되었습니다. 강하고 무역이 곧 진행 안내드리겠습니다.',
  });
}
