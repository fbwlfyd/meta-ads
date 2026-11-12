/**
 * Vercel 서버리스 함수 — TikTok 광고 API(Marketing API v1.3) 중계
 *   1단계(2026-10-20) 조회·진단  →  2단계(2026-11-11) 광고 등록(영상 업로드 · 캠페인 · 광고그룹 · 광고 생성)
 *
 * 배치 위치 : api/tiktok.js  (api/_auth.js 가 같이 있어야 한다)
 * 왜        : 틱톡 액세스 토큰은 서버 환경변수에만 둔다 (메타 토큰과 같은 방식). 페이지는 로그인 세션으로만 부른다.
 *
 * Vercel 환경변수 (Settings → Environment Variables → 넣고 Redeploy)
 *   TIKTOK_ACCESS_TOKEN     필수 · 개발자 앱에서 광고계정 관리자가 승인해 받은 장기 액세스 토큰
 *   TIKTOK_APP_ID           권장 · 개발자 앱 ID      ┐ 둘 다 있으면 «이 토큰이 승인된 광고계정 목록»을 자동으로 가져온다
 *   TIKTOK_APP_SECRET       권장 · 개발자 앱 시크릿  ┘
 *   TIKTOK_ADVERTISER_IDS   선택 · 앱 ID·시크릿이 없을 때 쓸 광고계정 ID (쉼표로 구분)
 *   GOOGLE_API_KEY          권장 · (api/meta.js 와 같은 키) Drive 에 올린 영상을 틱톡이 받아 갈 직접 다운로드 주소에 쓴다
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
 *   GET /api/tiktok?op=auth_url · exchange          → 승인 링크 · 코드 교환
 *   GET /api/tiktok?op=advertisers                  → 광고계정 목록
 *   GET /api/tiktok?op=diag&advertiser_id=…         → 진단 (표시 계정·양식·BC·픽셀·최근 캠페인/광고그룹/광고)
 *   GET /api/tiktok?op=region&advertiser_id=…&q=    → 지역 검색
 *   GET /api/tiktok?op=identities · pages · pixels · audiences · interests · actions · bcs  &advertiser_id=…  → 등록 탭 목록
 *   GET /api/tiktok?op=campaign_search&q=…          → 모든 광고계정에서 이름으로 캠페인 찾기 (중복 확인)
 *   GET /api/tiktok?op=video_info&advertiser_id=…&video_ids=a,b   → 영상 처리 상태
 *   GET /api/tiktok?op=ad_status&advertiser_id=…&ad_ids=a,b       → 광고 검토 상태
 *   GET /api/tiktok?path=campaign/get/&advertiser_id=…&… → 허용된 조회 경로 그대로 중계
 *   POST /api/tiktok  본문 {op: …}
 *     upload_video    {advertiser_id, drive_file_id | video_url, file_name}      → 영상 업로드 (URL 방식) {video_id}
 *     cover           {advertiser_id, video_id, cover_url?}                        → 영상 커버 이미지 {image_id}
 *     create_campaign {advertiser_id, campaign_name, budget_strategy, budget, optimization_goal?}
 *     create_adgroup  {advertiser_id, campaign_id, adgroup_name, lead_mode, …}
 *     create_ad       {advertiser_id, adgroup_id, ad_name, identity, video_id, image_id, ad_text, call_to_action, …}
 *     pause_campaign  {advertiser_id, campaign_id}                                 → 만든 캠페인 일시중지 (메타·구글처럼 꺼진 채로)
 *     confirm_terms   {advertiser_id}                                              → 리드 광고 약관 동의 (틱톡이 요구할 때만)
 */
const { verifyUser, noStore } = require('./_auth');

const BUILD = '2026-11-11.1';
const HOST = 'https://business-api.tiktok.com/open_api/v1.3';
// 조회만 허용 — 페이지가 path 로 직접 부를 수 있는 경로
const ALLOW_GET = ['advertiser/info/', 'campaign/get/', 'adgroup/get/', 'ad/get/', 'identity/get/', 'page/get/', 'tool/region/', 'tool/language/', 'file/video/ad/info/', 'bc/get/', 'pixel/list/', 'tool/action_category/', 'tool/interest_category/', 'dmp/custom_audience/list/'];
const regionCache = new Map();   // advertiser_id → { at, list }
const listCache = new Map();     // key → { at, data }  (관심사·행동 목록처럼 큰 것 1시간)

