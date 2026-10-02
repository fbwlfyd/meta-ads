/**
 * 공용 — 누가 부르는지 확인 (api/meta.js · api/submit.js 가 같이 쓴다)
 *
 * 페이지는 구글 로그인 토큰을 Authorization: Bearer 로 보낸다 (api/gads 와 같은 방식).
 * 여기서는 그 토큰이 ① 살아 있고 ② 이 페이지의 OAuth 클라이언트로 발급됐고 ③ 허용된 구글 계정인지 본다.
 * 파일 이름이 _ 로 시작하면 Vercel 이 함수로 노출하지 않는다.
 *
 * Vercel 환경변수
 *   ALLOWED_EMAILS     쓸 수 있는 구글 계정 (쉼표로 구분)             예: a@gmail.com, b@gmail.com
 *   ALLOWED_DOMAINS    선택 · 이 도메인 계정은 모두 허용 (쉼표로 구분)  예: ourclinic.co.kr
 *   GOOGLE_CLIENT_ID   선택 · 페이지의 OAuth 클라이언트 ID — 넣으면 다른 앱에서 발급한 토큰은 거절
 */
const cache = new Map();   // 토큰 → { exp, email }  (같은 토큰으로 계속 부르니 5분은 다시 묻지 않는다)
const list = v => String(v || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);

async function verifyGoogleUser(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: '구글 로그인이 필요해요 (Authorization 헤더 없음)' };
  const token = m[1].trim();
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return { ok: true, email: hit.email };

  // ① 토큰이 살아 있나 · 어느 앱이 발급했나
  let info = null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
    info = await r.json().catch(() => null);
    if (!r.ok || !info || info.error) return { ok: false, status: 401, error: '구글 로그인이 만료됐어요 — 다시 로그인하세요' };
  } catch (e) { return { ok: false, status: 502, error: '구글 토큰 확인 실패: ' + e.message }; }
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (clientId && info.aud !== clientId && info.azp !== clientId) return { ok: false, status: 401, error: '이 페이지에서 발급한 구글 토큰이 아니에요' };

  // ② 누구인가 — 페이지와 같은 방법(Drive about)으로 이메일을 읽는다. 로그인 권한(scope)을 더 받지 않아도 된다
  let email = String(info.email || '').toLowerCase();
  if (!email) {
    try {
      const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      email = String((j.user && j.user.emailAddress) || '').toLowerCase();
    } catch (e) { /* 아래에서 거절 */ }
  }
  if (!email) return { ok: false, status: 401, error: '구글 계정을 확인하지 못했어요 — 다시 로그인하세요' };

  // ③ 허용된 계정인가
  const emails = list(process.env.ALLOWED_EMAILS), domains = list(process.env.ALLOWED_DOMAINS);
  if (!emails.length && !domains.length) return { ok: false, status: 403, error: 'Vercel 환경변수 ALLOWED_EMAILS 에 쓸 수 있는 구글 계정을 넣고 재배포하세요' };
  const allowed = emails.includes(email) || domains.some(d => email.endsWith('@' + d));
  if (!allowed) return { ok: false, status: 403, error: `${email} 은 허용된 계정이 아니에요 — 관리자가 Vercel 환경변수 ALLOWED_EMAILS 에 추가해야 합니다` };

  const ttl = Math.min(Math.max(Number(info.expires_in || 0) * 1000, 30 * 1000), 5 * 60 * 1000);
  cache.set(token, { exp: Date.now() + ttl, email });
  if (cache.size > 500) cache.clear();
  return { ok: true, email };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = { verifyGoogleUser, noStore };
