// I/O helpers for the bot: GitHub REST, reading domains/ out of git, DNS lookups.
'use strict';

const { execFileSync } = require('node:child_process');
const { Resolver } = require('node:dns').promises;
const R = require('./rules');

// ── GitHub ──────────────────────────────────────────────────────
/** DRY_RUN=1: reads go to GitHub, writes are only printed. */
function github(token, { dryRun = false } = {}) {
  async function req(method, path, body, { force = false } = {}) {
    if (dryRun && method !== 'GET' && !force) {
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
  async function graphql(query, variables = {}) {
    if (dryRun && /^\s*mutation/.test(query)) {
      console.log(`[dry-run] graphql ${query.trim().split('\n')[0]} ${JSON.stringify(variables).slice(0, 200)}`);
      return {};
    }
    const d = await req('POST', '/graphql', { query, variables }, { force: true });
    if (d.errors && d.errors.length) throw new Error(`graphql: ${d.errors.map((e) => e.message).join('; ')}`);
    return d.data;
  }
  return {
    req, all, graphql,
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

/** What a visitor would see at https://host: DNS answers, HTTP status, page title, and a hint. */
async function verifySite(host) {
  const out = { host, dns: [], status: null, title: null, error: null, hint: null, ms: null };
  for (const m of ['resolveCname', 'resolve4', 'resolve6']) {
    try { out.dns.push(...(await resolver[m](host)).map((v) => `${m === 'resolveCname' ? 'CNAME' : m === 'resolve4' ? 'A' : 'AAAA'} ${v}`)); } catch { /* none */ }
  }
  if (!out.dns.length) { out.hint = 'DNS has no answer yet. A new name can take a few minutes.'; return out; }
  const t = Date.now();
  try {
    const res = await fetch(`https://${host}/`, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'awesomeprojects-verify' } });
    out.ms = Date.now() - t;
    out.status = res.status;
    const html = (await res.text()).slice(0, 200000);
    const m = html.match(/<title[^>]*>([^<]{0,120})/i);
    out.title = m ? m[1].trim() : null;
    if (res.status === 404 && /github pages/i.test(html)) out.hint = 'GitHub Pages answers but has no site for this name: set the custom domain in the repo\'s Settings → Pages, and check the deploy workflow ran.';
    else if (/DEPLOYMENT_NOT_FOUND|The deployment could not be found on Vercel/i.test(html)) out.hint = 'Vercel answers but the domain isn\'t added to a project yet: Project → Settings → Domains.';
    else if (res.status >= 400) out.hint = 'The host answers with an error. Check your host\'s dashboard for this domain.';
  } catch (e) {
    out.ms = Date.now() - t;
    const code = (e.cause && (e.cause.code || e.cause.message)) || e.name || e.message;
    out.error = String(code);
    if (/CERT|SSL|TLS|ALTNAME/i.test(out.error)) out.hint = 'DNS works but HTTPS doesn\'t yet: your host hasn\'t issued a certificate for this name. That usually takes a few minutes after you add the domain there.';
    else if (/Timeout|ETIMEDOUT/i.test(out.error)) out.hint = 'Nothing answered within 10 seconds.';
    else out.hint = 'Couldn\'t connect over HTTPS.';
  }
  return out;
}

module.exports = { github, git, readTree, diff, resolves, checkTargets, verifySite };
