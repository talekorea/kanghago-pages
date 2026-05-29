// 페이앱(PayApp) 결제 요청 생성 프록시 — 1단계 (수동 발송, 2026-05-30)
// POST /api/payapp-create
//   body: {
//     mailbox:        '...',     // 사서함 번호 (예: AP2233)
//     shipmentId:     'rec...',  // Airtable Shipments record ID (저장용)
//     amount:         123000,    // 결제 금액 (KRW, 정수)
//     goodname:       '...',     // 상품명 (예: "강하고 통관 AP2233 청구서")
//     customer_name:  '...',     // 화주 이름 (선택)
//     customer_phone: '...',     // 화주 전화 (선택, SMS 발송 시)
//   }
//   returns: { ok, payurl, mul_no, savedToAirtable }
//
// 결제 완료 처리는 1단계 수동 (직원이 페이앱 관리 페이지 → 도구 §13).
// 2단계에서 /api/payapp-webhook.js 신설 → 자동 처리.
//
// 환경 변수 (Vercel):
//   PAYAPP_USERID   — 페이앱 마이페이지 USERID
//   PAYAPP_LINKKEY  — API 연동 키 1
//   PAYAPP_LINKVAL  — API 연동 키 2
//   AIRTABLE_PAT    — Shipments PATCH용 (이미 있음)

const { atRequest, handleCors, readBody, TABLES } = require('./_lib');

const PAYAPP_ENDPOINT = 'https://api.payapp.kr/oapi/apiLoad.html';
// 페이앱 cmd=payrequest 명세:
//   userid (필수), shop_user_id (필수, 임의), goodname (필수), price (필수),
//   recvphone (휴대폰 SMS 발송 시), feedbackurl (웹훅 — 2단계),
//   returnurl (결제 완료 후 redirect), var1/var2 (사용자 정의), smsuse (y/n)
//   linkkey + linkval (HMAC 인증 키)
//
// 응답: x-www-form-urlencoded 형식 (state=1&payurl=...&mul_no=...&...)
// 또는 JSON (페이앱 계정 설정에 따라). 둘 다 대응.

function parsePayappResponse(text) {
  // 우선 JSON 파싱 시도
  try {
    const j = JSON.parse(text);
    return j;
  } catch (_) {
    // 실패 시 querystring 파싱
    const out = {};
    text.split('&').forEach(pair => {
      const [k, ...v] = pair.split('=');
      if (k) out[decodeURIComponent(k)] = decodeURIComponent((v.join('=') || '').replace(/\+/g, ' '));
    });
    return out;
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  // 환경변수 점검
  const USERID = process.env.PAYAPP_USERID;
  const LINKKEY = process.env.PAYAPP_LINKKEY;
  const LINKVAL = process.env.PAYAPP_LINKVAL;
  if (!USERID || !LINKKEY || !LINKVAL) {
    return res.status(503).json({
      ok: false,
      error: 'PAYAPP_USERID / PAYAPP_LINKKEY / PAYAPP_LINKVAL 환경변수 미설정',
      hint: 'Vercel Settings → Environment Variables에 3개 추가 후 재배포',
    });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid JSON body' }); }

  const { mailbox, shipmentId, amount, goodname, customer_name, customer_phone } = body;

  // 입력 검증
  if (!mailbox)   return res.status(400).json({ ok: false, error: 'mailbox 필수' });
  if (!amount || amount <= 0) return res.status(400).json({ ok: false, error: 'amount 필수(> 0)' });
  const intAmount = Math.round(Number(amount));
  if (intAmount < 100) return res.status(400).json({ ok: false, error: '최소 100원' });
  const finalGoodname = (goodname || `강하고 통관 ${mailbox} 청구서`).slice(0, 80);

  // shop_user_id: 사서함 + 타임스탬프 (중복 방지) — 페이앱에서 거래 식별용
  const shopUserId = `${mailbox}-${Date.now()}`;

  // 페이앱 요청 본문 (x-www-form-urlencoded)
  const params = new URLSearchParams();
  params.append('cmd', 'payrequest');
  params.append('userid', USERID);
  params.append('linkkey', LINKKEY);
  params.append('linkval', LINKVAL);
  params.append('shop_user_id', shopUserId);
  params.append('goodname', finalGoodname);
  params.append('price', String(intAmount));
  params.append('currency', 'KRW');
  params.append('var1', mailbox);                              // 사용자 정의 1 (사서함)
  if (shipmentId) params.append('var2', shipmentId);          // 사용자 정의 2 (Airtable rec)
  if (customer_phone) params.append('recvphone', customer_phone.replace(/\D/g, ''));
  if (customer_name)  params.append('payername', customer_name.slice(0, 30));
  params.append('smsuse', 'n');                                // 1단계는 SMS 자동발송 X (직원 수동)
  params.append('feedbackurl', '');                            // 1단계는 웹훅 X (2단계)
  // returnurl: 결제 완료 후 안내 페이지 (1단계는 페이앱 기본 완료창 사용)
  // params.append('returnurl', 'https://kanghago-pages.vercel.app/payment-complete.html');

  // 페이앱 호출
  let payappResp;
  try {
    const r = await fetch(PAYAPP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await r.text();
    payappResp = parsePayappResponse(text);
    payappResp._http = r.status;
    payappResp._raw = text.slice(0, 500);  // 디버깅용 (성공 시도 잘라서 응답에 포함 안 함)
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'payapp fetch failed', detail: e.message });
  }

  // 페이앱 응답 검증 — state=1이 성공 (또는 success 등 변형)
  const stateOk = String(payappResp.state || '').trim() === '1'
    || String(payappResp.success || '').toLowerCase() === 'true';
  const payurl = payappResp.payurl || payappResp.pay_url || '';
  const mulNo  = payappResp.mul_no || payappResp.mulNo || '';

  if (!stateOk || !payurl) {
    return res.status(502).json({
      ok: false,
      error: '페이앱 응답 비정상',
      detail: payappResp.errorMessage || payappResp.errmsg || payappResp._raw,
      payappState: payappResp.state,
      http: payappResp._http,
    });
  }

  // Airtable Shipments에 저장 (shipmentId가 있으면)
  let savedToAirtable = false;
  if (shipmentId) {
    try {
      await atRequest('PATCH', `/${TABLES.Shipments}/${shipmentId}`, {
        fields: {
          '페이앱_결제URL': payurl,
          '페이앱_거래번호': mulNo,
          '페이앱_요청금액': intAmount,
          '페이앱_요청일시': new Date().toISOString(),
          '페이앱_결제상태': '요청완료',
        },
        typecast: true,
      });
      savedToAirtable = true;
    } catch (e) {
      // Airtable 저장 실패해도 결제 URL은 반환 (직원이 수동 복사 가능)
      console.warn('[payapp-create] Airtable PATCH 실패:', e.message);
    }
  }

  return res.status(200).json({
    ok: true,
    payurl,
    mul_no: mulNo,
    amount: intAmount,
    mailbox,
    goodname: finalGoodname,
    savedToAirtable,
    requestedAt: new Date().toISOString(),
  });
};
