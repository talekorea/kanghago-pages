// 관세청 적용환율 프록시 — 공공데이터포털(data.go.kr) 방식
// GET /api/exchange-rate            → 최근 주차 적용환율 (수입, weekFxrtTpcd=2)
// GET /api/exchange-rate?date=YYYY-MM-DD  → 지정 주 시작일 기준
// GET /api/exchange-rate?debug=1    → 진단 (serviceKey 마스킹)
//
// 작동 URL (검증됨):
//   http://apis.data.go.kr/1220000/retrieveTrifFxrtInfo/getRetrieveTrifFxrtInfo
//     ?serviceKey={Encoding키}&aplyBgnDt={YYYYMMDD 월요일}&weekFxrtTpcd=2
// 환경변수: DATAGO_SERVICE_KEY (없으면 UNIPASS_API_KEY 폴백)

const { handleCors } = require('./_lib');

const ENDPOINT = 'http://apis.data.go.kr/1220000/retrieveTrifFxrtInfo/getRetrieveTrifFxrtInfo';

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 60 * 60 * 1000;  // 1시간

// 통화부호 → ISO 매핑 (공공데이터포털 currSgn은 USD/CNY 표준이지만 방어적으로 매핑)
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
  if (/달러|미국|US\s*Dollar|US[D]?/i.test(nm)) return 'USD';
  if (/위안|중국|Yuan|CN[YH]?|RMB/i.test(nm)) return 'CNY';
  if (/엔|일본|Yen|JPY/i.test(nm)) return 'JPY';
  if (/유로|Euro|EUR/i.test(nm)) return 'EUR';
  return s;
}

