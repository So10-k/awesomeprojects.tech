'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../scripts/providers');
const F = require('../scripts/frameworks');
const R = require('../scripts/rules');

const form = (provider, extra = {}) => ({ Subdomain: 'alice', 'Where should it point?': provider, ...extra });

test('every provider label resolves, and the rules accept every provider id', () => {
  for (const p of P.PROVIDERS) {
    assert.equal(P.byLabelOrId(p.label).id, p.id);
    assert.ok(R.PROVIDERS.includes(p.id), p.id);
  }
});

test('requests: GitHub repo → CNAME to the repo owner\'s github.io', () => {
  for (const repo of ['Alice/Portfolio', 'https://github.com/Alice/Portfolio.git', 'github.com/Alice/Portfolio/tree/main']) {
    const r = P.buildRequest(form('My GitHub repo (free hosting on GitHub Pages)', { 'GitHub repository': repo, Description: 'hi' }), 'Alice');
    assert.deepEqual(r.problems, [], repo);
    assert.deepEqual(r.entry, { owner: { github: 'Alice' }, description: 'hi', records: { CNAME: 'alice.github.io' }, site: { provider: 'github-pages', repo: 'Alice/Portfolio' } });
    assert.deepEqual(R.checkEntry('alice', r.entry), []);
  }
  assert.ok(P.buildRequest(form('github-pages', { 'GitHub repository': 'nope' }), 'a').problems.length);
});

test('requests: hosts with suffixes, plain CNAMEs and servers', () => {
  assert.deepEqual(P.buildRequest(form('Vercel'), 'a').entry.records, { CNAME: 'cname.vercel-dns.com' });
  assert.deepEqual(P.buildRequest(form('Netlify', { Target: 'my-site' }), 'a').entry.records, { CNAME: 'my-site.netlify.app' });
  assert.deepEqual(P.buildRequest(form('Netlify', { Target: 'https://my-site.netlify.app/' }), 'a').entry.records, { CNAME: 'my-site.netlify.app' });
  assert.ok(P.buildRequest(form('Netlify', { Target: 'evil.example.com' }), 'a').problems.length, 'wrong host for the provider');
  assert.deepEqual(P.buildRequest(form('Fly.io', { Target: 'app' }), 'a').entry.records, { CNAME: 'app.fly.dev' });
  assert.deepEqual(P.buildRequest(form('Another hostname (CNAME)', { Target: 'Foo.Example.com' }), 'a').entry.records, { CNAME: 'foo.example.com' });
  const srv = P.buildRequest(form('My own server (IP address)', { Target: '1.2.3.4, 2606:4700::1' }), 'a');
  assert.deepEqual(srv.entry.records, { A: ['1.2.3.4'], AAAA: ['2606:4700::1'] });
  assert.equal(srv.entry.site.provider, 'server');
  assert.ok(P.buildRequest(form('My own server (IP address)', { Target: 'banana' }), 'a').problems.length);
  for (const p of P.PROVIDERS) {
    const r = P.buildRequest(form(p.id, { Target: p.input === 'ips' ? '1.1.1.1' : p.id === 'cname' ? 'thing.example.com' : 'thing', 'GitHub repository': 'a/b' }), 'a');
    if (r.entry) assert.deepEqual(R.checkEntry('alice', r.entry), [], p.id);
  }
  assert.ok(P.buildRequest({ Subdomain: 'x', 'Where should it point?': '' }, 'a').problems.length);
});

test('setup guides', () => {
  const g = P.setupGuide({ provider: 'github-pages', name: 'alice', repo: 'Alice/site', branch: 'trunk', sourceRepo: 'So10-k/awesomeprojects.tech' });
  assert.match(g, /github\.com\/Alice\/site\/new\/trunk\?filename=/);
  assert.match(decodeURIComponent(g), /uses: So10-k\/awesomeprojects\.tech\/\.github\/workflows\/pages-site\.yml@main/);
  assert.match(g, /alice\.awesomeprojects\.tech/);
  for (const p of P.PROVIDERS) assert.match(P.setupGuide({ provider: p.id, name: 'x', repo: 'a/b', sourceRepo: 's/r' }), /\/verify x/);
});

const files = (...f) => new Set(f);

