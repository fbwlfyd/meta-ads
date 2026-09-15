/**
 * Vercel 서버리스 함수 — Google Ads API 중계
 *
 * 배치 위치 : 지금 HTML이 올라가 있는 그 프로젝트 안에  api/gads.js
 *             (새 프로젝트를 만드는 게 아닙니다)
 * 호출 주소 : https://<내주소>.vercel.app/api/gads?type=campaigns&customerId=1234567890
 *
 * 브라우저는 같은 도메인(/api/gads)만 부르므로 CORS가 발생하지 않는다.
 * 인증은 브라우저가 보낸 OAuth 액세스 토큰을 그대로 전달하고,
 * developer token 은 서버 환경변수에서 읽는다(HTML에 노출되지 않음).
 *
 * Vercel 환경변수 (Settings → Environment Variables)
 *   GOOGLE_ADS_DEVELOPER_TOKEN    필수
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID  선택 (MCC ID, 하이픈 없이)
 *   GOOGLE_ADS_API_VERSION        선택 (예: v21). 없으면 자동으로 찾는다.
 *
 * 진단용 호출
 *   /api/gads?type=ping      ← 로그인 없이 배포된 빌드 확인 (연동 탭이 자동으로 부른다)
 *   /api/gads?type=version   ← 어떤 API 버전이 살아 있는지 확인
 */

const HOST = 'https://googleads.googleapis.com';
// 이 파일의 빌드 표식 — HTML(연동 탭)이 /api/gads?type=ping 으로 읽어 구버전 배포를 잡아낸다
const BUILD = '2026-09-17';
const FEATURES = ['audience', 'geo', 'findcampaigns', 'campaigngeo', 'campaign'];

// 최신 버전부터 훑는다. 지원 종료된 버전은 HTML 404를 돌려주므로 건너뛴다.
const CANDIDATE_VERSIONS = ['v23', 'v22', 'v21', 'v20', 'v19', 'v18'];
let cachedVersion = null;

const QUERIES = {
  campaigns: () =>
    "SELECT campaign.id, campaign.name, campaign.status FROM campaign " +
    "WHERE campaign.status = 'ENABLED' ORDER BY campaign.id DESC LIMIT 300",
  adgroups: (p) =>
    "SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group " +
    `WHERE campaign.id = ${Number(p.campaignId)} LIMIT 200`,
  ads: (p) =>
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status FROM ad_group_ad " +
    `WHERE ad_group.id = ${Number(p.adGroupId)} LIMIT 200`,
  // 잠재고객(audience 리소스)만. 세그먼트(user_list: 'AdWords optimized list', 'Purchasers of …')와
  // 실적최대화 애셋그룹 전용 신호(scope=ASSET_GROUP)는 제외한다.
  audiences: () =>
    "SELECT audience.id, audience.name, audience.status, audience.scope FROM audience " +
    "WHERE audience.status = 'ENABLED' AND audience.scope = 'CUSTOMER' ORDER BY audience.name LIMIT 300",
  // 캠페인 단위에 걸린 지역 타겟 (있으면 광고그룹에서 지역을 다시 설정하지 않는다)
  campaigngeo: (p) =>
    "SELECT campaign_criterion.criterion_id, campaign_criterion.location.geo_target_constant, " +
    "campaign_criterion.negative, campaign_criterion.type FROM campaign_criterion " +
    `WHERE campaign.id = ${Number(p.campaignId)} AND campaign_criterion.type = 'LOCATION' LIMIT 100`,
};

// 응답이 JSON이 아니면(=지원 종료된 버전 등) 내용을 그대로 담아 돌려준다
async function readBody(res) {
  const text = await res.text();
  try {
    return { ok: true, json: JSON.parse(text), text };
  } catch (e) {
    return { ok: false, json: null, text };
  }
}

// 살아 있는 API 버전을 찾는다 (한 번 찾으면 캐시)
async function resolveVersion(headers) {
  if (process.env.GOOGLE_ADS_API_VERSION) return process.env.GOOGLE_ADS_API_VERSION;
  if (cachedVersion) return cachedVersion;
  const tried = [];
  for (const v of CANDIDATE_VERSIONS) {
    try {
      const res = await fetch(`${HOST}/${v}/customers:listAccessibleCustomers`, { headers });
      const body = await readBody(res);
      if (body.ok) { cachedVersion = v; return v; }   // JSON이면 살아 있는 버전
      tried.push(`${v}:HTTP${res.status}/HTML`);
    } catch (e) {
      tried.push(`${v}:${e.message}`);
    }
  }
  const err = new Error('사용 가능한 Google Ads API 버전을 찾지 못했습니다 — ' + tried.join(', '));
  err.tried = tried;
  throw err;
}

