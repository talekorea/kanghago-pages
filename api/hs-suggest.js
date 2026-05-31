// v3.2.22 (2026-05-31): AI HS 추천 — 양방향 (hs2name / name2hs / both)
//
// POST /api/hs-suggest { nameEn?, material?, hs10?, note? }
//   - 영문명만 → HS 후보 생성 (name2hs)
//   - HS만     → 영문명 후보 + 공식세율 (hs2name)
//   - 둘 다    → 정합성 검증 + 보강 후보 (both)
//
// 출력: { ok, mode, candidates: [{hs10?, nameEn?, reason, rates?, source}], note? }

const { handleCors, readBody } = require('./_lib');
const TARIFF = require('../data/tariff.json');   // 11,326 HS × {A, CN, E1}

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

function buildPrompt(mode, nameEn, material, hs10) {
  if (mode === 'hs2name') {
    const tariff = TARIFF[hs10];
    const tariffInfo = tariff ? `(공식 세율: A=${tariff.A}% / CN=${tariff.CN}% / E1=${tariff.E1}%)` : '(공식표 미존재)';
    return `다음 한국 HSK 10자리 ${hs10} 코드에 해당하는 제품의 영문 품명(Description) 후보를 2~3개 제시하라.
한국 관세율표 ${hs10} ${tariffInfo} 기준으로, 통관 신고에 적합한 짧은 영문 품명을 추천하라.
**JSON 배열만 반환** — 설명 텍스트 금지:
[{"nameEn":"...", "reason":"한 줄 근거"}]

참고:
- 재질: ${material || '(미입력)'}
- HS코드: ${hs10}`;
  }
  if (mode === 'both') {
    const tariff = TARIFF[hs10];
    const tariffInfo = tariff ? `유효 (A=${tariff.A}/CN=${tariff.CN}/E1=${tariff.E1})` : '⚠ 공식표 미존재';
    return `다음 정보가 HS코드와 영문 품명이 서로 부합하는지 검토하라.
- 영문 품명: ${nameEn}
- 재질: ${material || '(미입력)'}
- HS코드 (입력): ${hs10}  [공식 관세표: ${tariffInfo}]

**JSON만 반환**:
[
  {"hs10":"입력한 HS 또는 더 적합한 HS", "reason":"정합성 + 한 줄 근거. 다르면 왜 그런지"},
  ...(최대 3개)
]`;
  }
  // name2hs (기본)
  return `다음 제품의 한국 HSK 10자리 후보를 2~3개 제시하라.
각 후보에 한 줄 근거를 달고, 한국 관세율표 기준으로 판단하라.
**JSON 배열만 반환** — 설명 텍스트 금지:
[{"hs10":"0000000000","reason":"한 줄 근거"}]

제품 정보:
- 영문 품명: ${nameEn || '(미입력)'}
- 재질: ${material || '(미입력)'}`;
}

async function callAnthropic(mode, nameEn, material, hs10) {
  if (!ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다'), { hint: 'Vercel 환경 변수에 ANTHROPIC_API_KEY 추가 + 재배포' });
  }

  const userMsg = buildPrompt(mode, nameEn, material, hs10);
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
    throw Object.assign(new Error('AI 응답에서 JSON 배열을 추출하지 못했습니다'), { detail: text.slice(0, 200) });
  }
  return parsed;
}

// name2hs / both 모드: AI 후보 hs10 → 공식표 교차검증 + 세율 부착
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

// hs2name 모드: AI 영문명 후보 → 정리 (HS는 입력 그대로 + 공식세율 부착)
function buildNameCandidates(aiCands, hs10) {
  const rates = TARIFF[hs10] || null;
  const out = [];
  const seen = new Set();
  for (const c of aiCands) {
    const nameEn = String(c.nameEn || c.name_en || c.english || c['영문명'] || '').trim().slice(0, 120);
    if (!nameEn || seen.has(nameEn.toLowerCase())) continue;
    seen.add(nameEn.toLowerCase());
    const reason = (c.reason || c.근거 || '').toString().trim().slice(0, 220);
    out.push({
      hs10, nameEn, reason: reason || '(근거 없음)',
      rates: rates || undefined,
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
    const nameEn = String(body.nameEn || '').trim();
    const material = String(body.material || '').trim();
    const hs10Raw = String(body.hs10 || '').trim();
    const hs10 = normalize10(hs10Raw);

    if (!nameEn && !hs10) {
      return res.status(400).json({ ok: false, error: '영문 품명(nameEn) 또는 HS코드(hs10) 중 최소 하나 필요' });
    }

    // 모드 결정
    let mode;
    if (hs10 && nameEn) mode = 'both';
    else if (hs10 && !nameEn) mode = 'hs2name';
    else mode = 'name2hs';

    // hs10 유효성 사전 검증 (10자리지만 공식표에 없는 경우)
    let invalidHsNote = null;
    let leafCandidates = [];
    if (hs10 && hs10.length === 10 && !TARIFF[hs10]) {
      leafCandidates = findLeafCandidates(hs10, 5);
      const leafFmt = leafCandidates.map(k => `${k.slice(0,4)}.${k.slice(4,6)}-${k.slice(6,10)}`).join(' / ');
      invalidHsNote = `⚠ HS ${hs10Raw} 공식 11,326 표에 없음. 같은 6자리 leaf 후보: ${leafFmt || '(없음)'}`;
    } else if (hs10 && hs10.length < 10) {
      invalidHsNote = `⚠ HS 10자리 필요 (입력 ${hs10.length}자리). 정확한 코드를 입력해주세요`;
    }

    // AI 호출
    const aiCands = await callAnthropic(mode, nameEn, material, hs10);

    let candidates;
    if (mode === 'hs2name') {
      candidates = buildNameCandidates(aiCands, hs10);
      // 무효 HS → 영문명 후보 신뢰도 낮으므로 leaf 후보를 같이 제시 (선택 시 HS도 교체)
      if (invalidHsNote && leafCandidates.length) {
        leafCandidates.forEach(leaf => {
          candidates.push({
            hs10: leaf, nameEn: '',
            reason: `(leaf 후보 — HS ${hs10Raw} 대신 사용 권장)`,
            rates: TARIFF[leaf],
            source: 'leaf',
          });
        });
      }
    } else {
      candidates = validateHsCandidates(aiCands);
    }

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true, mode, candidates: [],
        warning: 'AI 후보가 공식 관세표에 매칭되지 않습니다. 입력을 더 구체적으로 해주세요.',
        note: invalidHsNote,
        aiRaw: aiCands,
      });
    }

    return res.status(200).json({ ok: true, mode, candidates, count: candidates.length, note: invalidHsNote });
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
