// api.awesomeprojects.tech: the panel's backend (a Cloudflare Worker, no dependencies).
//
//   GET  /auth/login?return=/me/     → GitHub sign-in (identity only: no scopes, no access to your account)
//   GET  /auth/callback              → back to the site with a signed session in the URL fragment
//   GET  /api/me                     → who you are and your role
//   POST /api/action                 → queue an action for the bot (private: a repository_dispatch, no comment)
//   GET  /api/status/:id             → how that action went
//   GET  /api/queue                  → open requests/reports/PRs + live config (maintainers)
//   GET  /api/audit                  → the private audit log (maintainers)
//   GET  /api/stats                  → numbers for the admin overview (maintainers)
//   *    /api/requests[/:id[/…]]     → private requests: create, list, read, edit, cancel, note, decide
//   POST /bot/result                 → the bot reports an action's result (shared secret)
//   POST /bot/request                → the bot reports a request's review or go-live (shared secret)
//
// Sessions are bearer tokens kept by the page, never cookies: every *.awesomeprojects.tech site is
// "same-site" with this API, so a cookie could be ridden by someone's subdomain. A bearer token can't.
//
// Env: REPO, SITE_ORIGIN, EXTRA_ORIGINS (optional, comma-separated), GITHUB_CLIENT_ID,
//      GITHUB_CLIENT_SECRET, DISPATCH_TOKEN, SESSION_SECRET, BOT_SECRET; KV binding PANEL
//      (jobs, rate limits); D1 binding DB (requests, notes, audit: strongly consistent).

import { buildResponse, parseAuthnRequest, metadata, postForm } from './saml.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SESSION_HOURS = 12;
const RATE = { max: 40, windowSec: 600 };

