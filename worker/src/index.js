// api.awesomeprojects.tech: the panel's backend (a Cloudflare Worker, no dependencies).
//
//   GET  /auth/login?return=/me/     → GitHub sign-in (identity only: no scopes, no access to your account)
//   GET  /auth/callback              → back to the site with a signed session in the URL fragment
//   GET  /api/me                     → who you are and your role
//   POST /api/action                 → queue an action for the bot (private: a repository_dispatch, no comment)
//   GET  /api/status/:id             → how that action went
//   GET  /api/queue                  → open requests/reports/PRs + live config (maintainers)
//   GET  /api/audit                  → the private audit log (maintainers)
//   POST /bot/result                 → the bot reports back (shared secret)
//
// Sessions are bearer tokens kept by the page, never cookies: every *.awesomeprojects.tech site is
// "same-site" with this API, so a cookie could be ridden by someone's subdomain. A bearer token can't.
//
// Env: REPO, SITE_ORIGIN, EXTRA_ORIGINS (optional, comma-separated), GITHUB_CLIENT_ID,
//      GITHUB_CLIENT_SECRET, DISPATCH_TOKEN, SESSION_SECRET, BOT_SECRET; KV binding PANEL.

const enc = new TextEncoder();
const dec = new TextDecoder();
const SESSION_HOURS = 12;
const RATE = { max: 40, windowSec: 600 };

// ── Signing ─────────────────────────────────────────────────────
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function sign(obj, secret) {
  const body = b64url(enc.encode(JSON.stringify(obj)));
  return `${body}.${await hmac(secret, body)}`;
}
export async function verify(token, secret, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEqual(await hmac(secret, body), sig)) return null;
  try {
    const obj = JSON.parse(dec.decode(fromB64url(body)));
    return obj && typeof obj.exp === 'number' && obj.exp > now ? obj : null;
  } catch { return null; }
}

// ── Actions: structured in, command out (never raw text from the browser) ──
const USER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const NAME = /^[a-z0-9_](?:[a-z0-9._-]{0,180}[a-z0-9])?$/;
const LABEL = /^_?[a-z0-9](?:[a-z0-9._-]{0,120}[a-z0-9])?$/;
const clean = (s, max = 300) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const user = (s) => { const u = clean(s, 40).replace(/^@/, ''); if (!USER.test(u)) throw new Error('That isn\'t a GitHub username.'); return u; };
const name = (s) => { const n = clean(s, 190).toLowerCase(); if (!NAME.test(n)) throw new Error('That isn\'t a valid name.'); return n; };
const issueNo = (n) => { const x = Number(n); if (!Number.isInteger(x) || x < 1) throw new Error('Missing the request number.'); return x; };
const opt = (s) => (clean(s) ? ` ${clean(s)}` : '');

