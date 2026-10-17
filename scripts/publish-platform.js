#!/usr/bin/env node
// Create/update the private EMU platform repo (bot, worker, site-build, reusable workflows).
// Run from the public registry repo with BOT_PAT (a provisioned owner of the managed org).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const platformRepo = (config.platformRepo || (config.emu && config.emu.org ? `${config.emu.org}/platform` : '')).replace(/^\/+|\/+$/g, '');
const token = String(process.env.BOT_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
if (!platformRepo) throw new Error('config.json → platformRepo (or emu.org) is required');
if (!token) throw new Error('BOT_PAT (or GH_TOKEN) is required');

const [org, name] = platformRepo.split('/');
if (!org || !name) throw new Error(`Bad platformRepo: ${platformRepo}`);

const PATHS = [
  'scripts',
  'worker',
  'templates',
  'test',
  'docs/MANAGED.md',
  'docs/MAINTAINERS.md',
  'docs/PANEL.md',
  'package.json',
  '.github/workflows/cf-pages-site.yml',
  '.github/workflows/pages-site.yml',
  '.github/workflows/panel.yml',
];

const staging = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ap-platform-'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const sh = (c, opts = {}) => execFileSync('bash', ['-lc', c], { stdio: 'inherit', ...opts });

async function gh(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'awesomeprojects-platform-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${pathname}: ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function copyIntoStaging() {
  for (const p of PATHS) {
    const src = path.join(root, p);
    if (!fs.existsSync(src)) throw new Error(`Missing ${p} (already moved?). Run this before stripping the public repo.`);
    const dest = path.join(staging, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  // Platform README
  fs.writeFileSync(path.join(staging, 'README.md'), `# awesomeprojects.tech platform (private)

Private ops for the managed-user enterprise: bot, panel Worker, site-build scripts, and reusable
deploy workflows. Site repos in \`${org}\` call workflows here; the public registry is
[\`So10-k/awesomeprojects.tech\`](https://github.com/So10-k/awesomeprojects.tech).

## Secrets

Copy from the public registry (or set fresh): \`BOT_PAT\`, \`EMU_ADMIN_TOKEN\`,
\`CLOUDFLARE_PAGES_TOKEN\`, \`CLOUDFLARE_ACCOUNT_ID\`, \`CLOUDFLARE_WORKERS_TOKEN\`,
\`PANEL_*\`, \`PANEL_BOT_SECRET\`, \`PANEL_SAML_*\`, etc. See \`docs/PANEL.md\` and \`docs/MANAGED.md\`.

## Develop

\`\`\`bash
npm test
\`\`\`
`);
  // Platform-only bot workflow (optional direct runs) + thin note
  fs.mkdirSync(path.join(staging, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(staging, '.github/workflows/checks.yml'), `name: Checks
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
`);
}

async function ensureRepo() {
  try {
    await gh(`/repos/${platformRepo}`);
    console.log(`Repo ${platformRepo} exists`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`Creating ${platformRepo}…`);
    await gh(`/orgs/${org}/repos`, {
      method: 'POST',
      body: {
        name,
        private: true,
        description: 'Private awesomeprojects.tech platform (bot, panel, site builds)',
        auto_init: true,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      },
    });
    // wait for auto_init
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function pushStaging() {
  const url = `https://x-access-token:${token}@github.com/${platformRepo}.git`;
  run('git', ['init', '-b', 'main'], { cwd: staging });
  run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: staging });
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: staging });
  run('git', ['add', '-A'], { cwd: staging });
  run('git', ['commit', '-m', 'Sync platform from public registry'], { cwd: staging });
  // Platform content is owned here; replace remote main.
  sh(`git remote add origin '${url.replace(/'/g, "'\\''")}' && git push -u origin main --force`, { cwd: staging });
}

(async () => {
  console.log(`Publishing → ${platformRepo}`);
  copyIntoStaging();
  await ensureRepo();
  pushStaging();
  console.log('Done:', `https://github.com/${platformRepo}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
