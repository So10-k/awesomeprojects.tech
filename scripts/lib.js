// I/O helpers for the bot: GitHub REST, reading domains/ out of git, DNS lookups.
'use strict';

const { execFileSync } = require('node:child_process');
const { Resolver } = require('node:dns').promises;
const R = require('./rules');

// ── GitHub ──────────────────────────────────────────────────────
/** DRY_RUN=1: reads go to GitHub, writes are only printed. */
function github(token, { dryRun = false } = {}) {
  async function req(method, path, body) {
    if (dryRun && method !== 'GET') {
      console.log(`[dry-run] ${method} ${path}${body ? ' ' + JSON.stringify(body).slice(0, 300) : ''}`);
      return method === 'POST' && /\/pulls$/.test(path) ? { number: 0, head: { sha: 'dry' } } : {};
    }
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'awesomeprojects-subdomain-bot',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path}: ${res.status} ${data && data.message}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  async function all(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const d = await req('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...d);
      if (d.length < 100) return out;
    }
  }
  return {
    req, all,
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    patch: (p, b) => req('PATCH', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p, b) => req('DELETE', p, b),
  };
}

// ── git ─────────────────────────────────────────────────────────
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

/** domains/ at a git ref → { entries: { name: data }, invalid: { name: message } }. Never executes anything. */
function readTree(ref) {
  const entries = {};
  const invalid = {};
  const blobs = git(['ls-tree', ref, 'domains/']).split('\n').filter(Boolean)
    .map((l) => { const [meta, file] = l.split('\t'); return { sha: meta.split(' ')[2], file }; })
    .filter((b) => b.file.endsWith('.json'));
  if (!blobs.length) return { entries, invalid };
  const out = execFileSync('git', ['cat-file', '--batch'], { input: blobs.map((b) => b.sha).join('\n') + '\n', maxBuffer: 1 << 28 });
  let pos = 0;
  for (const b of blobs) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString().split(' ')[2]);
    const content = out.subarray(nl + 1, nl + 1 + size).toString('utf8');
    pos = nl + 1 + size + 1;
    const name = R.nameFromFile(b.file);
    try { entries[name] = JSON.parse(content); } catch (e) { invalid[name] = e.message; }
  }
  return { entries, invalid };
}

/** [{ status, file }] from `from` to `to`. */
function diff(from, to) {
  return git(['diff', '--name-status', '--no-renames', from, to]).trim().split('\n').filter(Boolean)
    .map((l) => { const [status, file] = l.split('\t'); return { status: status[0], file }; });
}

// ── DNS ─────────────────────────────────────────────────────────
const resolver = new Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/** true: resolves · false: definitely doesn't exist · undefined: couldn't tell. */
async function resolves(host) {
  const h = host.replace(/\.$/, '');
  const tries = ['resolve4', 'resolve6', 'resolveCname'].map((m) => resolver[m](h).then(() => 'yes', (e) => e.code));
  const results = await Promise.all(tries);
  if (results.includes('yes')) return true;
  if (results.every((c) => c === 'ENOTFOUND' || c === 'ENODATA')) return false;
  return undefined;
}

/** { host: bool } for every CNAME/MX target in the given entries. */
async function checkTargets(datas) {
  const hosts = new Set();
  for (const d of datas) {
    const r = (d && d.records) || {};
    if (typeof r.CNAME === 'string') hosts.add(r.CNAME.toLowerCase().replace(/\.$/, ''));
    for (const mx of Array.isArray(r.MX) ? r.MX : []) {
      const h = typeof mx === 'string' ? mx : mx && mx.host;
      if (typeof h === 'string') hosts.add(h.toLowerCase().replace(/\.$/, ''));
    }
  }
  const out = {};
  await Promise.all([...hosts].map(async (h) => { out[h] = await resolves(h); }));
  return out;
}

module.exports = { github, git, readTree, diff, resolves, checkTargets };
