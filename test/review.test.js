'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { review, profileSignals, consentsFrom } = require('../scripts/review');
const { reviewComment } = require('../scripts/comment');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86400000;
const entry = (github, records = { CNAME: `${github}.github.io` }) => ({ owner: { github }, records });
const person = (login, ageDays = 900, extra = {}) => ({
  login, type: 'User', created_at: new Date(NOW - ageDays * DAY).toISOString(),
  public_repos: 12, followers: 4, name: 'A Person', bio: null, ...extra,
});
const config = {
  maxPerOwner: 3, rejectAccountsYoungerThanDays: 7, holdAccountsYoungerThanDays: 30, holdBotScoreAtLeast: 3,
  holdNamesContaining: ['login', 'paypal'], autoMerge: false, autoMergeMinAccountAgeDays: 180,
};

/** Review a PR by `author` that applies `files` ({ name: data | null }) on top of `base`. */
function run({ author = 'alice', profile, base = {}, files = {}, comments = [], labels = [], dns = {}, maintainers = ['boss'], cfg = {}, overrideHolds, overrideAll } = {}) {
  const head = { ...base };
  const changes = [];
  for (const [n, data] of Object.entries(files)) {
    const file = n.includes('/') ? n : `domains/${n}.json`;
    if (n.includes('/')) { changes.push({ status: 'M', file }); continue; }
    if (data === null) { delete head[n]; changes.push({ status: 'D', file }); }
    else { changes.push({ status: base[n] ? 'M' : 'A', file }); head[n] = data; }
  }
  return review({
    author, profile: profile === undefined ? person(author) : profile, changes, base, head, comments, labels, dns,
    reserved: ['www'], config: { ...config, ...cfg }, maintainers, now: NOW, overrideHolds, overrideAll, by: 'boss',
  });
}
const levels = (r, check) => r.findings.filter((f) => f.check === check).map((f) => f.level);
const say = (login, body) => ({ user: { login }, body });

test('a normal request is ready', () => {
  const r = run({ files: { alice: entry('alice') }, dns: { 'alice.github.io': true } });
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.labels, ['ready']);
  assert.equal(r.autoMerge, false, 'auto-merge is off by default');
  assert.deepEqual(levels(r, 'target'), ['pass']);
});

test('auto-merge only for established accounts', () => {
  assert.equal(run({ files: { alice: entry('alice') }, cfg: { autoMerge: true } }).autoMerge, true);
  assert.equal(run({ files: { alice: entry('alice') }, cfg: { autoMerge: true }, profile: person('alice', 100) }).autoMerge, false);
  assert.equal(run({ files: { alice: entry('alice') }, cfg: { autoMerge: true }, profile: person('alice', 900, { followers: 0, public_repos: 0, name: null }) }).autoMerge, false);
});

test('format problems need changes', () => {
  const r = run({ files: { alice: entry('alice', { A: ['10.0.0.1'] }) } });
  assert.equal(r.verdict, 'needs-changes');
  assert.ok(levels(r, 'format').includes('error'));
  assert.equal(run({ files: { 'README.md': {} } }).verdict, 'needs-changes', 'only domains/');
  assert.equal(run({ files: { alice: entry('bob') } }).verdict, 'needs-changes', 'owner must be the author');
});

test('account age: reject, hold, pass', () => {
  const young = run({ profile: person('alice', 3), files: { alice: entry('alice') } });
  assert.equal(young.verdict, 'rejected');
  assert.match(young.findings.find((f) => f.check === 'account').text, /2026-10-20/);
  const newish = run({ profile: person('alice', 20), files: { alice: entry('alice') } });
  assert.equal(newish.verdict, 'on-hold');
  assert.ok(newish.labels.includes('new-account'));
  assert.equal(run({ profile: person('alice', 20), files: { alice: entry('alice') }, overrideHolds: true }).verdict, 'ready');
});