test('frameworks: detection', () => {
  const next = F.plan({ pkg: { dependencies: { next: '15', react: '19' } }, files: files('package.json', 'pnpm-lock.yaml', 'app/page.tsx') });
  assert.equal(next.framework, 'next');
  assert.equal(next.pm, 'pnpm');
  assert.equal(next.install, 'pnpm install --frozen-lockfile');
  assert.equal(next.output, 'out');
  assert.equal(next.nextExport, true);
  assert.deepEqual(next.warnings, []);

  const vite = F.plan({ pkg: { devDependencies: { vite: '6' }, scripts: { build: 'vite build' } }, files: files('package-lock.json') });
  assert.deepEqual([vite.framework, vite.install, vite.build, vite.output, vite.spa], ['vite', 'npm ci', 'npm run build', 'dist', true]);
  assert.equal(F.plan({ pkg: { dependencies: { astro: '5' } }, files: files('yarn.lock') }).build, 'yarn run build');
  assert.equal(F.plan({ pkg: { dependencies: { gatsby: '5' } } }).output, 'public');
  assert.equal(F.plan({ pkg: { dependencies: { nuxt: '3' } } }).output, '.output/public');
  assert.equal(F.plan({ pkg: { scripts: { build: 'make' } } }).framework, 'node');
  assert.equal(F.plan({ pkg: { dependencies: { next: '15' } }, files: files(), config: {} }).node, '20');
  assert.equal(F.plan({ pkg: { dependencies: { next: '15' }, engines: { node: '>=22' } } }).node, '22');
});

test('frameworks: warnings', () => {
  const api = F.plan({ pkg: { dependencies: { next: '15' } }, files: files('app/api/hello/route.ts', 'app/page.tsx') });
  assert.match(api.warnings[0], /Vercel/);
  assert.match(F.plan({ pkg: { dependencies: { next: '14' } }, files: files('src/middleware.ts') }).warnings[0], /server features/);
  assert.match(F.plan({ pkg: { devDependencies: { '@sveltejs/kit': '2' } } }).warnings[0], /adapter-static/);
  assert.equal(F.plan({ pkg: { devDependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3' } } }).warnings.length, 0);
});

test('frameworks: plain HTML', () => {
  assert.equal(F.plan({ files: files('index.html') }).output, '.');
  assert.equal(F.plan({ files: files('docs/index.html') }).output, 'docs');
  assert.equal(F.plan({ files: files('public/index.html') }).output, 'public');
  assert.ok(F.plan({ files: files('README.md') }).warnings.length);
});

test('frameworks: awesomeprojects.json overrides', () => {
  const p = F.plan({ pkg: { dependencies: { next: '15' } }, config: { build: 'make site', output: 'site', node: '22', spa: true } });
  assert.deepEqual([p.build, p.output, p.node, p.spa, p.nextExport], ['make site', 'site', '22', true, false]);
  assert.equal(F.plan({ pkg: { dependencies: { next: '15' } }, config: { framework: 'static', output: 'public' } }).framework, 'static');
  assert.deepEqual(F.readConfig('{"framework":"vite"}').problems, []);
  assert.ok(F.readConfig('{nope').problems.length);
  assert.ok(F.readConfig({ output: '../etc' }).problems.length);
  assert.ok(F.readConfig({ wat: 1 }).problems.length);
  assert.ok(F.readConfig({ spa: 'yes' }).problems.length);
});

test('frameworks: Next.js static export wrapper', () => {
  assert.equal(F.nextExportConfig(null).rename, null);
  assert.match(F.nextExportConfig(null).content, /output: 'export'/);
  const js = F.nextExportConfig('js');
  assert.deepEqual(js.rename, ['next.config.js', 'next.config.user.js']);
  assert.equal(js.file, 'next.config.mjs');
  assert.equal(F.nextExportConfig('ts').file, 'next.config.ts');
});

test('rules: site metadata', () => {
  assert.deepEqual(R.checkSite({ provider: 'vercel' }), []);
  assert.ok(R.checkSite({ provider: 'nope' }).length);
  assert.ok(R.checkSite({ provider: 'github-pages' }).length, 'needs repo');
  assert.ok(R.checkSite({ provider: 'github-pages', repo: 'acme/site' }, { CNAME: 'alice.github.io' }).length, 'CNAME must match the repo owner');
  assert.ok(R.checkSite({ provider: 'vercel', extra: 1 }).length);
  assert.equal(R.limitFor('Bob', { limits: { bob: 5 } }), 5);
  assert.equal(R.limitFor('carol', { limits: { bob: 5 }, maxPerOwner: 3 }), 3);
});

test('the request form offers exactly the providers the bot knows', () => {
  const yml = require('node:fs').readFileSync(require('node:path').join(__dirname, '../.github/ISSUE_TEMPLATE/request.yml'), 'utf8');
  const block = yml.split('id: provider')[1].split('validations:')[0];
  const options = [...block.matchAll(/^ {8}- (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(options, P.PROVIDERS.map((p) => p.label));
  for (const label of ['Subdomain', 'Where should it point?', 'GitHub repository', 'Target', 'Description']) {
    assert.ok(yml.includes(`label: ${label}`), label);
  }
});
