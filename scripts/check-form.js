#!/usr/bin/env node
// The issue form lives here; provider labels live in scripts/providers.js (also copied to platform).
// Platform's unit test skips this file because it is not in that repo.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const P = require('./providers');

const yml = fs.readFileSync(path.join(__dirname, '../.github/ISSUE_TEMPLATE/request.yml'), 'utf8');
const block = yml.split('id: provider')[1].split('validations:')[0];
const options = [...block.matchAll(/^ {8}- (.+)$/gm)].map((m) => m[1].trim());
const labels = P.PROVIDERS.map((p) => p.label);
if (options.join('\n') !== labels.join('\n')) {
  console.error('Request form providers:\n' + options.join('\n'));
  console.error('Bot providers:\n' + labels.join('\n'));
  process.exit(1);
}
for (const label of ['Subdomain', 'Where should it point?', 'GitHub repository', 'Target', 'Description']) {
  if (!yml.includes(`label: ${label}`)) {
    console.error(`Request form is missing label: ${label}`);
    process.exit(1);
  }
}
console.log(`✓ request form matches ${labels.length} providers`);
