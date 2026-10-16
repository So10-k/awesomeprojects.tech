'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../scripts/commands');
const { requestComment } = require('../scripts/comment');
const { review } = require('../scripts/review');
const P = require('../scripts/providers');
const F = require('../scripts/frameworks');

const e = (github, records = { CNAME: `${github}.github.io` }, extra = {}) => ({ owner: { github }, records, ...extra });
const entries = {
  alice: e('alice', { CNAME: 'alice.github.io' }, { description: 'Portfolio', site: { provider: 'github-pages', repo: 'alice/site' } }),
  '_vercel.alice': e('alice', { TXT: 'x' }),
  bob: e('bob', { A: ['1.2.3.4'] }, { site: { provider: 'server' } }),
};

test('parseCommand', () => {
  assert.deepEqual(C.parseCommand('/txt alice _vercel "a b c"\nmore text'), { cmd: '/txt', args: ['alice', '_vercel', 'a b c'], rest: 'alice _vercel "a b c"' });
  assert.deepEqual(C.parseCommand('  /HELP  ').cmd, '/help');
  assert.equal(C.parseCommand('please /approve'), null, 'must start the comment');
  assert.equal(C.parseCommand('/notacommand'), null);
  assert.equal(C.parseCommand('/approvedly'), null);
  assert.deepEqual(C.parseCommand('/ban @mallory spam bot').args, ['@mallory', 'spam', 'bot']);
});

test('the catalog is consistent', () => {
  for (const cmd of C.ADMIN_ONLY) assert.ok(C.CATALOG.some((c) => c.cmd === cmd && c.admin), cmd);
  for (const cmd of C.READ_ONLY) assert.ok(C.CATALOG.some((c) => c.cmd === cmd && !c.admin), cmd);
  const help = C.helpTable();
  for (const c of C.CATALOG) assert.ok(help.includes(c.usage), c.usage);
  assert.ok(!C.helpTable({ admin: false }).includes('/ban'));
});

