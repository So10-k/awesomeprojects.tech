'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../scripts/requests');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const person = (login, ageDays = 900) => ({ login, type: 'User', created_at: new Date(NOW - ageDays * 86400000).toISOString(), public_repos: 3, followers: 1, name: 'x' });
const entry = (github) => ({ owner: { github, email: 'old@example.com' }, records: { CNAME: `${github}.github.io` } });
const say = (login, body) => ({ user: { login }, body });
const entries = { alice: entry('alice'), '_vercel.alice': entry('alice'), 'blog.alice': entry('bob'), bob: entry('bob') };

test('issue forms and names', () => {
  const f = Q.parseForm('### Subdomain\n\nalice.awesomeprojects.tech\n\n### New owner\n\n_No response_\n\n### Why\n\nbecause\nreally');
  assert.deepEqual(f, { Subdomain: 'alice.awesomeprojects.tech', 'New owner': '', Why: 'because\nreally' });
  for (const s of ['alice', 'Alice.awesomeprojects.tech', 'https://alice.awesomeprojects.tech/x', ' `alice` ', 'alice.awesomeprojects.tech.']) {
    assert.equal(Q.cleanName(s), 'alice', s);
  }
});

const plan = (o) => Q.planTransfer({ entries, maintainers: ['boss'], config: { maxPerOwner: 3, rejectAccountsYoungerThanDays: 7 }, now: NOW, comments: [], ...o });

test('transfer: new owner asks, waits for the current owner', () => {
  const p = plan({ author: 'carol', form: { Subdomain: 'alice', 'New owner': '' }, profile: person('carol') });
  assert.equal(p.to, 'carol');
  assert.equal(p.from, 'alice');
  assert.deepEqual(p.waiting.map((w) => [w.who, w.cmd]), [['alice', '/approve']]);
  assert.equal(p.ok, false);
  const done = plan({ author: 'carol', form: { Subdomain: 'alice' }, profile: person('carol'), comments: [say('alice', '/approve')] });
  assert.equal(done.ok, true);
  // Moves alice's own names under it, not bob's, and drops the old contact details.
  assert.deepEqual(done.changes.map((c) => c.file), ['domains/_vercel.alice.json', 'domains/alice.json']);
  assert.deepEqual(JSON.parse(done.changes[1].content).owner, { github: 'carol' });
});

test('transfer: owner gives it away, waits for the new owner', () => {
  const p = plan({ author: 'alice', form: { Subdomain: 'alice', 'New owner': '@Carol' }, profile: person('carol') });
  assert.deepEqual(p.waiting.map((w) => [w.who, w.cmd]), [['carol', '/accept']]);
  assert.ok(plan({ author: 'alice', form: { Subdomain: 'alice', 'New owner': 'carol' }, profile: person('carol'), comments: [say('carol', '/accept')] }).ok);
});

test('transfer: a maintainer can stand in for an unresponsive owner', () => {
  assert.ok(plan({ author: 'carol', form: { Subdomain: 'alice' }, profile: person('carol'), comments: [say('boss', '/approve')] }).ok);
});

test('transfer: problems', () => {
  const p = (o) => plan({ author: 'carol', profile: person('carol'), ...o }).problems;
  assert.ok(p({ form: { Subdomain: 'nope' } }).length);
  assert.ok(p({ form: { Subdomain: 'blog.alice' } }).length, 'top-level only');
  assert.ok(p({ form: { Subdomain: 'alice', 'New owner': 'alice' } }).length, 'already theirs');
  assert.ok(p({ form: { Subdomain: 'alice' }, profile: person('carol', 2) }).length, 'too new');
  assert.ok(p({ form: { Subdomain: 'alice' }, profile: { ...person('carol'), type: 'Bot' } }).length);
  assert.ok(p({ form: { Subdomain: 'alice' }, profile: null }).length);
  const full = { ...entries, c1: entry('carol'), c2: entry('carol'), c3: entry('carol') };
  assert.ok(plan({ entries: full, author: 'carol', profile: person('carol'), form: { Subdomain: 'alice' } }).problems.length, 'limit');
});

test('takedown', () => {
  const own = Q.planTakedown({ author: 'alice', entries, form: { Subdomain: 'alice', Reason: 'I own it and want it removed' } });
  assert.equal(own.byOwner, true);
  assert.equal(own.reason, 'owner');
  assert.deepEqual(own.changes.map((c) => c.file), ['domains/_vercel.alice.json', 'domains/alice.json', 'domains/blog.alice.json']);
  assert.ok(own.changes.every((c) => c.content === null));

  const report = Q.planTakedown({ author: 'zed', entries, form: { Subdomain: 'bob', Reason: 'Phishing or scam' } });
  assert.equal(report.byOwner, false);
  assert.equal(report.reason, 'phishing');
  assert.equal(Q.planTakedown({ author: 'alice', entries, form: { Subdomain: 'blog.alice', Reason: 'x' } }).byOwner, true, 'parent owner');
  assert.ok(Q.planTakedown({ author: 'zed', entries, form: { Subdomain: 'gone' } }).problems.length);
});