/** role: 'user' | 'maintainer' | 'owner'. Returns { command, target } or { update } for the bot. */
export const ACTIONS = {
  // Everyone (the bot checks they own the name)
  verify: { role: 'user', build: (a) => ({ command: `/verify ${name(a.name)}` }) },
  whois: { role: 'user', build: (a) => ({ command: `/whois ${name(a.name)}` }) },
  txt: {
    role: 'user',
    build: (a) => {
      const label = clean(a.label, 120).toLowerCase();
      if (!LABEL.test(label)) throw new Error('That isn\'t a valid record label (e.g. _vercel).');
      const value = clean(a.value, 255);
      if (!value) throw new Error('The TXT value is empty.');
      return { command: `/txt ${name(a.name)} ${label} "${value.replace(/"/g, '')}"` };
    },
  },
  remove: { role: 'user', build: (a) => ({ command: `/remove ${name(a.name)}` }) },
  update: {
    role: 'user',
    build: (a) => ({
      update: {
        name: name(a.name),
        provider: clean(a.provider, 60),
        repo: clean(a.repo, 140),
        target: clean(a.target, 300),
        description: clean(a.description, 200),
      },
    }),
  },
  // Maintainers
  approve: { role: 'maintainer', build: (a) => ({ command: '/approve', target: issueNo(a.number) }) },
  reject: { role: 'maintainer', build: (a) => ({ command: `/reject${opt(a.reason)}`, target: issueNo(a.number) }) },
  hold: { role: 'maintainer', build: (a) => ({ command: `/hold${opt(a.reason)}`, target: issueNo(a.number) }) },
  unhold: { role: 'maintainer', build: (a) => ({ command: '/unhold', target: issueNo(a.number) }) },
  recheck: { role: 'maintainer', build: (a) => ({ command: '/recheck', target: issueNo(a.number) }) },
  dismiss: { role: 'maintainer', build: (a) => ({ command: `/dismiss${opt(a.reason)}`, target: issueNo(a.number) }) },
  takedown: {
    role: 'maintainer',
    build: (a) => (a.number ? { command: `/takedown${opt(a.reason)}`, target: issueNo(a.number) } : { command: `/takedown ${name(a.name)}${opt(a.reason)}` }),
  },
  ban: { role: 'maintainer', build: (a) => ({ command: `/ban @${user(a.user)}${opt(a.reason)}` }) },
  unban: { role: 'maintainer', build: (a) => ({ command: `/unban @${user(a.user)}` }) },
  limit: {
    role: 'maintainer',
    build: (a) => {
      const n = Number(a.n);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('The limit must be 0–100.');
      return { command: `/limit @${user(a.user)} ${n}` };
    },
  },
  reserve: { role: 'maintainer', build: (a) => ({ command: `/reserve ${name(a.name)}` }) },
  unreserve: { role: 'maintainer', build: (a) => ({ command: `/unreserve ${name(a.name)}` }) },
  lock: { role: 'maintainer', build: (a) => ({ command: `/lock${opt(a.reason)}` }) },
  unlock: { role: 'maintainer', build: () => ({ command: '/unlock' }) },
  deploy: { role: 'maintainer', build: () => ({ command: '/deploy' }) },
  health: { role: 'maintainer', build: () => ({ command: '/health' }) },
  // Owner
  promote: { role: 'owner', build: (a) => ({ command: `/promote @${user(a.user)}` }) },
  demote: { role: 'owner', build: (a) => ({ command: `/demote @${user(a.user)}` }) },
};
const RANK = { user: 0, maintainer: 1, owner: 2 };

// ── HTTP helpers ────────────────────────────────────────────────
function origins(env) {
  return [env.SITE_ORIGIN, ...String(env.EXTRA_ORIGINS || '').split(',')].map((s) => s.trim()).filter(Boolean);
}
function cors(req, env) {
  const o = req.headers.get('Origin');
  if (!o || !origins(env).includes(o)) return {};
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
const json = (req, env, data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req, env) },
});
const fail = (req, env, status, error) => json(req, env, { error }, status);

