// 관세청 UNI-PASS 고시환율 프록시
// GET /api/exchange-rate            → 오늘 기준 고시환율
// GET /api/exchange-rate?date=YYYY-MM-DD → 지정일 적용환율
//
// CORS 처리. 인메모리 1시간 캐시 (Vercel 함수 인스턴스 동안).
// UNIPASS_API_KEY 미설정 시 503 + 메시지 — 프론트는 Mock으로 폴백.

const { handleCors } = require('./_lib');

const ENDPOINT = 'https://unipass.customs.go.kr:38010/ext/rest/trifFxrtInfoQry/retrieveTrifFxrtInfo';

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 60 * 60 * 1000;  // 1시간

function ymdDash(s) {
  if (!s || s.length < 8) return '';
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

function isoWeekNo(dateStr) {
  // ISO 8601 주차 (관세청 UNI-PASS는 정확한 정의를 공개하지 않으나 ISO 기준이 무난)
  if (!dateStr || dateStr.length < 8) return '';
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(4, 6), d = +dateStr.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

function parseUnipassXml(xml) {
  const items = [...xml.matchAll(/<trifFxrtInfoQryRsltVo>([\s\S]*?)<\/trifFxrtInfoQryRsltVo>/g)];
  const get = (s, tag) => {
    const m = s.match(new RegExp('<' + tag + '>([^<]+)<\\/' + tag + '>'));
    return m ? m[1].trim() : '';
  };
  const rates = {};
  let aplyStart = '', aplyEnd = '';
  items.forEach(m => {
    const body = m[1];
    const currCode = (get(body, 'currSgn') || get(body, 'mtryUtNm')).toUpperCase();
    const rate = parseFloat(get(body, 'fxrt') || get(body, 'kwExchRate'));
    if (currCode && !isNaN(rate) && rate > 0) rates[currCode] = rate;
    aplyStart = aplyStart || get(body, 'aplyBgnDt');
    aplyEnd = aplyEnd || get(body, 'aplyEndDt');
  });
  return { rates, aplyStart, aplyEnd, itemCount: items.length };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    // 캐시 히트 (인메모리, 1시간)
    if (_cache && Date.now() - _cacheAt < CACHE_TTL && !req.query.force) {
      return res.json({ ...(_cache), cached: true });
    }

    const key = process.env.UNIPASS_API_KEY;
    if (!key) {
      return res.status(503).json({
        error: 'UNIPASS_API_KEY 미설정 — Vercel 환경변수에 추가 필요 (공공데이터포털 → 관세청 UNI-PASS 인증키)',
        hint: 'mock_fallback'
      });
    }

    const dateParam = (req.query.date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
    const url = `${ENDPOINT}?crkyCn=${encodeURIComponent(key)}&aplyBgnDt=${dateParam}&imexTp=2`;

    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error('UNI-PASS HTTP ' + r.status);
    const xml = await r.text();

    const parsed = parseUnipassXml(xml);
    if (!parsed.itemCount) {
      // 파싱 실패 — 응답 형식이 바뀌었을 수 있음
      console.warn('UNI-PASS empty/unrecognized response (head 300):', xml.slice(0, 300));
      return res.status(502).json({
        error: 'UNI-PASS 응답 파싱 실패 — 응답 형식 변경 가능성',
        hint: 'mock_fallback'
      });
    }

    const result = {
      weekStart: ymdDash(parsed.aplyStart) || ymdDash(dateParam),
      weekEnd: ymdDash(parsed.aplyEnd) || ymdDash(dateParam),
      weekNo: isoWeekNo(parsed.aplyStart || dateParam),
      source: '관세청 UNI-PASS 고시환율 (실시간)',
      fetchedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      rates: {
        USD: parsed.rates.USD || 0,
        CNY: parsed.rates.CNY || 0,
        EUR: parsed.rates.EUR || 0,
        JPY: parsed.rates.JPY || 0,  // JPY는 100엔당 (UNI-PASS 원본 그대로)
      },
    };

    _cache = result;
    _cacheAt = Date.now();
    res.json({ ...result, cached: false });
  } catch (e) {
    console.error('exchange-rate error:', e);
    res.status(500).json({ error: e.message, hint: 'mock_fallback' });
  }
};
