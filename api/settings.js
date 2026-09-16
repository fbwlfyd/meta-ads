/**
 * Vercel 서버리스 함수 — 공유 설정 저장소 (관리자가 저장한 설정을 모두에게)
 *
 * 배치 위치 : 지금 HTML이 올라가 있는 그 프로젝트 안에  api/settings.js
 * 저장 위치 : GitHub 저장소의 settings.json (커밋으로 저장 → Vercel이 자동 재배포 → /settings.json 으로 모두가 받음)
 *
 * Vercel 환경변수 (Settings → Environment Variables) — 세 개 넣고 Redeploy
 *   GITHUB_TOKEN         GitHub 개인 액세스 토큰 (저장소 Contents: Read and write)
 *   GITHUB_REPO          owner/repo 형태 (예: hong/meta-ads)
 *   SETTINGS_ADMIN_KEY   관리자 키 (아무 문자열 — 페이지의 "모두에게 적용"에서 입력)
 *   GITHUB_BRANCH        선택 (기본 main)
 *
 * 호출
 *   GET  /api/settings   → 저장된 settings.json 내용 (없으면 404, 환경변수 없으면 501)
 *   POST /api/settings   → 헤더 x-admin-key 가 맞으면 settings.json 을 커밋 (본문 = 설정 JSON)
 */
const REPO = process.env.GITHUB_REPO || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const ADMIN_KEY = process.env.SETTINGS_ADMIN_KEY || '';
const FILE_PATH = process.env.SETTINGS_PATH || 'settings.json';

const gh = () => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'adtool-settings',
});
const contentsUrl = () => `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

async function readCurrent() {
  const r = await fetch(`${contentsUrl()}?ref=${encodeURIComponent(BRANCH)}`, { headers: gh() });
  if (r.status === 404) return { sha: null, text: '' };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub 읽기 실패 (HTTP ${r.status}): ${j.message || ''}`);
  const text = Buffer.from(String(j.content || ''), 'base64').toString('utf8');
  return { sha: j.sha || null, text };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REPO || !TOKEN) {
    return res.status(501).json({ error: '공유 설정 저장소가 아직 설정되지 않았어요 — Vercel 환경변수 GITHUB_TOKEN · GITHUB_REPO · SETTINGS_ADMIN_KEY 를 넣고 재배포하세요', configured: false });
  }

  try {
    if (req.method === 'GET') {
      const cur = await readCurrent();
      if (!cur.sha) return res.status(404).json({ error: '아직 저장된 공유 설정이 없어요' });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(cur.text);
    }

    if (req.method === 'POST') {
      if (!ADMIN_KEY) return res.status(501).json({ error: 'SETTINGS_ADMIN_KEY 환경변수가 없어요' });
      const key = String(req.headers['x-admin-key'] || (req.body && req.body.adminKey) || '');
      if (key !== ADMIN_KEY) return res.status(401).json({ error: '관리자 키가 맞지 않아요' });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== 'object' || (!body.meta && !body.google)) return res.status(400).json({ error: '설정 내용이 비어 있어요' });
      const payload = { version: body.version || 1, updatedAt: body.updatedAt || new Date().toISOString(), updatedBy: body.updatedBy || '관리자', meta: body.meta || {}, google: body.google || {} };
      const text = JSON.stringify(payload, null, 2);
      const cur = await readCurrent();
      const put = await fetch(contentsUrl(), {
        method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, gh()),
        body: JSON.stringify({
          message: `공유 설정 저장 (${payload.updatedBy}, ${payload.updatedAt})`,
          content: Buffer.from(text, 'utf8').toString('base64'),
          branch: BRANCH,
          ...(cur.sha ? { sha: cur.sha } : {}),
        }),
      });
      const pj = await put.json().catch(() => ({}));
      if (!put.ok) return res.status(put.status).json({ error: `GitHub 저장 실패 (HTTP ${put.status}): ${pj.message || ''}` });
      return res.status(200).json({ ok: true, updatedAt: payload.updatedAt, commit: pj.commit && pj.commit.sha });
    }

    return res.status(405).json({ error: 'GET 또는 POST 만 됩니다' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
