// 관세사 포털 공개 설정 — Supabase URL/anon key 노출 (브라우저용)
// anon key는 publishable이라 RLS만 통과시킴 (데이터 보호는 RLS + agent.js 백엔드에서)

const { handleCors } = require('./_lib');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return res.status(503).json({
      error: 'SUPABASE_URL / SUPABASE_ANON_KEY 환경변수 미설정',
      hint: 'Vercel Project Settings → Environment Variables 추가 필요',
    });
  }
  // 브라우저 캐시 — 60분 (anon key는 자주 안 바뀜)
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ supabaseUrl: url, supabaseAnonKey: anon });
};
