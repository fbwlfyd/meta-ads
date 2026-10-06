/**
 * Vercel 서버리스 함수 — 공유 설정 저장소 (관리자가 저장한 설정을 모두에게)
 *
 * 배치 위치 : 지금 HTML이 올라가 있는 그 프로젝트 안에  api/settings.js  (+ api/_auth.js 가 같이 있어야 한다)
 * 저장 위치 : GitHub 저장소의 settings.json (커밋으로 저장 → Vercel이 자동 재배포)
 *
 * 2026-10-06.1 — 읽기도 로그인한 사람만 (로그인 창의 제작자 세션 · 또는 허용된 구글 계정)
 *   · 예전엔 주소만 알면 누구나 /api/settings · /settings.json 으로 계정명·담당자·치과 목록을 볼 수 있었다
 *   · 페이지는 구글 로그인 토큰을 Authorization: Bearer 로 보내고, 여기서 확인한 뒤에만 내준다
 *   · vercel.json 의 redirects 가 /settings.json 요청도 이 함수로 보낸다 → 정적 파일도 그냥은 못 본다
 *   · GitHub 저장소 설정(환경변수)이 없으면 배포에 포함된 settings.json 을 읽어 준다 (vercel.json functions.includeFiles)
 *
 * Vercel 환경변수 (Settings → Environment Variables) — 넣고 Redeploy
 *   ALLOWED_EMAILS       선택 · 구글 계정으로도 들어올 수 있는 사람 (쉼표로 구분) — api/_auth.js 참고
 *   GITHUB_TOKEN         GitHub 개인 액세스 토큰 (저장소 Contents: Read and write)
 *   GITHUB_REPO          owner/repo 형태 (예: hong/meta-ads)
 *   SETTINGS_ADMIN_KEY   관리자 키 (아무 문자열 — 페이지의 "모두에게 적용"에서 입력)
 *   GITHUB_BRANCH        선택 (기본 main)
 *
 * 호출
 *   GET  /api/settings?ping=1 → 배포 확인 (로그인 없이)
 *   GET  /api/settings        → 저장된 settings.json 내용 (허용 계정만 · 없으면 404)
 *   POST /api/settings        → 허용 계정 + 헤더 x-admin-key 가 맞으면 settings.json 을 커밋 (본문 = 설정 JSON)
 */
const fs = require('fs');
const path = require('path');
const { verifyUser, noStore } = require('./_auth');

const BUILD = '2026-10-06.1';
const REPO = process.env.GITHUB_REPO || '';
const TOKEN = String(process.env.GITHUB_TOKEN || '').trim().split(/\s+/)[0] || '';
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

/* 배포에 같이 올라간 settings.json (GitHub API 를 안 쓰고 파일만 올려 두는 방식일 때) */
function readBundled() {
  const cands = [path.join(process.cwd(), FILE_PATH), path.join(__dirname, '..', FILE_PATH), path.join(__dirname, FILE_PATH)];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (e) { /* 다음 후보 */ }
  }
  return '';
}

function sendJsonText(res, text) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).send(text);
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  if (q.ping) {
    return res.status(200).json({
      ok: true, build: BUILD,
      configured: !!(REPO && TOKEN), adminKeySet: !!ADMIN_KEY,
      allowlistSet: !!(process.env.ALLOWED_EMAILS || process.env.ALLOWED_DOMAINS),
      bundledFile: !!readBundled(),
    });
  }

  try {
    if (req.method === 'GET') {
      const who = await verifyUser(req);
      if (!who.ok) return res.status(who.status).json({ error: who.error, needLogin: true, sessionInvalid: !!who.sessionInvalid });
      if (REPO && TOKEN) {
        const cur = await readCurrent();
        if (cur.sha && cur.text) return sendJsonText(res, cur.text);
      }
      const bundled = readBundled();
      if (bundled) return sendJsonText(res, bundled);
      return res.status(404).json({ error: '아직 저장된 공유 설정이 없어요' });
    }

    if (req.method === 'POST') {
      if (!REPO || !TOKEN) {
        // 저장소 설정이 없으면 페이지가 settings.json 파일을 내려받아 GitHub 에 올리는 방식으로 넘어간다
        return res.status(501).json({ error: '공유 설정 저장소가 아직 설정되지 않았어요 — Vercel 환경변수 GITHUB_TOKEN · GITHUB_REPO · SETTINGS_ADMIN_KEY 를 넣고 재배포하세요', configured: false });
      }
      if (!ADMIN_KEY) return res.status(501).json({ error: 'SETTINGS_ADMIN_KEY 환경변수가 없어요' });
      const who = await verifyUser(req);
      if (!who.ok) return res.status(who.status).json({ error: who.error, needLogin: true, sessionInvalid: !!who.sessionInvalid });
      const key = String(req.headers['x-admin-key'] || (req.body && req.body.adminKey) || '');
      if (key !== ADMIN_KEY) return res.status(401).json({ error: '관리자 키가 맞지 않아요' });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== 'object' || (!body.meta && !body.google)) return res.status(400).json({ error: '설정 내용이 비어 있어요' });
      const payload = { version: body.version || 1, updatedAt: body.updatedAt || new Date().toISOString(), updatedBy: body.updatedBy || who.label || '관리자', meta: body.meta || {}, google: body.google || {} };
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
