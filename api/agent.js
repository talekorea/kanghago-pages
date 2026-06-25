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
const https = require('https');

// [통관 진행상황 v1] UNIPASS(:38010)는 LINK형 → Vercel 직접호출 불가.
//   서울 전용 중계(kanghago-relay)로만 호출. self-signed HTTPS라 인증서 검증 끄고
//   X-Relay-Secret(RELAY_SECRET)으로 핀닝. 중계는 원본 XML만 반환, 파싱은 여기서.
function callCustomsRelay(urlStr, secret, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('RELAY_URL 형식 오류')); }
    const data = Buffer.from(payload, 'utf8');
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Relay-Secret': secret },
      rejectUnauthorized: false, timeout: 20000,
    }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('relay non-JSON: ' + body.slice(0, 120))); } });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('relay timeout')));
    r.write(data); r.end();
  });
}
function _xmlTag(block, name) {
  const m = block.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
  return m ? m[1].trim() : '';
}
// UNIPASS 화물통관진행정보(cargCsclPrgsInfo) XML → 요약 + 처리단계 타임라인
function parseCargoProgress(xml) {
  xml = xml || '';
  const ntce = _xmlTag(xml, 'ntceInfo');
  const tCnt = parseInt(_xmlTag(xml, 'tCnt') || '0', 10);
  const sumBlocks = xml.match(/<cargCsclPrgsInfoQryVo>[\s\S]*?<\/cargCsclPrgsInfoQryVo>/g) || [];
  let summary = null;
  if (sumBlocks.length) {
    const b = sumBlocks[0];
    summary = {
      blNo: _xmlTag(b, 'blNo') || _xmlTag(b, 'hblNo'),
      cargMtNo: _xmlTag(b, 'cargMtNo'),
      prnm: _xmlTag(b, 'prnm'),                 // 품명
      pckGcnt: _xmlTag(b, 'pckGcnt'),           // 포장개수
      ttwg: _xmlTag(b, 'ttwg'),                 // 총중량
      shipNat: _xmlTag(b, 'shipNatNm'),         // 선적국
      etprDt: _xmlTag(b, 'etprDt'),             // 입항일
      csclPrgsStts: _xmlTag(b, 'csclPrgsStts'), // 통관진행상태
      shedNm: _xmlTag(b, 'shedNm'),             // 장치장(보세창고)
      관리대상검사여부: _xmlTag(b, 'mtTrgtCargYnNm'), // [검사] 예 '반입후검사'/'즉시검사' — 빈값/비검사면 미표시
      frwrEntsConm: _xmlTag(b, 'frwrEntsConm'), // [v3.2.93] 한국 포워딩사(적하목록 제출 포워더업체상호)
    };
  }
  const dtlBlocks = xml.match(/<cargCsclPrgsInfoDtlQryVo>[\s\S]*?<\/cargCsclPrgsInfoDtlQryVo>/g) || [];
  const stages = dtlBlocks.map(b => ({
    처리일시: _xmlTag(b, 'prcsDttm'),
    장치장: _xmlTag(b, 'shedNm'),
    반출입내용: _xmlTag(b, 'rlbrCn'),
    진행상태: _xmlTag(b, 'cargTrcnRelaBsopTpcd') || _xmlTag(b, 'csclPrgsStts'),
    중량: _xmlTag(b, 'wght'),
    포장: _xmlTag(b, 'pckGcnt'),
  })).sort((a, b) => (a.처리일시 || '').localeCompare(b.처리일시 || ''));
  return { ntce, tCnt, summary, stages, stagesCount: stages.length };
}
// [통관 진행상황 v1] 공용 핸들러 — Admin 토큰(도구)·Supabase JWT(관세사) 양쪽 분기에서 호출.
async function handleCustomsProgress(req, res) {
  const blNo = String(req.query.blNo || req.query.bl || '').trim();
  const blYear = String(req.query.blYear || req.query.year || '').trim();
  const cargoMgmtNo = String(req.query.cargoMgmtNo || '').trim();
  if (!blNo && !cargoMgmtNo) return res.status(400).json({ ok: false, error: 'blNo 또는 cargoMgmtNo 필요' });
  const RELAY_URL = process.env.RELAY_URL, RELAY_SECRET = process.env.RELAY_SECRET;
  if (!RELAY_URL || !RELAY_SECRET) return res.status(503).json({ ok: false, error: '중계 미설정(RELAY_URL/RELAY_SECRET)' });
  const payload = JSON.stringify(cargoMgmtNo ? { cargoMgmtNo } : { blNo, blYear });
  let rr;
  try { rr = await callCustomsRelay(RELAY_URL, RELAY_SECRET, payload); }
  catch (e) { return res.status(502).json({ ok: false, error: '중계 호출 실패', detail: String(e.message || e).slice(0, 200) }); }
  if (!rr || !rr.ok) return res.status(502).json({ ok: false, error: (rr && rr.error) || '중계 오류', detail: rr && rr.detail });
  const parsed = parseCargoProgress(rr.xml || '');
  const out = { ok: true, ...parsed, queriedAt: rr.queriedAt };
  if (req.query.debug === '1') out._rawSample = String(rr.xml || '').slice(0, 1500);
  return res.json(out);
}

