/**
 * Vercel 서버리스 함수 — Meta Graph API 중계 (Meta 토큰은 서버 환경변수에만 둔다)
 *
 * 배치 위치 : 지금 HTML이 올라가 있는 그 프로젝트 안에  api/meta.js  (+ api/_auth.js)
 * 왜        : 예전엔 Meta 액세스 토큰이 HTML 안에 있어서 주소를 아는 사람은 누구나 광고계정을 쓸 수 있었다.
 *             이제 페이지는 구글 로그인 토큰만 보내고, 이 함수가 «허용된 구글 계정» 인지 확인한 뒤 Meta 를 대신 부른다.
 *
 * Vercel 환경변수 (Settings → Environment Variables → 넣고 Redeploy)
 *   META_ACCESS_TOKEN   필수 · Meta 시스템 사용자 토큰 (ads_management 등)
 *   ALLOWED_EMAILS      선택 · 구글 계정으로도 들어올 수 있는 사람 (쉼표로 구분) — 제작자 이름·코드 로그인(api/login.js)이 기본
 *   GOOGLE_API_KEY      권장 · Drive API 용 API 키 (영상을 Meta 에 넘길 때 Drive 직접 다운로드 주소에 쓴다)
 *   META_API_VERSION    선택 · 기본 v25.0
 *
 * 호출 (페이지 → 이 함수, 로그인 창의 세션 헤더 x-adtool-session — 또는 예전 방식 Authorization: Bearer <구글 토큰>)
 *   GET  /api/meta?path=me/adaccounts&fields=…          → Graph GET 그대로 중계 (access_token 은 서버가 붙인다)
 *   GET  /api/meta?path=<페이지ID>/leadgen_forms&asPage=<페이지ID>   → 그 페이지의 페이지 토큰으로 부른다
 *   POST /api/meta?path=act_<id>/adimages   본문 {bytes:<base64>} 또는 {drive_file_id}
 *   POST /api/meta?path=act_<id>/advideos   본문 {drive_file_id, name}  → Drive 에 올린 영상을 Meta 가 받아 간다 (file_url)
 *   GET  /api/meta?ping=1                                 → 로그인 없이 배포 확인
 *   쓰기(POST)는 위 두 경로만 허용 — 캠페인·광고 생성은 Make 가 한다
 */
const { verifyUser, noStore } = require('./_auth');

const BUILD = '2026-10-06.1';
const GRAPH = 'https://graph.facebook.com';
const VERSION = process.env.META_API_VERSION || 'v25.0';
const ALLOW_POST = [/^act_\d+\/adimages$/, /^act_\d+\/advideos$/];
let pageTokens = { at: 0, map: {} };

/* Make 가 쓰는 Drive 공유 파일을 Meta 가 바로 내려받을 수 있는 주소 */
function driveDownloadUrl(fileId) {
  const id = String(fileId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return '';
  const key = String(process.env.GOOGLE_API_KEY || '').trim().split(/\s+/)[0] || '';
  return key
    ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(key)}`
    : `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
}

/* 응답에서 토큰은 전부 걷어낸다 (페이지 토큰 · 다음 페이지 주소 안의 access_token) */
function strip(obj) {
  if (Array.isArray(obj)) { obj.forEach(strip); return obj; }
  if (!obj || typeof obj !== 'object') return obj;
  Object.keys(obj).forEach(k => {
    if (k === 'access_token') { delete obj[k]; return; }
    const v = obj[k];
    if (typeof v === 'string' && (k === 'next' || k === 'previous') && /access_token=/.test(v)) obj[k] = v.replace(/([?&])access_token=[^&]*&?/, '$1').replace(/[?&]$/, '');
    else if (v && typeof v === 'object') strip(v);
  });
  return obj;
}