test('bot check', () => {
  assert.equal(run({ profile: person('alice', 900, { type: 'Bot' }), files: { alice: entry('alice') } }).verdict, 'rejected');
  const s = profileSignals(person('alice99999', 40, { public_repos: 0, followers: 0, name: null }), NOW);
  assert.equal(s.botScore, 5);
  const r = run({ author: 'alice99999', profile: person('alice99999', 40, { public_repos: 0, followers: 0, name: null }), files: { alice99999: entry('alice99999') } });
  assert.equal(r.verdict, 'on-hold');
  assert.ok(r.labels.includes('maybe-bot'));
  assert.equal(run({ profile: null, files: { alice: entry('alice') } }).verdict, 'needs-changes', 'lookup failed');
});

test('banned users are rejected', () => {
  assert.equal(run({ files: { alice: entry('alice') }, cfg: { bannedUsers: ['ALICE'] } }).verdict, 'rejected');
});

test('existing subdomains and the limit', () => {
  const base = { a1: entry('alice'), a2: entry('alice') };
  const r = run({ base, files: { a3: entry('alice') } });
  assert.equal(r.verdict, 'ready');
  assert.deepEqual(r.existing, ['a1', 'a2']);
  assert.match(r.findings.find((f) => f.check === 'limit').text, /3 of 3 \(already: `a1`, `a2`\)/);
  const over = run({ base: { ...base, a3: entry('alice') }, files: { a4: entry('alice') } });
  assert.equal(over.verdict, 'needs-changes');
  assert.deepEqual(levels(over, 'limit'), ['error']);
});

test("someone else's name: rejected, pointing at transfers", () => {
  const base = { bob: entry('bob') };
  const take = run({ base, files: { bob: entry('alice') } });
  assert.equal(take.verdict, 'rejected');
  assert.match(take.findings.find((f) => f.level === 'reject').text, /transfer request/);
  assert.equal(run({ base, files: { bob: null } }).verdict, 'rejected', 'cannot delete it');
  assert.equal(run({ author: 'boss', base, files: { bob: null } }).verdict, 'ready', 'maintainers can');
});

test('names under an owned subdomain are held for the parent owner', () => {
  const base = { bob: entry('bob') };
  const r = run({ base, files: { 'blog.bob': entry('alice') } });
  assert.equal(r.verdict, 'on-hold');
  assert.ok(r.labels.includes('nested'));
  assert.equal(r.findings.find((f) => f.level === 'hold').waitingFor, 'bob');
  assert.equal(run({ base, files: { 'blog.bob': entry('alice') }, comments: [say('mallory', '/approve')] }).verdict, 'on-hold', 'only bob can approve');
  assert.equal(run({ base, files: { 'blog.bob': entry('alice') }, comments: [say('Bob', '/approve')] }).verdict, 'ready');
  assert.equal(run({ base, files: { 'blog.bob': entry('alice') }, comments: [say('boss', '/approve')] }).verdict, 'ready', 'a maintainer can approve');
  assert.equal(run({ author: 'bob', base, files: { '_vercel.bob': entry('bob', { TXT: 'x' }) } }).verdict, 'ready', 'own nested: no hold');
  assert.equal(run({ base, files: { 'x.nobody': entry('alice') } }).verdict, 'needs-changes', 'parent must exist');
  // The parent's owner may remove names under theirs.
  const withChild = { bob: entry('bob'), 'blog.bob': entry('alice') };
  assert.equal(run({ author: 'bob', base: withChild, files: { 'blog.bob': null } }).verdict, 'ready');
  // Deleting a parent that still has children needs those gone too.
  assert.equal(run({ author: 'bob', base: withChild, files: { bob: null } }).verdict, 'needs-changes');
});

test('handing a name over waits for the new owner', () => {
  const base = { alice: entry('alice') };
  const r = run({ base, files: { alice: entry('carol') } });
  assert.equal(r.verdict, 'on-hold');
  assert.ok(r.labels.includes('transfer'));
  assert.equal(run({ base, files: { alice: entry('carol') }, comments: [say('carol', '/accept')] }).verdict, 'ready');
});

