// v3.2.24 (2026-05-31): AI HS 추천 — 신뢰원 = 마지막 편집 칸 (단방향)
//
// POST /api/hs-suggest { mode, nameEn?, material?, hs10? }
//   mode='name2hs' → 영문명·재질 → HS 후보 (기존)
//   mode='hs2name' → HS → 영문명·재질 후보 (HS 유효 필수)
//   ※ 'both' 모드 폐기 — 신뢰원만 근거로 단방향 추천 (다른 칸 값은 무시)
//
// HS 무효 (10자리이나 공식표 미존재) → { ok:false, invalid:true, leafCandidates:[...] }
//   호출자는 영문명 추천을 제시하지 말 것.

const { handleCors, readBody } = require('./_lib');
// v3.2.33: tariff.json → public/data/로 이동 (Vercel은 public/만 정적 서빙). api 경로도 동기화.
const TARIFF = require('../public/data/tariff.json');
// v3.2.248: HS6 공식 검증용 — TARIFF(10자리 11,326건)를 6자리로 절단한 집합. 모듈 스코프 1회 생성(요청마다 재생성 금지).
const HS6_SET = new Set(Object.keys(TARIFF).map(k => String(k).replace(/\D/g, '').slice(0, 6)).filter(x => x.length === 6));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1024;

// [ecom-v0.16 Phase2] link2en — 1688 링크(offerId) → 실제 중문 상품명/재질 → 영문 통관품명 변환.
//   ★API_TOKEN_INVOICE(강하고 별도 토큰)는 사장님이 Vercel 대시보드에서 직접 등록(코드에 값 없음).
const ALIBABA_PROXY_URL = process.env.ALIBABA_PROXY_URL || 'http://198.13.44.43:3688';
const API_TOKEN_INVOICE = process.env.API_TOKEN_INVOICE;
const PROXY_TIMEOUT_MS = 15000;
const AI_TIMEOUT_MS = 30000;

function extractOfferId(link) {
  const s = String(link || '');
  const m = s.match(/1688\.com\/offer\/(\d+)/) || s.match(/[?&]offerId=(\d+)/);
  return m ? m[1] : null;
}

// 1688 프록시(POST /api/product) 호출 — 중문 상품명(subject) + 재질(材质 속성) 추출.
//   ★재질 속성이 없는 리스팅(실측 6/12)은 실패가 아님 — materialCn=''로 정상 반환.
async function fetchOfferDetail(offerId) {
  if (!API_TOKEN_INVOICE) {
    throw Object.assign(new Error('API_TOKEN_INVOICE 환경 변수가 설정되지 않았습니다'),
      { hint: 'Vercel 대시보드(kanghago-pages) 환경 변수에 API_TOKEN_INVOICE 추가 + 재배포', stage: 'proxy' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`${ALIBABA_PROXY_URL}/api/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN_INVOICE}`, 'X-Caller': 'invoice' },
      body: JSON.stringify({ offerId }),
      signal: controller.signal,
    });
  } catch (e) {
    throw Object.assign(new Error('1688 프록시 연결 실패(타임아웃/네트워크)'), { hint: e.message, stage: 'proxy' });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw Object.assign(new Error(`1688 프록시 HTTP ${r.status}`), { stage: 'proxy' });
  const data = await r.json().catch(() => null);
  const res = data && data.result;
  if (!res || res.success !== true || !res.result) {
    throw Object.assign(new Error((res && res.message) || '1688 상품 조회 실패(존재하지 않거나 비공개)'), { stage: 'proxy' });
  }
  const inner = res.result;
  const subject = String(inner.subject || '').trim();
  if (!subject) throw Object.assign(new Error('1688 응답에 상품명(subject) 없음'), { stage: 'proxy' });
  let materialCn = '';
  for (const a of (inner.productAttribute || [])) {
    if (a.attributeName === '材质') { materialCn = String(a.value || '').trim(); break; }
  }
  return { subject, materialCn };
}

