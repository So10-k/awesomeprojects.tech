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
  const [type, value] = r.NS ? ['NS', r.NS.join(', ')] : r.CNAME ? ['CNAME', r.CNAME] : r.A ? ['A', r.A.join(', ')] : r.AAAA ? ['AAAA', r.AAAA.join(', ')] : r.MX ? ['MX', 'mail'] : ['TXT', '…'];
  names.push({
    name,
    owner: R.ownerOf(d),
    type,
    target: String(value).replace(/\.$/, ''),
    host: C.hostOf(d),
    description: d.description || undefined,
    repo: d.site && d.site.repo,
    status: d.site && d.site.provider === 'hosted' ? d.site.status || 'active' : undefined,
    hold: d.hold || undefined,
    records: d.records,
  });
}

// Transparency: what happened to names each month, read from the zone's git history (commit titles say
// which kind of removal it was: "Remove", "Take down" or "Release"; holds are "Hold <name>: not renewed").
function transparency() {
  let log;
  try {
    log = require('node:child_process').execFileSync('git', ['log', '--format=@@%ct\t%s', '--name-status', '--', 'domains/'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const months = {};
  const bump = (t, k) => { const m = new Date(t * 1000).toISOString().slice(0, 7); (months[m] ||= { month: m, registered: 0, removed: 0, takedowns: 0, held: 0, released: 0 })[k]++; };
  let t = 0, subject = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) {
      [t, subject] = line.slice(2).split('\t'); t = Number(t);
      if (/^Hold [^\s:]+: not renewed/.test(subject)) bump(t, 'held');
      continue;
    }
    const m = /^([AD])\tdomains\/([^/]+)\.json$/.exec(line);
    if (!m || m[2].includes('.')) continue; // top-level names only
    if (m[1] === 'A') bump(t, 'registered');
    else bump(t, /^Take down /.test(subject) ? 'takedowns' : /^Release /.test(subject) ? 'released' : 'removed');
  }
  const rows = Object.values(months).sort((x, y) => y.month.localeCompare(x.month));
  if (!rows.length) return null;
  const total = rows.reduce((o, r) => { for (const k of Object.keys(r)) if (k !== 'month') o[k] = (o[k] || 0) + r[k]; return o; }, {});
  return { since: rows[rows.length - 1].month, total, months: rows.slice(0, 12) };
}

// The changelog: changes to how the registry works, from main's history. Commits that only change data
// (names, the roster, settings, reserved words: the bot makes those all day) are left out.
function changelog(limit = 120) {
  let log;
  try {
    log = require('node:child_process').execFileSync('git', ['log', '--first-parent', '--format=@@%h\t%ct\t%s', '--name-only', '-n', '600', 'HEAD'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const DATA = /^(domains\/|maintainers\.json$|config\.json$|reserved\.json$)/;
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.files.some((f) => !DATA.test(f))) out.push({ sha: cur.sha, at: cur.at, title: cur.title.replace(/\s*\(#\d+\)$/, ''), pr: cur.pr }); };
  for (const line of log.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      const [sha, ct, ...rest] = line.slice(2).split('\t');
      const title = rest.join('\t');
      const m = /\(#(\d+)\)$/.exec(title);
      cur = { sha, at: Number(ct) * 1000, title, pr: m ? Number(m[1]) : null, files: [] };
    } else if (line.trim() && cur) cur.files.push(line.trim());
  }
  flush();
  return out.filter((c) => !/^Merge (branch|pull request)/.test(c.title)).slice(0, limit);
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
  transparency: transparency(),
  changelog: changelog(),
  onHold: names.filter((n) => n.hold).length,
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
