/**
 * Vercel 서버리스 함수 — 로그인 창 (제작자 이름 + 코드)
 *
 * 배치 위치 : api/login.js  (api/_auth.js 가 같이 있어야 한다)
 * 아이디   = 설정 → 제작자(Meta) 의 «이름»,  비밀번호 = 같은 줄의 «코드»  (관리자가 «모두에게 적용» 한 공유 설정을 서버가 읽는다)
 *
 * 호출
 *   GET  /api/login?ping=1          → 배포 확인 (로그인 없이)  {ok, build, canLogin, staffCount, settingsSource}
 *   POST /api/login  {name, code}   → 맞으면 {ok, session, name, exp}  (세션은 30일 · 헤더 x-adtool-session 으로 보낸다)
 *   GET  /api/login?check=1         → 지금 세션(또는 구글 토큰)이 유효한지 {ok, name, kind, exp}
 *
 * 틀린 시도는 같은 주소(IP)에서 10분에 8번까지 — 그 뒤엔 잠시 429
 */
const { AUTH_BUILD, verifyUser, findStaff, signSession, sessionKey, readSharedSettings, staffEntries, noStore } = require('./_auth');

const BUILD = '2026-10-06.1';
const fails = new Map();   // ip → { n, until }
const LIMIT = 8, WINDOW = 10 * 60 * 1000;
const ipOf = req => String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim() || 'unknown';
function limited(ip) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (Date.now() > f.until) { fails.delete(ip); return 0; }
  return f.n >= LIMIT ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() > f.until) fails.set(ip, { n: 1, until: Date.now() + WINDOW });
  else f.n++;
  if (fails.size > 2000) fails.clear();
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};

  if (q.ping) {
    let staffCount = 0, source = '';
    try { const s = await readSharedSettings(); staffCount = staffEntries(s).length; source = s ? (process.env.GITHUB_REPO ? 'github' : 'file') : ''; } catch (e) { /* 아래 */ }
    return res.status(200).json({ ok: true, build: BUILD, authBuild: AUTH_BUILD, canLogin: !!sessionKey() && staffCount > 0, hasSecret: !!sessionKey(), staffCount, settingsSource: source });
  }

  if (q.check) {
    const who = await verifyUser(req);
    if (!who.ok) return res.status(who.status).json({ ok: false, error: who.error, sessionInvalid: !!who.sessionInvalid });
    return res.status(200).json({ ok: true, name: who.label, kind: who.kind, exp: who.exp || 0 });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 로 보내주세요' });
  if (!sessionKey()) return res.status(500).json({ error: 'Vercel 환경변수 SESSION_SECRET(또는 SETTINGS_ADMIN_KEY · META_ACCESS_TOKEN)이 비어 있어 로그인 세션을 만들 수 없어요' });

  const ip = ipOf(req);
  const wait = limited(ip);
  if (wait) return res.status(429).json({ error: `틀린 시도가 많아 잠시 막았어요 — ${Math.ceil(wait / 60)}분 뒤에 다시 해주세요` });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const name = String((body && body.name) || '').trim(), code = String((body && body.code) || '').trim();
  if (!name || !code) return res.status(400).json({ error: '이름과 코드를 모두 넣어주세요' });

  let found;
  try { found = await findStaff(name, code); } catch (e) { return res.status(502).json({ error: '제작자 목록을 읽지 못했어요: ' + e.message }); }
  if (!found.entriesCount) {
    return res.status(503).json({ error: found.hasSettings
      ? '공유 설정에 제작자(Meta)가 한 명도 없어요 — 관리자가 설정 → 제작자에 이름·코드를 넣고 «모두에게 적용»을 눌러야 로그인할 수 있어요'
      : '아직 공유 설정이 없어요 — 관리자가 설정 → 제작자를 채우고 «모두에게 적용»(또는 settings.json 업로드)을 해야 로그인할 수 있어요', needSettings: true });
  }
  if (!found.hit) {
    noteFail(ip);
    await new Promise(r => setTimeout(r, 400));   // 무작위 대입을 느리게
    return res.status(401).json({ error: '이름 또는 코드가 맞지 않아요 — 설정 → 제작자에 적힌 이름·코드 그대로 넣어주세요' });
  }
  const session = signSession(found.hit.name, found.hit.code);
  const exp = Date.now() + (Math.max(1, Number(process.env.SESSION_DAYS) || 30)) * 86400000;
  return res.status(200).json({ ok: true, session, name: found.hit.name, exp });
};
