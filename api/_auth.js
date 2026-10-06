/**
 * 공용 — 누가 부르는지 확인 (api/login.js · api/meta.js · api/submit.js · api/settings.js 가 같이 쓴다)
 * 파일 이름이 _ 로 시작하면 Vercel 이 함수로 노출하지 않는다.
 *
 * 2026-10-06.1 — 로그인 창(제작자 이름 + 코드)
 *   · 페이지의 로그인 창에서 보낸 이름·코드를 공유 설정의 «Meta 제작자» 목록과 맞춰 보고, 맞으면 서명된 세션 토큰을 내준다 (30일)
 *   · 이후 모든 호출은 헤더 x-adtool-session 으로 들어온다 → 서명·만료 확인 + 제작자 목록에 아직 있는지 확인(목록에서 빼면 바로 못 씀)
 *   · 예전 방식(허용된 구글 계정 · Authorization: Bearer <구글 토큰> · ALLOWED_EMAILS)도 그대로 받는다 — 관리자가 처음 설정을 올릴 때 쓴다
 *
 * Vercel 환경변수
 *   SESSION_SECRET     선택 · 세션 서명 비밀값 (아무 긴 문자열). 없으면 SETTINGS_ADMIN_KEY → META_ACCESS_TOKEN 순으로 대신 쓴다 (바꾸면 모두 다시 로그인)
 *   SESSION_DAYS       선택 · 로그인 유지 기간 (기본 30)
 *   LOGIN_USERS        선택 · 공유 설정 없이도 로그인시킬 사람  예: 홍길동:HGD, 김철수:KCS
 *   ALLOWED_EMAILS     선택 · 구글 계정으로도 들어올 수 있는 사람 (쉼표로 구분)
 *   ALLOWED_DOMAINS    선택 · 이 도메인 구글 계정은 모두 허용
 *   GOOGLE_CLIENT_ID   선택 · 페이지의 OAuth 클라이언트 ID — 넣으면 다른 앱에서 발급한 구글 토큰은 거절
 *   GITHUB_TOKEN · GITHUB_REPO · GITHUB_BRANCH · SETTINGS_PATH — 공유 설정(settings.json) 위치 (api/settings.js 와 같다)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_BUILD = '2026-10-06.1';
const cache = new Map();   // 구글 토큰 → { exp, email }  (같은 토큰으로 계속 부르니 5분은 다시 묻지 않는다)
const list = v => String(v || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS) || 30);

/* ───────── 공유 설정 읽기 (GitHub 최신 → 배포에 포함된 settings.json) · 60초 캐시 ───────── */
const FILE_PATH = process.env.SETTINGS_PATH || 'settings.json';
let settingsCache = { at: 0, data: null, source: '' };
function readBundledSettingsText() {
  const cands = [path.join(process.cwd(), FILE_PATH), path.join(__dirname, '..', FILE_PATH), path.join(__dirname, FILE_PATH)];
  for (const p of cands) { try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (e) { /* 다음 후보 */ } }
  return '';
}
async function readGithubSettingsText() {
  const REPO = process.env.GITHUB_REPO || '';
  const TOKEN = String(process.env.GITHUB_TOKEN || '').trim().split(/\s+/)[0] || '';
  if (!REPO || !TOKEN) return '';
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'adtool-auth' },
  });
  if (!r.ok) return '';
  const j = await r.json().catch(() => ({}));
  return Buffer.from(String(j.content || ''), 'base64').toString('utf8');
}
async function readSharedSettings(force) {
  if (!force && Date.now() - settingsCache.at < 60 * 1000) return settingsCache.data;
  let data = null, source = '';
  try { const t = await readGithubSettingsText(); if (t) { data = JSON.parse(t); source = 'github'; } } catch (e) { data = null; }
  if (!data) { try { const t = readBundledSettingsText(); if (t) { data = JSON.parse(t); source = 'file'; } } catch (e) { data = null; } }
  settingsCache = { at: Date.now(), data, source };
  return data;
}

