import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { sign, resetCaches } from '../worker/src/index.js';

const SITE = 'https://awesomeprojects.tech';

/** D1's API over node:sqlite, with the real migration applied. */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../worker/migrations/0001_requests.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return api; },
        async run() { st.run(...args); return { success: true }; },
        async all() { return { results: st.all(...args) }; },
        async first() { return st.get(...args) ?? null; },
      };
      return api;
    },
  };
}
function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, async list() { return { keys: [], list_complete: true }; } };
}

let cfg = { maintainers: ['mia'], locked: false, bannedUsers: ['spammer'] };
const dispatched = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const res = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/contents/config.json')) return res({ content: Buffer.from(JSON.stringify(cfg)).toString('base64') });
  if (u.endsWith('/dispatches')) { dispatched.push(JSON.parse(init.body).client_payload); return new Response(null, { status: 204 }); }
  return res({ message: 'unmocked' }, 404);
};

const env = () => ({ REPO: 'boss/awesomeprojects.tech', SITE_ORIGIN: SITE, SESSION_SECRET: 's3cret', BOT_SECRET: 'b0t', DISPATCH_TOKEN: 't', PANEL: kv(), DB: d1() });
const tok = (e, login) => sign({ login, id: 1, exp: Date.now() + 3600e3 }, e.SESSION_SECRET);
async function call(e, path, { method = 'GET', body, as, bot } = {}) {
  const headers = { Origin: SITE };
  if (as) headers.Authorization = `Bearer ${await tok(e, as)}`;
  if (bot) headers.Authorization = `Bearer ${e.BOT_SECRET}`;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request(`https://api.awesomeprojects.tech${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), e);
  const text = await r.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, data };
}

test('a request from start to live, privately', async () => {
  const e = env();
  dispatched.length = 0;
  // Alice asks.
  const made = await call(e, '/api/requests', { method: 'POST', as: 'alice', body: { name: 'Neon', provider: 'Vercel', description: 'Neon garden' } });
  assert.equal(made.status, 200);
  const id = made.data.request.id;
  assert.equal(made.data.request.state, 'checking');
  assert.deepEqual(dispatched[0], { kind: 'review', request: id, actor: 'alice', form: { name: 'neon', provider: 'Vercel', repo: '', target: '', description: 'Neon garden' }, manualHold: false });

  // The bot reviews it.
  assert.equal((await call(e, '/bot/request', { method: 'POST', body: { request: id, kind: 'review', verdict: 'ready', review: { verdict: 'ready', findings: [] } } })).status, 401, 'needs the bot secret');
  assert.equal((await call(e, '/bot/request', { method: 'POST', bot: true, body: { request: id, kind: 'review', verdict: 'ready', review: { verdict: 'ready', findings: [{ check: 'format', level: 'pass', text: 'Valid' }] } } })).status, 200);

  // Private: Alice and maintainers see it, Bob doesn't.
  assert.equal((await call(e, `/api/requests/${id}`, { as: 'bob' })).status, 404);
  assert.equal((await call(e, `/api/requests/${id}`, { as: 'alice' })).data.request.state, 'ready');
  assert.equal((await call(e, '/api/requests', { as: 'bob' })).data.requests.length, 0);
  assert.equal((await call(e, '/api/requests?scope=all', { as: 'bob' })).data.requests.length, 0, 'scope=all is maintainers only');
  assert.equal((await call(e, '/api/requests?scope=all', { as: 'mia' })).data.requests.length, 1);

  // A conversation, with an internal note only maintainers see.
  await call(e, `/api/requests/${id}/note`, { method: 'POST', as: 'mia', body: { body: 'Looks good!' } });
  await call(e, `/api/requests/${id}/note`, { method: 'POST', as: 'mia', body: { body: 'checked the target', internal: true } });
  await call(e, `/api/requests/${id}/note`, { method: 'POST', as: 'alice', body: { body: 'thanks', internal: true } });
  const aliceView = await call(e, `/api/requests/${id}`, { as: 'alice' });
  assert.deepEqual(aliceView.data.notes.map((n) => n.body), ['Looks good!', 'thanks'], 'requesters can\'t make or see internal notes');
  assert.equal(aliceView.data.history, undefined, 'history is maintainers only');
  assert.equal((await call(e, `/api/requests/${id}`, { as: 'mia' })).data.notes.length, 3);

  // Only maintainers decide.
  assert.equal((await call(e, `/api/requests/${id}/decide`, { method: 'POST', as: 'alice', body: { decision: 'approve' } })).status, 403);
  assert.equal((await call(e, `/api/requests/${id}/decide`, { method: 'POST', as: 'mia', body: { decision: 'approve' } })).status, 200);
  assert.equal(dispatched.at(-1).kind, 'approve');
  assert.equal(dispatched.at(-1).requester, 'alice');
  assert.equal((await call(e, `/api/requests/${id}`, { as: 'alice' })).data.request.state, 'approving');

  // The bot reports it live.
  await call(e, '/bot/request', { method: 'POST', bot: true, body: { request: id, kind: 'live', result: { pr: 'https://github.com/x/pull/9', guide: 'steps' }, message: '🎉 live' } });
  const done = await call(e, `/api/requests/${id}`, { as: 'alice' });
  assert.equal(done.data.request.state, 'live');
  assert.equal(done.data.request.result.pr, 'https://github.com/x/pull/9');
  assert.equal(done.data.notes.at(-1).author, 'bot');
  assert.equal((await call(e, `/api/requests/${id}/edit`, { method: 'POST', as: 'alice', body: { provider: 'Netlify' } })).status, 409, 'closed requests can\'t change');

  // Everything is in the audit log and the stats.
  const log = await call(e, '/api/audit', { as: 'mia' });
  assert.deepEqual(log.data.entries.map((a) => a.summary).reverse(), ['request neon', 'approve request neon']);
  const st = await call(e, '/api/stats', { as: 'mia' });
  assert.equal(st.data.requests.live, 1);
  assert.equal(st.data.last30, 1);
});

test('edits, holds, cancel, limits', async () => {
  const e = env();
  dispatched.length = 0;
  const id = (await call(e, '/api/requests', { method: 'POST', as: 'alice', body: { name: 'rocket', provider: 'Netlify', target: 'rkt' } })).data.request.id;
  assert.equal((await call(e, '/api/requests', { method: 'POST', as: 'alice', body: { name: 'rocket', provider: 'Vercel' } })).status, 409, 'one open request per name');
  assert.equal((await call(e, '/api/requests', { method: 'POST', as: 'alice', body: { name: 'a.b', provider: 'Vercel' } })).status, 400, 'top-level only');

  // Edit → re-review with the new form.
  assert.equal((await call(e, `/api/requests/${id}/edit`, { method: 'POST', as: 'bob', body: { target: 'x' } })).status, 404);
  assert.equal((await call(e, `/api/requests/${id}/edit`, { method: 'POST', as: 'alice', body: { target: 'rocket-2', name: 'stolen' } })).status, 200);
  assert.deepEqual([dispatched.at(-1).form.target, dispatched.at(-1).form.name], ['rocket-2', 'rocket'], 'the name can\'t change');

  // A hold sticks through reviews.
  await call(e, `/api/requests/${id}/decide`, { method: 'POST', as: 'mia', body: { decision: 'hold', reason: 'checking the site' } });
  await call(e, '/bot/request', { method: 'POST', bot: true, body: { request: id, kind: 'review', verdict: 'ready', review: {} } });
  assert.equal((await call(e, `/api/requests/${id}`, { as: 'alice' })).data.request.state, 'on-hold');
  await call(e, `/api/requests/${id}/decide`, { method: 'POST', as: 'mia', body: { decision: 'unhold' } });
  assert.equal(dispatched.at(-1).manualHold, false);

  // Cancel.
  assert.equal((await call(e, `/api/requests/${id}/cancel`, { method: 'POST', as: 'alice' })).status, 200);
  assert.equal((await call(e, `/api/requests/${id}`, { as: 'alice' })).data.request.state, 'cancelled');
  assert.equal((await call(e, '/bot/request', { method: 'POST', bot: true, body: { request: id, kind: 'review', verdict: 'ready' } })).data, 'closed', 'late reviews don\'t reopen it');

  // Bans and pauses.
  assert.equal((await call(e, '/api/requests', { method: 'POST', as: 'spammer', body: { name: 'x', provider: 'Vercel' } })).status, 403);
  cfg = { ...cfg, locked: 'maintenance' };
  resetCaches();
  const paused = await call(e, '/api/requests', { method: 'POST', as: 'carol', body: { name: 'x', provider: 'Vercel' } });
  assert.equal(paused.status, 423);
  assert.match(paused.data.error, /maintenance/);
  assert.equal((await call(e, '/api/requests', { method: 'POST', as: 'mia', body: { name: 'x', provider: 'Vercel' } })).status, 200, 'maintainers can still request');
  cfg = { ...cfg, locked: false };
  resetCaches();
});
