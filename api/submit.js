/**
 * Vercel 서버리스 함수 — Make 웹훅 중계 (웹훅 주소는 서버 환경변수에만 둔다)
 *
 * 배치 위치 : 지금 HTML이 올라가 있는 그 프로젝트 안에  api/submit.js  (+ api/_auth.js)
 * 왜        : 예전엔 Make 웹훅 주소가 HTML 안에 있어서 주소를 아는 사람은 누구나 시나리오를 돌릴 수 있었다
 *             (관리자 연결로 캠페인 생성·유튜브 업로드가 됨). 이제 페이지는 여기로 보내고,
 *             이 함수가 «허용된 구글 계정» 인지 확인한 뒤 Make 로 넘긴다.
 *
 * Vercel 환경변수
 *   MAKE_WEBHOOK_META     메타광고등록 시나리오 웹훅 주소 (https://hook.eu1.make.com/…)
 *   MAKE_WEBHOOK_GOOGLE   구글 광고등록 시나리오 웹훅 주소
 *   ALLOWED_EMAILS        쓸 수 있는 구글 계정 (api/_auth.js 참고)
 *   MAKE_SHARED_SECRET    선택 · Make 쪽에서 한 번 더 확인하고 싶을 때 (웹훅 모듈 «Get request headers» 켜고
 *                         x-adtool-secret 헤더 값이 이것과 같을 때만 진행하도록 필터)
 *
 * 호출 (페이지 → 이 함수, Authorization: Bearer <구글 토큰>)
 *   POST /api/submit   본문 { platform: 'meta' | 'google', payload: {…} }  → Make 의 응답을 그대로 돌려준다
 *   GET  /api/submit?ping=1   → 로그인 없이 배포 확인
 */
const { verifyGoogleUser, noStore } = require('./_auth');

const BUILD = '2026-10-02.2';

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.ping) {
    return res.status(200).json({
      ok: true, build: BUILD,
      hasMeta: !!process.env.MAKE_WEBHOOK_META, hasGoogle: !!process.env.MAKE_WEBHOOK_GOOGLE,
      allowlistSet: !!(process.env.ALLOWED_EMAILS || process.env.ALLOWED_DOMAINS),
      secretSet: !!process.env.MAKE_SHARED_SECRET,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 로 보내주세요' });
  const who = await verifyGoogleUser(req);
  if (!who.ok) return res.status(who.status).json({ error: who.error });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const platform = body.platform === 'google' ? 'google' : (body.platform === 'meta' ? 'meta' : '');
  const payload = body.payload;
  if (!platform) return res.status(400).json({ error: 'platform 은 meta 또는 google 이어야 해요' });
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'payload 가 없어요' });
  const url = String((platform === 'google' ? process.env.MAKE_WEBHOOK_GOOGLE : process.env.MAKE_WEBHOOK_META) || '').trim().split(/\s+/)[0] || '';   // 줄바꿈이 섞여 들어가도 첫 토막만
  if (!/^https:\/\/hook\.[a-z0-9.-]*make\.com\//i.test(url)) {
    return res.status(500).json({ error: `Vercel 환경변수 ${platform === 'google' ? 'MAKE_WEBHOOK_GOOGLE' : 'MAKE_WEBHOOK_META'} 가 비어 있거나 Make 웹훅 주소가 아니에요 — 넣고 재배포하세요` });
  }
  payload.보낸사람 = who.email;   // Make 등록로그에 남길 수 있다

  let r, text;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, process.env.MAKE_SHARED_SECRET ? { 'x-adtool-secret': String(process.env.MAKE_SHARED_SECRET) } : {}),
      body: JSON.stringify(payload),
    });
    text = await r.text();
  } catch (e) { return res.status(502).json({ error: 'Make 웹훅 호출 실패: ' + e.message }); }
  res.setHeader('Content-Type', r.headers.get('content-type') || 'text/plain; charset=utf-8');
  return res.status(r.status).send(text);
};