test('/available', () => {
  assert.match(C.availability('carol', entries, ['www'], { repoUrl: 'https://github.com/o/r' }), /✅.*available.*template=request\.yml.*subdomain=carol/);
  assert.match(C.availability('Alice.awesomeprojects.tech', entries, []), /taken by @alice/);
  assert.match(C.availability('www', entries, ['www']), /reserved/);
  assert.match(C.availability('-bad-', entries, []), /can't be used/);
  assert.match(C.availability('x.alice', entries, []), /under/);
  assert.match(C.availability('', entries, []), /Usage/);
});

test('/whois, /mine, /stats', () => {
  const w = C.whois('alice', entries, { repoUrl: 'https://github.com/o/r' });
  assert.match(w, /@alice/);
  assert.match(w, /GitHub Pages \(\[alice\/site\]/);
  assert.match(w, /`CNAME alice\.github\.io`/);
  assert.match(w, /Under it.*_vercel\.alice/);
  assert.match(C.whois('nobody', entries), /isn't registered/);
  assert.match(C.mine('ALICE', entries, { maxPerOwner: 3 }), /1 of 3/);
  assert.match(C.mine('bob', entries, { maxPerOwner: 3, limits: { bob: 9 } }), /1 of 9/);
  assert.match(C.mine('zed', entries, { maxPerOwner: 3 }), /don't have any/);
  const s = C.stats(entries, { openRequests: 4 });
  assert.match(s, /Subdomains\*\* \| 2/);
  assert.match(s, /People\*\* \| 2/);
  assert.match(s, /Open requests\*\* \| 4/);
  assert.match(s, /GitHub Pages \| 1/);
});

test('admin edits', () => {
  const config = { maxPerOwner: 3, bannedUsers: [], limits: {}, locked: false };
  const ban = C.adminEdit('/ban', ['@Mallory', 'spam'], { config, reserved: [] });
  assert.deepEqual(ban.config.bannedUsers, ['mallory']);
  assert.match(ban.message, /Banned @mallory: spam/);
  assert.ok(C.adminEdit('/ban', ['mallory'], { config: ban.config, reserved: [] }).error, 'already banned');
  assert.deepEqual(C.adminEdit('/unban', ['mallory'], { config: ban.config, reserved: [] }).config.bannedUsers, []);
  assert.deepEqual(C.adminEdit('/limit', ['@bob', '10'], { config, reserved: [] }).config.limits, { bob: 10 });
  assert.deepEqual(C.adminEdit('/limit', ['bob', '3'], { config: { ...config, limits: { Bob: 10 } }, reserved: [] }).config.limits, {}, 'back to default');
  assert.ok(C.adminEdit('/limit', ['bob', 'lots'], { config, reserved: [] }).error);
  assert.deepEqual(C.adminEdit('/reserve', ['Shop'], { config, reserved: ['www'] }).reserved, ['www', 'shop']);
  assert.match(C.adminEdit('/reserve', ['alice'], { config, reserved: [], entries }).message, /registered to @alice/);
  assert.ok(C.adminEdit('/reserve', ['www'], { config, reserved: ['www'] }).error);
  assert.deepEqual(C.adminEdit('/unreserve', ['www'], { config, reserved: ['www', 'mail'] }).reserved, ['mail']);
  assert.equal(C.adminEdit('/lock', ['moving', 'servers'], { config, reserved: [] }).config.locked, 'moving servers');
  assert.equal(C.adminEdit('/lock', [], { config, reserved: [] }).config.locked, true);
  assert.equal(C.adminEdit('/unlock', [], { config: { ...config, locked: true }, reserved: [] }).config.locked, false);
  assert.ok(C.adminEdit('/unlock', [], { config, reserved: [] }).error);
  assert.deepEqual(config.bannedUsers, [], 'never mutates the input');
  const pro = C.adminEdit('/promote', ['@Carol'], { config: { ...config, maintainers: [] }, reserved: [] });
  assert.deepEqual(pro.config.maintainers, ['carol']);
  assert.ok(C.adminEdit('/promote', ['carol'], { config: pro.config, reserved: [] }).error, 'already one');
  assert.deepEqual(C.adminEdit('/demote', ['carol'], { config: pro.config, reserved: [] }).config.maintainers, []);
  assert.match(C.adminEdit('/demote', ['boss'], { config: pro.config, reserved: [], owner: 'Boss' }).error, /owner/);
  assert.ok(C.OWNER_ONLY.has('/promote') && C.ADMIN_ONLY.has('/demote'));
});

test('request comments', () => {
  const built = P.buildRequest({ Subdomain: 'carol', 'Where should it point?': 'github-pages', 'GitHub repository': 'carol/site' }, 'carol');
  const r = review({
    author: 'carol', profile: { login: 'carol', type: 'User', created_at: '2020-01-01T00:00:00Z', public_repos: 5, followers: 2, name: 'C' },
    changes: [{ status: 'A', file: 'domains/carol.json' }], base: {}, head: { carol: built.entry }, config: { maxPerOwner: 3 },
    extra: [{ check: 'repo', level: 'pass', text: 'carol/site is yours' }],
  });
  const plan = F.plan({ pkg: { dependencies: { next: '15' } }, files: new Set(['app/api/x/route.ts']) });
  const md = requestComment(r, { name: 'carol', domain: 'awesomeprojects.tech', entry: built.entry, plan });
  assert.match(md, /^<!-- subdomain-bot:request -->/);
  assert.match(md, /Ready to go live: `carol\.awesomeprojects\.tech`/);
  assert.match(md, /\*\*Repository\*\*/);
  assert.match(md, /Detected\*\* \| Next\.js/);
  assert.match(md, /⚠️.*Vercel/);
  assert.match(md, /"repo": "carol\/site"/);
  assert.match(requestComment(null, { name: 'x', domain: 'd', problems: ['Pick a name.'] }), /Almost there[\s\S]*Pick a name/);
  assert.match(requestComment(null, { name: 'x', domain: 'd', locked: 'maintenance' }), /paused[\s\S]*maintenance/);
  assert.match(requestComment(r, { name: 'x', domain: 'd', live: true, guide: 'STEPS', prUrl: 'u' }), /is live![\s\S]*STEPS/);
});
