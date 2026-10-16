import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sign, verify, ACTIONS } from '../worker/src/index.js';

const SITE = 'https://awesomeprojects.tech';
function kv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k).v : null; },
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata }); },
    async list({ prefix, limit = 1000 }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name, metadata: m.get(name).meta }));
      return { keys, list_complete: true };
    },
  };
}
const env = (extra = {}) => ({
  REPO: 'boss/awesomeprojects.tech', SITE_ORIGIN: SITE, GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret',
  DISPATCH_TOKEN: 'dtoken', SESSION_SECRET: 'session-secret-for-tests', BOT_SECRET: 'bot-secret-for-tests', PANEL: kv(), ...extra,
});

// Fake GitHub.
const dispatched = [];
const config = { maintainers: ['mia'] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/contents/config.json')) return res({ content: b64(config) });
  if (u.includes('/contents/reserved.json')) return res({ content: b64(['www']) });
  if (u.endsWith('/dispatches')) { dispatched.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  if (u.includes('/issues?state=open')) return res([{ number: 5, title: 'Request: x', html_url: 'h', user: { login: 'a' }, created_at: 'c', comments: 1, labels: [{ name: 'request' }], body: 'b' }]);
  if (u === 'https://github.com/login/oauth/access_token') return res({ access_token: 'gho_temp' });
  if (u === 'https://api.github.com/user') return res({ login: 'Alice', id: 7, avatar_url: 'av' });
  return res({ message: `unmocked ${u}` }, 404);
};

const call = (e, path, { method = 'GET', body, token, origin = SITE, headers = {} } = {}) => worker.fetch(new Request(`https://api.awesomeprojects.tech${path}`, {
  method,
  headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
}), e);
const sessionFor = (e, login) => sign({ login, id: 1, exp: Date.now() + 3600e3 }, e.SESSION_SECRET);

test('sessions: signed, tamper-proof, expiring', async () => {
  const t = await sign({ login: 'alice', exp: Date.now() + 1000 }, 's');
  assert.equal((await verify(t, 's')).login, 'alice');
  assert.equal(await verify(t, 'other'), null, 'wrong secret');
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ login: 'boss', exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(await verify(`${forged}.${sig}`, 's'), null, 'swapped body');
  assert.equal(await verify(`${body}.x${sig.slice(1)}`, 's'), null, 'bad signature');
  assert.equal(await verify(await sign({ login: 'a', exp: Date.now() - 1 }, 's'), 's'), null, 'expired');
  assert.equal(await verify('garbage', 's'), null);
});

test('actions build safe commands and reject junk', () => {
  assert.deepEqual(ACTIONS.ban.build({ user: '@Mallory', reason: 'spam\n/unlock' }), { command: '/ban @Mallory spam /unlock' }, 'newlines can\'t start a second command');
  assert.deepEqual(ACTIONS.approve.build({ number: '41' }), { command: '/approve', target: 41 });
  assert.deepEqual(ACTIONS.txt.build({ name: 'alice', label: '_vercel', value: 'a "b" c' }), { command: '/txt alice _vercel "a b c"' });
  assert.deepEqual(ACTIONS.takedown.build({ name: 'evil', reason: 'phish' }), { command: '/takedown evil phish' });
  assert.deepEqual(ACTIONS.takedown.build({ number: 9 }), { command: '/takedown', target: 9 });
  assert.equal(ACTIONS.update.build({ name: 'Alice', provider: 'Vercel' }).update.name, 'alice');
  for (const [a, args] of [['ban', { user: 'not a user!' }], ['approve', {}], ['limit', { user: 'a', n: 1000 }], ['txt', { name: 'a', label: 'bad label', value: 'x' }], ['remove', { name: '../etc' }]]) {
    assert.throws(() => ACTIONS[a].build(args), undefined, a);
  }
});

test('roles are enforced by the server', async () => {
  const e = env();
  const alice = await sessionFor(e, 'alice');
  const mia = await sessionFor(e, 'Mia');
  const boss = await sessionFor(e, 'Boss');
  assert.equal((await call(e, '/api/action', { method: 'POST', token: alice, body: { action: 'ban', args: { user: 'x' } } })).status, 403);
  assert.equal((await call(e, '/api/action', { method: 'POST', token: mia, body: { action: 'promote', args: { user: 'x' } } })).status, 403, 'maintainers can\'t promote');
  assert.equal((await call(e, '/api/action', { method: 'POST', token: boss, body: { action: 'promote', args: { user: 'x' } } })).status, 200);
  assert.equal((await call(e, '/api/action', { method: 'POST', token: alice, body: { action: 'verify', args: { name: 'alice' } } })).status, 200, 'users can act on names');
  assert.equal((await (await call(e, '/api/me', { token: mia })).json()).role, 'maintainer');
  assert.equal((await call(e, '/api/queue', { token: alice })).status, 403);
  assert.equal((await call(e, '/api/queue', { token: mia })).status, 200);
  assert.equal((await call(e, '/api/me')).status, 401, 'no session');
  assert.equal((await call(e, '/api/action', { method: 'POST', token: boss, origin: 'https://evil.awesomeprojects.tech', body: { action: 'deploy' } })).status, 403, 'other origins (even subdomains) can\'t post');
});

test('an action is dispatched privately, tracked, and audited', async () => {
  const e = env();
  dispatched.length = 0;
  const mia = await sessionFor(e, 'mia');
  const r = await call(e, '/api/action', { method: 'POST', token: mia, body: { action: 'approve', args: { number: 41 } } });
  const { id, summary } = await r.json();
  assert.equal(summary, '/approve on #41');
  const sent = dispatched[0].client_payload;
  assert.deepEqual({ ...sent, at: 0 }, { id, actor: 'mia', at: 0, summary: '/approve on #41', command: '/approve', target: 41 });
  assert.ok(Number.isFinite(sent.at));
  assert.equal((await (await call(e, `/api/status/${id}`, { token: mia })).json()).state, 'queued');

  // Only the bot can report back.
  assert.equal((await call(e, '/bot/result', { method: 'POST', body: { id, ok: true, message: 'merged' }, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  // The report carries everything it needs: it works even where the job isn't visible yet.
  const report = { id, actor: sent.actor, at: sent.at, summary: sent.summary, ok: true, message: '🎉 live', link: 'L' };
  const elsewhere = env({ PANEL: e.PANEL });
  e.PANEL.m.delete(`job:${id}`);
  assert.equal((await call(elsewhere, '/bot/result', { method: 'POST', body: report, headers: { Authorization: `Bearer ${e.BOT_SECRET}` } })).status, 200);
  await e.PANEL.put(`job:${id}`, JSON.stringify({ id, actor: 'mia', state: 'queued', summary: sent.summary }));
  const done = await (await call(e, `/api/status/${id}`, { token: mia })).json();
  assert.deepEqual([done.state, done.message, done.link], ['done', '🎉 live', 'L']);

  // Someone else can't read it; the audit log has it.
  const alice = await sessionFor(e, 'alice');
  assert.equal((await call(e, `/api/status/${id}`, { token: alice })).status, 404);
  assert.equal((await call(e, '/api/audit', { token: alice })).status, 403);
  const log = await (await call(e, '/api/audit', { token: mia })).json();
  assert.equal(log.entries[0].summary, '/approve on #41');
  assert.equal(log.entries[0].state, 'done');
  assert.equal(log.entries[0].actor, 'mia');
});

test('rate limit', async () => {
  const e = env();
  const alice = await sessionFor(e, 'alice');
  let last;
  for (let i = 0; i < 41; i++) last = await call(e, '/api/action', { method: 'POST', token: alice, body: { action: 'verify', args: { name: 'alice' } } });
  assert.equal(last.status, 429);
});

test('sign-in round trip', async () => {
  const e = env();
  const start = await call(e, '/auth/login?return=/me/');
  assert.equal(start.status, 302);
  const gh = new URL(start.headers.get('Location'));
  assert.equal(gh.origin + gh.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(gh.searchParams.get('client_id'), 'cid');
  assert.equal(gh.searchParams.get('scope'), null, 'no scopes: identity only');
  assert.equal((await call(e, '/auth/login?return=//evil.com')).status, 400, 'no open redirect');
  const back = await call(e, `/auth/callback?code=abc&state=${encodeURIComponent(gh.searchParams.get('state'))}`);
  const loc = back.headers.get('Location');
  assert.ok(loc.startsWith(`${SITE}/me/#session=`), loc);
  const s = await verify(decodeURIComponent(loc.split('#session=')[1]), e.SESSION_SECRET);
  assert.equal(s.login, 'Alice');
  assert.equal((await call(e, '/auth/callback?code=abc&state=forged')).status, 400);
});

test('CORS only for the site', async () => {
  const e = env();
  const ok = await call(e, '/api/me', { method: 'OPTIONS' });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), SITE);
  const bad = await call(e, '/api/me', { method: 'OPTIONS', origin: 'https://evil.awesomeprojects.tech' });
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});
