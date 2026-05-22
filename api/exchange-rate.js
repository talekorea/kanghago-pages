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

// UNI-PASS 통화부호(국가부호 스타일) → ISO 통화코드 매핑
const CURR_MAP = {
  US: 'USD', USD: 'USD',
  CN: 'CNY', CNY: 'CNY', CH: 'CNY', CNH: 'CNY', RMB: 'CNY',
  JP: 'JPY', JPY: 'JPY',
  EU: 'EUR', EUR: 'EUR',
};
function mapCurrency(currSgn, mtryUtNm) {
  const s = (currSgn || '').toUpperCase().trim();
  if (CURR_MAP[s]) return CURR_MAP[s];
  const nm = mtryUtNm || '';
  if (/달러|미국|US[D]?/i.test(nm)) return 'USD';
  if (/위안|중국|CN[YH]?|RMB/i.test(nm)) return 'CNY';
  if (/엔|일본|JPY/i.test(nm)) return 'JPY';
  if (/유로|EUR/i.test(nm)) return 'EUR';
  return s;  // 알 수 없으면 원본 부호 유지
}

// 응답 루트 태그가 *RsltVo 또는 *RtnVo 변형이어도 item 단위로 잡도록 넓은 매칭
function parseUnipassXml(xml) {
  let items = [...xml.matchAll(/<trifFxrtInfoQryRsltVo>([\s\S]*?)<\/trifFxrtInfoQryRsltVo>/g)];
  if (!items.length) {
    // 폴백: 통화부호(currSgn) 또는 환율(fxrt) 포함한 임의 반복 블록
    items = [...xml.matchAll(/<(\w*Vo)>([\s\S]*?)<\/\1>/g)].map(m => [m[0], m[2]])
      .filter(it => /<(currSgn|mtryUtNm|fxrt|kwExchRate)>/.test(it[1]));
  }
  const get = (s, tag) => {
    const m = s.match(new RegExp('<' + tag + '>([^<]+)<\\/' + tag + '>'));
    return m ? m[1].trim() : '';
  };
  const rates = {};
  const raw = {};
  let aplyStart = '', aplyEnd = '';
  items.forEach(m => {
    const body = m[1];
    const currSgn = get(body, 'currSgn');
    const mtryUtNm = get(body, 'mtryUtNm');
    const rate = parseFloat(get(body, 'fxrt') || get(body, 'kwExchRate'));
    if ((currSgn || mtryUtNm) && !isNaN(rate) && rate > 0) {
      const code = mapCurrency(currSgn, mtryUtNm);
      rates[code] = rate;
      raw[currSgn || mtryUtNm] = rate;
    }
    aplyStart = aplyStart || get(body, 'aplyBgnDt');
    aplyEnd = aplyEnd || get(body, 'aplyEndDt');
  });
  return { rates, raw, aplyStart, aplyEnd, itemCount: items.length };
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
    const xml = await r.text();
    const parsed = parseUnipassXml(xml);

    // 진단 모드 — ?debug=1 (사장님이 원본/파싱 결과 확인용, 인증키 노출 X)
    if (req.query.debug) {
      return res.json({
        diag: true, httpStatus: r.status, keyPresent: !!key,
        itemCount: parsed.itemCount, rawCurrencies: parsed.raw, mappedRates: parsed.rates,
        aply: parsed.aplyStart + '~' + parsed.aplyEnd,
        xmlHead: xml.slice(0, 1000),
      });
    }

    if (!r.ok) throw new Error('UNI-PASS HTTP ' + r.status);
    if (!parsed.itemCount) {
      console.warn('UNI-PASS empty/unrecognized response (head 500):', xml.slice(0, 500));
      return res.status(502).json({
        error: 'UNI-PASS 응답 파싱 실패 — ?debug=1로 원본 확인',
        hint: 'mock_fallback', xmlHead: xml.slice(0, 300),
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
