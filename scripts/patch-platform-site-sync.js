#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const platformRepo = config.platformRepo;
const token = String(process.env.BOT_PAT || '').trim();
if (!token) throw new Error('BOT_PAT required');

async function gh(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'awesomeprojects-platform-patch',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status} ${text.slice(0, 400)}`);
  return data;
}

(async () => {
  const file = await gh(`/repos/${platformRepo}/contents/scripts/bot.js?ref=main`);
  let src = Buffer.from(file.content, 'base64').toString('utf8');
  const old = "    case '/site-sync': {\n      if (kind === 'discussion') return undefined;\n      needOrg();\n";
  const neu = "    case '/site-sync': {\n      if (kind === 'discussion') return undefined;\n      needHosting();\n";
  if (!src.includes(old)) {
    if (src.includes(neu)) { console.log('Already patched'); return; }
    throw new Error('Expected site-sync/needOrg block not found');
  }
  src = src.replace(old, neu);
  await gh(`/repos/${platformRepo}/contents/scripts/bot.js`, {
    method: 'PUT',
    body: {
      message: 'site-sync: use needHosting so EMU-only orgs work',
      content: Buffer.from(src).toString('base64'),
      sha: file.sha,
      branch: 'main',
    },
  });
  console.log('Patched', platformRepo, 'scripts/bot.js');
})().catch((e) => { console.error(e); process.exit(1); });