test('sensitive names and Pages mismatches are held', () => {
  assert.ok(run({ files: { 'paypal-login': entry('alice') } }).labels.includes('sensitive-name'));
  const r = run({ files: { alice: entry('alice', { CNAME: 'someone-else.github.io' }) } });
  assert.equal(r.verdict, 'on-hold');
  assert.ok(r.labels.includes('pages-mismatch'));
});

test('dangling targets need changes', () => {
  const r = run({ files: { alice: entry('alice', { CNAME: 'gone.example.com' }) }, dns: { 'gone.example.com': false } });
  assert.equal(r.verdict, 'needs-changes');
  assert.deepEqual(levels(r, 'target'), ['error']);
});

test('manual hold, and a maintainer overriding it', () => {
  assert.equal(run({ files: { alice: entry('alice') }, labels: ['manual-hold'] }).verdict, 'on-hold');
  const r = run({ files: { alice: entry('alice') }, labels: ['manual-hold'], overrideHolds: true });
  assert.equal(r.verdict, 'ready');
  assert.ok(!r.findings.some((f) => f.level === 'hold'), 'no hold rows left under a ready headline');
  assert.match(r.findings.find((f) => f.check === 'consent').text, /approved by (a maintainer|@boss)/);
});

test('consents are read from the first word of comments', () => {
  const c = consentsFrom([say('Bob', '/approve'), say('carol', 'I /accept'), say('dan', '/accept please')]);
  assert.deepEqual([...c.approve], ['bob']);
  assert.deepEqual([...c.accept], ['dan']);
});

test('the review comment shows every check', () => {
  const md = reviewComment(run({ profile: person('alice', 20), files: { alice: entry('alice') } }));
  assert.match(md, /^<!-- subdomain-bot:review -->/);
  assert.match(md, /On hold/);
  for (const label of ['Format & records', 'Ownership', 'Account age', 'Bot check', 'Subdomains you own', 'Name check', 'Target is live', 'Consent']) {
    assert.ok(md.includes(label), label);
  }
  assert.match(md, /Waiting for:\*\* a maintainer/);
});

test('force: policy blockers are overridden, broken records and other people\'s names are not', () => {
  // Too young + bot + over the limit + reserved + dangling target: all forceable.
  const base = { a1: entry('alice'), a2: entry('alice'), a3: entry('alice') };
  const young = person('alice', 2, { type: 'Bot' });
  assert.equal(run({ profile: young, base, files: { www: entry('alice', { CNAME: 'gone.example.com' }) }, dns: { 'gone.example.com': false } }).verdict, 'rejected');
  const forced = run({ profile: young, base, files: { www: entry('alice', { CNAME: 'gone.example.com' }) }, dns: { 'gone.example.com': false }, overrideAll: true });
  assert.equal(forced.verdict, 'ready');
  assert.ok(forced.overridden >= 4);
  assert.ok(forced.findings.some((f) => /overridden by @boss/.test(f.text)));
  // Broken records stay blocked.
  assert.equal(run({ files: { alice: entry('alice', { A: ['10.0.0.1'] }) }, overrideAll: true }).verdict, 'needs-changes');
  // Someone else's name stays blocked.
  assert.equal(run({ base: { bob: entry('bob') }, files: { bob: entry('alice') }, overrideAll: true }).verdict, 'rejected');
  // Banned is forceable (a maintainer decided).
  assert.equal(run({ files: { alice: entry('alice') }, cfg: { bannedUsers: ['alice'] }, overrideAll: true }).verdict, 'ready');
});

test('only maintainers can mark a name forced', () => {
  const forcedEntry = { ...entry('alice'), forced: 'alice' };
  const r = run({ files: { www: forcedEntry } });
  assert.equal(r.verdict, 'needs-changes');
  assert.ok(r.findings.some((f) => /only maintainers can set/.test(f.text)));
  assert.equal(run({ author: 'boss', files: { www: { ...entry('boss'), forced: 'boss' } } }).verdict, 'ready');
});
