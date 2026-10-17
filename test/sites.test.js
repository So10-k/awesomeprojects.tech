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
  assert.deepEqual(r.entry.site, { provider: 'hosted', repo: 'awesomeprojects-sites/neon', status: 'active', template: 'html' });
  assert.equal(P.buildRequest({ ...form, Template: 'Next.js' }, 'alice', { sitesOrg: 'o' }).entry.site.template, 'next');
  assert.equal(P.buildRequest({ ...form, Template: 'vite-react' }, 'alice', { sitesOrg: 'o' }).entry.site.template, 'vite-react');
  assert.equal(P.buildRequest({ ...form, Template: 'nonsense' }, 'alice', { sitesOrg: 'o' }).entry.site.template, 'html');
  assert.deepEqual(R.checkEntry('neon', { ...r.entry }), []);
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

test('templates, rulesets, ops decisions, roles', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const t of S.TEMPLATES) assert.ok(fs.existsSync(path.join(__dirname, '..', 'templates', t.id)), `templates/${t.id}`);
  assert.equal(S.fillTemplate('{{name}} at {{host}} by @{{owner}} {{ style }}', { name: 'a', host: 'a.x', owner: 'o' }), 'a at a.x by @o {{ style }}');
  const push = S.workflowRuleset({ maxFileSizeMB: 500, blockedExtensions: ['.exe', 'zip'] });
  assert.equal(push.rules.find((r) => r.type === 'max_file_size').parameters.max_file_size, 100, 'capped at GitHub\'s 100 MB');
  assert.deepEqual(push.rules.find((r) => r.type === 'file_extension_restriction').parameters.restricted_file_extensions, ['*.exe', '*.zip']);
  const frozen = S.frozenRuleset();
  assert.deepEqual(frozen.conditions.repository_property.include[0].property_values, ['locked', 'suspended']);
  assert.ok(frozen.rules.some((r) => r.type === 'update'));
  assert.deepEqual(S.PROPERTIES.find((p) => p.property_name === 'ap_status').allowed_values, S.STATUSES);
  const day = 86400e3;
  const old = new Date(Date.now() - 200 * day).toISOString();
  assert.equal(S.inactivity({ pushedAt: old, status: 'active', warnDays: 180 }), 'warn');
  assert.equal(S.inactivity({ pushedAt: old, status: 'active', warnDays: 180, warnedAt: 'x' }), 'none');
  assert.equal(S.inactivity({ pushedAt: old, status: 'active', warnDays: 180, lockDays: 190 }), 'lock');
  assert.equal(S.inactivity({ pushedAt: old, status: 'locked', warnDays: 1, lockDays: 1 }), 'none', 'only active sites');
  assert.equal(S.seatsLeft({ used: 48, max: 50 }), 2);
  assert.equal(S.seatsLeft({ used: 99, max: 0 }), Infinity, '0 = no cap');
  assert.equal(S.httpsReady({ https_enforced: false, https_certificate: { state: 'approved' } }), true);
  assert.equal(S.httpsReady({ https_enforced: true, https_certificate: { state: 'approved' } }), false);
  // Custom roles keep only permissions GitHub offers.
  const roles = S.repoRoles(['view_dependabot_alerts', 'close_issue', 'bogus_one']);
  const owner = roles.find((r) => r.name === 'ap-site-owner');
  assert.equal(owner.base_role, 'write');
  assert.ok(owner.permissions.every((p) => ['view_dependabot_alerts', 'close_issue'].includes(p)));
  assert.equal(roles.find((r) => r.name === 'ap-site-locked').base_role, 'triage');
  assert.equal(S.ownerRole('active', ['ap-site-owner']), 'ap-site-owner');
  assert.equal(S.ownerRole('locked', ['ap-site-locked']), 'ap-site-locked');
  assert.equal(S.ownerRole('locked', []), 'pull', 'falls back to built-in roles');
  assert.equal(S.ownerRole('archived', ['ap-site-owner']), null);
});

test('managed-enterprise hosting: Cloudflare Pages entries', () => {
  const r = P.buildRequest({ Subdomain: 'neon', 'Where should it point?': 'hosted', Template: 'astro' }, 'alice', { sitesOrg: 'old-org', emuOrg: 'ap-sites' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.entry.records, { CNAME: 'ap-neon.pages.dev' });
  assert.deepEqual(r.entry.site, { provider: 'hosted', platform: 'cloudflare', repo: 'ap-sites/neon', status: 'active', template: 'astro' });
  assert.deepEqual(R.checkEntry('neon', r.entry), []);
  assert.ok(R.checkEntry('neon', { ...r.entry, records: { CNAME: 'evil.pages.dev' } }).length, 'must be its own project');
  assert.ok(S.onCloudflare(r.entry));
  assert.equal(S.cfProject('a'.repeat(63)).length <= 58, true);
  assert.match(S.deployWorkflowCf('So10-k/awesomeprojects.tech', 'ap-neon'), /cf-pages-site\.yml@main[\s\S]*project: ap-neon[\s\S]*secrets: inherit/);
  // EMU-only (no classic sitesOrg): still hosts on Cloudflare.
  const only = P.buildRequest({ Subdomain: 'neon', 'Where should it point?': 'hosted', Template: 'html' }, 'alice', { emuOrg: 'ap-sites' });
  assert.deepEqual(only.problems, []);
  assert.equal(only.entry.site.repo, 'ap-sites/neon');
  assert.ok(S.onCloudflare(only.entry));
});