// [채널톡 발송 v1] api.channel.io 공개 :443 직접 호출(중계 불필요). 키는 Vercel env에서만.
function callChannel(method, path, payload, key, secret) {
  return new Promise((resolve, reject) => {
    const data = payload != null ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const r = https.request({
      hostname: 'api.channel.io', port: 443, path, method,
      headers: Object.assign({ 'x-access-key': key, 'x-access-secret': secret, 'Content-Type': 'application/json' },
        data ? { 'Content-Length': data.length } : {}),
      timeout: 15000,
    }, (resp) => {
      let b = ''; resp.on('data', c => b += c);
      resp.on('end', () => {
        let j; try { j = b ? JSON.parse(b) : {}; } catch (e) { return reject(new Error('channel non-JSON: ' + b.slice(0, 120))); }
        if (resp.statusCode >= 400) return reject(new Error('channel HTTP ' + resp.statusCode + ': ' + (j.message || b.slice(0, 120))));
        resolve(j);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('channel timeout')));
    if (data) r.write(data); r.end();
  });
}
// 메시지 템플릿(상수 분리) — 분기점(통관완료·출고) / 통관단계 / 면허 / 자유. 분기점은 45자 SMS 확정 문구.
const BRANCHPOINT_TEMPLATES = {
  '수입신고수리': (mb) => `[강하고] ${mb} 수입통관 완료됐어요. 곧 출고 안내드릴게요.`,
  '반출': (mb) => `[강하고] ${mb} 통관품 출고(반출)됐어요. 도착 안내 곧 드려요.`,
};
function buildNotifyMessage(kind, payload, mailbox) {
  payload = payload || {};
  // 분기점 알림: payload.stage(수입신고수리/반출)면 확정 SMS 템플릿 사용
  if (kind === '통관단계' && payload.stage && BRANCHPOINT_TEMPLATES[payload.stage]) return BRANCHPOINT_TEMPLATES[payload.stage](mailbox);
  if (kind === '통관단계') return `[강하고] ${mailbox} 통관 안내\n현재: ${payload.진행상태 || payload.stage || '-'}${payload.note ? '\n' + payload.note : ''}`;
  if (kind === '면허') return `[강하고] ${mailbox} 수입신고필증(면허)이 발급되었습니다.${payload.url ? '\n다운로드: ' + payload.url : ''}`;
  return `[강하고] ${mailbox}\n${payload.text || ''}`.trim();
}
// 통관알림이력(쉼표구분 stage 키) 헬퍼
function histList(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function histHas(s, stage) { return histList(s).includes(stage); }
function histAppend(s, stage) { const a = histList(s); if (!a.includes(stage)) a.push(stage); return a.join(','); }
// [채널톡 발송 v1] 사서함 → Customers.채널톡userId → user-chats(조회/생성) → 메시지. dryRun이면 발송 X.
//   stage(분기점) 있으면: 발송 전 통관알림이력에 있으면 skip(중복금지), 성공 후 append(dedup).
async function handleNotifyCustomer(req, res, body, actor) {
  const kind = body.kind || '자유';
  const stage = String(body.stage || '').trim();
  let mailbox = String(body['사서함'] || body.mailbox || '').trim();
  const shipmentId = body.shipmentId || null;
  let hist = '';
  if (shipmentId) {
    try { const sh = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`); if (!mailbox) mailbox = sh.fields['고객사서함'] || sh.fields['사서함'] || ''; hist = String(sh.fields['통관알림이력'] || ''); } catch (e) {}
  }
  const base = String(mailbox).replace(/-\d{6}$/, '').split(' ')[0];
  if (!base) return res.status(400).json({ ok: false, error: '사서함 누락' });
  const cs = await atListAll(`/${TABLES.Customers}?filterByFormula=${encodeURIComponent(`{사서함번호}='${base}'`)}&maxRecords=1`);
  const userId = cs.length ? String(cs[0].fields['채널톡userId'] || '').trim() : '';
  if (!userId) return res.status(400).json({ ok: false, error: '채널톡 미연결(채널톡userId 없음) — 수동 안내 필요', mailbox: base });
  const text = buildNotifyMessage(kind, body.payload, base);
  if (body.dryRun) return res.json({ ok: true, dryRun: true, mailbox: base, userId, message: text, alreadySent: !!(stage && histHas(hist, stage)) });
  // 중복금지: 이미 보낸 분기점이면 발송 안 함
  if (stage && shipmentId && histHas(hist, stage)) return res.json({ ok: true, skipped: true, reason: '이미 발송됨', stage, mailbox: base });
  const KEY = process.env.CHANNELTALK_ACCESS_KEY, SECRET = process.env.CHANNELTALK_ACCESS_SECRET;
  if (!KEY || !SECRET) return res.status(503).json({ ok: false, error: '채널톡 키 미설정(CHANNELTALK_ACCESS_KEY/SECRET)' });
  try {
    const list = await callChannel('GET', `/open/v5/users/${userId}/user-chats`, null, KEY, SECRET);
    const chats = (list && (list.userChats || list)) || [];
    let chatId = Array.isArray(chats) ? ((chats.find(c => c.state === 'opened') || chats[0] || {}).id) : null;
    if (!chatId) {
      const created = await callChannel('POST', `/open/v5/users/${userId}/user-chats`, {}, KEY, SECRET);
      chatId = created && (created.userChat ? created.userChat.id : created.id);
    }
    if (!chatId) return res.status(502).json({ ok: false, error: 'user-chat 생성/조회 실패' });
    const sent = await callChannel('POST', `/open/v5/user-chats/${chatId}/messages?botName=${encodeURIComponent('강하고')}`, { plainText: text }, KEY, SECRET);
    const messageId = sent && (sent.message ? sent.message.id : sent.id);
    // 성공 후 분기점 기록(append, dedup)
    if (stage && shipmentId) {
      try { await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, { fields: { '통관알림이력': histAppend(hist, stage) }, typecast: true }); } catch (e) { console.warn('[notify] 이력 기록 실패:', e.message); }
    }
    await logAction(actor, shipmentId, null, {}, { 채널톡발송: messageId, kind, stage, mailbox: base });
    return res.json({ ok: true, mailbox: base, userId, chatId, messageId, stage: stage || undefined });
  } catch (e) {
    return res.status(502).json({ ok: false, error: '채널톡 발송 실패', detail: String(e.message || e).slice(0, 200) });
  }
}
// [Phase2 판정 단일함수] 박스입력 완료 = 박스≥1 AND 모든 박스 무게KG·가로cm·세로cm·높이cm > 0.
//   ★도구(인보이스 도구) isBoxInputComplete와 동일 로직 유지(중복 구현 금지 — 두 곳 동기).
function isBoxInputComplete(boxes) {
  if (!boxes || boxes.length < 1) return false;
  return boxes.every(function (b) {
    var src = b.fields || b;
    var g = function (k) { return parseFloat(src[k]) || 0; };
    return g('무게KG') > 0 && g('가로cm') > 0 && g('세로cm') > 0 && g('높이cm') > 0;
  });
}



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

// v3.2.42 (2026-06-06): staff_users 조회 — 도구 v3.2.42 inline 로그인 게이트용 (op=staff_me).
//   loadAgent 패턴 그대로, 테이블만 staff_users로. role(admin/staff) 추가 반환.
async function loadStaff(userId, email) {
  const hdr = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_users?id=eq.${userId}&select=id,email,name,role,active`,
    { headers: hdr }
  );
  if (!r.ok) { const err = new Error('직원 조회 실패'); err.status = 500; throw err; }
  let rows = await r.json();
  let matchedByEmail = false;
  // id 매칭 실패 시 email 폴백 (loadAgent와 동일 — auth user id 재발급 케이스 복구)
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
  const filter = matchedByEmail ? `email=eq.${encodeURIComponent(email)}` : `id=eq.${userId}`;
  fetch(`${SUPABASE_URL}/rest/v1/staff_users?${filter}`, {
    method: 'PATCH',
    headers: { ...hdr, 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_login_at: new Date().toISOString() }),
  }).catch(() => {});
  return staff;
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

// ===== v3.2.42 (2026-06-06): 직원 관리 — 관세사 패턴 미러 =====
//   adminCreateAgentWithPassword/adminListAgents/adminToggleAgent의 staff_users 버전.
//   role='staff'만 발급 가능. role='admin'은 Supabase SQL Editor 수동만 (보안).
async function upsertStaffUser(userId, email, name) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?on_conflict=id`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation,resolution=merge-duplicates',
    },
    // role='staff' 고정 — admin은 SQL Editor에서 수동만 (모달에서 admin 발급 불가, 권한 상승 차단)
    body: JSON.stringify({ id: userId, email, name: name || null, role: 'staff', active: true }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('staff_users upsert 실패: ' + JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

async function adminListStaff() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_users?select=id,email,name,role,active,created_at,last_login_at&order=created_at.desc`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!r.ok) throw new Error('직원 목록 조회 실패 HTTP ' + r.status);
  return await r.json();
}

async function adminToggleStaff(staffId, active) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?id=eq.${staffId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation',
    },
    body: JSON.stringify({ active: !!active }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('직원 활성 토글 실패: ' + JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

// 비밀번호 포함 직원 신규 생성 — adminCreateAgentWithPassword와 동일 흐름, 테이블만 다름.
//   기존 auth 사용자(예: 관세사로 이미 등록된 이메일)면 비번 reset + staff_users insert.
async function adminCreateStaffWithPassword(email, name, password) {
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
      await adminSetUserPassword(existing.id, password);
      return await upsertStaffUser(existing.id, email, name);
    }
    throw new Error('Supabase 사용자 생성 실패: ' + (auth.msg || auth.error_description || auth.error || r1.status));
  }
  const userId = auth.id || (auth.user && auth.user.id);
  if (!userId) throw new Error('생성 응답에 user.id 없음');
  return await upsertStaffUser(userId, email, name);
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
      // v3.2.42 (2026-06-06): 직원 관리 — 관세사 admin_* 패턴 미러 (staff_admin_*)
      if (req.method === 'GET' && req.query.op === 'staff_admin_list') {
        const staff = await adminListStaff();
        return res.json({ staff });
      }
      // [통관 진행상황 v1] 도구(Admin 토큰)에서 통관 진행 조회 — 공용 핸들러 호출.
      if (req.method === 'GET' && req.query.op === 'customs_progress') {
        return await handleCustomsProgress(req, res);
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        // [채널톡 발송 v1] 도구(Admin 토큰) — 공용 핸들러 호출.
        if (body.op === 'notify_customer') return await handleNotifyCustomer(req, res, body, { id: null, email: 'admin' });
        // 직원 관리 op (v3.2.42) — 같은 ADMIN_INVITE_TOKEN, role='staff' 고정 발급
        if (body.op === 'staff_admin_create') {
          const { email, name, password } = body;
          if (!email) return res.status(400).json({ error: 'email 필수' });
          if (!password || String(password).length < 6) return res.status(400).json({ error: 'password 6자 이상 필수' });
          const staff = await adminCreateStaffWithPassword(String(email).trim().toLowerCase(), name || null, String(password));
          return res.json({ ok: true, staff });
        }
        if (body.op === 'staff_admin_toggle') {
          const { staffId, active } = body;
          if (!staffId) return res.status(400).json({ error: 'staffId 필수' });
          const staff = await adminToggleStaff(staffId, !!active);
          return res.json({ ok: true, staff });
        }
        if (body.op === 'staff_admin_set_password') {
          const { email, staffId, password } = body;
          if (!password || String(password).length < 6) return res.status(400).json({ error: 'password 6자 이상 필수' });
          let userId = staffId, staffEmail = email;
          if (!userId) {
            if (!email) return res.status(400).json({ error: 'email 또는 staffId 필요' });
            const u = await findAuthUserByEmail(email);
            if (!u) return res.status(404).json({ error: '직원 auth 사용자 없음' });
            userId = u.id; staffEmail = u.email;
          }
          await adminSetUserPassword(userId, String(password));
          return res.json({ ok: true, userId, email: staffEmail });
        }
        // ↓ 기존 관세사 admin op 분기
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

    // v3.2.42 (2026-06-06): 직원 포털 통합 — Hobby 12 함수 한도 회피.
    //   기존 api/staff.js 삭제, 그 op=me를 여기 op=staff_me로 흡수.
    //   토큰 검증은 동일(Supabase JWT). loadAgent(customs_agents)는 안 거치고
    //   바로 loadStaff(staff_users) → 직원 role/active 반환. 도구 v3.2.42 inline 게이트 사용.
    const user = await verifySupabaseToken(authH);
    if (req.method === 'GET' && req.query.op === 'staff_me') {
      const staff = await loadStaff(user.id, user.email);
      return res.json({
        staff: {
          email: staff.email,
          name: staff.name,
          role: staff.role,
          active: staff.active,
        },
      });
    }

    // [통관 진행상황 v1] 로그인(staff/관세사 공통)만 통과하면 사용 — 중계 호출.
    if (req.method === 'GET' && req.query.op === 'customs_progress') {
      return await handleCustomsProgress(req, res);
    }
    // [채널톡 발송 v1] staff/관세사 JWT 허용 — loadAgent 전에 처리(staff는 customs_agents 아님). body 1회 읽어 재사용.
    let _postBody = null;
    if (req.method === 'POST') {
      _postBody = await readBody(req);
      if (_postBody.op === 'notify_customer') return await handleNotifyCustomer(req, res, _postBody, { id: user.id, email: user.email });
    }

    // ===== 관세사 op (Authorization: Bearer <Supabase JWT>) =====
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
        // 선적일 추가(관세사 대시보드 목록 날짜 = 선적일 표시용). 출고요청일도 호환 위해 유지.
        const url = `/${TABLES.Shipments}?fields[]=사서함&fields[]=상태&fields[]=출고요청일&fields[]=선적일&fields[]=입금완료일시`;   // [v3.2.142] 입금완료일시 = 종결/외상 분류용
        const recs = await atListAll(url);
        // [고객명 표시] Customers(사서함번호 → 회원명/회사명) 조인 — booking_summary와 동일 소스. 읽기 전용·표시 전용.
        let custMap = {};
        try {
          const custs = await atListAll(`/${TABLES.Customers}?fields[]=사서함번호&fields[]=회원명&fields[]=회사명`);
          custs.forEach(c => { const k = (c.fields || {})['사서함번호']; if (k) custMap[k] = { member: c.fields['회원명'] || '', company: c.fields['회사명'] || '' }; });
        } catch (e) { /* Customers 없으면 이름 생략 */ }
        return res.json({ count: recs.length, shipments: recs.map(r => {
          const base = String((r.fields || {})['사서함'] || '').replace(/-\d{6}$/, '');   // [선적분 키] AP-YYMMDD → base
          const cust = custMap[base] || custMap[(r.fields || {})['사서함']] || { member: '', company: '' };
          return { id: r.id, fields: Object.assign({}, r.fields, { '회원명': cust.member, '회사명': cust.company }) };
        }) });
      }
      if (op === 'search_products') {
        // 자동완성: 영문명/HS/한글명 부분 일치 → 사용횟수 DESC + 마지막사용일시 DESC
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json({ products: [] });
        const qEsc = q.toLowerCase().replace(/'/g, "\\'");
        // v3.2.35: 관세사 확정한 Products만 자동완성 후보 (학습 정책 — 오염 차단)
        //   미확정 옛 제품(예: Latex Loop band → 4016.99 사용횟수 0)이 추천에 안 나옴
        const f = `AND({관세사확정},OR(FIND('${qEsc}',LOWER({Description}&'')),FIND('${qEsc}',LOWER({HS코드}&'')),FIND('${qEsc}',LOWER({통관품명_한글}&''))))`;
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
        // v3.2.35: HSMapping write는 learnFromConfirmation(확정 시만)에서만 → 여기 read는 안전.
        //   그래도 사용횟수 > 0 우선 + Description 누락(오염) 제외.
        const code = String(req.query.code || '').trim();
        if (!code) return res.json({ rates: null });
        const f = `{HS코드}='${code.replace(/'/g, "\\'")}'`;
        let recs = [];
        try { recs = await atListAll(`/${TABLES.HSMapping}?filterByFormula=${encodeURIComponent(f)}`); }
        catch (e) { console.warn('[agent hs_rates]', e.message); }
        const withRates = recs.map(r => r.fields)
          .filter(rf => rf['기본세율'] != null || rf['FTA_한중'] != null || rf['아태세율'] != null)
          .filter(rf => (rf['사용횟수'] || 0) > 0)   // v3.2.35: 사용횟수 0(오염 가능성) 제외
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
        // [파일허브] 위임장·사업자등록증(Customers, 재사용) 다운로드용 — base 사서함으로 1건 매칭
        let customer = null;
        try {
          const base = (ship.fields['고객사서함'] || String(shipName || '').replace(/-\d{6}$/, '').split(' ')[0] || shipName);
          if (base) {
            const cs = await atListAll(`/${TABLES.Customers}?filterByFormula=${encodeURIComponent(`{사서함번호}='${base}'`)}&maxRecords=1`);
            if (cs.length) customer = cs[0];
          }
        } catch (e) { /* 고객 없으면 null */ }
        // [v3.2.81] ★응답 화이트리스트 — 관세사가 통관 작업에 쓰는 필드만 반환. 전체 덤프 폐기(신규 필드 자동 비노출).
        //   ★제외: 고객토큰(보안)·청구금액/영세율/VAT/청구_*/해운비원가(마진)·발행주체/결제방식/외부거래ID/페이앱_*/입금완료일시·메모·도착지·마스터BL파일 등.
        //   서버 로직(사서함·고객사서함)은 위에서 이미 full fields로 수행됨 — 여기선 응답만 큐레이트.
        const AGENT_SHIP_WL = ['사서함', '고객사서함', '상태', '출고요청일', '선적일', 'BL번호', 'BL발급일', 'BL파일', 'CO파일', 'PI파일', '면허파일', '1차IP파일', '최종IP파일', '대조확인상태', '대조확인일시', '대조확인자', 'CO대조', '선적항', '선명', '선택FTA', '적용FTA확정', '원산지증명서신청', '수취_수취인', '수취_회사', '출발지'];   // [v3.2.116] IP 스냅샷 다운로드 노출
        if (ship && ship.fields) { const _o = {}; for (const k of AGENT_SHIP_WL) { if (ship.fields[k] !== undefined) _o[k] = ship.fields[k]; } ship.fields = _o; }
        return res.json({ shipment: ship, products, orders, customer });
      }

      // [부킹 요약] 읽기 전용 — 선적일(Orders.실제출고요청일)별 사서함 박스 무게/CBM 합산.
      //   도구 fetchBookingSummary와 동일 집계. 쓰기 없음. PAT는 서버(env)만 — 관세사 브라우저 노출 0.
      if (op === 'booking_summary') {
        const daysParam = (req.query.days || '').trim();
        const days = daysParam ? daysParam.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!days.length) return res.status(400).json({ error: 'days 누락' });
        const orderFormula = `OR(${days.map(d => `IS_SAME({실제출고요청일},'${d}','day')`).join(',')})`;
        const orders = await atListAll(`/${TABLES.Orders}?filterByFormula=${encodeURIComponent(orderFormula)}&fields[]=Shipment&fields[]=실제출고요청일&fields[]=주문번호&fields[]=대행종류`);
        if (!orders.length) return res.json({ rows: [], days });
        const shipDateMap = {};
        // [v3.2.37] 실대행종류(구매·결제·배송)만 집계 — 합배송·엑셀업로드 등 비-대행종류 제외. 표시 전용.
        const REAL_AGENT = ['구매대행', '결제대행', '배송대행'];
        const agentByShip = {};   // shipId -> Set(real agent types)
        orders.forEach(o => { const ships = (o.fields || {}).Shipment || []; const d = (o.fields || {})['실제출고요청일']; const at = String((o.fields || {})['대행종류'] || '').trim(); ships.forEach(sid => { if (d && (!shipDateMap[sid] || d < shipDateMap[sid])) shipDateMap[sid] = d; if (REAL_AGENT.includes(at)) { (agentByShip[sid] = agentByShip[sid] || new Set()).add(at); } }); });
        const shipIds = Object.keys(shipDateMap);
        if (!shipIds.length) return res.json({ rows: [], days });
        const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
        let ships = [];
        for (const c of chunk(shipIds, 50)) {
          const f = `OR(${c.map(id => `RECORD_ID()='${id}'`).join(',')})`;
          ships = ships.concat(await atListAll(`/${TABLES.Shipments}?filterByFormula=${encodeURIComponent(f)}&fields[]=사서함&fields[]=상태&fields[]=출고요청일&fields[]=BL번호&fields[]=배송방식`));   // [v3.2.109] BL번호 = 수입면장 일괄 매칭 키 / [v3.2.37] 배송방식
        }
        let custMap = {};
        try {
          const custs = await atListAll(`/${TABLES.Customers}?fields[]=사서함번호&fields[]=회원명&fields[]=회사명`);
          custs.forEach(c => { const k = (c.fields || {})['사서함번호']; if (k) custMap[k] = { member: c.fields['회원명'] || '', company: c.fields['회사명'] || '' }; });
        } catch (e) { /* Customers 없으면 이름 생략 */ }
        const rows = [];
        for (const s of ships) {
          const sf = s.fields || {}; const mailbox = sf['사서함'] || ''; const shipDate = shipDateMap[s.id] || ''; const status = sf['상태'] || '';
          let boxes = [];
          try { boxes = await atListAll(`/${TABLES.Boxes}?filterByFormula=${encodeURIComponent(`SEARCH('${mailbox}',ARRAYJOIN({Shipment}))`)}&fields[]=박스순번&fields[]=무게KG&fields[]=부피CBM&fields[]=배송방식`); } catch (e) {}
          let kgSum = 0, cbmSum = 0, missing = false;
          boxes.forEach(b => { const kg = parseFloat((b.fields || {})['무게KG']) || 0; const cbm = parseFloat((b.fields || {})['부피CBM']) || 0; kgSum += kg; cbmSum += cbm; if (kg <= 0 || cbm <= 0) missing = true; });
          const cust = custMap[String(mailbox).replace(/-\d{6}$/, '')] || custMap[mailbox] || { member: '', company: '' };   // [선적분 키] base 우선
          // [v3.2.37] 배송방식 — Shipments.배송방식(단일 권위) 우선, 빈값이면 Boxes.배송방식 집합 폴백. 화물+택배 섞이면 둘 다 표시.
          const shipMethods = [...new Set([sf['배송방식'], ...boxes.map(b => (b.fields || {})['배송방식'])].map(v => String(v || '').trim()).filter(v => v === '화물' || v === '택배' || v === '밀크런'))];
          const agentTypes = [...(agentByShip[s.id] || [])];
          rows.push({ id: s.id, blNo: sf['BL번호'] || '', mailbox, shipDate, status, member: cust.member, company: cust.company, boxCount: boxes.length, kgSum, cbmSum, missingMeasure: missing, isReady: boxes.length > 0 && !missing, agentTypes, shipMethods });   // [v3.2.109] id·blNo / [v3.2.37] agentTypes·shipMethods(표시 전용)
        }
        rows.sort((a, b) => (a.shipDate || '').localeCompare(b.shipDate || '') || a.mailbox.localeCompare(b.mailbox));
        return res.json({ rows, days });
      }

      // [Phase2 박스입력 진행률] 읽기 전용 — Shipments.선적일 기준 그룹, 선적일 ≥ 오늘-7일(KST)만.
      //   완료 판정 = isBoxInputComplete (도구와 동일 로직 — 박스≥1 + 모든 박스 무게/가로/세로/높이 > 0).
      if (op === 'box_progress') {
        const cutoff = new Date(Date.now() - 7 * 86400000 + 9 * 3600000).toISOString().slice(0, 10);   // 오늘-7일 KST (산술만)
        const ships = await atListAll(`/${TABLES.Shipments}?fields[]=사서함&fields[]=선적일`);
        const windowed = ships.filter(s => { const sd = (s.fields || {})['선적일']; return sd && sd >= cutoff; });   // 문자열 비교(파싱 X)
        const groups = {};
        for (const s of windowed) {
          const f = s.fields || {}; const name = f['사서함'] || ''; const sd = f['선적일'] || '';
          let boxes = [];
          try { boxes = await atListAll(`/${TABLES.Boxes}?filterByFormula=${encodeURIComponent(`SEARCH('${name}',ARRAYJOIN({Shipment}))`)}&fields[]=무게KG&fields[]=가로cm&fields[]=세로cm&fields[]=높이cm`); } catch (e) {}
          if (!groups[sd]) groups[sd] = { date: sd, total: 0, complete: 0, incomplete: [] };
          const g = groups[sd]; g.total++;
          if (isBoxInputComplete(boxes)) g.complete++; else g.incomplete.push(name);
        }
        const rows = Object.values(groups).sort((a, b) => a.date.localeCompare(b.date));
        return res.json({ rows, cutoff });
      }

      // [v3.2.128] 관세사 최종파일 다운로드 — 선적일(Orders.실제출고요청일)별 사서함의 최종IP+CO+BL 첨부 URL 반환.
      //   읽기 전용 · 서버 PAT만(브라우저 노출 0). ZIP 묶음은 브라우저(JSZip). 부킹 요약과 동일한 날짜→사서함 해석.
      //   최종 IP = downloadInvoiceExcel({stage:'final'})가 _snapshotIp로 저장한 Shipments.최종IP파일(v3.2.127 게이트 반영본).
      //   CO·BL·최종IP 중 하나라도 없으면 ready=false → 브라우저가 ❌ 표시 후 ZIP에서 스킵.
      if (op === 'final_files') {
        const daysParam = (req.query.days || '').trim();
        const days = daysParam ? daysParam.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!days.length) return res.status(400).json({ error: 'days 누락' });
        const orderFormula = `OR(${days.map(d => `IS_SAME({실제출고요청일},'${d}','day')`).join(',')})`;
        const orders = await atListAll(`/${TABLES.Orders}?filterByFormula=${encodeURIComponent(orderFormula)}&fields[]=Shipment&fields[]=실제출고요청일`);
        if (!orders.length) return res.json({ rows: [], days });
        const shipDateMap = {};
        orders.forEach(o => { const ships = (o.fields || {}).Shipment || []; const d = (o.fields || {})['실제출고요청일']; ships.forEach(sid => { if (!d) return; if (!shipDateMap[sid] || d < shipDateMap[sid]) shipDateMap[sid] = d; }); });
        const shipIds = Object.keys(shipDateMap);
        if (!shipIds.length) return res.json({ rows: [], days });
        const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
        let ships = [];
        for (const c of chunk(shipIds, 50)) {
          const f = `OR(${c.map(id => `RECORD_ID()='${id}'`).join(',')})`;
          ships = ships.concat(await atListAll(`/${TABLES.Shipments}?filterByFormula=${encodeURIComponent(f)}&fields[]=사서함&fields[]=상태&fields[]=BL번호&fields[]=최종IP파일&fields[]=CO파일&fields[]=BL파일`));
        }
        const att = (arr) => (Array.isArray(arr) ? arr : []).map(a => ({ url: a.url, filename: a.filename || 'file' })).filter(a => a.url);
        const rows = ships.map(s => {
          const sf = s.fields || {};
          // [v3.2.132] 최종IP는 ★최신(마지막) 1장만 — 과거 append 누적분(예: CO 전/후 2장)이 남아도 가장 최근것만 담음. (1차IP파일은 ZIP 미포함)
          const _ipAll = att(sf['최종IP파일']); const finalIp = _ipAll.length ? [_ipAll[_ipAll.length - 1]] : [];
          const co = att(sf['CO파일']); const bl = att(sf['BL파일']);
          const missing = [].concat(finalIp.length ? [] : ['최종IP'], co.length ? [] : ['CO'], bl.length ? [] : ['BL']);
          return { id: s.id, mailbox: sf['사서함'] || '', shipDate: shipDateMap[s.id] || '', status: sf['상태'] || '', blNo: sf['BL번호'] || '', finalIp, co, bl, ready: missing.length === 0, missing };
        });
        rows.sort((a, b) => (a.shipDate || '').localeCompare(b.shipDate || '') || a.mailbox.localeCompare(b.mailbox));
        return res.json({ rows, days });
      }
      return res.status(400).json({ error: 'Unknown op' });
    }

    if (req.method === 'POST') {
      const body = _postBody || await readBody(req);   // [채널톡] notify 분기에서 이미 읽었으면 재사용(이중 read 방지)
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

      // v3.2.49 [Phase 1-G]: BL/CO 대조 확인 (관세사). 도구(직원)와 동일 단일 필드.
      if (op === 'confirm_doc_match') {
        const { shipmentId } = body;
        if (!shipmentId) return res.status(400).json({ error: 'shipmentId 누락' });
        const ship = await atRequest('GET', `/${TABLES.Shipments}/${shipmentId}`);
        const prev = ship.fields['대조확인상태'] || '';
        const today = new Date().toISOString().slice(0, 10);
        await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
          fields: { '대조확인상태': '확인완료', '대조확인일시': today, '대조확인자': '관세사:' + (agent.email || agent.name || '') }, typecast: true,
        });
        await logAction(agent, shipmentId, null, { '대조확인상태': prev }, { '대조확인상태': '확인완료' });
        return res.json({ ok: true, 대조확인일시: today });
      }

      // [파일허브] 면허(수입신고필증) 업로드 — 관세사 JWT. Shipments.면허파일 1장 replace.
      // [v3.2.73] ★content endpoint(uploadAttachment)로 전환 — base64 직접 업로드. data:URL을 attachment.url에 넣던 방식(422 INVALID_ATTACHMENT_OBJECT) 폐기.
      if (op === 'upload_license') {
        const { shipmentId, file } = body;
        if (!shipmentId) return res.status(400).json({ error: 'shipmentId 누락' });
        if (!file || !file.base64) return res.status(400).json({ error: '파일(file.base64) 누락' });
        const LICENSE_FIELD = 'fldYmUhtUuJG5RP0R';   // Shipments.면허파일 (필드 ID — 한글명 인코딩 사고 방지)
        await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, { fields: { '면허파일': [] }, typecast: true });   // 1장 replace → 비움
        const up = await fetch(`https://content.airtable.com/v0/${BASE_ID}/${shipmentId}/${LICENSE_FIELD}/uploadAttachment`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: String(file.contentType || 'application/pdf'), filename: String(file.filename || '면허.pdf'), file: String(file.base64) }),
        });
        if (!up.ok) { const t = await up.text(); return res.status(502).json({ error: `면허 업로드 실패 ${up.status}: ${t.slice(0, 160)}` }); }
        const uj = await up.json();
        const atts = (uj.fields && uj.fields[LICENSE_FIELD]) || [];
        const fname = (atts[0] && atts[0].filename) || String(file.filename || '면허.pdf');
        await logAction(agent, shipmentId, null, { '면허파일': '(이전)' }, { '면허파일': fname });
        return res.json({ ok: true, filename: fname });
      }

      // [v3.2.110] 수입면장 일괄업로드 정정: 별도 op 폐기 — 정본=면허파일(fldYmUht)이므로 단건과 동일하게 op=upload_license 재사용.
      //   (v3.2.109가 통관필증(fldAHuXo)을 타깃했으나 면장 데이터는 전부 면허파일에 있어 정정. 통관필증은 0건·미사용.)

      return res.status(400).json({ error: 'Unknown op' });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[agent] error:', e);
    res.status(status).json({ error: e.message || String(e) });
  }
};