const token = () => String(process.env.TIKTOK_ACCESS_TOKEN || '').trim().split(/\s+/)[0] || '';
const appId = () => String(process.env.TIKTOK_APP_ID || '').trim();
const appSecret = () => String(process.env.TIKTOK_APP_SECRET || '').trim().split(/\s+/)[0] || '';
const googleKey = () => String(process.env.GOOGLE_API_KEY || '').trim().split(/\s+/)[0] || '';
const redact = m => String(m || '').split(token()).join('[토큰]').split(appSecret() || '\u0000').join('[시크릿]').split(googleKey() || '\u0000').join('[키]');
const digits = v => String(v || '').replace(/[^0-9]/g, '');
const str = v => (v === undefined || v === null) ? '' : String(v);
const arr = v => Array.isArray(v) ? v : (v === undefined || v === null || v === '') ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean);
const bad = msg => { const e = new Error(msg); e.http = 400; return e; };   // 틱톡을 부르기 전에 우리가 잡는 입력 오류

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
  if (!r.ok || Number(j.code) !== 0) { const err = new Error(`${j.message || 'TikTok 오류'} (code ${j.code}${j.request_id ? ' · ' + j.request_id : ''})`); err.code = j.code; err.http = r.status; err.ttMessage = j.message || ''; throw err; }
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
/* 승인 링크 — redirect 는 앱에 «승인된» Advertiser redirect URL 과 글자 그대로 같아야 한다 (새로 넣은 URL 은 심사가 끝나야 쓸 수 있다) */
function authUrl(req, redirectOverride) {
  if (!appId()) return '';
  const redirect = String(redirectOverride || '').trim() || selfUrl(req);
  if (!/^https:\/\/[^\s"'<>]+$/.test(redirect)) throw new Error('redirect URL 은 https:// 로 시작하는 주소여야 해요');
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
  // objective_type 은 필수 (리드 생성 기준으로 묻는다). promotion_type 까지 요구하면 그것도 붙여 한 번 더
  let d;
  try { d = await tt('tool/region/', { advertiser_id: advertiserId, placements: ['PLACEMENT_TIKTOK'], objective_type: 'LEAD_GENERATION' }); }
  catch (e) { if (/promotion_type/.test(e.message)) d = await tt('tool/region/', { advertiser_id: advertiserId, placements: ['PLACEMENT_TIKTOK'], objective_type: 'LEAD_GENERATION', promotion_type: 'LEAD_GENERATION' }); else throw e; }
  const list = (d.region_info || d.list || []).map(r => ({ id: String(r.location_id || r.region_id || ''), name: r.name || '', level: r.level || r.region_level || '', parentId: String(r.parent_id || ''), code: r.region_code || r.country_code || '' }));
  regionCache.set(advertiserId, { at: Date.now(), list });
  if (regionCache.size > 50) regionCache.clear();
  return list;
}
/* 지역 검색 — 이름으로 거른다 (한국 것 우선). ids 를 주면 그 ID 들의 이름·경로만 돌려준다 */
async function regions(advertiserId, q, ids) {
  const list = await regionList(advertiserId);
  const byId = {}; list.forEach(r => { byId[r.id] = r; });
  const chain = r => { const out = []; let cur = r; for (let i = 0; cur && i < 5; i++) { out.push(cur.name); cur = byId[cur.parentId]; } return out; };
  const withPath = r => Object.assign({}, r, { path: chain(r).join(', ') });
  if (ids && ids.length) return ids.map(id => byId[String(id)]).filter(Boolean).map(withPath);
  const word = String(q || '').trim().toLowerCase();
  const kr = list.filter(r => /KR|대한민국|South Korea/i.test([r.code, ...chain(r)].join(' ')));
  const pool = kr.length ? kr : list;
  const found = word ? pool.filter(r => String(r.name || '').toLowerCase().includes(word)) : pool.slice(0, 50);
  return found.slice(0, 50).map(withPath);
}

/* ───────────────────────── 등록 탭용 목록 ───────────────────────── */
/* 비즈니스 센터 목록 */
async function bcs() {
  const d = await tt('bc/get/', { page_size: 50 });
  return (d.list || []).map(b => ({ id: String((b.bc_info && b.bc_info.bc_id) || b.bc_id || ''), name: (b.bc_info && b.bc_info.name) || b.name || '', role: b.user_role || (b.bc_info && b.bc_info.user_role) || '' })).filter(b => b.id);
}
/* 표시 계정(아이덴티티) — 기본 목록 + 비즈니스 센터가 승인한 틱톡 계정(BC_AUTH_TT) 까지 합친다 */
async function identities(advertiserId) {
  const out = { list: [], errors: {} };
  const seen = new Set();
  const push = (i, bcId) => {
    const id = str(i.identity_id); if (!id) return;
    const key = id + '|' + str(i.identity_type);
    if (seen.has(key)) return; seen.add(key);
    out.list.push({ id, type: i.identity_type || '', name: i.display_name || '', bcId: bcId || str(i.identity_authorized_bc_id), verified: i.is_verified === undefined ? undefined : !!i.is_verified, profile: i.profile_image || '' });
  };
  try { const d = await tt('identity/get/', { advertiser_id: advertiserId, page_size: 100 }); (d.identity_list || d.list || []).forEach(i => push(i, '')); }
  catch (e) { out.errors.identities = redact(e.message); }
  let bcList = [];
  try { bcList = await bcs(); out.bcs = bcList; } catch (e) { out.errors.bcs = redact(e.message); }
  for (const bc of bcList.slice(0, 10)) {
    try { const d = await tt('identity/get/', { advertiser_id: advertiserId, identity_type: 'BC_AUTH_TT', identity_authorized_bc_id: bc.id, page_size: 100 }); (d.identity_list || d.list || []).forEach(i => push(i, bc.id)); }
    catch (e) { out.errors['bc_' + bc.id] = redact(e.message); }
  }
  return out;
}
/* 인스턴트 양식 */
async function pages(advertiserId) {
  const d = await tt('page/get/', { advertiser_id: advertiserId, business_type: 'LEAD_GEN', page_size: 100 });
  return (d.list || []).map(p => ({ id: str(p.page_id), title: p.title || p.name || '', status: p.status || '', updated: p.update_time || p.modify_time || '' }));
}
/* 활성 여부 — 상태 비슷한 값이 하나라도 «꺼짐» 이면 false, 아무 정보도 없으면 null */
function activeFlag(o) {
  if (!o || typeof o !== 'object') return null;
  for (const k of ['status', 'pixel_status', 'event_status', 'activity_status', 'active_status', 'is_active', 'active', 'enabled']) {
    if (o[k] === undefined || o[k] === null || o[k] === '') continue;
    const v = o[k];
    if (typeof v === 'boolean') return v;
    const s = String(v).toUpperCase();
    if (/INACTIVE|DISABLE|PAUSED|DELETED|REMOVED|OFF|FALSE|EXPIRED|UNAVAILABLE/.test(s)) return false;
    if (/ACTIVE|ENABLE|ON|TRUE|AVAILABLE|NORMAL/.test(s)) return true;
  }
  for (const k of ['last_active_time', 'last_event_time', 'last_fired_time']) {
    if (!o[k]) continue;
    const ts = typeof o[k] === 'number' ? o[k] * (o[k] < 1e12 ? 1000 : 1) : Date.parse(String(o[k]).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(o[k])) ? '' : 'Z'));
    if (!isNaN(ts)) return Date.now() - ts < 45 * 24 * 3600 * 1000;
  }
  return null;
}
/* 픽셀(데이터 세트) + 그 안의 이벤트 — 최적화 이벤트 드롭다운은 고른 픽셀의 이벤트만 보여준다 */
async function pixels(advertiserId) {
  const d = await tt('pixel/list/', { advertiser_id: advertiserId, page_size: 50 });
  return (d.pixels || d.list || []).map(x => {
    const events = (x.events || x.event_list || []).map(ev => ({
      type: str(ev.event_type || ev.type || ev.optimization_event || ''), name: str(ev.name || ev.event_name || ev.event_type || ''), id: str(ev.event_id || ev.id || ''),
      active: activeFlag(ev), statistic: str(ev.statistic_type || ''),
    })).filter(ev => ev.type);
    return { id: str(x.pixel_id), name: x.pixel_name || x.name || '', code: x.pixel_code || '', active: activeFlag(x), mode: str(x.pixel_setup_mode || x.pixel_mode || ''), events };
  }).filter(x => x.id);
}
/* 맞춤 타겟(시청자) — 제외 타겟에 쓴다. Audience management 권한이 있어야 한다 */
async function audiences(advertiserId) {
  const out = [];
  let page = 1;
  for (let i = 0; i < 5; i++, page++) {
    const d = await tt('dmp/custom_audience/list/', { advertiser_id: advertiserId, page, page_size: 100 });
    (d.list || []).forEach(a => out.push({ id: str(a.audience_id), name: a.name || '', type: str(a.audience_type || a.audience_sub_type || ''), size: a.cover_num === undefined ? null : a.cover_num, valid: a.is_valid === undefined ? null : !!a.is_valid, expiring: !!a.is_expiring, shared: a.is_creator === undefined ? null : !a.is_creator }));
    const total = Number((d.page_info && d.page_info.total_page) || 1);
    if (page >= total) break;
  }
  return out;
}
/* 트리 → 한 줄 목록 (id · 이름 · 상위 경로) */
function flattenTree(nodes, idKey, nameKey, parentPath, out, depth) {
  (nodes || []).forEach(n => {
    const name = str(n[nameKey] || n.name || '');
    const path = parentPath ? parentPath + ' > ' + name : name;
    const id = str(n[idKey] || n.id || '');
    if (id) out.push({ id, name, path, level: depth, scene: n.action_scene || '' });
    const kids = n.sub_categories || n.children || n.sub_category || [];
    if (Array.isArray(kids) && kids.length) flattenTree(kids, idKey, nameKey, path, out, depth + 1);
  });
  return out;
}
async function cached(key, fn) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
  const data = await fn();
  listCache.set(key, { at: Date.now(), data });
  if (listCache.size > 100) listCache.clear();
  return data;
}
/* 관심사 (세부 타겟팅) */
async function interests(advertiserId) {
  return cached('interests|' + advertiserId, async () => {
    let d;
    try { d = await tt('tool/interest_category/', { advertiser_id: advertiserId, version: 2, language: 'ko' }); }
    catch (e) { d = await tt('tool/interest_category/', { advertiser_id: advertiserId, version: 2 }); }
    return flattenTree(d.interest_categories || d.list || [], 'interest_category_id', 'interest_category_name', '', [], 0);
  });
}
/* 행동 (세부 타겟팅) — 장면(영상 상호작용 · 크리에이터 팔로우 · 해시태그)별로 받아 합친다 */
async function actions(advertiserId) {
  return cached('actions|' + advertiserId, async () => {
    const out = []; const errors = [];
    const scenes = ['VIDEO_RELATED', 'CREATOR_RELATED', 'HASHTAG_RELATED'];
    let base = null;
    try { base = await tt('tool/action_category/', { advertiser_id: advertiserId, language: 'ko' }); }
    catch (e) { try { base = await tt('tool/action_category/', { advertiser_id: advertiserId }); } catch (e2) { errors.push(redact(e2.message)); } }
    if (base) flattenTree(base.action_categories || base.list || [], 'action_category_id', 'action_category_name', '', out, 0);
    if (!out.length) {
      for (const scene of scenes) {
        try { const d = await tt('tool/action_category/', { advertiser_id: advertiserId, action_scene: scene, language: 'ko' }); flattenTree(d.action_categories || d.list || [], 'action_category_id', 'action_category_name', '', out, 0).forEach(x => { if (!x.scene) x.scene = scene; }); }
        catch (e) { errors.push(scene + ': ' + redact(e.message)); }
      }
    }
    out.forEach(x => { if (!x.scene) x.scene = 'VIDEO_RELATED'; });
    return { list: out, errors };
  });
}
/* 모든 광고계정에서 캠페인 이름으로 찾기 — 틱톡은 계정마다 같은 이름을 받아주지만 우리는 전체에서 하나여야 한다 */
async function campaignSearch(q) {
  const word = String(q || '').trim();
  const advs = await advertisers();
  const out = []; const errors = {};
  await Promise.all(advs.slice(0, 30).map(async a => {
    try {
      for (let page = 1; page <= 3; page++) {
        const d = await tt('campaign/get/', { advertiser_id: a.id, page, page_size: 100, fields: ['campaign_id', 'campaign_name', 'objective_type', 'operation_status', 'secondary_status', 'create_time'], filtering: word ? { campaign_name: word } : undefined });
        (d.list || []).forEach(c => out.push({ advertiserId: a.id, advertiserName: a.name, id: str(c.campaign_id), name: c.campaign_name || '', objective: c.objective_type || '', status: c.operation_status || '', secondary: c.secondary_status || '', created: c.create_time || '' }));
        const total = Number((d.page_info && d.page_info.total_page) || 1);
        if (page >= total) break;
      }
    } catch (e) { errors[a.id] = redact(e.message); }
  }));
  return { list: out, errors, advertisers: advs.length };
}

