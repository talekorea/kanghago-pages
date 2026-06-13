// 공통 Airtable 헬퍼 - 모든 Function에서 사용
// PAT와 Base ID는 Vercel 환경 변수에서 읽음

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appGdGsw2NmQqgE95';

const TABLES = {
  Shipments: 'tbl57cGPE8M67XFXE',
  Suppliers: 'tbl5PW2rZJJgdUuy9',
  HSMapping: 'tblKGJE2B7HKP3NiO',
  Orders: 'tblGykcNaMArMQTCE',
  Boxes: 'tblw6kU2k8ZwUHPvC',
  Products: 'tblwvS4CJgQsDmt1O',
  BoxAssignments: 'tbljU43lgCs55moqU',
  CostItems: 'tblDvZbBHrcFfbEAv',
  Customers: 'tblsNuJ0aDyAga2oa'   // 누락돼 있어 TABLES.Customers=undefined→/undefined 403 (notify·파일허브 customer·booking_summary 고객명 깨짐) 수정
};

async function atRequest(method, path, body) {
  if (!AIRTABLE_PAT) throw new Error('AIRTABLE_PAT 환경 변수가 설정되지 않았습니다');
  const url = `https://api.airtable.com/v0/${BASE_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_PAT}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable ${res.status}: ${text}`);
  }
  return await res.json();
}

async function atListAll(path) {
  const out = [];
  let offset = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = path + (offset ? `${sep}offset=${offset}` : '');
    const data = await atRequest('GET', url);
    out.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return out;
}

// CORS preflight 처리
// Authorization 허용: 작업자 도구(file:///)가 Bearer write-token으로 호출 (v3.0.1)
function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
      return;
    }
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = { atRequest, atListAll, handleCors, readBody, TABLES, BASE_ID };
