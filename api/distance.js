// Phase F1 — 카카오 길찾기 API 프록시 (출발지: 인천항 보세창고 → 도착지: 입력 주소)
//
// GET /api/distance?address=...    → { km, sec, fromAddress, toAddress, source }
// GET /api/distance?lng=..&lat=..  → 좌표 직접 입력
//
// KAKAO_REST_API_KEY 미설정 시 503 (Mock 폴백을 프론트에서 처리)

const { handleCors } = require('./_lib');

// 인천항 보세창고 (기준점)
const ORIGIN = { lat: 37.4505, lng: 126.6588, address: '인천광역시 중구 항동7가' };

let _cache = new Map();        // address → { km, sec, at }
const CACHE_TTL = 12 * 3600 * 1000;  // 12시간

async function kakaoGeocode(key, addr) {
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(addr)}`;
  const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!r.ok) throw new Error('카카오 지오코딩 HTTP ' + r.status);
  const data = await r.json();
  const doc = (data.documents || [])[0];
  if (!doc) throw new Error('주소를 찾을 수 없습니다: ' + addr);
  return { lng: parseFloat(doc.x), lat: parseFloat(doc.y), formatted: doc.address_name };
}

async function kakaoRoute(key, origin, dest) {
  const url = `https://apis-navi.kakaomobility.com/v1/directions`
    + `?origin=${origin.lng},${origin.lat}&destination=${dest.lng},${dest.lat}`
    + `&priority=RECOMMEND&summary=true`;
  const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
  if (!r.ok) throw new Error('카카오 길찾기 HTTP ' + r.status);
  const data = await r.json();
  const route = (data.routes || [])[0];
  if (!route || !route.summary) throw new Error('경로를 찾을 수 없습니다');
  return { km: route.summary.distance / 1000, sec: route.summary.duration };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const key = process.env.KAKAO_REST_API_KEY;
    if (!key) {
      return res.status(503).json({
        error: 'KAKAO_REST_API_KEY 미설정 — Mock 모드로 폴백하세요',
        hint: 'mock_fallback',
        origin: ORIGIN,
      });
    }

    let dest, addrLabel;
    if (req.query.lng && req.query.lat) {
      dest = { lng: parseFloat(req.query.lng), lat: parseFloat(req.query.lat) };
      addrLabel = req.query.address || `${dest.lat},${dest.lng}`;
    } else if (req.query.address) {
      const addr = String(req.query.address).trim();
      const cached = _cache.get(addr);
      if (cached && Date.now() - cached.at < CACHE_TTL) {
        return res.json({ ...cached, cached: true });
      }
      const geo = await kakaoGeocode(key, addr);
      dest = { lng: geo.lng, lat: geo.lat };
      addrLabel = geo.formatted || addr;
    } else {
      return res.status(400).json({ error: 'address 또는 lng/lat 필요' });
    }

    const route = await kakaoRoute(key, ORIGIN, dest);
    const result = {
      km: Math.round(route.km * 10) / 10,
      sec: route.sec,
      fromAddress: ORIGIN.address,
      toAddress: addrLabel,
      origin: ORIGIN, dest,
      source: 'kakao_mobility',
      at: Date.now(),
    };
    if (req.query.address) _cache.set(req.query.address, result);
    res.json(result);
  } catch (e) {
    console.error('[distance]', e);
    res.status(500).json({ error: e.message, hint: 'mock_fallback' });
  }
};
