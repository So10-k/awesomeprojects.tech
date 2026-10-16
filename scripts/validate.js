#!/usr/bin/env node
// Validates everything in domains/ (run before every deploy, and locally with `npm run validate`).
// Pull requests are reviewed by scripts/bot.js, which uses the same rules.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const R = require('./rules');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'domains');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const reserved = read('reserved.json');
const config = read('config.json');
const maintainers = [process.env.GITHUB_REPOSITORY_OWNER, ...(config.maintainers || [])].filter(Boolean);

const problems = []; // [file, message]
const entries = {};

for (const f of fs.readdirSync(dir).sort()) {
  if (f === '.gitkeep') continue;
  const name = R.nameFromFile(f);
  if (!name) { problems.push([`domains/${f}`, 'only .json files belong in domains/']); continue; }
  try {
    entries[name] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch (e) {
    problems.push([`domains/${f}`, `invalid JSON: ${e.message}`]);
  }
}

const opts = { reserved, maintainers, maxPerOwner: config.maxPerOwner };
for (const [name, errs] of Object.entries(R.checkTree(entries, opts))) {
  for (const e of errs) problems.push([`domains/${name}.json`, e]);
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n${problems.map(([f, m]) => `- ${f}: ${m}`).join('\n')}`);
  if (process.env.GITHUB_ACTIONS) for (const [f, m] of problems) console.log(`::error file=${f}::${m}`);
  process.exit(1);
}
console.log(`✓ ${Object.keys(entries).length} subdomain file(s) look good`);