/* 페이지 토큰 — me/accounts 에서 한 번 받아 10분 캐시 (인스턴트 양식·인스타 연결 조회에 필요) */
async function pageToken(pageId, userToken) {
  if (Date.now() - pageTokens.at > 10 * 60 * 1000) {
    const map = {};
    let url = `${GRAPH}/${VERSION}/me/accounts?fields=id,access_token&limit=100`;
    for (let i = 0; i < 5 && url; i++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) break;
      (j.data || []).forEach(p => { if (p.id && p.access_token) map[p.id] = p.access_token; });
      url = j.paging && j.paging.next ? j.paging.next : '';
    }
    pageTokens = { at: Date.now(), map };
  }
  return pageTokens.map[String(pageId)] || '';
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  if (q.ping) {
    return res.status(200).json({
      ok: true, build: BUILD, apiVersion: VERSION,
      hasToken: !!process.env.META_ACCESS_TOKEN,
      allowlistSet: !!(process.env.ALLOWED_EMAILS || process.env.ALLOWED_DOMAINS),
      loginReady: !!(process.env.SESSION_SECRET || process.env.SETTINGS_ADMIN_KEY || process.env.META_ACCESS_TOKEN),
      hasGoogleApiKey: !!process.env.GOOGLE_API_KEY,
    });
  }
  // 환경변수에 줄바꿈·공백이 섞여 들어가도(두 번 붙여넣기 등) 첫 토막만 쓴다 — 아니면 «invalid header value» 로 전부 실패한다
  const token = String(process.env.META_ACCESS_TOKEN || '').trim().split(/\s+/)[0] || '';
  if (!token) return res.status(500).json({ error: { message: 'Vercel 환경변수 META_ACCESS_TOKEN 이 비어 있어요 — 넣고 재배포하세요', code: 0 } });
  const redact = m => String(m || '').replace(/EAA[A-Za-z0-9]+/g, '[토큰]').split(token).join('[토큰]');   // 오류 문구에 토큰이 섞여 나가지 않게
  const who = await verifyUser(req);   // 제작자 세션(x-adtool-session) 또는 허용된 구글 계정
  if (!who.ok) return res.status(who.status).json({ error: { message: who.error, code: who.status, type: 'AuthError' }, sessionInvalid: !!who.sessionInvalid });

  let path = String(q.path || '').replace(/^\/+/, '').replace(/^v\d+\.\d+\//, '');
  if (!path || !/^[A-Za-z0-9_./-]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: { message: 'path 가 비어 있거나 잘못됐어요', code: 0 } });
  const method = req.method === 'POST' ? 'POST' : 'GET';
  if (method === 'POST' && !ALLOW_POST.some(re => re.test(path))) return res.status(403).json({ error: { message: `이 경로로는 쓰기를 허용하지 않아요: ${path} (업로드만 됩니다)`, code: 0 } });

  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => { if (k !== 'path' && k !== 'asPage' && k !== 'access_token' && v !== undefined && v !== '') params.set(k, String(v)); });
  let useToken = token;
  const asPage = String(q.asPage || '').replace(/[^A-Za-z0-9_]/g, '');
  if (asPage) { try { useToken = (await pageToken(asPage, token)) || token; } catch (e) { useToken = token; } }

  let body;
  if (method === 'POST') {
    const b = (req.body && typeof req.body === 'object') ? Object.assign({}, req.body) : {};
    delete b.access_token;
    if (b.drive_file_id) {
      const url = driveDownloadUrl(b.drive_file_id);
      delete b.drive_file_id;
      if (/\/advideos$/.test(path)) b.file_url = url; else b.url = url;
    }
    body = JSON.stringify(b);
  }
  const url = `${GRAPH}/${VERSION}/${path}${params.toString() ? '?' + params.toString() : ''}`;
  let r, text;
  try {
    r = await fetch(url, { method, headers: Object.assign({ Authorization: `Bearer ${useToken}` }, body ? { 'Content-Type': 'application/json' } : {}), body });
    text = await r.text();
  } catch (e) { return res.status(502).json({ error: { message: 'Meta 호출 실패: ' + redact(e.message), code: 0 } }); }
  let j;
  try { j = JSON.parse(text); } catch (e) { j = { error: { message: 'Meta 가 JSON 이 아닌 응답을 보냈어요: ' + String(text || '').slice(0, 200), code: 0 } }; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(r.status).send(JSON.stringify(strip(j)));
};
