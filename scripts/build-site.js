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
const out = path.join(root, process.argv[2] || '_site');
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
  emuOrg: (config.emu && config.emu.org) || '',
  // Hosted repos live in the managed enterprise; links to them go to its host (e.g. awesome-projects.ghe.com).
  emuHost: (config.emu && config.emu.host) || '',
  signIn: config.emu && config.emu.enterprise ? `https://${(config.emu.host || 'github.com')}/enterprises/${config.emu.enterprise}/sso` : '',
  announcement: config.announcement || '',
  templates: require('./sites').TEMPLATES,
  settings: Object.fromEntries(Object.entries(C.SETTINGS).map(([k, v]) => [k, { ...v, value: config[k] }])),
};

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
fs.writeFileSync(path.join(out, 'data.json'), JSON.stringify(data));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`site → ${path.relative(root, out)}/ (${names.length} names)`);
