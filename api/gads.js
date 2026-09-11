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
 */

const API = 'https://googleads.googleapis.com/v18';

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
  audiences: () =>
    "SELECT user_list.id, user_list.name FROM user_list " +
    "WHERE user_list.membership_status = 'OPEN' LIMIT 200",
};

// Google Ads 응답에서 {id, name, status} 만 뽑아낸다
function normalize(type, rows) {
  return rows.map((r) => {
    if (type === 'campaigns') return { id: String(r.campaign.id), name: r.campaign.name, status: r.campaign.status };
    if (type === 'adgroups') return { id: String(r.adGroup.id), name: r.adGroup.name, status: r.adGroup.status };
    if (type === 'ads') return { id: String(r.adGroupAd.ad.id), name: r.adGroupAd.ad.name || '(이름 없음)', status: r.adGroupAd.status };
    if (type === 'audiences') return { id: String(r.userList.id), name: r.userList.name, status: '' };
    return null;
  }).filter(Boolean);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) {
    return res.status(500).json({ error: 'GOOGLE_ADS_DEVELOPER_TOKEN 환경변수가 없습니다' });
  }
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: '로그인 토큰이 없습니다 (Authorization 헤더 필요)' });
  }

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
    // 접근 가능한 계정 목록
    if (type === 'accounts') {
      const r = await fetch(`${API}/customers:listAccessibleCustomers`, { headers });
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'Google Ads 오류', detail: j });
      const ids = (j.resourceNames || []).map((n) => n.split('/').pop());
      const out = [];
      for (const id of ids.slice(0, 50)) {
        try {
          const rr = await fetch(`${API}/customers/${id}/googleAds:searchStream`, {
            method: 'POST', headers,
            body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' }),
          });
          const jj = await rr.json();
          const first = (Array.isArray(jj) ? jj : [jj])[0];
          const c = first && first.results && first.results[0] && first.results[0].customer;
          out.push({ id, name: (c && c.descriptiveName) || `계정 ${id}`, status: '' });
        } catch (e) {
          out.push({ id, name: `계정 ${id}`, status: '' });
        }
      }
      return res.status(200).json(out);
    }

    // 지역 검색
    if (type === 'geo') {
      const r = await fetch(`${API}/geoTargetConstants:suggest`, {
        method: 'POST', headers,
        body: JSON.stringify({ locale: 'ko', countryCode: 'KR', locationNames: { names: [req.query.q || ''] } }),
      });
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'Google Ads 오류', detail: j });
      const out = (j.geoTargetConstantSuggestions || []).map((s) => {
        const g = s.geoTargetConstant || {};
        return { id: String(g.id || (g.resourceName || '').split('/').pop()), name: g.name || '', status: g.targetType || '' };
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
    const j = await r.json();
    if (!r.ok) {
      const d = j.error || (Array.isArray(j) && j[0] && j[0].error) || {};
      return res.status(r.status).json({ error: d.message || 'Google Ads 오류', detail: j });
    }
    const rows = [];
    (Array.isArray(j) ? j : [j]).forEach((chunk) => (chunk.results || []).forEach((x) => rows.push(x)));
    return res.status(200).json(normalize(type, rows));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
