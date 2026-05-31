// v3.2.19 (2026-05-31): AI HS 추천 + 공식 관세율표 교차검증
//
// POST /api/hs-suggest { nameEn, material?, note? }
//   → Anthropic claude-sonnet-4-6 호출
//   → 응답에서 hs10 추출 → KANGHAGO_TARIFF 교차검증 (표 없는 HS는 leaf 후보로 치환 or 제외)
//   → 통과한 후보에 공식 세율(A/CN/E1) 부착하여 반환
//
// 출력: { ok: true, candidates: [{hs10, reason, rates: {A, CN, E1}}] }
// 에러: { ok: false, error, hint? }

const { handleCors, readBody } = require('./_lib');
const TARIFF = require('../data/tariff.json');   // 11,326 HS × {A, CN, E1}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1024;

// HS 정규화 → 숫자 10자리
function normalize10(hsRaw) {
  const d = String(hsRaw || '').replace(/\D/g, '');
  return d.length === 10 ? d : (d.length > 10 ? d.slice(0, 10) : d);
}

// 같은 6자리 prefix leaf 후보 (정확 매칭 실패 시 치환용)
function findLeafCandidates(hsRaw, max = 3) {
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

// 응답 텍스트에서 JSON 추출 (코드펜스 제거)
function extractJson(text) {
  if (!text) return null;
  // ```json ... ``` 또는 ``` ... ``` 제거
  let s = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 첫 `[` 또는 `{`부터 마지막 `]` 또는 `}`까지 잘라내기 (안전)
  const start = Math.min(...['[', '{'].map(c => { const i = s.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (start === Infinity || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

async function callAnthropic(nameEn, material, note) {
  if (!ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다'), { hint: 'Vercel 환경 변수에 ANTHROPIC_API_KEY 추가 + 재배포' });
  }

  const userMsg = `다음 제품의 한국 HSK 10자리 후보를 2~3개 제시하라.
각 후보에 한 줄 근거를 달고, 한국 관세율표 기준으로 판단하라.
**JSON 배열만 반환** — 설명 텍스트 금지:
[{"hs10":"0000000000","reason":"한 줄 근거"}]

제품 정보:
- 영문 품명: ${nameEn || '(미입력)'}
- 재질: ${material || '(미입력)'}
- 메모: ${note || '(없음)'}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: userMsg }],
    }),
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

// AI 후보 → 공식표 교차검증 → 최종 candidates 반환
function validateAndEnrich(aiCandidates) {
  const out = [];
  const seen = new Set();

  for (const c of aiCandidates) {
    const hs10 = normalize10(c.hs10 || c.hs || c.code);
    const reason = (c.reason || c.근거 || '').toString().trim().slice(0, 200);

    if (hs10.length === 10 && TARIFF[hs10]) {
      // ✓ 정확 매칭 — 공식 세율 부착
      if (seen.has(hs10)) continue;
      seen.add(hs10);
      out.push({ hs10, reason: reason || '(근거 없음)', rates: TARIFF[hs10], source: 'ai' });
    } else if (hs10.length >= 6) {
      // ✗ 정확 매칭 실패 → 같은 6자리 leaf 후보로 치환
      const leafs = findLeafCandidates(hs10, 2);
      for (const leaf of leafs) {
        if (seen.has(leaf)) continue;
        seen.add(leaf);
        out.push({
          hs10: leaf,
          reason: `${reason} (AI 후보 ${hs10}가 표에 없어 같은 6자리 leaf로 치환)`,
          rates: TARIFF[leaf],
          source: 'ai+leaf',
        });
      }
      // leaf도 없으면 그 후보는 버림 (AI 환각 차단)
    }
    // 6자리 미만이면 무시
  }

  return out;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : await readBody(req).catch(() => ({}));
    const nameEn = String(body.nameEn || '').trim();
    const material = String(body.material || '').trim();
    const note = String(body.note || '').trim();

    if (!nameEn) {
      return res.status(400).json({ ok: false, error: '영문 품명(nameEn) 필수' });
    }

    const aiCandidates = await callAnthropic(nameEn, material, note);
    const candidates = validateAndEnrich(aiCandidates);

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true,
        candidates: [],
        warning: 'AI 후보가 모두 공식 관세표에 없습니다. 영문명/재질을 더 구체적으로 입력해보세요.',
        aiRaw: aiCandidates,
      });
    }

    return res.status(200).json({ ok: true, candidates, count: candidates.length });
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