function gh(env, path, init = {}) {
  return fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      'User-Agent': 'awesomeprojects-panel',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(env.DISPATCH_TOKEN ? { Authorization: `Bearer ${env.DISPATCH_TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
}
async function repoJson(env, file) {
  const r = await gh(env, `/repos/${env.REPO}/contents/${file}?ref=main`);
  if (!r.ok) throw new Error(`couldn't read ${file} (${r.status})`);
  const d = await r.json();
  return JSON.parse(dec.decode(Uint8Array.from(atob(d.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))));
}

let configCache = { at: 0, value: null };
async function config(env, now = Date.now()) {
  if (configCache.value && now - configCache.at < 30000) return configCache.value;
  configCache = { at: now, value: await repoJson(env, 'config.json') };
  return configCache.value;
}
export async function roleOf(login, env) {
  const owner = env.REPO.split('/')[0].toLowerCase();
  const l = String(login).toLowerCase();
  if (l === owner) return 'owner';
  const c = await config(env);
  return (c.maintainers || []).map((m) => m.toLowerCase()).includes(l) ? 'maintainer' : 'user';
}

async function session(req, env) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? verify(h.slice(7), env.SESSION_SECRET) : null;
}

const newId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
const auditKey = (now, id) => `audit:${String(1e13 - now).padStart(13, '0')}:${id}`;

// ── Routes ──────────────────────────────────────────────────────
async function login(req, env, url) {
  const ret = url.searchParams.get('return') || '/me/';
  if (!ret.startsWith('/') || ret.startsWith('//')) return new Response('bad return path', { status: 400 });
  const state = await sign({ r: ret, n: newId(), exp: Date.now() + 10 * 60 * 1000 }, env.SESSION_SECRET);
  const to = new URL('https://github.com/login/oauth/authorize');
  to.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  to.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  to.searchParams.set('state', state);
  to.searchParams.set('allow_signup', 'false');
  return Response.redirect(to.toString(), 302);
}

async function callback(req, env, url) {
  const st = await verify(url.searchParams.get('state'), env.SESSION_SECRET);
  const code = url.searchParams.get('code');
  if (!st || !code) return new Response('Sign-in expired. Go back and try again.', { status: 400 });
  const tok = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'awesomeprojects-panel' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/callback` }),
  }).then((r) => r.json());
  if (!tok.access_token) return new Response('GitHub didn\'t sign you in. Go back and try again.', { status: 400 });
  const me = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'awesomeprojects-panel', Accept: 'application/vnd.github+json' },
  }).then((r) => r.json());
  // We only needed to know who you are: GitHub's token isn't kept.
  if (!me || !me.login) return new Response('Couldn\'t read your GitHub profile.', { status: 400 });
  const s = await sign({ login: me.login, id: me.id, avatar: me.avatar_url, exp: Date.now() + SESSION_HOURS * 3600e3 }, env.SESSION_SECRET);
  return Response.redirect(`${env.SITE_ORIGIN}${st.r}#session=${encodeURIComponent(s)}`, 302);
}

async function action(req, env, s) {
  let body;
  try { body = await req.json(); } catch { return fail(req, env, 400, 'Send JSON.'); }
  const def = ACTIONS[body && body.action];
  if (!def) return fail(req, env, 400, 'Unknown action.');
  const role = await roleOf(s.login, env);
  if (RANK[role] < RANK[def.role]) return fail(req, env, 403, def.role === 'owner' ? 'Only the owner can do that.' : 'Only maintainers can do that.');
  let built;
  try { built = def.build(body.args || {}); } catch (e) { return fail(req, env, 400, e.message); }

  // Rate limit per person.
  const now = Date.now();
  const rk = `rl:${s.login.toLowerCase()}:${Math.floor(now / 1000 / RATE.windowSec)}`;
  const used = Number(await env.PANEL.get(rk)) || 0;
  if (used >= RATE.max) return fail(req, env, 429, 'Slow down a little: try again in a few minutes.');
  await env.PANEL.put(rk, String(used + 1), { expirationTtl: RATE.windowSec * 2 });

  const id = newId();
  const summary = built.update ? `update ${built.update.name}` : `${built.command}${built.target ? ` on #${built.target}` : ''}`;
  const key = auditKey(now, id);
  const job = { id, actor: s.login, role, action: body.action, summary, state: 'queued', at: now, auditKey: key };
  await env.PANEL.put(`job:${id}`, JSON.stringify(job), { expirationTtl: 7 * 86400 });
  await env.PANEL.put(key, '', { metadata: { at: now, actor: s.login, role, summary, state: 'queued' } });

  const r = await gh(env, `/repos/${env.REPO}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'panel', client_payload: { id, actor: s.login, ...built } }),
  });
  if (!r.ok) {
    const msg = `GitHub refused the action (${r.status}).`;
    await env.PANEL.put(`job:${id}`, JSON.stringify({ ...job, state: 'error', message: msg }), { expirationTtl: 7 * 86400 });
    await env.PANEL.put(key, '', { metadata: { at: now, actor: s.login, role, summary, state: 'error' } });
    return fail(req, env, 502, msg);
  }
  return json(req, env, { id, summary });
}

async function status(req, env, s, id) {
  const raw = await env.PANEL.get(`job:${id}`);
  if (!raw) return fail(req, env, 404, 'Not found.');
  const job = JSON.parse(raw);
  if (job.actor.toLowerCase() !== s.login.toLowerCase() && RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 404, 'Not found.');
  return json(req, env, job);
}

async function botResult(req, env) {
  const h = req.headers.get('Authorization') || '';
  if (!env.BOT_SECRET || !safeEqual(h, `Bearer ${env.BOT_SECRET}`)) return new Response('no', { status: 401 });
  const { id, ok, message, link } = await req.json();
  const raw = await env.PANEL.get(`job:${id}`);
  if (!raw) return new Response('unknown job', { status: 404 });
  const job = { ...JSON.parse(raw), state: ok ? 'done' : 'error', message: String(message || '').slice(0, 8000), link: link || null, doneAt: Date.now() };
  await env.PANEL.put(`job:${id}`, JSON.stringify(job), { expirationTtl: 7 * 86400 });
  const short = String(message || '').replace(/[#*`>|_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  await env.PANEL.put(job.auditKey, '', { metadata: { at: job.at, actor: job.actor, role: job.role, summary: job.summary, state: job.state, result: short, link: job.link } });
  return new Response('ok');
}

async function audit(req, env, s, url) {
  if (RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 403, 'Only maintainers can read the audit log.');
  const list = await env.PANEL.list({ prefix: 'audit:', limit: Math.min(Number(url.searchParams.get('limit')) || 100, 500), cursor: url.searchParams.get('cursor') || undefined });
  return json(req, env, { entries: list.keys.map((k) => k.metadata).filter(Boolean), cursor: list.list_complete ? null : list.cursor });
}

let queueCache = { at: 0, value: null };
async function queue(req, env, s) {
  if (RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 403, 'Only maintainers can see the queue.');
  const now = Date.now();
  if (!queueCache.value || now - queueCache.at > 15000) {
    const items = [];
    for (let page = 1; page < 6; page++) {
      const r = await gh(env, `/repos/${env.REPO}/issues?state=open&per_page=100&page=${page}`);
      if (!r.ok) return fail(req, env, 502, `GitHub said ${r.status}`);
      const d = await r.json();
      items.push(...d.map((i) => ({
        number: i.number, title: i.title, html_url: i.html_url, user: { login: i.user.login }, created_at: i.created_at,
        comments: i.comments, labels: i.labels.map((l) => l.name), body: String(i.body || '').slice(0, 2000), pull_request: !!i.pull_request,
      })));
      if (d.length < 100) break;
    }
    queueCache = { at: now, value: { items, config: await config(env, now), reserved: await repoJson(env, 'reserved.json') } };
  }
  return json(req, env, queueCache.value);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    try {
      if (url.pathname === '/' || url.pathname === '/health') return json(req, env, { ok: true, repo: env.REPO });
      if (url.pathname === '/auth/login' && req.method === 'GET') return login(req, env, url);
      if (url.pathname === '/auth/callback' && req.method === 'GET') return callback(req, env, url);
      if (url.pathname === '/bot/result' && req.method === 'POST') return botResult(req, env);
      if (url.pathname.startsWith('/api/')) {
        // State-changing calls must come from the site itself.
        if (req.method === 'POST' && !origins(env).includes(req.headers.get('Origin'))) return fail(req, env, 403, 'Wrong origin.');
        const s = await session(req, env);
        if (!s) return fail(req, env, 401, 'Sign in again.');
        if (url.pathname === '/api/me' && req.method === 'GET') return json(req, env, { login: s.login, avatar: s.avatar, role: await roleOf(s.login, env) });
        if (url.pathname === '/api/action' && req.method === 'POST') return action(req, env, s);
        if (url.pathname.startsWith('/api/status/') && req.method === 'GET') return status(req, env, s, url.pathname.slice(12));
        if (url.pathname === '/api/queue' && req.method === 'GET') return queue(req, env, s);
        if (url.pathname === '/api/audit' && req.method === 'GET') return audit(req, env, s, url);
      }
      return fail(req, env, 404, 'Not found.');
    } catch (e) {
      return fail(req, env, 500, `Something broke: ${e.message}`);
    }
  },
};
