/**
 * Vercel 서버리스 함수 — TikTok 광고 API(Marketing API v1.3) 중계   ※ 1단계: 읽기 전용 (연결 확인·진단)
 *
 * 배치 위치 : api/tiktok.js  (api/_auth.js 가 같이 있어야 한다)
 * 왜        : 틱톡 액세스 토큰은 서버 환경변수에만 둔다 (메타 토큰과 같은 방식). 페이지는 로그인 세션으로만 부른다.
 *
 * Vercel 환경변수 (Settings → Environment Variables → 넣고 Redeploy)
 *   TIKTOK_ACCESS_TOKEN     필수 · 개발자 앱에서 광고계정 관리자가 승인해 받은 장기 액세스 토큰
 *   TIKTOK_APP_ID           권장 · 개발자 앱 ID      ┐ 둘 다 있으면 «이 토큰이 승인된 광고계정 목록»을 자동으로 가져온다
 *   TIKTOK_APP_SECRET       권장 · 개발자 앱 시크릿  ┘
 *   TIKTOK_ADVERTISER_IDS   선택 · 앱 ID·시크릿이 없을 때 쓸 광고계정 ID (쉼표로 구분)
 *
 * 토큰 만들기 (처음 한 번 · TIKTOK_APP_ID·TIKTOK_APP_SECRET 을 먼저 넣고 재배포)
 *   ① 개발자 포털 My Apps → 앱 → «Advertiser redirect URL» 을  https://<내주소>/api/tiktok  으로
 *   ② 페이지 연동 탭 «틱톡 승인 링크 열기» (또는 앱 상세의 Authorized URL) → 광고계정 관리자로 로그인 → 계정 전부 체크 → Confirm
 *   ③ 이 함수로 돌아오면(?auth_code=…) 코드를 장기 토큰으로 바꿔 화면에 보여준다 → Vercel 환경변수 TIKTOK_ACCESS_TOKEN 에 넣고 재배포
 *      (redirect URL 을 못 바꾸면: 주소창의 auth_code 를 연동 탭 «auth_code 붙여넣기» 칸에 넣고 «토큰 만들기»)
 *
 * 호출 (페이지 → 이 함수, 로그인 창 세션 헤더 x-adtool-session)
 *   GET /api/tiktok?ping=1                          → 로그인 없이 배포 확인
 *   GET /api/tiktok?auth_code=…                     → (틱톡이 보내는 리다이렉트) 코드 → 장기 토큰 교환, 화면에 표시
 *   GET /api/tiktok?op=auth_url                     → 틱톡 승인 링크
 *   GET /api/tiktok?op=exchange&auth_code=…         → 코드 → 장기 토큰 교환 (JSON)
 *   GET /api/tiktok?op=advertisers                  → 광고계정 목록
 *   GET /api/tiktok?op=diag&advertiser_id=…         → 그 계정의 표시 계정(아이덴티티)·인스턴트 양식·최근 캠페인/광고그룹/광고 + 설정
 *   GET /api/tiktok?op=region&advertiser_id=…&q=해운대 → 지역 검색 (시/도·시·구 ID)
 *   GET /api/tiktok?path=campaign/get/&advertiser_id=…&… → 허용된 조회 경로 그대로 중계
 *   쓰기(캠페인·광고 생성)는 2단계에서 추가한다 — 지금은 조회만 허용
 */
const { verifyUser, noStore } = require('./_auth');

const BUILD = '2026-10-20.2';
const HOST = 'https://business-api.tiktok.com/open_api/v1.3';
// 조회만 허용 — 페이지가 path 로 직접 부를 수 있는 경로
const ALLOW_GET = ['advertiser/info/', 'campaign/get/', 'adgroup/get/', 'ad/get/', 'identity/get/', 'page/get/', 'tool/region/', 'tool/language/', 'file/video/ad/info/', 'bc/get/'];
const regionCache = new Map();   // advertiser_id → { at, list }

const token = () => String(process.env.TIKTOK_ACCESS_TOKEN || '').trim().split(/\s+/)[0] || '';
const appId = () => String(process.env.TIKTOK_APP_ID || '').trim();
const appSecret = () => String(process.env.TIKTOK_APP_SECRET || '').trim().split(/\s+/)[0] || '';
const redact = m => String(m || '').split(token()).join('[토큰]').split(appSecret() || '\u0000').join('[시크릿]');