// ── Signing ─────────────────────────────────────────────────────
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret).trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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
  // The DNS manager: set (or delete, records = null) one name's records. The bot checks ownership.
  records: {
    role: 'user',
    build: (a) => {
      const n = name(a.name);
      if (a.records === null) return { records: { name: n, records: null } };
      const r = a.records;
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Records must be an object.');
      const allowed = ['A', 'AAAA', 'CNAME', 'TXT', 'MX'];
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        if (!allowed.includes(k)) throw new Error(`${k} records aren't offered.`);
        if (JSON.stringify(v).length > 3000) throw new Error('That\'s too much data for one name.');
        out[k] = v;
      }
      if (!Object.keys(out).length) throw new Error('Add at least one record.');
      return { records: { name: n, records: out } };
    },
  },
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
  approve: { role: 'maintainer', build: (a) => ({ command: a.force ? '/approve force' : '/approve', target: issueNo(a.number) }) },
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
  // Hosted sites
  site: {
    role: 'maintainer',
    build: (a) => {
      const st = clean(a.status, 20).toLowerCase();
      if (!['active', 'locked', 'suspended', 'archived'].includes(st)) throw new Error('Status must be active, locked, suspended or archived.');
      return { command: `/site ${name(a.name)} ${st}` };
    },
  },
  'site-sync': { role: 'maintainer', build: (a) => ({ command: `/site-sync ${name(a.name)}` }) },
  'repo-access': {
    role: 'maintainer',
    build: (a) => {
      const lvl = clean(a.level, 20).toLowerCase();
      if (!['read', 'write', 'maintain', 'none'].includes(lvl)) throw new Error('Access must be read, write, maintain or none.');
      return { command: `/repo-access ${name(a.name)} @${user(a.user)} ${lvl}` };
    },
  },
  'emu-account': { role: 'user', build: () => ({ emu: { op: 'provision' } }) },
  'emu-suspend': { role: 'maintainer', build: (a) => ({ command: `/emu-suspend @${user(a.user)}` }) },
  'emu-restore': { role: 'maintainer', build: (a) => ({ command: `/emu-restore @${user(a.user)}` }) },
  'emu-create': { role: 'maintainer', build: (a) => ({ command: `/emu-create @${user(a.user)}` }) },
  redeploy: { role: 'user', build: (a) => ({ command: `/redeploy ${name(a.name)}` }) },
  'site-collab': {
    role: 'user',
    build: (a) => {
      const op = clean(a.op, 10).toLowerCase() || 'add';
      if (!['add', 'remove'].includes(op)) throw new Error('Add or remove.');
      return { command: `/site-collab ${name(a.name)} @${user(a.user)} ${op}` };
    },
  },
  create: {
    role: 'maintainer',
    build: (a) => ({
      create: {
        name: name(a.name), owner: user(a.owner), provider: clean(a.provider, 60), repo: clean(a.repo, 140),
        target: clean(a.target, 300), template: clean(a.template, 40), description: clean(a.description, 200), force: !!a.force,
      },
    }),
  },
  'make-repo': {
    role: 'maintainer',
    build: (a) => {
      const r = clean(a.repo, 100).toLowerCase();
      if (!/^[a-z0-9._-]{1,100}$/.test(r)) throw new Error('Repo names: letters, numbers, . _ -');
      return { command: `/make-repo ${r} @${user(a.user)} ${clean(a.template, 40) || 'html'}` };
    },
  },
  'suspend-user': { role: 'maintainer', build: (a) => ({ command: `/suspend-user @${user(a.user)}${opt(a.reason)}` }) },
  announce: { role: 'maintainer', build: (a) => ({ command: `/announce ${clean(a.text, 280) || 'off'}` }) },
  ops: { role: 'maintainer', build: () => ({ command: '/ops' }) },
  seats: { role: 'maintainer', build: () => ({ command: '/seats' }) },
  // Owner
  config: {
    role: 'owner',
    build: (a) => {
      const key = clean(a.key, 60);
      if (!/^[A-Za-z]+$/.test(key)) throw new Error('Unknown setting.');
      return { command: `/config ${key} ${clean(a.value, 2000)}` };
    },
  },
  'org-setup': { role: 'owner', build: () => ({ command: '/org-setup' }) },
  'bot-check': { role: 'owner', build: () => ({ command: '/bot-check' }) },
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
// ── SAML identity provider for the managed-user enterprise ─────
const samlIssuer = (env, url) => env.SAML_ISSUER || `${url.origin}/saml`;
const spEntity = (env) => `https://github.com/enterprises/${env.EMU_ENTERPRISE}`;
const spAcs = (env) => `${spEntity(env)}/saml/consume`;
function page(title, body, status = 200) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui;background:#0b1020;color:#e6ebff;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:34rem;padding:2rem">
<h1 style="font-size:1.4rem">${title}</h1>${body}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** GitHub sends people here to sign in (HTTP-Redirect or HTTP-POST binding). */
async function samlSso(req, env, url) {
  if (!env.EMU_ENTERPRISE || !env.SAML_PRIVATE_KEY || !env.SAML_CERT) return page('Not set up yet', '<p>Enterprise sign-in isn\'t switched on.</p>', 503);
  let samlRequest = url.searchParams.get('SAMLRequest');
  let relayState = url.searchParams.get('RelayState') || '';
  let deflated = true;
  if (req.method === 'POST') {
    const form = await req.formData();
    samlRequest = form.get('SAMLRequest');
    relayState = form.get('RelayState') || '';
    deflated = false;
  }
  let ar = { id: undefined, acs: spAcs(env), issuer: spEntity(env) };
  if (samlRequest) {
    try { ar = await parseAuthnRequest(samlRequest, { deflated }); } catch { return page('Bad sign-in request', '<p>Start again from GitHub.</p>', 400); }
  }
  // Only ever answer our own enterprise.
  if (ar.issuer && ar.issuer !== spEntity(env)) return page('Unknown service', '<p>This sign-in is only for our GitHub enterprise.</p>', 400);
  if (ar.acs && ar.acs !== spAcs(env)) return page('Unknown service', '<p>Unexpected return address.</p>', 400);
  const samlState = { id: ar.id || null, relay: String(relayState).slice(0, 1000) };
  return login(req, env, new URL(`${url.origin}/auth/login?return=/me/`), { saml: samlState });
}

