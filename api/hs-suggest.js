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
const TARIFF = require('../data/tariff.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1024;

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

function buildPrompt(mode, nameEn, material, hs10, construction) {
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
  // name2hs (기본) — v3.2.27: construction (knit/woven) 우선 지시 반영
  const constructionHint = construction === 'knit'
    ? '\n- 의류라면 편물(knitted) → 61류(6101~6117) 우선 고려'
    : construction === 'woven'
      ? '\n- 의류라면 직물(woven) → 62류(6201~6217) 우선 고려'
      : '';
  return `다음 제품의 한국 HSK 10자리 후보를 2~3개 제시하라.
각 후보에 한 줄 근거를 달고, 한국 관세율표 기준으로 판단하라.${constructionHint}
**JSON 배열만 반환** — 설명 텍스트 금지:
[{"hs10":"0000000000","reason":"한 줄 근거"}]

제품 정보 (신뢰원):
- 영문 품명: ${nameEn || '(미입력)'}
- 재질: ${material || '(미입력)'}
- 편물/직물: ${construction === 'knit' ? '편물(knitted)' : construction === 'woven' ? '직물(woven)' : '(미정)'}`;
}

async function callAnthropic(mode, nameEn, material, hs10, construction) {
  if (!ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다'),
      { hint: 'Vercel 환경 변수에 ANTHROPIC_API_KEY 추가 + 재배포' });
  }
  const userMsg = buildPrompt(mode, nameEn, material, hs10, construction);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: userMsg }] }),
  });
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
    const hs10Raw = String(body.hs10 || '').trim();
    const hs10 = normalize10(hs10Raw);
    // v3.2.27: 편물/직물 — 의류 류(61/62) 분기 힌트
    const construction = (body.construction === 'knit' || body.construction === 'woven') ? body.construction : null;

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

    const aiCands = await callAnthropic(mode, nameEn, material, hs10, construction);
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