/* ───────────────────────── 광고 등록 (쓰기) ───────────────────────── */
/* Drive 에 올린 공유 파일을 틱톡이 바로 내려받을 수 있는 주소 (api/meta.js 와 같은 규칙) */
function driveDownloadUrls(fileId) {
  const id = String(fileId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return [];
  const list = [];
  if (googleKey()) list.push(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(googleKey())}`);
  list.push(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
  list.push(`https://drive.google.com/uc?export=download&confirm=t&id=${id}`);
  return list;
}
/* 틱톡이 돌려준 오류문에서 «이미 있는 영상 ID» 를 건진다 (같은 파일을 또 올리면 기존 ID 를 알려주는 경우) */
function videoIdInMessage(msg) { const m = String(msg || '').match(/video[_ ]?id[^0-9a-z]*([0-9a-z]{10,})/i); return m ? m[1] : ''; }
/* 영상 업로드 — URL 방식. 파일 이름은 계정 안에서 겹치면 안 되므로 뒤에 시각을 붙여 보낸다 */
async function uploadVideo(b) {
  const adv = digits(b.advertiser_id);
  if (!adv) throw bad('advertiser_id 가 필요해요');
  const urls = b.video_url ? [String(b.video_url)] : driveDownloadUrls(b.drive_file_id);
  if (!urls.length) throw bad('drive_file_id 또는 video_url 이 필요해요');
  const base = String(b.file_name || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
  const fileName = b.keep_name ? base : base.replace(/(\.[A-Za-z0-9]+)?$/, `_${stamp}$1`);
  let lastErr = null;
  for (const url of urls) {
    try {
      const d = await tt('file/video/ad/upload/', null, { advertiser_id: adv, upload_type: 'UPLOAD_BY_URL', video_url: url, file_name: fileName, flaw_detect: true, auto_fix_enabled: true, auto_bind_enabled: true });
      const v = Array.isArray(d) ? d[0] : (d.list ? d.list[0] : d);
      if (!v || !v.video_id) throw new Error('틱톡 응답에 video_id 가 없어요: ' + JSON.stringify(d).slice(0, 200));
      return { video_id: str(v.video_id), material_id: str(v.material_id || ''), file_name: str(v.file_name || fileName), width: v.width, height: v.height, duration: v.duration, size: v.size, preview_url: v.preview_url || '', cover_url: v.video_cover_url || v.poster_url || '', displayable: v.displayable, source_url_kind: /googleapis/.test(url) ? 'api' : 'drive' };
    } catch (e) {
      lastErr = e;
      const existing = videoIdInMessage(e.ttMessage || e.message);
      if (existing && /exist|duplicate|already|이미/i.test(e.message)) return { video_id: existing, reused: true, file_name: fileName };
      // 내려받기 실패면 다음 주소로 — 그 밖(이름 중복·형식 오류)은 바로 멈춘다
      if (!/download|fetch|url|timeout|time out|network|access|403|404/i.test(e.message)) break;
    }
  }
  throw lastErr || new Error('영상 업로드 실패');
}
/* 영상 처리 상태 */
async function videoInfo(adv, ids) {
  const d = await tt('file/video/ad/info/', { advertiser_id: adv, video_ids: ids.slice(0, 20) });
  return (d.list || []).map(v => ({ video_id: str(v.video_id), material_id: str(v.material_id || ''), displayable: v.displayable, preview_url: v.preview_url || '', cover_url: v.video_cover_url || v.poster_url || '', width: v.width, height: v.height, duration: v.duration, file_name: v.file_name || '', allowed_placements: v.allowed_placements || [] }));
}
/* 영상 커버 — 틱톡이 뽑아 주는 썸네일 중 첫 장 → 없으면 페이지가 준 커버 이미지 주소 → 없으면 영상 정보의 커버 주소 */
async function cover(b) {
  const adv = digits(b.advertiser_id); const vid = str(b.video_id);
  if (!adv || !vid) throw bad('advertiser_id · video_id 가 필요해요');
  const errors = [];
  for (let i = 0; i < 3; i++) {
    try {
      const d = await tt('file/video/suggestcover/', { advertiser_id: adv, video_id: vid, poster_number: 3 });
      const first = (d.list || [])[0];
      if (first && (first.id || first.image_id)) return { image_id: str(first.id || first.image_id), source: 'suggest', url: first.url || '' };
      errors.push('suggestcover: 빈 목록');
    } catch (e) { errors.push('suggestcover: ' + redact(e.message)); if (!/process|transcod|ready|wait/i.test(e.message)) break; }
    await new Promise(r => setTimeout(r, 2500));
  }
  const cands = [];
  if (b.cover_url) cands.push(String(b.cover_url));
  if (b.cover_drive_file_id) driveDownloadUrls(b.cover_drive_file_id).forEach(u => cands.push(u));
  try { const info = await videoInfo(adv, [vid]); if (info[0] && info[0].cover_url) cands.push(info[0].cover_url); } catch (e) { errors.push('video info: ' + redact(e.message)); }
  for (const url of cands) {
    try {
      const d = await tt('file/image/ad/upload/', null, { advertiser_id: adv, upload_type: 'UPLOAD_BY_URL', image_url: url, file_name: `cover_${vid}_${Date.now()}.jpg` });
      const img = Array.isArray(d) ? d[0] : d;
      if (img && (img.image_id || img.id)) return { image_id: str(img.image_id || img.id), source: 'upload', url: img.image_url || '' };
      errors.push('image upload: 응답에 image_id 없음');
    } catch (e) { errors.push('image upload: ' + redact(e.message)); }
  }
  const err = new Error('커버 이미지를 만들지 못했어요 — ' + errors.join(' / ')); err.http = 502; throw err;
}

/* 틱톡이 항목 하나를 거절하면 그 항목만 빼거나(선택 항목) 다른 값으로 바꿔(열거형) 다시 보낸다 — 만들다 만 것 없이 실패하는 검증 오류에서만 */
const OPTIONAL_FIELDS = ['attribution_event_count', 'click_attribution_window', 'view_attribution_window', 'smart_audience_enabled', 'smart_interest_behavior_enabled', 'share_disabled', 'video_download_disabled', 'comment_disabled', 'creative_material_mode', 'promotion_target_type', 'promotion_website_type', 'utm_params', 'dark_post_status', 'operation_status', 'actions', 'interest_category_ids', 'excluded_audience_ids', 'languages', 'identity_authorized_bc_id', 'campaign_type', 'budget_optimize_on', 'auto_targeting_enabled', 'promotional_music_disabled', 'tracking_pixel_id'];
async function createWithRetry(path, body, alternatives) {
  const tried = [];
  let cur = Object.assign({}, body);
  for (let i = 0; i < 6; i++) {
    try { const data = await tt(path, null, cur); return { data, sent: cur, tried }; }
    catch (e) {
      const msg = String(e.ttMessage || e.message || '');
      const validation = e.code === 40002 || e.code === 40001 || e.code === 40100 || /invalid|not support|unsupport|illegal|required|cannot|can't|not allowed|missing|unknown|incorrect|must be|should be|does not exist|not exist|not match|disallow|conflict|enum/i.test(msg);
      if (!validation) { e.tried = tried; e.sent = cur; throw e; }
      let changed = false;
      for (const [field, list] of Object.entries(alternatives || {})) {
        if (cur[field] === undefined) continue;
        if (!new RegExp(field.replace(/_/g, '[_ ]?'), 'i').test(msg)) continue;
        const idx = list.indexOf(cur[field]);
        const next = list.slice(idx + 1).find(v => !tried.includes(`${field}=${v}`));
        if (next !== undefined) { tried.push(`${field}=${next}`); cur = Object.assign({}, cur, { [field]: next }); changed = true; break; }
      }
      if (changed) continue;
      const bad = OPTIONAL_FIELDS.find(f => cur[f] !== undefined && new RegExp('(^|[^a-z_])' + f + '([^a-z_]|$)', 'i').test(msg));
      if (bad) { tried.push('-' + bad); const n = Object.assign({}, cur); delete n[bad]; cur = n; continue; }
      e.tried = tried; e.sent = cur; throw e;
    }
  }
  throw new Error('재시도 한도를 넘었어요');
}
const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const ENGAGE_EVENTS = ['ON_WEB_DETAIL', 'PAGE_VIEW', 'LANDING_PAGE_VIEW', 'BUTTON', 'ON_WEB_SEARCH', 'SEARCH', 'ON_WEB_CART', 'ADD_TO_CART', 'ON_WEB_ADD_TO_WISHLIST', 'ADD_TO_WISHLIST', 'INITIATE_CHECKOUT', 'ON_WEB_ORDER', 'VIEW_CONTENT', 'CLICK_BUTTON'];

/* 캠페인 — 목표 리드. 예산 전략: adgroup(기본 · 캠페인은 무제한, 광고그룹이 일예산) / campaign(캠페인 예산 최적화 CBO) */
async function createCampaign(b) {
  const adv = digits(b.advertiser_id); const name = String(b.campaign_name || '').trim();
  if (!adv || !name) throw bad('advertiser_id · campaign_name 이 필요해요');
  const cbo = b.budget_strategy === 'campaign';
  const budget = Number(b.budget || 0);
  if (cbo && !(budget > 0)) throw bad('캠페인 예산 전략에는 예산(원)이 필요해요');
  const body = { advertiser_id: adv, campaign_name: name, objective_type: 'LEAD_GENERATION', campaign_type: 'REGULAR_CAMPAIGN', budget_optimize_on: cbo };
  if (cbo) { body.budget_mode = 'BUDGET_MODE_DAY'; body.budget = budget; body.optimization_goal = b.optimization_goal || 'LEAD_GENERATION'; }
  else body.budget_mode = 'BUDGET_MODE_INFINITE';
  if (b.operation_status === 'DISABLE') body.operation_status = 'DISABLE';   // 허용 목록에 든 계정만 먹는다 — 아니면 무시된다
  const r = await createWithRetry('campaign/create/', body, { optimization_goal: ['LEAD_GENERATION', 'LEADS', 'CONVERT'] });
  return { campaign_id: str(r.data.campaign_id), sent: r.sent, tried: r.tried };
}
/* 광고그룹 — 리드 방식(web: 웹사이트+픽셀 이벤트 / form: 인스턴트 양식) 에 따라 최적화 위치가 정해진다. 입찰·과금·페이싱·어트리뷰션은 고정 */
async function createAdgroup(b) {
  const adv = digits(b.advertiser_id); const camp = digits(b.campaign_id); const name = String(b.adgroup_name || '').trim();
  if (!adv || !camp || !name) throw bad('advertiser_id · campaign_id · adgroup_name 이 필요해요');
  const web = b.lead_mode === 'web';
  const cbo = b.budget_strategy === 'campaign';
  const budget = Number(b.budget || 0);
  if (!cbo && !(budget > 0)) throw bad('광고그룹 일예산(원)이 필요해요');
  const locations = arr(b.location_ids).map(String).filter(Boolean);
  if (!locations.length) throw bad('지역을 1개 이상 골라주세요');
  const ages = arr(b.age_groups).map(String).filter(Boolean);
  const event = str(b.optimization_event).toUpperCase();
  const engage = web && ENGAGE_EVENTS.includes(event);
  const goal = str(b.optimization_goal) || (engage ? 'LEAD_WEB_ENGAGEMENT' : 'LEADS');
  const body = {
    advertiser_id: adv, campaign_id: camp, adgroup_name: name,
    promotion_type: 'LEAD_GENERATION', promotion_target_type: web ? 'EXTERNAL_WEBSITE' : 'INSTANT_PAGE',
    optimization_goal: goal, bid_type: 'BID_TYPE_NO_BID', billing_event: 'OCPM', pacing: 'PACING_MODE_SMOOTH',
    placement_type: b.placement_type === 'PLACEMENT_TYPE_NORMAL' ? 'PLACEMENT_TYPE_NORMAL' : 'PLACEMENT_TYPE_AUTOMATIC',
    location_ids: locations, gender: str(b.gender) || 'GENDER_UNLIMITED', languages: arr(b.languages).length ? arr(b.languages) : ['ko'],
    schedule_type: 'SCHEDULE_FROM_NOW', schedule_start_time: str(b.schedule_start_time) || nowUtc(),
    creative_material_mode: 'CUSTOM',
    comment_disabled: true, video_download_disabled: true, share_disabled: true,
    operation_status: b.operation_status === 'ENABLE' ? 'ENABLE' : 'DISABLE',
  };
  if (ages.length) body.age_groups = ages;
  if (body.placement_type === 'PLACEMENT_TYPE_NORMAL') body.placements = arr(b.placements).length ? arr(b.placements) : ['PLACEMENT_TIKTOK'];
  if (cbo) { body.budget_mode = 'BUDGET_MODE_INFINITE'; body.budget = 0; }
  else { body.budget_mode = 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET'; body.budget = budget; }
  if (web) {
    if (!digits(b.pixel_id) || !event) throw bad('웹사이트(랜딩) 방식에는 데이터 연결(픽셀)과 최적화 이벤트가 필요해요');
    body.pixel_id = digits(b.pixel_id); body.optimization_event = event;
    body.click_attribution_window = 'SEVEN_DAYS'; body.view_attribution_window = 'ONE_DAY'; body.attribution_event_count = 'EVERY';
  }
  if (arr(b.excluded_audience_ids).length) body.excluded_audience_ids = arr(b.excluded_audience_ids).map(String);
  if (arr(b.interest_category_ids).length) body.interest_category_ids = arr(b.interest_category_ids).map(String);
  if (Array.isArray(b.actions) && b.actions.length) body.actions = b.actions.map(a => ({ action_scene: a.action_scene || 'VIDEO_RELATED', action_period: Number(a.action_period || 15), action_category_ids: arr(a.action_category_ids).map(String), user_actions: arr(a.user_actions).length ? arr(a.user_actions) : ['WATCHED_TO_END', 'LIKED', 'COMMENTED', 'SHARED'] }));
  if (b.smart_audience_enabled !== undefined) body.smart_audience_enabled = !!b.smart_audience_enabled;
  const alts = { optimization_goal: web ? (engage ? ['LEAD_WEB_ENGAGEMENT', 'LEADS', 'CONVERT', 'LEAD_GENERATION'] : ['LEADS', 'CONVERT', 'LEAD_GENERATION', 'LEAD_WEB_ENGAGEMENT']) : ['LEADS', 'LEAD_GENERATION'], budget_mode: cbo ? ['BUDGET_MODE_INFINITE', 'BUDGET_MODE_DAY'] : ['BUDGET_MODE_DYNAMIC_DAILY_BUDGET', 'BUDGET_MODE_DAY'] };
  const r = await createWithRetry('adgroup/create/', body, alts);
  return { adgroup_id: str(r.data.adgroup_id), sent: r.sent, tried: r.tried };
}
/* 광고 — 단일 동영상 · 표시 계정 · 광고로만 표시(dark post) · 고정 URL 파라미터 · 만들 땐 꺼 둔다 */
const FIXED_UTM = [{ key: 'campaign_id', value: '__CAMPAIGN_ID__' }, { key: 'adset_id', value: '__AID__' }, { key: 'ad_id', value: '__CID__' }];
async function createAd(b) {
  const adv = digits(b.advertiser_id); const group = digits(b.adgroup_id);
  if (!adv || !group) throw bad('advertiser_id · adgroup_id 가 필요해요');
  const web = b.lead_mode === 'web';
  const idn = b.identity || {};
  if (!str(idn.id)) throw bad('표시 계정(아이덴티티)을 골라주세요');
  const c = {
    ad_name: String(b.ad_name || '').trim().slice(0, 512), ad_format: 'SINGLE_VIDEO',
    identity_type: str(idn.type) || 'BC_AUTH_TT', identity_id: str(idn.id),
    video_id: str(b.video_id), image_ids: [str(b.image_id)].filter(Boolean),
    ad_text: String(b.ad_text || '').trim(), call_to_action: str(b.call_to_action) || 'LEARN_MORE',
    dark_post_status: b.dark_post === false ? 'OFF' : 'ON',
    promotional_music_disabled: true,
    operation_status: b.operation_status === 'ENABLE' ? 'ENABLE' : 'DISABLE',
  };
  if (!c.ad_name || !c.video_id || !c.ad_text) throw bad('ad_name · video_id · ad_text 가 필요해요');
  if (c.identity_type === 'BC_AUTH_TT') {
    let bcId = str(idn.bcId);
    if (!bcId) { try { const list = await bcs(); if (list.length === 1) bcId = list[0].id; } catch (e) { /* 아래에서 오류 */ } }
    if (!bcId) throw bad('비즈니스 센터 ID 가 필요해요 (설정 → TikTok 기본값 → 표시 계정의 BC)');
    c.identity_authorized_bc_id = bcId;
  }
  if (web) {
    if (!/^https?:\/\/\S+$/i.test(str(b.landing_page_url))) throw bad('랜딩 페이지 URL 이 비어 있거나 https:// 로 시작하지 않아요');
    c.landing_page_url = str(b.landing_page_url);
    c.utm_params = Array.isArray(b.utm_params) && b.utm_params.length ? b.utm_params.map(u => ({ key: str(u.key), value: str(u.value) })).filter(u => u.key) : FIXED_UTM.slice();
  } else {
    if (!digits(b.page_id)) throw bad('인스턴트 양식을 골라주세요');
    c.page_id = Number(digits(b.page_id));
  }
  if (digits(b.tracking_pixel_id)) c.tracking_pixel_id = Number(digits(b.tracking_pixel_id));
  const body = { advertiser_id: adv, adgroup_id: group, creatives: [c] };
  // 영상이 아직 처리 중이면 잠시 기다렸다 다시 (최대 6번)
  let last = null;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await createWithRetryNested(body);
      const ids = r.data.ad_ids || (r.data.list || []).map(a => a.ad_id) || [];
      return { ad_id: str(ids[0] || ''), ad_ids: ids.map(String), sent: r.sent.creatives[0], tried: r.tried, utm_appended: !!r.utmAppended };
    } catch (e) {
      last = e;
      if (/process|transcod|not ready|being uploaded|uploading|wait/i.test(e.ttMessage || e.message)) { await new Promise(r => setTimeout(r, 5000)); continue; }
      throw e;
    }
  }
  throw last;
}
/* ad/create 는 creatives 배열 안을 고쳐야 해서 따로 — 선택 항목 거절 시 그 항목만 빼고, utm_params 를 못 받으면 URL 에 직접 붙인다 */
async function createWithRetryNested(body) {
  const tried = []; let utmAppended = false;
  let cur = JSON.parse(JSON.stringify(body));
  for (let i = 0; i < 6; i++) {
    try { const data = await tt('ad/create/', null, cur); return { data, sent: cur, tried, utmAppended }; }
    catch (e) {
      const msg = String(e.ttMessage || e.message || '');
      const validation = e.code === 40002 || e.code === 40001 || e.code === 40100 || /invalid|not support|unsupport|illegal|required|cannot|can't|not allowed|missing|unknown|incorrect|must be|should be|not exist|not match|disallow|enum/i.test(msg);
      if (!validation) { e.tried = tried; e.sent = cur; throw e; }
      const c = cur.creatives[0];
      if (c.utm_params && /utm/i.test(msg)) {
        // URL 파라미터 항목을 안 받으면 랜딩 URL 뒤에 그대로 붙여 보낸다 (틱톡이 매크로를 바꿔 넣는다)
        const qs = c.utm_params.map(u => `${encodeURIComponent(u.key)}=${u.value}`).join('&');
        c.landing_page_url += (c.landing_page_url.includes('?') ? '&' : '?') + qs;
        delete c.utm_params; utmAppended = true; tried.push('utm→url'); continue;
      }
      const bad = OPTIONAL_FIELDS.find(f => c[f] !== undefined && new RegExp('(^|[^a-z_])' + f + '([^a-z_]|$)', 'i').test(msg));
      if (bad) { tried.push('-' + bad); delete c[bad]; continue; }
      e.tried = tried; e.sent = cur; throw e;
    }
  }
  throw new Error('재시도 한도를 넘었어요');
}
async function pauseCampaign(b) {
  const adv = digits(b.advertiser_id); const camp = digits(b.campaign_id);
  if (!adv || !camp) throw bad('advertiser_id · campaign_id 가 필요해요');
  await tt('campaign/status/update/', null, { advertiser_id: adv, campaign_ids: [camp], operation_status: 'DISABLE' });
  return { ok: true };
}
async function confirmTerms(b) {
  const adv = digits(b.advertiser_id);
  if (!adv) throw bad('advertiser_id 가 필요해요');
  await tt('term/confirm/', null, { advertiser_id: adv, term_type: 'LEAD_ADS' });
  return { ok: true };
}
async function adStatus(adv, ids) {
  const d = await tt('ad/get/', { advertiser_id: adv, page_size: 50, fields: ['ad_id', 'ad_name', 'adgroup_id', 'campaign_id', 'operation_status', 'secondary_status', 'landing_page_url', 'page_id', 'dark_post_status', 'identity_id', 'identity_type', 'call_to_action', 'video_id', 'image_ids', 'tracking_pixel_id', 'tracking_offline_event_set_ids', 'utm_params', 'create_time'], filtering: { ad_ids: ids.slice(0, 50) } });
  return (d.list || []);
}

/* 진단 — 한 계정의 표시 계정·양식·최근 캠페인/광고그룹/광고 (이름 규칙·기본 설정을 읽어 가기 위해) */
async function diag(advertiserId) {
  const out = { advertiser_id: advertiserId, errors: {} };
  const safe = async (key, fn) => { try { out[key] = await fn(); } catch (e) { out.errors[key] = redact(e.message); out[key] = null; } };
  await safe('identities', async () => { const d = await tt('identity/get/', { advertiser_id: advertiserId }); return (d.identity_list || d.list || []).map(i => ({ id: i.identity_id, type: i.identity_type, name: i.display_name, verified: i.is_verified === undefined ? undefined : !!i.is_verified })); });
  await safe('forms', async () => { const d = await tt('page/get/', { advertiser_id: advertiserId, business_type: 'LEAD_GEN', page_size: 50 }); return (d.list || []).map(p => ({ id: p.page_id, title: p.title || p.name || '', status: p.status || '' })); });
  await safe('bcs', bcs);
  await safe('pixels', async () => (await pixels(advertiserId)).map(x => ({ id: x.id, name: x.name, code: x.code, active: x.active, events: x.events.map(ev => `${ev.name || ev.type}${ev.type && ev.name !== ev.type ? ' (' + ev.type + ')' : ''}${ev.active === false ? ' ⏸' : ''}`) })));
  // 캠페인 — 기본 항목 + (되면) Smart+ 여부 같은 추가 항목
  const campBase = ['campaign_id', 'campaign_name', 'objective_type', 'budget', 'budget_mode', 'operation_status', 'create_time'];
  const campExtra = ['campaign_type', 'is_smart_performance_campaign', 'budget_optimize_on', 'bid_type', 'optimization_goal', 'secondary_status'];
  await safe('campaigns', async () => {
    try { const d = await tt('campaign/get/', { advertiser_id: advertiserId, page_size: 15, fields: campBase.concat(campExtra) }); return (d.list || []); }
    catch (e) { out.errors.campaignsExtra = redact(e.message); const d = await tt('campaign/get/', { advertiser_id: advertiserId, page_size: 15, fields: campBase }); return (d.list || []); }
  });
  const agBase = ['adgroup_id', 'adgroup_name', 'campaign_id', 'campaign_name', 'promotion_type', 'placement_type', 'placements', 'optimization_goal', 'optimization_event', 'bid_type', 'bid_price', 'billing_event', 'budget', 'budget_mode', 'schedule_type', 'schedule_start_time', 'schedule_end_time', 'location_ids', 'zipcode_ids', 'age_groups', 'gender', 'languages', 'identity_id', 'identity_type', 'pacing', 'operation_status', 'create_time', 'pixel_id', 'promotion_website_type'];
  const agExtra = ['conversion_bid_price', 'deep_bid_type', 'smart_audience_enabled', 'targeting_expansion', 'interest_category_ids', 'audience_ids', 'excluded_audience_ids', 'operating_systems', 'secondary_status', 'creative_material_mode', 'brand_safety_type', 'comment_disabled', 'video_download_disabled', 'share_disabled', 'promotion_target_type', 'is_smart_performance_campaign', 'identity_authorized_bc_id', 'optimization_event', 'click_attribution_window', 'view_attribution_window', 'attribution_event_count', 'actions'];
  await safe('adgroups', async () => {
    try { const d = await tt('adgroup/get/', { advertiser_id: advertiserId, page_size: 15, fields: agBase.concat(agExtra) }); return (d.list || []); }
    catch (e) { out.errors.adgroupsExtra = redact(e.message); const d = await tt('adgroup/get/', { advertiser_id: advertiserId, page_size: 15, fields: agBase }); return (d.list || []); }
  });
  const adFields = ['ad_id', 'ad_name', 'adgroup_id', 'adgroup_name', 'campaign_id', 'ad_format', 'video_id', 'image_ids', 'ad_text', 'ad_texts', 'call_to_action', 'call_to_action_id', 'landing_page_url', 'page_id', 'identity_id', 'identity_type', 'identity_authorized_bc_id', 'display_name', 'operation_status', 'create_time', 'creative_type', 'secondary_status', 'music_id', 'promotional_music_disabled', 'tiktok_item_id', 'dark_post_status', 'creative_authorized', 'ad_url', 'utm_params', 'tracking_pixel_id', 'tracking_offline_event_set_ids'];
  const adBase = ['ad_id', 'ad_name', 'adgroup_id', 'campaign_id', 'ad_format', 'video_id', 'image_ids', 'ad_text', 'call_to_action', 'landing_page_url', 'page_id', 'identity_id', 'identity_type', 'identity_authorized_bc_id', 'display_name', 'operation_status', 'create_time'];
  // 광고 — 틱톡이 자동으로 만든 변형(Music_Refresh · auto carousel generation)은 뒤로 보내고, 최근 광고그룹 3개의 광고를 따로 본다
  const isAuto = a => /-Music_Refresh-|^auto carousel generation_|smart creative|_Smart_Creative_/i.test(String(a.ad_name || ''));
  await safe('ads', async () => {
    let list;
    try { const d = await tt('ad/get/', { advertiser_id: advertiserId, page_size: 60, fields: adFields }); list = (d.list || []); }
    catch (e) { out.errors.adsExtra = redact(e.message); const d = await tt('ad/get/', { advertiser_id: advertiserId, page_size: 60, fields: adBase }); list = (d.list || []); }
    const real = list.filter(a => !isAuto(a)), auto = list.filter(isAuto);
    out.adsAutoCount = auto.length;
    return real.slice(0, 20).concat(auto.slice(0, 3).map(a => Object.assign({ _auto: true }, a)));
  });
  await safe('adsOfRecentGroups', async () => {
    const ids = (out.adgroups || []).slice(0, 3).map(g => String(g.adgroup_id)).filter(Boolean);
    if (!ids.length) return [];
    let list;
    try { const d = await tt('ad/get/', { advertiser_id: advertiserId, page_size: 60, fields: adFields, filtering: { adgroup_ids: ids } }); list = (d.list || []); }
    catch (e) { const d = await tt('ad/get/', { advertiser_id: advertiserId, page_size: 60, fields: adBase, filtering: { adgroup_ids: ids } }); list = (d.list || []); }
    return list.filter(a => !isAuto(a)).slice(0, 15).concat(list.filter(isAuto).slice(0, 2).map(a => Object.assign({ _auto: true }, a)));
  });
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
  if (q.ping) return res.status(200).json({ ok: true, build: BUILD, hasToken: !!token(), hasApp: !!(appId() && appSecret()), hasAdvertiserIds: !!process.env.TIKTOK_ADVERTISER_IDS, hasGoogleApiKey: !!googleKey(), redirectUrl: selfUrl(req), readOnly: false, canWrite: true });
  // 틱톡 승인 뒤 리다이렉트 — 로그인 없이 들어온다 (auth_code 는 승인한 관리자만 받고, 1시간·1회용)
  if (req.method === 'GET' && q.auth_code && !q.op) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    try { return res.status(200).send(tokenPage(await exchange(q.auth_code))); }
    catch (e) { return res.status(200).send(tokenPage(null, redact(e.message))); }
  }
  const who = await verifyUser(req);
  if (!who.ok) return res.status(who.status).json({ error: who.error, sessionInvalid: !!who.sessionInvalid });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET 또는 POST 만 됩니다' });
  const op0 = String(q.op || '');
  if (req.method === 'GET' && op0 === 'auth_url') {
    try { const u = authUrl(req, q.redirect); return u ? res.status(200).json({ url: u, redirectUrl: String(q.redirect || '').trim() || selfUrl(req) }) : res.status(500).json({ error: 'Vercel 환경변수 TIKTOK_APP_ID 를 먼저 넣고 재배포하세요' }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if (req.method === 'GET' && op0 === 'exchange') { try { const r = await exchange(q.auth_code); return res.status(200).json(r); } catch (e) { return res.status(400).json({ error: redact(e.message) }); } }
  if (!token()) return res.status(500).json({ error: 'Vercel 환경변수 TIKTOK_ACCESS_TOKEN 이 비어 있어요 — 연동 탭의 «틱톡 승인 링크 열기»로 토큰을 만들어 넣고 재배포하세요' });

  try {
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
      if (!b || typeof b !== 'object') return res.status(400).json({ error: '본문이 JSON 이 아니에요' });
      const op = String(b.op || op0);
      if (op === 'upload_video') return res.status(200).json(await uploadVideo(b));
      if (op === 'cover') return res.status(200).json(await cover(b));
      if (op === 'create_campaign') return res.status(200).json(await createCampaign(b));
      if (op === 'create_adgroup') return res.status(200).json(await createAdgroup(b));
      if (op === 'create_ad') return res.status(200).json(await createAd(b));
      if (op === 'pause_campaign') return res.status(200).json(await pauseCampaign(b));
      if (op === 'confirm_terms') return res.status(200).json(await confirmTerms(b));
      return res.status(400).json({ error: `모르는 op: ${op}` });
    }
    const op = op0;
    const adv = digits(q.advertiser_id);
    const needAdv = () => { if (!adv) { const e = new Error('advertiser_id 가 필요해요'); e.http = 400; throw e; } };
    if (op === 'advertisers') return res.status(200).json({ list: await advertisers() });
    if (op === 'bcs') return res.status(200).json({ list: await bcs() });
    if (op === 'region') { needAdv(); return res.status(200).json({ list: await regions(adv, q.q, arr(q.ids)) }); }
    if (op === 'diag') { needAdv(); return res.status(200).json(await diag(adv)); }
    if (op === 'identities') { needAdv(); return res.status(200).json(await identities(adv)); }
    if (op === 'pages') { needAdv(); return res.status(200).json({ list: await pages(adv) }); }
    if (op === 'pixels') { needAdv(); return res.status(200).json({ list: await pixels(adv) }); }
    if (op === 'audiences') { needAdv(); return res.status(200).json({ list: await audiences(adv) }); }
    if (op === 'interests') { needAdv(); return res.status(200).json({ list: await interests(adv) }); }
    if (op === 'actions') { needAdv(); return res.status(200).json(await actions(adv)); }
    if (op === 'campaign_search') return res.status(200).json(await campaignSearch(q.q));
    if (op === 'video_info') { needAdv(); return res.status(200).json({ list: await videoInfo(adv, arr(q.video_ids)) }); }
    if (op === 'ad_status') { needAdv(); return res.status(200).json({ list: await adStatus(adv, arr(q.ad_ids)) }); }
    const path = String(q.path || '').replace(/^\/+/, '');
    if (path) {
      if (!ALLOW_GET.includes(path)) return res.status(403).json({ error: `이 경로는 허용하지 않아요: ${path}` });
      const params = {};
      Object.entries(q).forEach(([k, v]) => { if (k !== 'path' && k !== 'op') params[k] = v; });
      return res.status(200).json(await tt(path, params));
    }
    return res.status(400).json({ error: 'op 또는 path 가 필요해요' });
  } catch (e) {
    const out = { error: redact(e.message), code: e.code };
    if (e.tried && e.tried.length) out.tried = e.tried;
    if (e.sent) out.sent = JSON.parse(redact(JSON.stringify(e.sent)));
    return res.status(e.http && e.http >= 400 ? e.http : 502).json(out);
  }
};