/** After GitHub OAuth told us who this is: answer GitHub's SAML request for their managed account. */
async function samlFinish(env, saml, me) {
  if (!env.DB) return page('Not set up yet', '<p>Accounts aren\'t switched on.</p>', 503);
  const idn = await env.DB.prepare('SELECT * FROM identities WHERE personal_id = ?1').bind(me.id).first();
  if (!idn || idn.status !== 'active') {
    const why = !idn ? 'You don\'t have an enterprise account yet.' : idn.status === 'suspended' ? 'Your enterprise account is suspended.' : 'Your enterprise account isn\'t ready yet.';
    return page(why, `<p>Signed in as <b>@${me.login}</b>. ${idn && idn.status === 'suspended' ? 'Contact a maintainer.' : `Get one at <a style="color:#7aa8ff" href="${env.SITE_ORIGIN}/me/">My domains</a>, then come back.`}</p>`, 403);
  }
  const { xml } = await buildResponse({
    nameId: idn.user_name, acs: spAcs(env), audience: spEntity(env), issuer: env.SAML_ISSUER || 'https://api.awesomeprojects.tech/saml',
    inResponseTo: saml.id || undefined, attributes: { full_name: [me.name || me.login] },
    privateKey: env.SAML_PRIVATE_KEY, cert: env.SAML_CERT,
  });
  await auditWrite(env, { id: newId(), at: Date.now(), actor: me.login, role: 'user', summary: `enterprise sign-in as ${idn.managed_login || idn.user_name}`, state: 'done' });
  return new Response(postForm({ acs: spAcs(env), samlResponse: btoa(unescape(encodeURIComponent(xml))), relayState: saml.relay }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** The bot reports a managed account it created or changed. */
async function botIdentity(req, env) {
  const h = req.headers.get('Authorization') || '';
  const secret = String(env.BOT_SECRET || '').trim();
  if (!secret || !safeEqual(h.trim(), `Bearer ${secret}`)) return new Response('no', { status: 401 });
  const b = await req.json();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO identities (personal_id, personal_login, user_name, managed_login, scim_id, status, note, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
    ON CONFLICT(personal_id) DO UPDATE SET personal_login = excluded.personal_login, user_name = excluded.user_name, managed_login = COALESCE(excluded.managed_login, managed_login),
      scim_id = COALESCE(excluded.scim_id, scim_id), status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`)
    .bind(Number(b.personal_id), String(b.personal_login), String(b.user_name), b.managed_login || null, b.scim_id || null, String(b.status), b.note || null, now).run();
  return new Response('ok');
}
/** Your managed account (or, for maintainers, anyone's / everyone's). */
async function identityView(req, env, s, url) {
  if (!env.DB) return json(req, env, { identity: null, enabled: false });
  const enabled = !!(env.EMU_ENTERPRISE && env.SAML_CERT);
  const who = clean(url.searchParams.get('login'), 40).replace(/^@/, '');
  if (url.searchParams.get('all') === '1' || who) {
    if (RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 403, 'Maintainers only.');
    const rows = who
      ? (await env.DB.prepare('SELECT * FROM identities WHERE lower(personal_login) = lower(?1)').bind(who).all()).results
      : (await env.DB.prepare('SELECT * FROM identities ORDER BY updated_at DESC LIMIT 500').all()).results;
    return json(req, env, { identities: rows || [], enabled, enterprise: env.EMU_ENTERPRISE || null });
  }
  const idn = await env.DB.prepare('SELECT * FROM identities WHERE personal_id = ?1').bind(s.id).first();
  return json(req, env, { identity: idn || null, enabled, enterprise: env.EMU_ENTERPRISE || null, signIn: env.EMU_ENTERPRISE ? `https://github.com/enterprises/${env.EMU_ENTERPRISE}/sso` : null });
}

/** Tests only: forget cached config. */
export { sweep };
export function resetCaches() { configCache = { at: 0, value: null }; queueCache = { at: 0, value: null }; }

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
async function login(req, env, url, extra = {}) {
  const ret = url.searchParams.get('return') || '/me/';
  if (!ret.startsWith('/') || ret.startsWith('//')) return new Response('bad return path', { status: 400 });
  const state = await sign({ r: ret, n: newId(), exp: Date.now() + 10 * 60 * 1000, ...extra }, env.SESSION_SECRET);
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
  if (st.saml) return samlFinish(env, st.saml, me);
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
  const summary = built.emu ? 'get my enterprise account' : built.create ? `create ${built.create.name} for @${built.create.owner}${built.create.force ? ' (forced)' : ''}` : built.update ? `update ${built.update.name}` : built.records ? `records ${built.records.name}${built.records.records === null ? ' (delete)' : ''}` : `${built.command}${built.target ? ` on #${built.target}` : ''}`;
  const key = auditKey(now, id);
  const job = { id, actor: s.login, role, action: body.action, summary, state: 'queued', at: now, auditKey: key };
  await env.PANEL.put(`job:${id}`, JSON.stringify(job), { expirationTtl: 7 * 86400 });
  await auditWrite(env, { id, at: now, actor: s.login, role, summary, state: 'queued' });

  const r = await gh(env, `/repos/${env.REPO}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // at + summary come back with the result, so reporting never needs to read KV (which is only
    // eventually consistent between Cloudflare locations: the bot's report lands somewhere else).
    body: JSON.stringify({ event_type: 'panel', client_payload: { id, actor: s.login, actorId: s.id, at: now, summary, ...built } }),
  });
  if (!r.ok) {
    const msg = `GitHub refused the action (${r.status}).`;
    await env.PANEL.put(`job:${id}`, JSON.stringify({ ...job, state: 'error', message: msg }), { expirationTtl: 7 * 86400 });
    await auditWrite(env, { id, at: now, actor: s.login, role, summary, state: 'error', result: msg });
    return fail(req, env, 502, msg);
  }
  return json(req, env, { id, summary });
}

async function status(req, env, s, id) {
  const raw = await env.PANEL.get(`job:${id}`);
  if (!raw) return fail(req, env, 404, 'Not found.');
  const job = JSON.parse(raw);
  if (job.actor.toLowerCase() !== s.login.toLowerCase() && RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 404, 'Not found.');
  if (job.state !== 'queued') return json(req, env, job);
  const result = await env.PANEL.get(`result:${id}`, { cacheTtl: 30 });
  return json(req, env, result ? { ...job, ...JSON.parse(result) } : job);
}

/** The bot reports back. Write-only: the job may not be visible from this location yet. */
async function botResult(req, env) {
  const h = req.headers.get('Authorization') || '';
  const secret = String(env.BOT_SECRET || '').trim();
  if (!secret || !safeEqual(h.trim(), `Bearer ${secret}`)) return new Response('no', { status: 401 });
  const { id, ok, message, link, actor, summary, at } = await req.json();
  if (!id || typeof id !== 'string') return new Response('missing id', { status: 400 });
  const state = ok ? 'done' : 'error';
  const result = { state, message: String(message || '').slice(0, 8000), link: link || null, doneAt: Date.now() };
  await env.PANEL.put(`result:${id}`, JSON.stringify(result), { expirationTtl: 7 * 86400 });
  if (actor && Number.isFinite(at)) {
    const role = await roleOf(actor, env).catch(() => 'user');
    await auditWrite(env, { id, at, actor, role, summary: String(summary || '').slice(0, 200), state, result: shortText(message), link: result.link });
  }
  return new Response('ok');
}

const shortText = (m) => String(m || '').replace(/[#*`>|_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** The audit log: D1 when bound (searchable, consistent), KV otherwise. Upserts by id. */
async function auditWrite(env, a) {
  if (env.DB) {
    await env.DB.prepare(`INSERT INTO audit (id, at, actor, role, summary, state, result, link, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, result = excluded.result, link = excluded.link`)
      .bind(a.id, a.at, a.actor, a.role, a.summary, a.state, a.result || null, a.link || null, a.request || null).run();
    return;
  }
  await env.PANEL.put(auditKey(a.at, a.id), '', { metadata: a });
}

async function audit(req, env, s, url) {
  if (RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 403, 'Only maintainers can read the audit log.');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  if (env.DB) {
    const actor = clean(url.searchParams.get('actor'), 40).replace(/^@/, '');
    const q = clean(url.searchParams.get('q'), 100);
    const before = Number(url.searchParams.get('before')) || 9e15;
    const rows = await env.DB.prepare(`SELECT * FROM audit WHERE at < ?1 AND (?2 = '' OR lower(actor) = lower(?2)) AND (?3 = '' OR summary LIKE ?4 OR result LIKE ?4)
      ORDER BY at DESC LIMIT ?5`).bind(before, actor, q, `%${q}%`, limit).all();
    const entries = rows.results || [];
    return json(req, env, { entries, cursor: entries.length === limit ? entries[entries.length - 1].at : null });
  }
  const list = await env.PANEL.list({ prefix: 'audit:', limit, cursor: url.searchParams.get('cursor') || undefined });
  return json(req, env, { entries: list.keys.map((k) => k.metadata).filter(Boolean), cursor: list.list_complete ? null : list.cursor });
}

// ── Private requests ────────────────────────────────────────────
const OPEN_STATES = ['checking', 'ready', 'on-hold', 'needs-changes', 'approving'];
const MAX_OPEN_PER_PERSON = 5;

function cleanForm(a) {
  const n = name(a.name);
  if (n.includes('.')) throw new Error('Request a top-level name; add records under it from My domains afterwards.');
  return { name: n, provider: clean(a.provider, 80), template: clean(a.template, 40), repo: clean(a.repo, 140), target: clean(a.target, 300), description: clean(a.description, 200) };
}
const rowOut = (r, { full }) => ({
  id: r.id, name: r.name, requester: r.requester, state: r.state, manualHold: !!r.manual_hold, form: JSON.parse(r.form),
  review: r.review ? JSON.parse(r.review) : null, result: r.result ? JSON.parse(r.result) : null,
  decidedBy: r.decided_by, createdAt: r.created_at, updatedAt: r.updated_at, ...(full ? {} : {}),
});

async function dispatch(env, payload) {
  const r = await gh(env, `/repos/${env.REPO}/dispatches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'panel', client_payload: payload }),
  });
  if (!r.ok) throw new Error(`GitHub refused it (${r.status}).`);
}
async function rateLimit(env, login, now = Date.now()) {
  const rk = `rl:${login.toLowerCase()}:${Math.floor(now / 1000 / RATE.windowSec)}`;
  const used = Number(await env.PANEL.get(rk)) || 0;
  if (used >= RATE.max) throw Object.assign(new Error('Slow down a little: try again in a few minutes.'), { status: 429 });
  await env.PANEL.put(rk, String(used + 1), { expirationTtl: RATE.windowSec * 2 });
}
async function getRequest(env, id) {
  return env.DB.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first();
}
async function requestReview(env, row, form) {
  await dispatch(env, { kind: 'review', request: row.id, actor: row.requester, form, manualHold: !!row.manual_hold });
}

async function requests(req, env, s, url, parts) {
  if (!env.DB) return fail(req, env, 503, 'Requests aren\'t set up on the server yet.');
  const role = await roleOf(s.login, env);
  const isMaint = RANK[role] >= RANK.maintainer;
  const now = Date.now();
  const [, , , id, verb] = parts; // /api/requests/:id/:verb
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const audited = (summary, request) => auditWrite(env, { id: newId(), at: now, actor: s.login, role, summary, state: 'done', request });

  // List
  if (!id && req.method === 'GET') {
    const scope = url.searchParams.get('scope') === 'all' && isMaint ? 'all' : 'mine';
    const state = clean(url.searchParams.get('state'), 20);
    const rows = await env.DB.prepare(`SELECT * FROM requests WHERE (?1 = 'all' OR lower(requester) = lower(?2)) AND (?3 = '' OR state = ?3)
      ORDER BY updated_at DESC LIMIT 200`).bind(scope, s.login, state).all();
    return json(req, env, { requests: (rows.results || []).map((r) => rowOut(r, { full: false })) });
  }

  // Create
  if (!id && req.method === 'POST') {
    let form;
    try { form = cleanForm(body); } catch (e) { return fail(req, env, 400, e.message); }
    const cfg = await config(env);
    if (cfg.locked && !isMaint) return fail(req, env, 423, `Requests are paused${typeof cfg.locked === 'string' ? `: ${cfg.locked}` : ''}. Try again later.`);
    if ((cfg.bannedUsers || []).map((u) => u.toLowerCase()).includes(s.login.toLowerCase())) return fail(req, env, 403, 'This account can\'t request names.');
    try { await rateLimit(env, s.login, now); } catch (e) { return fail(req, env, e.status || 429, e.message); }
    const open = await env.DB.prepare(`SELECT id, name FROM requests WHERE lower(requester) = lower(?1) AND state IN ('checking','ready','on-hold','needs-changes','approving')`).bind(s.login).all();
    const mineOpen = open.results || [];
    if (mineOpen.some((r) => r.name === form.name)) return fail(req, env, 409, `You already have an open request for ${form.name}.`);
    if (mineOpen.length >= MAX_OPEN_PER_PERSON && !isMaint) return fail(req, env, 429, `You have ${mineOpen.length} open requests. Wait for those first.`);
    const row = { id: newId(), name: form.name, requester: s.login, form: JSON.stringify(form), state: 'checking', manual_hold: 0, created_at: now, updated_at: now };
    await env.DB.prepare('INSERT INTO requests (id, name, requester, form, state, manual_hold, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)')
      .bind(row.id, row.name, row.requester, row.form, row.state, now).run();
    await audited(`request ${form.name}`, row.id);
    try { await requestReview(env, row, form); } catch (e) { return fail(req, env, 502, e.message); }
    return json(req, env, { request: rowOut(row, { full: true }) });
  }

  const row = await getRequest(env, id);
  const mine = row && row.requester.toLowerCase() === s.login.toLowerCase();
  if (!row || (!mine && !isMaint)) return fail(req, env, 404, 'Not found.');

  // Read (with the conversation; internal notes for maintainers only)
  if (!verb && req.method === 'GET') {
    const notes = await env.DB.prepare(`SELECT author, body, internal, created_at FROM notes WHERE request_id = ?1 AND (?2 = 1 OR internal = 0) ORDER BY created_at`).bind(id, isMaint ? 1 : 0).all();
    const history = isMaint ? (await env.DB.prepare('SELECT at, actor, summary FROM audit WHERE request_id = ?1 ORDER BY at').bind(id).all()).results : undefined;
    return json(req, env, { request: rowOut(row, { full: true }), notes: notes.results || [], history });
  }
  if (req.method !== 'POST') return fail(req, env, 405, 'Use POST.');
  const closed = ['live', 'rejected', 'cancelled'].includes(row.state);

  if (verb === 'note') {
    const text = String(body.body || '').trim().slice(0, 4000);
    if (!text) return fail(req, env, 400, 'The note is empty.');
    const internal = isMaint && body.internal ? 1 : 0;
    await env.DB.prepare('INSERT INTO notes (request_id, author, body, internal, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, s.login, text, internal, now).run();
    await env.DB.prepare('UPDATE requests SET updated_at = ?2 WHERE id = ?1').bind(id, now).run();
    return json(req, env, { ok: true });
  }
  if (verb === 'edit') {
    if (!mine && !isMaint) return fail(req, env, 403, 'Only the requester can edit it.');
    if (closed || row.state === 'approving') return fail(req, env, 409, 'This request can\'t be changed any more.');
    let form;
    try { form = cleanForm({ ...JSON.parse(row.form), ...body, name: row.name }); } catch (e) { return fail(req, env, 400, e.message); }
    await env.DB.prepare(`UPDATE requests SET form = ?2, state = 'checking', review = NULL, updated_at = ?3 WHERE id = ?1`).bind(id, JSON.stringify(form), now).run();
    await audited(`edit request ${row.name}`, id);
    try { await requestReview(env, row, form); } catch (e) { return fail(req, env, 502, e.message); }
    return json(req, env, { ok: true });
  }
  if (verb === 'cancel') {
    if (!mine && !isMaint) return fail(req, env, 403, 'Only the requester can cancel it.');
    if (closed) return fail(req, env, 409, 'It\'s already closed.');
    await env.DB.prepare(`UPDATE requests SET state = 'cancelled', updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
    await audited(`cancel request ${row.name}`, id);
    return json(req, env, { ok: true });
  }
  if (verb === 'decide') {
    if (!isMaint) return fail(req, env, 403, 'Only maintainers can decide.');
    if (closed) return fail(req, env, 409, 'It\'s already closed.');
    const decision = clean(body.decision, 20);
    const reason = clean(body.reason, 500);
    const form = JSON.parse(row.form);
    if (reason) await env.DB.prepare('INSERT INTO notes (request_id, author, body, internal, created_at) VALUES (?1, ?2, ?3, 0, ?4)').bind(id, s.login, `${decision === 'reject' ? 'Rejected' : decision === 'hold' ? 'On hold' : 'Note'}: ${reason}`, now).run();
    if (decision === 'reject') {
      await env.DB.prepare(`UPDATE requests SET state = 'rejected', decided_by = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, s.login, now).run();
    } else if (decision === 'hold') {
      await env.DB.prepare(`UPDATE requests SET manual_hold = 1, state = 'on-hold', updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
    } else if (decision === 'unhold') {
      await env.DB.prepare(`UPDATE requests SET manual_hold = 0, state = 'checking', updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
      await requestReview(env, { ...row, manual_hold: 0 }, form);
    } else if (decision === 'recheck') {
      await env.DB.prepare(`UPDATE requests SET state = 'checking', updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
      await requestReview(env, row, form);
    } else if (decision === 'approve' || decision === 'force-approve') {
      await env.DB.prepare(`UPDATE requests SET state = 'approving', decided_by = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, s.login, now).run();
      await dispatch(env, { kind: 'approve', request: id, actor: s.login, requester: row.requester, form, force: decision === 'force-approve' });
    } else return fail(req, env, 400, 'Unknown decision.');
    await audited(`${decision} request ${row.name}${reason ? `: ${reason}` : ''}`, id);
    return json(req, env, { ok: true });
  }
  return fail(req, env, 404, 'Not found.');
}

/** The bot's daily (or on-demand) snapshot of every hosted site. */
async function botSites(req, env) {
  const h = req.headers.get('Authorization') || '';
  const secret = String(env.BOT_SECRET || '').trim();
  if (!secret || !safeEqual(h.trim(), `Bearer ${secret}`)) return new Response('no', { status: 401 });
  const snap = await req.json();
  await env.PANEL.put('sites:snapshot', JSON.stringify(snap));
  return new Response('ok');
}
/** The bot's activity lines go to the private audit log; the bot reads them back for the daily digest. */
async function botActivity(req, env, url) {
  const h = req.headers.get('Authorization') || '';
  const secret = String(env.BOT_SECRET || '').trim();
  if (!secret || !safeEqual(h.trim(), `Bearer ${secret}`)) return new Response('no', { status: 401 });
  if (!env.DB) return new Response('no db', { status: 503 });
  if (req.method === 'GET') {
    const since = Number(url.searchParams.get('since')) || Date.now() - 86400e3;
    const rows = (await env.DB.prepare(`SELECT at, actor, summary FROM audit WHERE role = 'bot-log' AND at > ?1 ORDER BY at`).bind(since).all()).results || [];
    return new Response(JSON.stringify({ lines: rows }), { headers: { 'Content-Type': 'application/json' } });
  }
  const { line } = await req.json();
  const text = String(line || '').slice(0, 600);
  const actor = (text.match(/by @([a-z\d-]+)/i) || [])[1] || 'bot';
  await auditWrite(env, { id: newId(), at: Date.now(), actor, role: 'bot-log', summary: text, state: 'done' });
  return new Response('ok');
}

/** Maintainers see every site; everyone else sees their own. */
async function sitesView(req, env, s) {
  const snap = JSON.parse((await env.PANEL.get('sites:snapshot')) || '{"sites":[]}');
  if (RANK[await roleOf(s.login, env)] >= RANK.maintainer) return json(req, env, snap);
  const me = s.login.toLowerCase();
  return json(req, env, { at: snap.at, sites: (snap.sites || []).filter((x) => String(x.owner).toLowerCase() === me || (x.collaborators || []).map((c) => c.toLowerCase()).includes(me)) });
}

/** Hourly: close private requests that have needed changes for too long. */
async function sweep(env) {
  if (!env.DB) return;
  const cfg = await config(env).catch(() => ({}));
  const days = cfg.staleRequestDays || 14;
  const cutoff = Date.now() - days * 86400e3;
  const stale = (await env.DB.prepare(`SELECT id, name FROM requests WHERE state = 'needs-changes' AND updated_at < ?1 LIMIT 100`).bind(cutoff).all()).results || [];
  for (const r of stale) {
    await env.DB.prepare(`UPDATE requests SET state = 'cancelled', updated_at = ?2 WHERE id = ?1`).bind(r.id, Date.now()).run();
    await env.DB.prepare(`INSERT INTO notes (request_id, author, body, internal, created_at) VALUES (?1, 'bot', ?2, 0, ?3)`)
      .bind(r.id, `Closed after ${days} days without changes. Start a new request any time.`, Date.now()).run();
    await auditWrite(env, { id: newId(), at: Date.now(), actor: 'bot', role: 'owner', summary: `auto-close stale request ${r.name}`, state: 'done', request: r.id });
  }
}

/** The bot reports a review (kind "review") or the outcome of an approval (kind "live" / "failed"). */
async function botRequest(req, env) {
  const h = req.headers.get('Authorization') || '';
  const secret = String(env.BOT_SECRET || '').trim();
  if (!secret || !safeEqual(h.trim(), `Bearer ${secret}`)) return new Response('no', { status: 401 });
  if (!env.DB) return new Response('no db', { status: 503 });
  const b = await req.json();
  const row = await getRequest(env, String(b.request || ''));
  if (!row) return new Response('unknown request', { status: 404 });
  const now = Date.now();
  if (['live', 'rejected', 'cancelled'].includes(row.state)) return new Response('closed');
  if (b.kind === 'review') {
    const state = row.manual_hold && b.verdict !== 'rejected' ? 'on-hold' : b.verdict;
    await env.DB.prepare('UPDATE requests SET state = ?2, review = ?3, updated_at = ?4 WHERE id = ?1').bind(row.id, state, JSON.stringify(b.review || null), now).run();
  } else if (b.kind === 'live') {
    await env.DB.prepare(`UPDATE requests SET state = 'live', result = ?2, updated_at = ?3 WHERE id = ?1`).bind(row.id, JSON.stringify(b.result || null), now).run();
  } else if (b.kind === 'failed') {
    await env.DB.prepare('UPDATE requests SET state = ?2, review = COALESCE(?3, review), updated_at = ?4 WHERE id = ?1').bind(row.id, b.verdict || 'needs-changes', b.review ? JSON.stringify(b.review) : null, now).run();
  }
  if (b.message) await env.DB.prepare(`INSERT INTO notes (request_id, author, body, internal, created_at) VALUES (?1, 'bot', ?2, 0, ?3)`).bind(row.id, String(b.message).slice(0, 4000), now).run();
  return new Response('ok');
}

async function stats(req, env, s) {
  if (RANK[await roleOf(s.login, env)] < RANK.maintainer) return fail(req, env, 403, 'Maintainers only.');
  if (!env.DB) return json(req, env, { requests: {}, last30: 0, actions7: 0, topActors: [] });
  const since30 = Date.now() - 30 * 86400e3;
  const byState = (await env.DB.prepare('SELECT state, COUNT(*) AS n FROM requests GROUP BY state').all()).results || [];
  const last30 = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE created_at > ?1').bind(since30).first();
  const actions7 = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit WHERE at > ?1').bind(Date.now() - 7 * 86400e3).first();
  const topActors = (await env.DB.prepare('SELECT actor, COUNT(*) AS n FROM audit WHERE at > ?1 GROUP BY actor ORDER BY n DESC LIMIT 8').bind(since30).all()).results || [];
  const perDay = (await env.DB.prepare(`SELECT CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM requests WHERE created_at > ?1 GROUP BY day ORDER BY day`).bind(since30).all()).results || [];
  return json(req, env, { requests: Object.fromEntries(byState.map((r) => [r.state, r.n])), last30: last30.n, actions7: actions7.n, topActors, perDay });
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    try {
      if (url.pathname === '/' || url.pathname === '/health') return json(req, env, { ok: true, repo: env.REPO });
      if (url.pathname === '/auth/login' && req.method === 'GET') return login(req, env, url);
      if (url.pathname === '/auth/callback' && req.method === 'GET') return callback(req, env, url);
      if (url.pathname === '/bot/result' && req.method === 'POST') return botResult(req, env);
      if (url.pathname === '/bot/request' && req.method === 'POST') return botRequest(req, env);
      if (url.pathname === '/bot/sites' && req.method === 'POST') return botSites(req, env);
      if (url.pathname === '/bot/activity') return botActivity(req, env, url);
      if (url.pathname === '/bot/identity' && req.method === 'POST') return botIdentity(req, env);
      if (url.pathname === '/saml/sso' && (req.method === 'GET' || req.method === 'POST')) return samlSso(req, env, url);
      if (url.pathname === '/saml/metadata' && req.method === 'GET') {
        if (!env.SAML_CERT) return new Response('not set up', { status: 503 });
        return new Response(metadata({ issuer: env.SAML_ISSUER || 'https://api.awesomeprojects.tech/saml', ssoUrl: `${url.origin}/saml/sso`, cert: env.SAML_CERT }), { headers: { 'Content-Type': 'application/samlmetadata+xml' } });
      }
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
        if (url.pathname === '/api/stats' && req.method === 'GET') return stats(req, env, s);
        if (url.pathname === '/api/sites' && req.method === 'GET') return sitesView(req, env, s);
        if (url.pathname === '/api/identity' && req.method === 'GET') return identityView(req, env, s, url);
        if (url.pathname === '/api/requests' || url.pathname.startsWith('/api/requests/')) return requests(req, env, s, url, url.pathname.split('/'));
      }
      return fail(req, env, 404, 'Not found.');
    } catch (e) {
      return fail(req, env, 500, `Something broke: ${e.message}`);
    }
  },
};