/* TikTok 호출 — GET 은 쿼리(배열·객체는 JSON 문자열), POST 는 JSON 본문. 응답 {code, message, data} 에서 code≠0 이면 오류 */
async function tt(path, params, body) {
  const p = String(path || '').replace(/^\/+/, '');
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v === undefined || v === null || v === '') return; q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v)); });
  const url = `${HOST}/${p}${q.toString() ? '?' + q.toString() : ''}`;
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'Access-Token': token() }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`TikTok 이 JSON 이 아닌 응답 (HTTP ${r.status}): ${text.slice(0, 160)}`); }
  if (!r.ok || Number(j.code) !== 0) { const err = new Error(`${j.message || 'TikTok 오류'} (code ${j.code}${j.request_id ? ' · ' + j.request_id : ''})`); err.code = j.code; err.http = r.status; throw err; }
  return j.data || {};
}

/* auth_code → 장기 액세스 토큰 (만료 없음 · 취소 전까지). 앱 ID·시크릿이 있어야 한다 */
async function exchange(authCode) {
  if (!appId() || !appSecret()) throw new Error('Vercel 환경변수 TIKTOK_APP_ID · TIKTOK_APP_SECRET 을 먼저 넣고 재배포하세요 (개발자 포털 My Apps → 앱 → Basic Information)');
  const code = String(authCode || '').trim();
  if (!code) throw new Error('auth_code 가 비어 있어요');
  const r = await fetch(`${HOST}/oauth2/access_token/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId(), secret: appSecret(), auth_code: code }) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`TikTok 이 JSON 이 아닌 응답 (HTTP ${r.status}): ${text.slice(0, 160)}`); }
  if (!r.ok || Number(j.code) !== 0 || !j.data || !j.data.access_token) throw new Error(`${j.message || 'TikTok 오류'} (code ${j.code}) — auth_code 는 1시간 안에 한 번만 쓸 수 있어요. 승인 링크를 다시 열어 새 코드로 해주세요`);
  return { access_token: j.data.access_token, advertiser_ids: (j.data.advertiser_ids || []).map(String), scope: j.data.scope || [] };
}
function selfUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? `${proto}://${host}/api/tiktok` : '';
}
function authUrl(req) {
  if (!appId()) return '';
  const redirect = selfUrl(req);
  return `https://business-api.tiktok.com/portal/auth?app_id=${encodeURIComponent(appId())}&state=adtool&redirect_uri=${encodeURIComponent(redirect)}`;
}
const escHtml = v => String(v || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function tokenPage(result, error) {
  const body = error
    ? `<h2>❌ 토큰을 만들지 못했어요</h2><p class="err">${escHtml(error)}</p><p>앱 상세의 <b>Authorized URL</b>(또는 페이지 연동 탭의 «틱톡 승인 링크 열기»)을 다시 열어 새 코드로 시도해 주세요.</p>`
    : `<h2>✅ 틱톡 장기 액세스 토큰이 만들어졌어요</h2>
       <p>승인된 광고계정 <b>${result.advertiser_ids.length}개</b>${result.advertiser_ids.length ? ' (' + escHtml(result.advertiser_ids.slice(0, 10).join(', ')) + (result.advertiser_ids.length > 10 ? ' …' : '') + ')' : ' — 0개면 승인 화면에서 광고계정을 체크하지 않은 거예요. 다시 승인해 주세요'}</p>
       <textarea id="tk" readonly>${escHtml(result.access_token)}</textarea>
       <button onclick="navigator.clipboard.writeText(document.getElementById('tk').value).then(()=>{this.textContent='복사됐어요 ✓'})">토큰 복사</button>
       <ol><li>Vercel → 프로젝트 → Settings → <b>Environment Variables</b></li><li>Key <code>TIKTOK_ACCESS_TOKEN</code> · Value 에 위 토큰 붙여넣기 → Save</li><li>Deployments → 맨 위 배포 → <b>Redeploy</b></li><li>페이지 설정 → 연동 탭 «TikTok 연결 확인»에서 ✅ 확인</li></ol>
       <p class="note">이 토큰은 만료되지 않아요(취소 전까지). 이 창은 닫으면 다시 못 보니 지금 복사해 두세요. 채팅·문서에는 붙여넣지 마세요.</p>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>틱톡 토큰</title>
<style>body{font-family:-apple-system,"Pretendard","Malgun Gothic",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1c1c1e;line-height:1.6}h2{font-size:20px}textarea{width:100%;height:110px;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:10px;border:1px solid #d1d1d6;border-radius:8px;word-break:break-all}button{height:40px;padding:0 16px;border:0;border-radius:8px;background:#007aff;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin:10px 0}code{background:#f5f5f7;padding:2px 6px;border-radius:4px}.err{color:#ff3b30;white-space:pre-wrap}.note{font-size:12px;color:#6c6c70}</style></head><body>${body}</body></html>`;
}

/* 광고계정 목록 — 앱 ID·시크릿이 있으면 토큰이 승인된 계정 전부, 없으면 환경변수 목록 */
async function advertisers() {
  let list = [];
  if (appId() && appSecret()) {
    const d = await tt('oauth2/advertiser/get/', { app_id: appId(), secret: appSecret() });
    list = (d.list || []).map(a => ({ id: String(a.advertiser_id), name: a.advertiser_name || '' }));
  } else {
    list = String(process.env.TIKTOK_ADVERTISER_IDS || '').split(/[,\s]+/).filter(Boolean).map(id => ({ id, name: '' }));
  }
  if (list.length) {
    try {
      const info = await tt('advertiser/info/', { advertiser_ids: list.map(a => a.id).slice(0, 100), fields: ['advertiser_id', 'name', 'status', 'currency', 'timezone', 'company'] });
      const byId = {}; (info.list || []).forEach(a => { byId[String(a.advertiser_id)] = a; });
      list = list.map(a => { const i = byId[a.id] || {}; return { id: a.id, name: i.name || a.name || `계정 ${a.id}`, status: i.status || '', currency: i.currency || '', timezone: i.timezone || '', company: i.company || '' }; });
    } catch (e) { /* 이름 없이라도 돌려준다 */ }
  }
  return list;
}

/* 그 계정이 쓸 수 있는 지역 전부 (1시간 캐시) */
async function regionList(advertiserId) {
  const hit = regionCache.get(advertiserId);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.list;
  const d = await tt('tool/region/', { advertiser_id: advertiserId, placements: ['PLACEMENT_TIKTOK'] });
  const list = (d.region_info || d.list || []).map(r => ({ id: String(r.location_id || r.region_id || ''), name: r.name || '', level: r.level || r.region_level || '', parentId: String(r.parent_id || ''), code: r.region_code || r.country_code || '' }));
  regionCache.set(advertiserId, { at: Date.now(), list });
  if (regionCache.size > 50) regionCache.clear();
  return list;
}
/* 지역 검색 — 이름으로 거른다 (한국 것 우선) */
async function regions(advertiserId, q) {
  const list = await regionList(advertiserId);
  const byId = {}; list.forEach(r => { byId[r.id] = r; });
  const chain = r => { const out = []; let cur = r; for (let i = 0; cur && i < 5; i++) { out.push(cur.name); cur = byId[cur.parentId]; } return out; };
  const word = String(q || '').trim().toLowerCase();
  const kr = list.filter(r => /KR|대한민국|South Korea/i.test([r.code, ...chain(r)].join(' ')));
  const pool = kr.length ? kr : list;
  const found = word ? pool.filter(r => String(r.name || '').toLowerCase().includes(word)) : pool.slice(0, 50);
  return found.slice(0, 50).map(r => Object.assign({}, r, { path: chain(r).join(', ') }));
}

/* 진단 — 한 계정의 표시 계정·양식·최근 캠페인/광고그룹/광고 (이름 규칙·기본 설정을 읽어 가기 위해) */
async function diag(advertiserId) {
  const out = { advertiser_id: advertiserId, errors: {} };
  const safe = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = redact(e.message); out[key] = null; } };
  await safe('identities', async () => { const d = await tt('identity/get/', { advertiser_id: advertiserId }); return (d.identity_list || d.list || []).map(i => ({ id: i.identity_id, type: i.identity_type, name: i.display_name, verified: i.is_verified === undefined ? undefined : !!i.is_verified })); });
  await safe('forms', async () => { const d = await tt('page/get/', { advertiser_id: advertiserId, business_type: 'LEAD_GEN', page_size: 50 }); return (d.list || []).map(p => ({ id: p.page_id, title: p.title || p.name || '', status: p.status || '' })); });
  await safe('campaigns', async () => { const d = await tt('campaign/get/', { advertiser_id: advertiserId, page_size: 15, fields: ['campaign_id', 'campaign_name', 'objective_type', 'budget', 'budget_mode', 'operation_status', 'create_time'] }); return (d.list || []); });
  await safe('adgroups', async () => { const d = await tt('adgroup/get/', { advertiser_id: advertiserId, page_size: 15, fields: ['adgroup_id', 'adgroup_name', 'campaign_id', 'campaign_name', 'promotion_type', 'placement_type', 'placements', 'optimization_goal', 'optimization_event', 'bid_type', 'bid_price', 'billing_event', 'budget', 'budget_mode', 'schedule_type', 'schedule_start_time', 'schedule_end_time', 'location_ids', 'zipcode_ids', 'age_groups', 'gender', 'languages', 'identity_id', 'identity_type', 'pacing', 'operation_status', 'create_time', 'pixel_id', 'promotion_website_type'] }); return (d.list || []); });
  await safe('ads', async () => { const d = await tt('ad/get/', { advertiser_id: advertiserId, page_size: 15, fields: ['ad_id', 'ad_name', 'adgroup_id', 'campaign_id', 'ad_format', 'video_id', 'image_ids', 'ad_text', 'call_to_action', 'landing_page_url', 'page_id', 'identity_id', 'identity_type', 'display_name', 'operation_status', 'create_time'] }); return (d.list || []); });
  // 광고그룹에 걸린 지역 ID → 이름
  try {
    const ids = new Set(); (out.adgroups || []).forEach(g => (g.location_ids || []).forEach(id => ids.add(String(id))));
    if (ids.size) {
      const byId = {}; (await regionList(advertiserId)).forEach(r => { byId[r.id] = r; });
      out.locationNames = {}; ids.forEach(id => { const r = byId[id]; out.locationNames[id] = r ? `${r.name}${r.level ? ' (' + r.level + ')' : ''}` : ''; });
    }
  } catch (e) { out.errors.locationNames = redact(e.message); }
  return out;
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  if (q.ping) return res.status(200).json({ ok: true, build: BUILD, hasToken: !!token(), hasApp: !!(appId() && appSecret()), hasAdvertiserIds: !!process.env.TIKTOK_ADVERTISER_IDS, redirectUrl: selfUrl(req), readOnly: true });
  // 틱톡 승인 뒤 리다이렉트 — 로그인 없이 들어온다 (auth_code 는 승인한 관리자만 받고, 1시간·1회용)
  if (q.auth_code && !q.op) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try { return res.status(200).send(tokenPage(await exchange(q.auth_code))); }
    catch (e) { return res.status(200).send(tokenPage(null, redact(e.message))); }
  }
  const who = await verifyUser(req);
  if (!who.ok) return res.status(who.status).json({ error: who.error, sessionInvalid: !!who.sessionInvalid });
  if (req.method !== 'GET') return res.status(405).json({ error: '아직 조회만 돼요 (1단계) — 캠페인·광고 생성은 2단계에서' });
  const op0 = String(q.op || '');
  if (op0 === 'auth_url') { const u = authUrl(req); return u ? res.status(200).json({ url: u, redirectUrl: selfUrl(req) }) : res.status(500).json({ error: 'Vercel 환경변수 TIKTOK_APP_ID 를 먼저 넣고 재배포하세요' }); }
  if (op0 === 'exchange') { try { const r = await exchange(q.auth_code); return res.status(200).json(r); } catch (e) { return res.status(400).json({ error: redact(e.message) }); } }
  if (!token()) return res.status(500).json({ error: 'Vercel 환경변수 TIKTOK_ACCESS_TOKEN 이 비어 있어요 — 연동 탭의 «틱톡 승인 링크 열기»로 토큰을 만들어 넣고 재배포하세요' });

  try {
    const op = op0;
    const adv = String(q.advertiser_id || '').replace(/[^0-9]/g, '');
    if (op === 'advertisers') return res.status(200).json({ list: await advertisers() });
    if (op === 'region') { if (!adv) return res.status(400).json({ error: 'advertiser_id 가 필요해요' }); return res.status(200).json({ list: await regions(adv, q.q) }); }
    if (op === 'diag') { if (!adv) return res.status(400).json({ error: 'advertiser_id 가 필요해요' }); return res.status(200).json(await diag(adv)); }
    const path = String(q.path || '').replace(/^\/+/, '');
    if (path) {
      if (!ALLOW_GET.includes(path)) return res.status(403).json({ error: `이 경로는 허용하지 않아요: ${path}` });
      const params = {};
      Object.entries(q).forEach(([k, v]) => { if (k !== 'path' && k !== 'op') params[k] = v; });
      return res.status(200).json(await tt(path, params));
    }
    return res.status(400).json({ error: 'op(advertisers · diag · region) 또는 path 가 필요해요' });
  } catch (e) {
    return res.status(e.http && e.http >= 400 ? e.http : 502).json({ error: redact(e.message), code: e.code });
  }
};
