'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/sites');
const R = require('../scripts/rules');
const P = require('../scripts/providers');

test('statuses: access and DNS', () => {
  assert.deepEqual(S.STATUSES.map((s) => [s, S.OWNER_PERMISSION[s], S.DNS_ON[s]]), [
    ['active', 'push', true], ['locked', 'pull', true], ['suspended', 'pull', false], ['archived', null, false],
  ]);
  const e = (status) => S.hostedEntry({ name: 'a', owner: 'alice', org: 'Org', description: 'x' }) && { site: { provider: 'hosted', repo: 'org/a', status } };
  assert.equal(S.dnsEnabled(e('active')), true);
  assert.equal(S.dnsEnabled(e('suspended')), false);
  assert.equal(S.dnsEnabled({ site: { provider: 'vercel' } }), true, 'non-hosted always on');
  assert.equal(S.statusOf({ site: { provider: 'hosted', repo: 'o/a' } }), 'active', 'default status');
});

test('transitions', () => {
  assert.equal(S.canTransition('active', 'locked', {}).ok, true);
  assert.equal(S.canTransition('active', 'active', {}).ok, false);
  assert.equal(S.canTransition('active', 'gone', {}).ok, false);
  assert.equal(S.canTransition('archived', 'active', { isOwner: false }).ok, false, 'only the owner un-archives');
  assert.equal(S.canTransition('archived', 'active', { isOwner: true }).ok, true);
});

test('hosted entries are valid domain files', () => {
  const entry = S.hostedEntry({ name: 'neon', owner: 'alice', org: 'AwesomeProjects-Sites', description: 'Neon' });
  assert.deepEqual(entry.records, { CNAME: 'awesomeprojects-sites.github.io' });
  assert.deepEqual(R.checkEntry('neon', entry), []);
  assert.ok(R.checkEntry('neon', { ...entry, site: { ...entry.site, status: 'deleted' } }).length);
  assert.ok(R.checkEntry('neon', { ...entry, records: { CNAME: 'evil.github.io' } }).length, 'CNAME must match the org');
  assert.ok(R.checkSite({ provider: 'vercel', status: 'locked' }).length, 'status is only for hosted');
});

test('requests: "Host it for me"', () => {
  const form = { Subdomain: 'neon', 'Where should it point?': 'Host it for me (we make you a private repo)', Description: 'Neon' };
  const r = P.buildRequest(form, 'alice', { sitesOrg: 'awesomeprojects-sites' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.entry.site, { provider: 'hosted', repo: 'awesomeprojects-sites/neon', status: 'active' });
  assert.ok(P.buildRequest(form, 'alice', {}).problems.length, 'off until an org is configured');
  assert.match(P.setupGuide({ provider: 'hosted', name: 'neon', repo: 'awesomeprojects-sites/neon', sourceRepo: 's/r' }), /invitations/);
});

test('repo setup', () => {
  const files = S.starterFiles({ name: 'neon', owner: 'alice', sourceRepo: 'So10-k/awesomeprojects.tech' });
  assert.deepEqual(files.map((f) => f.path).sort(), ['.github/workflows/deploy.yml', 'README.md', 'awesomeprojects.json', 'index.html']);
  assert.match(files[0].content, /uses: So10-k\/awesomeprojects\.tech\/\.github\/workflows\/pages-site\.yml@main/);
  assert.match(files.find((f) => f.path === 'index.html').content, /neon\.awesomeprojects\.tech/);
  assert.equal(S.repoSettings({ name: 'neon' }).private, true);
  const rs = S.workflowRuleset();
  assert.equal(rs.target, 'push');
  assert.deepEqual(rs.rules[0].parameters.restricted_file_paths, ['.github/workflows/**', '.github/actions/**']);
  assert.equal(rs.bypass_actors[0].actor_type, 'OrganizationAdmin', 'the bot (an org owner) can still manage workflows');
  assert.equal(S.ORG_SETTINGS.default_repository_permission, 'none');
  assert.ok(S.actionsPolicy('So10-k/awesomeprojects.tech').selected.patterns_allowed.includes('So10-k/awesomeprojects.tech/.github/workflows/*'));
});