/* ───────── 제작자 목록 (로그인 아이디 = 이름 · 비밀번호 = 코드) ───────── */
const normName = s => String(s || '').trim().replace(/\s+/g, ' ');
const normCode = s => String(s || '').trim().toUpperCase();
function staffEntries(settings) {
  const out = [];
  const add = (arr) => (Array.isArray(arr) ? arr : []).forEach(s => {
    const name = normName(s && s.name), code = normCode(s && (s.id || s.code));
    if (name && code) out.push({ name, code });
  });
  add(settings && settings.meta && settings.meta.staff);   // 요청대로 «Meta 제작자» 목록만
  String(process.env.LOGIN_USERS || '').split(/[,\n]+/).forEach(p => {
    const i = p.indexOf(':'); if (i < 0) return;
    const name = normName(p.slice(0, i)), code = normCode(p.slice(i + 1));
    if (name && code) out.push({ name, code });
  });
  return out;
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => { const x = sha(a), y = sha(b); return crypto.timingSafeEqual(x, y); };
const staffHash = (name, code) => crypto.createHash('sha256').update(`${normName(name)}\n${normCode(code)}`).digest('hex').slice(0, 24);

async function findStaff(name, code) {
  const settings = await readSharedSettings();
  const entries = staffEntries(settings);
  const n = normName(name), c = normCode(code);
  let hit = null;
  entries.forEach(e => { if (same(e.name, n) && same(e.code, c)) hit = e; });   // 항상 끝까지 돌아 시간차로 새지 않게
  return { hit, entriesCount: entries.length, hasSettings: !!settings };
}

/* ───────── 세션 토큰 (HMAC 서명) ───────── */
function sessionKey() {
  const s = String(process.env.SESSION_SECRET || process.env.SETTINGS_ADMIN_KEY || process.env.META_ACCESS_TOKEN || '').trim();
  return s ? crypto.createHash('sha256').update('adtool-session:' + s).digest() : null;
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function signSession(name, code) {
  const key = sessionKey();
  if (!key) return '';
  const payload = { n: normName(name), h: staffHash(name, code), iat: Date.now(), exp: Date.now() + SESSION_DAYS * 86400000 };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', key).update(body).digest());
  return `${body}.${sig}`;
}
function parseSession(token) {
  const key = sessionKey();
  if (!key || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const want = crypto.createHmac('sha256', key).update(parts[0]).digest();
  const got = unb64u(parts[1]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p = null;
  try { p = JSON.parse(unb64u(parts[0]).toString('utf8')); } catch (e) { return null; }
  if (!p || !p.n || !p.h || !(p.exp > Date.now())) return null;
  return p;
}
/* 세션이 아직 유효한 제작자인지 — 목록에서 빠졌거나 코드가 바뀌면 거절. 목록을 못 읽으면(일시 장애) 서명만 믿는다 */
async function verifySession(token) {
  const p = parseSession(token);
  if (!p) return { ok: false, status: 401, error: '로그인이 만료됐거나 유효하지 않아요 — 다시 로그인하세요', sessionInvalid: true };
  const settings = await readSharedSettings();
  const entries = staffEntries(settings);
  if (entries.length) {
    const still = entries.some(e => staffHash(e.name, e.code) === p.h);
    if (!still) return { ok: false, status: 403, error: `${p.n} 은 제작자 목록에 없거나 코드가 바뀌었어요 — 다시 로그인하세요`, sessionInvalid: true };
  }
  return { ok: true, kind: 'staff', name: p.n, label: p.n, exp: p.exp };
}

/* ───────── 구글 계정 (예전 방식 · 관리자용) ───────── */
async function verifyGoogleUser(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: '구글 로그인이 필요해요 (Authorization 헤더 없음)' };
  const token = m[1].trim();
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return { ok: true, kind: 'google', email: hit.email, label: hit.email };

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
  if (!emails.length && !domains.length) return { ok: false, status: 403, error: '구글 계정으로 들어오려면 Vercel 환경변수 ALLOWED_EMAILS 에 계정을 넣어야 해요 (제작자 이름·코드 로그인은 그냥 됩니다)' };
  const allowed = emails.includes(email) || domains.some(d => email.endsWith('@' + d));
  if (!allowed) return { ok: false, status: 403, error: `${email} 은 허용된 구글 계정이 아니에요 — 제작자 이름·코드로 로그인하거나, 관리자가 ALLOWED_EMAILS 에 추가해야 합니다` };

  const ttl = Math.min(Math.max(Number(info.expires_in || 0) * 1000, 30 * 1000), 5 * 60 * 1000);
  cache.set(token, { exp: Date.now() + ttl, email });
  if (cache.size > 500) cache.clear();
  return { ok: true, kind: 'google', email, label: email };
}

/* ───────── 어느 쪽이든 — 세션(제작자) 먼저, 없으면 구글 ───────── */
async function verifyUser(req) {
  const session = String(req.headers['x-adtool-session'] || '').trim();
  if (session) return verifySession(session);
  if (/^Bearer\s+/i.test(String(req.headers.authorization || ''))) return verifyGoogleUser(req);
  return { ok: false, status: 401, error: '로그인이 필요해요 — 제작자 이름과 코드로 로그인하세요', sessionInvalid: true };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = { AUTH_BUILD, verifyUser, verifyGoogleUser, verifySession, signSession, parseSession, findStaff, readSharedSettings, staffEntries, sessionKey, noStore };