function ymdDash(s) {
  if (!s || s.length < 8) return '';
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

// 주어진 날짜가 속한 주의 일요일(YYYYMMDD) — 관세 적용환율 주 시작일(일요일 발효)
// 사장님 작동 URL aplyBgnDt=20260517(일요일)과 일치
function weekStartOf(date) {
  const d = (date instanceof Date) ? new Date(date) : new Date(date || Date.now());
  d.setDate(d.getDate() - d.getDay());    // getDay 0=일 → 일요일까지 뒤로
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function minusDaysYmd(ymd, days) {
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  d.setDate(d.getDate() - days);
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function isoWeekNo(dateStr) {
  if (!dateStr || dateStr.length < 8) return '';
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(4, 6), d = +dateStr.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

function parseDataGoXml(xml) {
  const get = (s, tag) => {
    const m = s.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>'));
    return m ? m[1].trim() : '';
  };
  const resultCode = get(xml, 'resultCode');
  const resultMsg = get(xml, 'resultMsg');
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const rates = {};
  const raw = {};
  let aplyStart = '';
  items.forEach(m => {
    const body = m[1];
    const currSgn = get(body, 'currSgn');
    const mtryUtNm = get(body, 'mtryUtNm');
    const rate = parseFloat(get(body, 'fxrt'));
    aplyStart = aplyStart || get(body, 'aplyBgnDt');
    if ((currSgn || mtryUtNm) && !isNaN(rate) && rate > 0) {
      const code = mapCurrency(currSgn, mtryUtNm);
      if (['USD', 'CNY', 'JPY', 'EUR'].includes(code)) {
        rates[code] = rate;
        raw[currSgn || mtryUtNm] = rate;
      }
    }
  });
  return { resultCode, resultMsg, rates, raw, aplyStart, itemCount: items.length };
}

async function callDataGo(key, aplyBgnDt) {
  // serviceKey는 Encoding(이미 URL 인코딩) 키 — 그대로 부착 (재인코딩 X)
  const url = `${ENDPOINT}?serviceKey=${key}&aplyBgnDt=${aplyBgnDt}&weekFxrtTpcd=2`;
  const masked = `${ENDPOINT}?serviceKey=${(key || '').slice(0, 8)}...(${(key || '').length}자)&aplyBgnDt=${aplyBgnDt}&weekFxrtTpcd=2`;
  let r = null, xml = '', fetchErr = null;
  try {
    r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    xml = await r.text();
  } catch (e) {
    fetchErr = { message: e.message, name: e.name,
      cause: e.cause ? { code: e.cause.code, errno: e.cause.errno, syscall: e.cause.syscall } : null };
  }
  return { url, masked, status: r ? r.status : null, xml, fetchErr };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const debug = !!req.query.debug;
    if (_cache && Date.now() - _cacheAt < CACHE_TTL && !req.query.force && !debug) {
      return res.json({ ...(_cache), cached: true });
    }

    const key = process.env.DATAGO_SERVICE_KEY || process.env.UNIPASS_API_KEY;
    if (!key) {
      if (debug) return res.json({ diag: true, keyPresent: false, endpoint: ENDPOINT,
        envSampleNames: Object.keys(process.env).filter(k => /DATAGO|UNIPASS|SERVICE_KEY|CUSTOMS/i.test(k)),
        note: 'DATAGO_SERVICE_KEY(또는 UNIPASS_API_KEY) 환경변수 없음' });
      return res.status(503).json({ error: 'DATAGO_SERVICE_KEY 미설정', hint: 'mock_fallback' });
    }

    // 적용개시일(월요일) — 지정일 우선, 없으면 이번 주. 결과 없으면 이전 주들로 폴백(최대 3주)
    let aplyBgnDt = req.query.date ? weekStartOf(req.query.date) : weekStartOf(new Date());
    let attempt = null, parsed = null;
    for (let i = 0; i < 3; i++) {
      attempt = await callDataGo(key, aplyBgnDt);
      if (attempt.fetchErr) break;  // 네트워크 실패는 재시도 무의미
      parsed = parseDataGoXml(attempt.xml);
      if (parsed.resultCode === '00' && parsed.itemCount > 0 && parsed.rates.USD > 0) break;
      aplyBgnDt = minusDaysYmd(aplyBgnDt, 7);  // 이전 주
    }

    if (debug) {
      return res.json({
        diag: true, keyPresent: true, keyLength: key.length, keyPrefix: key.slice(0, 8) + '...',
        endpoint: ENDPOINT, maskedUrl: attempt.masked, httpStatus: attempt.status,
        fetchError: attempt.fetchErr,
        resultCode: parsed && parsed.resultCode, resultMsg: parsed && parsed.resultMsg,
        itemCount: parsed && parsed.itemCount, rawCurrencies: parsed && parsed.raw,
        mappedRates: parsed && parsed.rates, aplyBgnDt,
        xmlHead: (attempt.xml || '').slice(0, 1000),
      });
    }

    if (attempt.fetchErr) {
      return res.status(502).json({ error: '공공데이터포털 연결 실패: ' + attempt.fetchErr.message
        + (attempt.fetchErr.cause ? ' (' + attempt.fetchErr.cause.code + ')' : ''), hint: 'mock_fallback' });
    }
    if (!parsed || parsed.resultCode !== '00') {
      return res.status(502).json({ error: '공공데이터포털 응답 오류: ' + (parsed && parsed.resultMsg || 'resultCode ' + (parsed && parsed.resultCode)),
        hint: 'mock_fallback' });
    }
    if (!(parsed.rates.USD > 0)) {
      return res.status(502).json({ error: '환율 데이터 없음 (USD 0) — ?debug=1로 원본 확인', hint: 'mock_fallback' });
    }

    const result = {
      weekStart: ymdDash(parsed.aplyStart || aplyBgnDt),
      weekEnd: ymdDash(minusDaysYmd(parsed.aplyStart || aplyBgnDt, -6)),
      weekNo: isoWeekNo(parsed.aplyStart || aplyBgnDt),
      source: '관세청 적용환율 (공공데이터포털 실시간)',
      fetchedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      rates: {
        USD: parsed.rates.USD || 0,
        CNY: parsed.rates.CNY || 0,
        EUR: parsed.rates.EUR || 0,
        JPY: parsed.rates.JPY || 0,  // 100엔당
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
