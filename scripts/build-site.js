#!/usr/bin/env node
// Builds the website: copies site/ to _site/ and writes _site/data.json from the repo
// (names, reserved words, hosts, frameworks, commands), so the site always matches the bot.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const R = require('./rules');
const P = require('./providers');
const F = require('./frameworks');
const C = require('./commands');

const root = process.env.REPO_ROOT || path.join(__dirname, '..');
// `node scripts/build-site.js web` feeds the Astro site (web/): data for the pages, plus the pages that
// aren't Astro yet (My domains, the old console) as static files. Any other argument: the old static site.
const forWeb = process.argv[2] === 'web';
const out = path.join(root, forWeb ? 'web/public' : (process.argv[2] || '_site'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const names = [];
for (const f of fs.readdirSync(path.join(root, 'domains')).sort()) {
  const name = R.nameFromFile(f);
  if (!name) continue;
  let d;
  try { d = read(`domains/${f}`); } catch { continue; }
  const r = d.records || {};
  const [type, value] = r.CNAME ? ['CNAME', r.CNAME] : r.A ? ['A', r.A.join(', ')] : r.AAAA ? ['AAAA', r.AAAA.join(', ')] : r.MX ? ['MX', 'mail'] : ['TXT', '…'];
  names.push({
    name,
    owner: R.ownerOf(d),
    type,
    target: String(value).replace(/\.$/, ''),
    host: C.hostOf(d),
    description: d.description || undefined,
    repo: d.site && d.site.repo,
    status: d.site && d.site.provider === 'hosted' ? d.site.status || 'active' : undefined,
    records: d.records,
  });
}

const config = read('config.json');
const live = !!(config.ghes && config.ghes.live && config.ghes.host);
const data = {
  domain: R.DOMAIN,
  repo: process.env.GITHUB_REPOSITORY || 'So10-k/awesomeprojects.tech',
  generatedAt: new Date().toISOString(),
  maxPerOwner: config.maxPerOwner,
  locked: config.locked || false,
  owner: (process.env.GITHUB_REPOSITORY || 'So10-k/awesomeprojects.tech').split('/')[0],
  panelApi: process.env.PANEL_API || 'https://api.awesomeprojects.tech',
  maintainers: config.maintainers || [],
  bannedUsers: config.bannedUsers || [],
  limits: config.limits || {},
  reserved: read('reserved.json'),
  names,
  providers: P.PROVIDERS,
  frameworks: F.FRAMEWORKS.map(({ id, label, dep }) => ({ id, label, dep })),
  commands: C.CATALOG,
  sitesOrg: config.sitesOrg || '',
  // Hosted sites and people's accounts: our server once it's live (config.ghes.live), else the managed enterprise.
  emuOrg: (live && config.ghes.org) || (config.emu && config.emu.org) || '',
  // Hosted repos live in the managed enterprise; links to them go to its host (e.g. awesome-projects.ghe.com).
  emuHost: (live && config.ghes.host) || (config.emu && config.emu.host) || '',
  signIn: live ? `https://${config.ghes.host}/login`
    : config.emu && config.emu.enterprise ? `https://${(config.emu.host || 'github.com')}/enterprises/${config.emu.enterprise}/sso` : '',
  announcement: config.announcement || '',
  // The public roster (maintainers.json): ranks and rolesets, for the maintainers page.
  roster: (() => {
    try {
      const m = read('maintainers.json');
      return (m.people || []).filter((p) => (p.status || 'active') !== 'emeritus').map(({ github, rank, rolesets, status, since }) => ({ github, rank, rolesets: rolesets || [], status: status || 'active', since: since || null }));
    } catch { return []; }
  })(),
  templates: require('./sites').TEMPLATES,
  settings: Object.fromEntries(Object.entries(C.SETTINGS).map(([k, v]) => [k, { ...v, value: config[k] }])),
};

if (forWeb) {
  // Astro reads src/generated/data.json at build time; the browser fetches public/data.json.
  const gen = path.join(root, 'web/src/generated');
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(path.join(gen, 'data.json'), JSON.stringify(data, null, 1));
  fs.mkdirSync(out, { recursive: true });
  for (const keep of ['me', 'admin', 'session.js', 'style.css', 'legacy-theme.css']) {
    const from = path.join(root, 'site', keep);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(out, keep), { recursive: true });
  }
  fs.cpSync(path.join(root, 'brand'), path.join(out, 'brand'), { recursive: true });
  fs.copyFileSync(path.join(root, 'brand/favicon.svg'), path.join(out, 'favicon.svg'));
  fs.writeFileSync(path.join(out, 'data.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log(`web data → web/src/generated/data.json + web/public/ (${names.length} names)`);
} else {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'site'), out, { recursive: true });
  fs.writeFileSync(path.join(out, 'data.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  console.log(`site → ${path.relative(root, out)}/ (${names.length} names)`);
}