function normalize10(hsRaw) {
  const d = String(hsRaw || '').replace(/\D/g, '');
  return d.length === 10 ? d : (d.length > 10 ? d.slice(0, 10) : d);
}

function findLeafCandidates(hsRaw, max = 5) {
  const d = String(hsRaw || '').replace(/\D/g, '');
  if (d.length < 6) return [];
  const p6 = d.slice(0, 6);
  const out = [];
  for (const k in TARIFF) {
    if (k.startsWith(p6) && k !== d) {
      out.push(k);
      if (out.length >= max) break;
    }
  }
  return out;
}

function extractJson(text) {
  if (!text) return null;
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = Math.min(...['[', '{'].map(c => { const i = s.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (start === Infinity || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// v3.2.27: 영문명·재질 모순 감지 (heuristic)
//   영문명에 fiber 키워드 / 재질에 다른 fiber → 충돌
function detectConflict(nameEn, material) {
  if (!nameEn || !material) return null;
  const lowerN = nameEn.toLowerCase();
  const lowerM = material.toLowerCase();
  // 영문명에 명시된 fiber
  const fibersInName = [];
  if (/\bcotton\b/.test(lowerN)) fibersInName.push('cotton');
  if (/\bsynthetic\b|\bpolyester\b|\bnylon\b|\bacrylic\b/.test(lowerN)) fibersInName.push('synthetic');
  if (/\bwool\b/.test(lowerN)) fibersInName.push('wool');
  if (/\bsilk\b/.test(lowerN)) fibersInName.push('silk');
  if (/\blinen\b|\bflax\b/.test(lowerN)) fibersInName.push('linen');
  // 재질에 명시된 fiber
  const fiberInMat = /\bcotton\b/.test(lowerM) ? 'cotton'
                  : /\bsynthetic\b|\bpolyester\b|\bnylon\b|\bacrylic\b/.test(lowerM) ? 'synthetic'
                  : /\bwool\b/.test(lowerM) ? 'wool'
                  : /\bsilk\b/.test(lowerM) ? 'silk'
                  : /\blinen\b|\bflax\b/.test(lowerM) ? 'linen'
                  : null;
  if (fibersInName.length && fiberInMat && !fibersInName.includes(fiberInMat)) {
    return `영문명=${fibersInName.join('/')} / 재질=${fiberInMat}`;
  }
  return null;
}

// v3.2.27: 후보 hs10의 류(앞 2자리)가 갈리는지 감지
function detectChapterSplit(candidates) {
  if (!candidates || candidates.length < 2) return null;
  const chapters = new Set();
  candidates.forEach(c => {
    const hs = String(c.hs10 || '').replace(/\D/g, '');
    if (hs.length >= 2) chapters.add(hs.slice(0, 2));
  });
  if (chapters.size > 1) {
    return `후보 류 갈림: ${Array.from(chapters).map(c => c + '류').join(' / ')}`;
  }
  return null;
}

function buildPrompt(mode, nameEn, material, hs10, nameKr) {
  if (mode === 'name2hs6') {
    // [전자상거래] 영문 통관품명 → HS 6자리(국제 공통)만. ★10자리 국내 세번 추정 금지(근거 없는 숫자 방지).
    return `다음 제품의 국제 공통 HS 코드 6자리를 1~2개 후보로 제시하라.
- 영문 품명: ${nameEn || '(미입력)'}
- 재질: ${material || '(미입력)'}

★규칙(매우 중요):
- HS 6자리(국제 공통 분류, Harmonized System)까지만 판정. ★국내 세번 10자리는 절대 추정하지 마라(근거 없는 숫자 = 서류 오류).
- 분류가 모호하거나 품명만으로 6자리를 확정할 수 없으면 후보를 비워라(억지 추정 금지).
- 각 후보에 한 줄 근거.

**JSON 배열만 반환** — 설명 텍스트 금지:
[{"hs6":"630790","reason":"한 줄 근거"}]  (확정 불가면 [])`;
  }
  if (mode === 'kr2name') {
    // [전자상거래] 한국어 상품명(알리피드 마케팅명) → 영문 통관품명(세관 신고용 일반명) + HS 후보. 왕복 1회.
    return `다음 한국어 상품명을 세관 신고용 영문 통관품명으로 번역하고, 한국 HSK 10자리 후보를 함께 제시하라.
한국어 상품명: ${nameKr || '(미입력)'}

★번역 규칙(통관 신고용 — 매우 중요):
- 마케팅 문구·브랜드·수식어·용량·색상·"고급/선물용" 등 제거. **물품 자체를 지칭하는 일반명사구**만.
  예: "고급 스테인리스 보온병 500ml 선물용" → "vacuum flask" / "귀여운 강아지 집 대형" → "pet house" / "스마트폰 악세사리 케이스" → "phone case"
- 소문자 시작, 짧은 명사구(1~3단어). 영어.
- 재질을 유추할 수 있으면 영문으로(cotton/plastic/stainless steel 등), 없으면 빈 문자열.
- HS는 그 물품의 한국 관세율표 10자리 후보 1~2개.

**JSON 배열만 반환** — 설명 텍스트 금지:
[{"nameEn":"vacuum flask","material":"stainless steel","hs10":"0000000000","reason":"한 줄 근거"}]`;
  }
  if (mode === 'link2en') {
    // [ecom-v0.16 Phase2] 1688 실제 상품정보(중문) → 영문 통관품명. nameEn=subject(중문), material=materialCn(중문) 재사용.
    return `다음은 1688(중국 도매 플랫폼) 상품의 중국어 원문 정보다. 한국 수입통관 신고용 영문 품명으로 변환하라.
- 중국어 상품명: ${nameEn || '(정보 없음)'}
- 재질(중국어, 있으면): ${material || '(정보 없음)'}

★규칙(매우 중요):
- 마케팅 문구(可印LOGO·支持批发代发 같은 판촉/도매 안내 문구) · 브랜드명 · 수식어 · 연도 · 수량 제외.
- 물품의 재질+용도가 드러나는 구체적 명칭(소문자 시작, 짧은 명사구, 영어).
- food·snack·goods·products·supplies 같은 총칭 절대 금지 — 구체적으로 무엇인지 반드시 특정.
- 재질은 영문으로 변환(예: 不锈钢→stainless steel). 재질 정보가 없으면 빈 문자열(임의값 금지).
- 판단이 불가능하면 nameEn에 "UNKNOWN"만 반환(억지 추정 금지).

**JSON 배열만 반환** — 설명 텍스트 금지:
[{"nameEn":"...", "material":"...", "reason":"한 줄 근거"}]`;
  }
  if (mode === 'hs2name') {
    const tariff = TARIFF[hs10];
    const tariffInfo = `공식 세율: A=${tariff.A}% / CN=${tariff.CN}% / E1=${tariff.E1}%`;
    return `다음 한국 HSK 10자리 코드에 해당하는 제품의 영문 품명(Description)과 재질을 2~3개 후보로 제시하라.
HS코드: ${hs10}
${tariffInfo}

규칙:
- 통관 신고에 적합한 짧은 영문 품명 (소문자 시작, 명사구)
- 재질은 영문 (cotton / plastic / aluminum 등). 알 수 없으면 빈 문자열.
- 신뢰원은 HS코드만. 다른 입력은 무시하고 이 HS가 가리키는 품목을 그대로 묘사하라.

**JSON 배열만 반환** — 설명 텍스트 금지:
[{"nameEn":"...", "material":"...", "reason":"한 줄 근거"}]`;
  }
  // name2hs (기본) — v3.2.29: construction 입력 폐기. 의류일 때 편물(61)/직물(62) 양쪽 후보 지시.
  return `다음 제품의 한국 HSK 10자리 후보를 2~3개 제시하라.
각 후보에 한 줄 근거를 달고, 한국 관세율표 기준으로 판단하라.
- 의류는 편물(61류) / 직물(62류) 구분이 중요. 영문명에서 불확실하면 양쪽 후보를 모두 제시하라
  (예: 6104 계열·6204 계열 둘 다). 사용자가 HS로 최종 선택.
**JSON 배열만 반환** — 설명 텍스트 금지:
[{"hs10":"0000000000","reason":"한 줄 근거"}]

제품 정보 (신뢰원):
- 영문 품명: ${nameEn || '(미입력)'}
- 재질: ${material || '(미입력)'}`;
}

async function callAnthropic(mode, nameEn, material, hs10, nameKr, timeoutMs) {
  if (!ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다'),
      { hint: 'Vercel 환경 변수에 ANTHROPIC_API_KEY 추가 + 재배포' });
  }
  const userMsg = buildPrompt(mode, nameEn, material, hs10, nameKr);
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: userMsg }] }),
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw Object.assign(new Error(`Anthropic API ${r.status}`), { detail: errText.slice(0, 200) });
  }
  const data = await r.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const parsed = extractJson(text);
  if (!Array.isArray(parsed)) {
    throw Object.assign(new Error('AI 응답에서 JSON 배열을 추출하지 못했습니다'),
      { detail: text.slice(0, 200) });
  }
  return parsed;
}

