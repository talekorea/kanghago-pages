// 통관 상담 API (v3.0.1 — Supabase consultations 양방향 토글, 도구·고객 모두 API 경유)
//
// 고객용 (인증 불필요 — short_id를 아는 사람 = 고객 본인):
//   GET  /api/consultation?c=shortId                          → 상담 데이터 조회
//   POST /api/consultation { op:'customer_approve', c, response }  → 고객 확정
//
// 작업자용 (Authorization: Bearer <CONSULTATION_WRITE_TOKEN> 필수):
//   POST /api/consultation { op:'create', payload }           → 상담 생성 (short_id 발급)
//   POST /api/consultation { op:'customs_approve', c }        → 관세사/강하고 확정
//
// Supabase 키는 Vercel 환경 변수에만 — 브라우저(작업자 도구·고객 페이지)에 키 노출 0
//   SUPABASE_URL              예: https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY      service_role(sb_secret_*) 키 — 서버 전용
//   CONSULTATION_WRITE_TOKEN  작업자 도구 쓰기 인증용 임의 토큰 (Supabase 키 아님)

const crypto = require('crypto');
const { handleCors, readBody, atRequest, TABLES, BASE_ID } = require('./_lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WRITE_TOKEN = process.env.CONSULTATION_WRITE_TOKEN;

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
    const err = new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.bodyText = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// short_id 형식 검증 (12자 nanoid)
function isValidShortId(c) {
  return typeof c === 'string' && /^[0-9a-zA-Z]{8,24}$/.test(c);
}

// 12자 short_id 생성 (모호 문자 0/O/1/I/l 제외)
const SHORT_ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
function generateShortId(len) {
  len = len || 12;
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
  return out;
}

// 작업자 인증 — Bearer write-token
function isWorker(req) {
  if (!WRITE_TOKEN) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${WRITE_TOKEN}`;
}

// v3.0.4: 고객 응답을 Airtable에 동기화 — Shipments(응답 필드) + Customers(수취 정보)
// consultMode 고객 응답은 Supabase에만 저장되던 것을, 작업자가 보는 Airtable에도 반영한다.
// Shipments PATCH 실패 시 throw(호출부가 airtableSynced=false 처리), Customers는 보조(실패해도 진행).
async function syncCustomerResponseToAirtable(shipmentId, response) {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Shipments — 고객 응답 (핵심)
  await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
    fields: {
      '고객응답일시': today,
      '선택FTA': response.fta || '미선택',
      '배송방식': response.deliveryType || '미선택',
      '원산지증명서신청': !!response.coRequested,
      '특이사항': response.note || '',
    },
    typecast: true,
  });

  // 2. Customers — 수취 정보 upsert (보조: 실패해도 Shipments 동기화는 성공으로 간주)
  if (response.customer && typeof response.customer === 'object') {
    try {
      const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
      const shipName = ship.fields && ship.fields['사서함'];
      if (shipName) {
        const meta = await atRequest('GET', `/meta/bases/${BASE_ID}/tables`);
        const custTable = (meta.tables || []).find(t => t.name === 'Customers');
        if (custTable) {
          const c = response.customer;
          const custFields = {
            '사서함번호': shipName,
            '회원명': c.name || '',
            '회사명': c.company || '',
            '전화번호': c.phone || '',
            '주소': c.address || '',
            '마지막사용일': today,
          };
          const existRes = await atRequest('GET',
            `/${custTable.id}?filterByFormula=${encodeURIComponent(`{사서함번호}='${shipName}'`)}&maxRecords=1`);
          const existing = existRes.records && existRes.records[0];
          if (existing) {
            await atRequest('PATCH', `/${custTable.id}/${existing.id}`, { fields: custFields, typecast: true });
          } else {
            await atRequest('POST', `/${custTable.id}`, { fields: custFields, typecast: true });
          }
        }
      }
    } catch (e) {
      console.error('[consultation] Customers 동기화 경고 (Shipments는 완료):', e.message);
    }
  }
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

// 상담 조회 (고객 페이지)
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

// POST 분기 — op 기준
async function handlePost(req, res) {
  const body = await readBody(req);
  const op = (body && body.op) || 'customer_approve';

  if (op === 'create') return await handleCreate(req, res, body);
  if (op === 'customs_approve') return await handleCustomsApprove(req, res, body);
  if (op === 'customer_approve') return await handleCustomerApprove(req, res, body);
  return res.status(400).json({ error: '알 수 없는 요청(op)입니다.' });
}

// [작업자] 상담 생성 — short_id 발급
async function handleCreate(req, res, body) {
  if (!isWorker(req)) {
    return res.status(401).json({ error: '작업자 인증 실패 — 도구의 write-token을 확인해 주세요.' });
  }
  const payload = body && body.payload;
  if (!payload || typeof payload !== 'object' || !payload.v) {
    return res.status(400).json({ error: 'payload(v=1)가 필요합니다.' });
  }

  // short_id 중복(unique_violation) 시 재시도
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const shortId = generateShortId(12);
    try {
      const rows = await sbRequest('POST', '/consultations', {
        body: {
          short_id: shortId,
          airtable_sid: payload.sid || null,
          mailbox_id: payload.sname || '',
          payload,
        },
        prefer: 'return=representation',
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return res.json({ success: true, short_id: row.short_id, id: row.id });
    } catch (e) {
      if (e.status === 409 || (e.bodyText && e.bodyText.includes('23505'))) {
        lastErr = e;  // short_id 충돌 → 새 id로 재시도
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('상담 생성 실패 (short_id 충돌)');
}

// [작업자] 관세사/강하고 확정
async function handleCustomsApprove(req, res, body) {
  if (!isWorker(req)) {
    return res.status(401).json({ error: '작업자 인증 실패 — 도구의 write-token을 확인해 주세요.' });
  }
  const c = body && body.c;
  if (!isValidShortId(c)) {
    return res.status(400).json({ error: '잘못된 short_id입니다.' });
  }

  const patch = {
    customs_approved: true,
    customs_approved_at: new Date().toISOString(),
  };
  if (body.by) patch.customs_approved_by = String(body.by).slice(0, 120);

  const updated = await sbRequest('PATCH',
    `/consultations?short_id=eq.${encodeURIComponent(c)}&customs_approved=is.false`,
    { body: patch, prefer: 'return=representation' }
  );
  const row = Array.isArray(updated) ? updated[0] : updated;

  if (!row) {
    // 이미 확정됐거나 미존재 — 현재 상태 조회
    const cur = await sbRequest('GET',
      `/consultations?short_id=eq.${encodeURIComponent(c)}&select=customs_approved,customer_approved,finalized&limit=1`
    );
    const curRow = Array.isArray(cur) ? cur[0] : null;
    if (!curRow) return res.status(404).json({ error: '존재하지 않는 상담입니다.' });
    return res.json({
      success: true, alreadyApproved: true,
      finalized: !!curRow.finalized, customer_approved: !!curRow.customer_approved,
    });
  }
  res.json({ success: true, finalized: !!row.finalized, customer_approved: !!row.customer_approved });
}

// [고객] 고객 확정 — 인증 불필요 (short_id 자체가 자격증명)
async function handleCustomerApprove(req, res, body) {
  const c = body && body.c;
  const response = body && body.response;

  if (!isValidShortId(c)) {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }
  if (!response || typeof response !== 'object') {
    return res.status(400).json({ error: '응답 데이터가 없습니다.' });
  }

  // 현재 상태 확인 (404 / 410 / 409 구분)
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

  // customer_approved=false 인 행만 UPDATE (중복 제출 방지). 양쪽 확정 시 DB 트리거가 finalized 설정
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
    return res.status(409).json({ error: '이미 응답을 제출하셨습니다.', alreadyApproved: true });
  }

  // v3.0.4: Supabase 저장 완료 → Airtable Shipments/Customers에도 동기화 (best-effort).
  //   Airtable 동기화 실패해도 고객 제출 자체는 성공(Supabase 저장됨). 단 침묵 실패 방지 —
  //   서버 로그 + 응답의 airtableSynced 플래그로 노출.
  let airtableSynced = false;
  if (result.airtable_sid) {
    try {
      await syncCustomerResponseToAirtable(result.airtable_sid, response);
      airtableSynced = true;
    } catch (e) {
      console.error('[consultation] Airtable 동기화 실패 (Supabase 저장은 완료됨):', e.message);
    }
  } else {
    console.error('[consultation] airtable_sid 없음 — Airtable 동기화 건너뜀. short_id:', c);
  }

  res.json({
    success: true,
    finalized: !!result.finalized,
    customs_approved: !!result.customs_approved,
    airtableSynced,
    message: result.finalized
      ? '양쪽 확정이 완료되었습니다. 강하고 무역이 곧 진행 안내드리겠습니다.'
      : '응답이 정상 저장되었습니다. 강하고 무역이 곧 진행 안내드리겠습니다.',
  });
}