function normalize(type, rows) {
  return rows.map((r) => {
    if (type === 'campaigns') return { id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status };
    if (type === 'adgroups') return { id: String(r.adGroup.id), name: r.adGroup.name, status: r.adGroup.status };
    if (type === 'ads') return { id: String(r.adGroupAd.ad.id), name: r.adGroupAd.ad.name || '(이름 없음)', status: r.adGroupAd.status };
    if (type === 'audiences') return { id: String(r.audience.id), name: r.audience.name, status: r.audience.status || '', kind: 'audience' };
    if (type === 'campaigngeo') {
      const cc = r.campaignCriterion || {};
      const gt = (cc.location && cc.location.geoTargetConstant) || '';
      return { id: String(gt.split('/').pop() || cc.criterionId || ''), name: gt || String(cc.criterionId || ''), status: cc.negative ? 'NEGATIVE' : 'POSITIVE' };
    }
    return null;
  }).filter(Boolean);
}

function gadsError(body, res) {
  if (!body.ok) return `Google이 JSON이 아닌 응답을 보냈습니다 (HTTP ${res.status}): ${body.text.slice(0, 200)}`;
  const j = body.json;
  const d = j.error || (Array.isArray(j) && j[0] && j[0].error) || {};
  const detail = d.details && d.details[0] && d.details[0].errors && d.details[0].errors[0];
  return [d.message, detail && detail.message, d.status].filter(Boolean).join(' — ') || `HTTP ${res.status}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 로그인 없이 배포 상태만 확인 (비밀값은 내보내지 않는다)
  if (req.query && req.query.type === 'ping') {
    return res.status(200).json({
      ok: true,
      build: BUILD,
      features: FEATURES,
      hasDeveloperToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      hasLoginCustomerId: !!process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    });
  }

  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) return res.status(500).json({ error: 'GOOGLE_ADS_DEVELOPER_TOKEN 환경변수가 없습니다' });
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: '로그인 토큰이 없습니다 (Authorization 헤더 필요)' });

  const { type = '', customerId = '', campaignId = '', adGroupId = '' } = req.query;
  const headers = {
    Authorization: auth,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/[^0-9]/g, '');
  }

  try {
    // 진단: 어떤 버전이 살아 있는지 + 토큰이 먹히는지
    if (type === 'version') {
      const report = [];
      for (const v of CANDIDATE_VERSIONS) {
        try {
          const r = await fetch(`${HOST}/${v}/customers:listAccessibleCustomers`, { headers });
          const body = await readBody(r);
          report.push({
            version: v,
            http: r.status,
            json: body.ok,
            note: body.ok
              ? (r.ok ? '✅ 사용 가능' : '응답은 JSON — ' + gadsError(body, r))
              : '지원 종료된 버전(HTML 반환)',
          });
          if (body.ok) break;   // 살아 있는 버전을 찾으면 중단
        } catch (e) {
          report.push({ version: v, http: 0, json: false, note: e.message });
        }
      }
      return res.status(200).json({
        envVersion: process.env.GOOGLE_ADS_API_VERSION || null,
        loginCustomerId: headers['login-customer-id'] || null,
        report,
      });
    }

    const V = await resolveVersion(headers);
    const API = `${HOST}/${V}`;

    // 접근 가능한 모든 계정에서 캠페인 조건으로 찾는다 (findcampaigns · campaign 공용)
    //   stopWhenFound: ID 하나를 찾는 경우 첫 결과가 나오면 나머지 계정은 안 본다
    async function searchCampaignsEverywhere(query, stopWhenFound) {
      const r = await fetch(`${API}/customers:listAccessibleCustomers`, { headers });
      const body = await readBody(r);
      if (!r.ok || !body.ok) { const err = new Error(gadsError(body, r)); err.http = r.status; throw err; }
      const ids = (body.json.resourceNames || []).map((n) => n.split('/').pop()).slice(0, 40);
      const out = [];
      // 계정 수가 많을 수 있으니 8개씩 병렬로
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map(async (cid) => {
          try {
            const rr = await fetch(`${API}/customers/${cid}/googleAds:searchStream`, {
              method: 'POST', headers, body: JSON.stringify({ query }),
            });
            const bb = await readBody(rr);
            if (!rr.ok || !bb.ok) return;
            (Array.isArray(bb.json) ? bb.json : [bb.json]).forEach((chunk) =>
              (chunk.results || []).forEach((x) => out.push({
                id: String(x.campaign.id),
                name: x.campaign.name,
                status: x.campaign.status,
                customerId: String((x.customer && x.customer.id) || cid),
                customerName: (x.customer && x.customer.descriptiveName) || `계정 ${cid}`,
              })));
          } catch (e) { /* 접근 불가 계정은 건너뜀 */ }
        }));
        if (stopWhenFound && out.length > 0) break;
      }
      return out;
    }

    // 계정을 고르지 않고, 이름 조각으로 모든 계정에서 캠페인을 찾는다
    if (type === 'findcampaigns') {
      const terms = String(req.query.q || '').split('|').map((x) => x.trim()).filter(Boolean);
      if (terms.length === 0) return res.status(400).json({ error: '검색어(q)가 필요합니다' });
      const where = terms.map((t2) => `campaign.name LIKE '%${t2.replace(/'/g, "")}%'`).join(' AND ');
      // status=all 이면 일시중지 캠페인도 포함 (새로 만든 캠페인은 PAUSED 로 생성된다)
      const statusCond = req.query.status === 'all' ? "campaign.status != 'REMOVED'" : "campaign.status = 'ENABLED'";
      const query =
        'SELECT campaign.id, campaign.name, campaign.status, customer.id, customer.descriptive_name ' +
        `FROM campaign WHERE ${statusCond} AND ${where} ORDER BY campaign.id DESC LIMIT 100`;
      try { return res.status(200).json(await searchCampaignsEverywhere(query, false)); }
      catch (e) { return res.status(e.http || 500).json({ error: e.message, apiVersion: V }); }
    }

    // 캠페인 ID 하나로 어느 계정의 캠페인인지 찾는다 (HTML에서 ID를 직접 입력했을 때)
    //   결과 모양은 findcampaigns 와 같다 (0개 또는 1개)
    if (type === 'campaign') {
      const id = String(req.query.campaignId || '').replace(/[^0-9]/g, '');
      if (!id) return res.status(400).json({ error: 'campaignId가 필요합니다' });
      const query =
        'SELECT campaign.id, campaign.name, campaign.status, customer.id, customer.descriptive_name ' +
        `FROM campaign WHERE campaign.id = ${Number(id)} AND campaign.status != 'REMOVED' LIMIT 1`;
      try { return res.status(200).json((await searchCampaignsEverywhere(query, true)).slice(0, 1)); }
      catch (e) { return res.status(e.http || 500).json({ error: e.message, apiVersion: V }); }
    }

    if (type === 'accounts') {
      const r = await fetch(`${API}/customers:listAccessibleCustomers`, { headers });
      const body = await readBody(r);
      if (!r.ok || !body.ok) return res.status(r.status || 500).json({ error: gadsError(body, r), apiVersion: V });
      const ids = (body.json.resourceNames || []).map((n) => n.split('/').pop());
      const out = [];
      for (const id of ids.slice(0, 50)) {
        try {
          const rr = await fetch(`${API}/customers/${id}/googleAds:searchStream`, {
            method: 'POST', headers,
            body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' }),
          });
          const bb = await readBody(rr);
          const first = bb.ok ? (Array.isArray(bb.json) ? bb.json : [bb.json])[0] : null;
          const c = first && first.results && first.results[0] && first.results[0].customer;
          out.push({ id, name: (c && c.descriptiveName) || `계정 ${id}`, status: '' });
        } catch (e) {
          out.push({ id, name: `계정 ${id}`, status: '' });
        }
      }
      return res.status(200).json(out);
    }

    if (type === 'geo') {
      const r = await fetch(`${API}/geoTargetConstants:suggest`, {
        method: 'POST', headers,
        body: JSON.stringify({ locale: 'ko', countryCode: 'KR', locationNames: { names: [req.query.q || ''] } }),
      });
      const body = await readBody(r);
      if (!r.ok || !body.ok) return res.status(r.status || 500).json({ error: gadsError(body, r), apiVersion: V });
      const out = (body.json.geoTargetConstantSuggestions || []).map((s) => {
        const g = s.geoTargetConstant || {};
        return { id: String(g.id || (g.resourceName || '').split('/').pop()), name: g.name || '', status: g.targetType || '', canonical: g.canonicalName || '' };
      });
      return res.status(200).json(out);
    }

    const build = QUERIES[type];
    if (!build) return res.status(400).json({ error: `알 수 없는 type: ${type}` });
    const cid = String(customerId).replace(/[^0-9]/g, '');
    if (!cid) return res.status(400).json({ error: 'customerId가 필요합니다' });

    const r = await fetch(`${API}/customers/${cid}/googleAds:searchStream`, {
      method: 'POST', headers,
      body: JSON.stringify({ query: build({ campaignId, adGroupId }) }),
    });
    const body = await readBody(r);
    if (!r.ok || !body.ok) return res.status(r.status || 500).json({ error: gadsError(body, r), apiVersion: V });
    const rows = [];
    (Array.isArray(body.json) ? body.json : [body.json]).forEach((chunk) => (chunk.results || []).forEach((x) => rows.push(x)));
    return res.status(200).json(normalize(type, rows));
  } catch (e) {
    return res.status(500).json({ error: e.message, tried: e.tried });
  }
};