// name2hs 모드: AI 후보 hs10 → 공식표 교차검증 + 세율 부착
function validateHsCandidates(aiCands) {
  const out = [];
  const seen = new Set();
  for (const c of aiCands) {
    const hs10 = normalize10(c.hs10 || c.hs || c.code);
    const reason = (c.reason || c.근거 || '').toString().trim().slice(0, 220);
    if (hs10.length === 10 && TARIFF[hs10]) {
      if (seen.has(hs10)) continue;
      seen.add(hs10);
      out.push({ hs10, reason: reason || '(근거 없음)', rates: TARIFF[hs10], source: 'ai' });
    } else if (hs10.length >= 6) {
      const leafs = findLeafCandidates(hs10, 2);
      for (const leaf of leafs) {
        if (seen.has(leaf)) continue;
        seen.add(leaf);
        out.push({
          hs10: leaf,
          reason: `${reason} (AI 후보 ${hs10}가 공식표에 없어 같은 6자리 leaf로 치환)`,
          rates: TARIFF[leaf],
          source: 'ai+leaf',
        });
      }
    }
  }
  return out;
}

// hs2name 모드: AI 영문명·재질 후보 → 정리 (HS는 입력 그대로 + 공식세율 부착)
function buildNameCandidates(aiCands, hs10) {
  const rates = TARIFF[hs10];   // hs2name 호출 시점에 이미 유효성 검증됨
  const out = [];
  const seen = new Set();
  for (const c of aiCands) {
    const nameEn = String(c.nameEn || c.name_en || c.english || c['영문명'] || '').trim().slice(0, 120);
    const material = String(c.material || c['재질'] || '').trim().slice(0, 60);
    if (!nameEn || seen.has(nameEn.toLowerCase())) continue;
    seen.add(nameEn.toLowerCase());
    const reason = (c.reason || c.근거 || '').toString().trim().slice(0, 220);
    out.push({
      hs10, nameEn, material,
      reason: reason || '(근거 없음)',
      rates,
      source: 'ai-name',
    });
  }
  return out;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : await readBody(req).catch(() => ({}));
    const modeIn = String(body.mode || '').trim();
    const nameEn = String(body.nameEn || '').trim();
    const material = String(body.material || '').trim();
    const nameKr = String(body.nameKr || '').trim();   // [전자상거래] kr2name 입력(한국어 상품명)
    const hs10Raw = String(body.hs10 || '').trim();
    const hs10 = normalize10(hs10Raw);

    // [전자상거래] kr2name — 한국어 상품명 → 영문 통관품명 + HS 후보(왕복 1회). 별도 조기 반환.
    if (modeIn === 'kr2name') {
      if (!nameKr) return res.status(400).json({ ok: false, error: '한국어 상품명(nameKr) 필요 (kr2name 모드)' });
      const aiCands = await callAnthropic('kr2name', '', '', '', nameKr);
      const arr = Array.isArray(aiCands) ? aiCands : [];
      if (!arr.length) return res.status(200).json({ ok: true, mode: 'kr2name', nameEn: '', material: '', hsCandidates: [], warning: 'AI 번역 실패 — 수동 입력' });
      const top = arr[0] || {};
      // HS 후보는 공식표 유효한 것만 필터(무효는 참고용 제외)
      const hsCands = arr.map(c => normalize10(String(c.hs10 || ''))).filter(h => h.length === 10 && TARIFF[h]);
      return res.status(200).json({
        ok: true, mode: 'kr2name',
        nameEn: String(top.nameEn || '').trim().toLowerCase(),
        material: String(top.material || '').trim(),
        hsCandidates: [...new Set(hsCands)].slice(0, 2).map(h => ({ hs10: h, formatted: `${h.slice(0,4)}.${h.slice(4,6)}-${h.slice(6,10)}`, rates: TARIFF[h] })),
        reason: String(top.reason || ''),
      });
    }

    // [ecom-v0.16 Phase2] link2en — 1688 offerId/링크 → 실제 중문 상품명·재질 → 영문 통관품명. 별도 조기 반환.
    //   ★재시도 없음(QPS 보호) — 프록시/AI 어느 단계든 실패 시 즉시 반환.
    if (modeIn === 'link2en') {
      const offerId = String(body.offerId || '').trim() || extractOfferId(body.link);
      if (!offerId) return res.status(400).json({ ok: false, error: 'offerId 또는 1688 링크(link) 필요 (link2en 모드)' });
      let offer;
      try {
        offer = await fetchOfferDetail(offerId);
      } catch (e) {
        return res.status(200).json({ ok: false, mode: 'link2en', offerId, stage: e.stage || 'proxy', error: e.message, hint: e.hint });
      }
      let aiCands;
      try {
        aiCands = await callAnthropic('link2en', offer.subject, offer.materialCn, '', '', AI_TIMEOUT_MS);
      } catch (e) {
        return res.status(200).json({ ok: false, mode: 'link2en', offerId, stage: 'ai', subjectCn: offer.subject, materialCn: offer.materialCn, error: e.message, hint: e.hint || e.detail });
      }
      const arr = Array.isArray(aiCands) ? aiCands : [];
      const top = arr[0] || {};
      const nameEnOut = String(top.nameEn || '').trim();
      if (!nameEnOut || nameEnOut.toUpperCase() === 'UNKNOWN') {
        return res.status(200).json({ ok: false, mode: 'link2en', offerId, stage: 'ai-unknown', subjectCn: offer.subject, materialCn: offer.materialCn, error: 'AI 판단 불가(UNKNOWN)' });
      }
      return res.status(200).json({
        ok: true, mode: 'link2en', offerId,
        nameEn: nameEnOut.toLowerCase(),
        material: String(top.material || '').trim(),
        subjectCn: offer.subject, materialCn: offer.materialCn,
        reason: String(top.reason || ''),
      });
    }

    // [전자상거래] name2hs6 — 영문명 → HS 6자리(국제 공통)만. 10자리 추정 없음(HS6는 국내표 밖).
    //   v3.2.248: TARIFF 10자리를 6자리로 절단한 HS6_SET으로 교차검증 — 삭제·필터링 없이 verified 플래그만 부착.
    if (modeIn === 'name2hs6') {
      if (!nameEn) return res.status(400).json({ ok: false, error: '영문 품명(nameEn) 필요 (name2hs6 모드)' });
      const aiCands = await callAnthropic('name2hs6', nameEn, material, '', '');
      const arr = Array.isArray(aiCands) ? aiCands : [];
      const hs6 = [...new Set(arr.map(c => String(c.hs6 || '').replace(/\D/g, '')).filter(h => h.length === 6))];
      const hs6Candidates = hs6.slice(0, 2).map((h, i) => ({
        hs6: h,
        formatted: `${h.slice(0,4)}.${h.slice(4,6)}`,
        reason: String((arr[i] || {}).reason || ''),
        verified: HS6_SET.has(h),
      }));
      // verified:true 안정정렬 우선(동순위 원순서 보존) — 후보 삭제 금지, 순서만 재배치
      const sorted = hs6Candidates
        .map((c, i) => ({ c, i }))
        .sort((a, b) => (b.c.verified === a.c.verified ? a.i - b.i : (b.c.verified ? 1 : -1)))
        .map(x => x.c);
      return res.status(200).json({
        ok: true, mode: 'name2hs6',
        hs6Candidates: sorted,
        warning: hs6.length ? '' : 'HS 6자리 확정 불가 — 수동 입력(억지 추정 안 함)',
      });
    }
    // v3.2.29: construction 입력 폐기 — AI 프롬프트가 의류 양쪽 후보(61·62) 자동 제시

    // mode 결정 (기존 호환: mode 없으면 입력 패턴으로 유추)
    let mode = (modeIn === 'hs2name' || modeIn === 'name2hs') ? modeIn
             : (hs10 && !nameEn) ? 'hs2name'
             : 'name2hs';

    // hs2name 모드: HS 유효성 사전 검증
    if (mode === 'hs2name') {
      if (!hs10 || hs10.length !== 10) {
        return res.status(400).json({ ok: false, error: 'HS 10자리 필요 (hs2name 모드)' });
      }
      if (!TARIFF[hs10]) {
        // 무효 HS — 영문명 추천 안 함. leaf 후보만 반환.
        const leafs = findLeafCandidates(hs10, 5);
        return res.status(200).json({
          ok: false,
          invalid: true,
          error: `⚠ HS ${hs10Raw} 공식 11,326 표에 없음`,
          leafCandidates: leafs.map(k => ({
            hs10: k, formatted: `${k.slice(0,4)}.${k.slice(4,6)}-${k.slice(6,10)}`, rates: TARIFF[k],
          })),
        });
      }
    } else {
      // name2hs 모드: 영문명 필수
      if (!nameEn) return res.status(400).json({ ok: false, error: '영문 품명(nameEn) 필요 (name2hs 모드)' });
    }

    const aiCands = await callAnthropic(mode, nameEn, material, hs10);
    const candidates = (mode === 'hs2name')
      ? buildNameCandidates(aiCands, hs10)
      : validateHsCandidates(aiCands);

    // v3.2.27: 모순/모호 감지
    const conflictNotes = [];
    if (mode === 'name2hs') {
      const c1 = detectConflict(nameEn, material);
      if (c1) conflictNotes.push(c1);
      const c2 = detectChapterSplit(candidates);
      if (c2) conflictNotes.push(c2);
    }
    const conflict = conflictNotes.length > 0;
    const conflictNote = conflict ? conflictNotes.join(' · ') : null;

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true, mode, candidates: [],
        warning: 'AI 후보가 공식 관세표에 매칭되지 않습니다. 입력을 더 구체적으로 해주세요.',
        conflict, conflictNote,
        aiRaw: aiCands,
      });
    }

    return res.status(200).json({ ok: true, mode, candidates, count: candidates.length, conflict, conflictNote });
  } catch (e) {
    console.error('[hs-suggest]', e);
    return res.status(500).json({
      ok: false,
      error: e.message || '알 수 없는 오류',
      detail: e.detail || undefined,
      hint: e.hint || undefined,
    });
  }
};
