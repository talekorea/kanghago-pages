// v3.2.36 (2026-06-01): 페이앱 결제요청 취소
// POST /api/payapp-cancel { mul_no, memo? }
//   - cmd=paycancel (즉시 취소). 결제 승인 전에는 안전하게 취소 가능.
//   - 결제 완료(D+5 이내 일부 케이스) 후엔 정산 환불 별도 절차 필요.
// 출처: https://www.payapp.kr/dev_center/dev_center01.html

const { handleCors, readBody } = require('./_lib');

const PAYAPP_ENDPOINT = 'https://api.payapp.kr/oapi/apiLoad.html';

function parsePayappResponse(text) {
  try { return JSON.parse(text); }
  catch (_) {
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
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const USERID = process.env.PAYAPP_USERID;
  const LINKKEY = process.env.PAYAPP_LINKKEY;
  if (!USERID || !LINKKEY) {
    return res.status(503).json({ ok: false, error: 'PAYAPP_USERID / PAYAPP_LINKKEY 환경변수 미설정' });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }

  const mul_no = String(body.mul_no || '').trim();
  const memo = String(body.memo || '금액 변경으로 인한 재생성').slice(0, 60);
  if (!mul_no) return res.status(400).json({ ok: false, error: 'mul_no 필수' });

  const params = new URLSearchParams();
  params.append('cmd', 'paycancel');
  params.append('userid', USERID);
  params.append('linkkey', LINKKEY);
  params.append('mul_no', mul_no);
  params.append('cancelmemo', memo);

  try {
    const r = await fetch(PAYAPP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await r.text();
    const resp = parsePayappResponse(text);
    const stateOk = String(resp.state || '').trim() === '1' || String(resp.success || '').toLowerCase() === 'true';
    if (!stateOk) {
      return res.status(200).json({
        ok: false,
        cancelled: false,
        detail: resp.errorMessage || resp.errmsg || text.slice(0, 300),
        mul_no,
      });
    }
    return res.status(200).json({ ok: true, cancelled: true, mul_no, memo });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'payapp fetch failed', detail: e.message });
  }
};
