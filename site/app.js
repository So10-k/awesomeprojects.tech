// awesomeprojects.tech portal. Everything comes from data.json, built from the repo on every deploy
// (scripts/build-site.js), so names, reserved words, hosts and commands always match the bot.
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
const BASE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPO = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}\/[\w.-]{1,100}$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const BLURB = {
  hosted: 'We make you a private repo with a starter site, already live. Just push.',
  'github-pages': 'Free hosting for your repo: Next.js, Vite, Astro, plain HTML…',
  vercel: 'Full Next.js, server features included',
  netlify: 'Static sites and functions',
  'cloudflare-pages': 'Static sites on Cloudflare',
  render: 'Web services and static sites',
  railway: 'Apps and APIs',
  fly: 'Apps close to your users',
  cname: 'Any other host that gives you a hostname',
  server: 'A VPS or home server with a public IP',
};

let D = null; // data.json
let picked = null; // provider
let current = ''; // name

// ── Load ────────────────────────────────────────────────────────
fetch('data.json', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
  .then((data) => { D = data; init(); })
  .catch(() => { $('#stat').textContent = 'couldn\'t load the zone. Try reloading.'; });

function init() {
  const top = D.names.filter((n) => !n.name.includes('.'));
  const people = new Set(top.map((n) => n.owner)).size;
  $('#stat').textContent = `${top.length} name${top.length === 1 ? '' : 's'} · ${people} builder${people === 1 ? '' : 's'} · ${D.maxPerOwner} each`;
  renderHosts();
  renderZone('');
  renderCommands();
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('name');
  if (fromHash) { $('#name').value = fromHash; }
  lookup();
}

// ── The address bar ─────────────────────────────────────────────
const nameInput = $('#name');
$('#bar').addEventListener('click', () => nameInput.focus());
$('#bar').addEventListener('submit', (e) => { e.preventDefault(); if (!$('#claimBtn').disabled) claim(); });
nameInput.addEventListener('input', () => {
  const clean = nameInput.value.toLowerCase().replace(/\s+/g, '-').replace(/\.awesomeprojects\.tech\.?$/, '');
  if (clean !== nameInput.value) nameInput.value = clean;
  lookup();
});

function verdict(name) {
  if (!name) return { kind: 'empty' };
  if (name.includes('.')) return { kind: 'bad', why: 'one label only: names under another name are added by its owner' };
  if (!BASE_LABEL.test(name)) return { kind: 'bad', why: 'use a-z, 0-9 and dashes; no dash at the start or end; up to 63 characters' };
  if (name.startsWith('xn--')) return { kind: 'bad', why: 'punycode names aren\'t allowed' };
  if (D.reserved.includes(name)) return { kind: 'reserved' };
  const hit = D.names.find((n) => n.name === name);
  if (hit) return { kind: 'taken', hit };
  return { kind: 'free' };
}

function lookup() {
  const name = nameInput.value.trim();
  current = name;
  $('#sizer').textContent = name || nameInput.placeholder;
  const a = $('#answer');
  const btn = $('#claimBtn');
  if (!D) return;
  const v = verdict(name);
  a.replaceChildren(el('span', { className: 'semi', textContent: ';; ' }));
  const say = (cls, text) => a.append(el('span', { className: cls, textContent: text }));
  switch (v.kind) {
    case 'empty': say('', 'type a name to look it up'); break;
    case 'bad': say('no', `status: REFUSED · ${v.why}`); break;
    case 'reserved': say('no', `status: REFUSED · "${name}" is reserved`); break;
    case 'taken': {
      say('no', `ANSWER ${name}.${D.domain}.  ${v.hit.type}  ${v.hit.target}`);
      say('', `  ; taken by @${v.hit.owner}`);
      break;
    }
    case 'free': say('ok', `status: NXDOMAIN · nobody has ${name}.${D.domain}, so it's yours to claim`); break;
    default:
  }
  btn.disabled = v.kind !== 'free';
  btn.textContent = v.kind === 'free' ? `Claim ${name}.${D.domain}` : 'Claim this name';
  if (!$('#wizard').hidden) { $('#wizName').textContent = name || 'yourname'; updateRecord(); }
}

$('#claimBtn').addEventListener('click', claim);
function claim() {
  const w = $('#wizard');
  w.hidden = false;
  $('#wizName').textContent = current;
  updateRecord();
  w.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const first = w.querySelector('input[type=radio]:checked') || w.querySelector('input[type=radio]');
  if (first) first.focus({ preventScroll: true });
}

// ── Wizard ──────────────────────────────────────────────────────
function renderHosts() {
  const box = $('#hosts');
  for (const p of D.providers) {
    const id = `host-${p.id}`;
    const input = el('input', { type: 'radio', name: 'host', id, value: p.id });
    input.addEventListener('change', () => pick(p));
    const short = p.id === 'hosted' ? 'Host it for me' : p.id === 'github-pages' ? 'GitHub repo' : p.id === 'cname' ? 'Another host' : p.id === 'server' ? 'Own server' : p.label;
    box.append(el('div', { className: 'host' }, [input, el('label', { htmlFor: id }, [el('b', { textContent: short }), el('small', { textContent: BLURB[p.id] || '' })])]));
  }
}

function pick(p) {
  picked = p;
  $('#details').hidden = false;
  $('#repoField').hidden = p.input !== 'repo';
  $('#targetField').hidden = !(p.input === 'target' || p.input === 'ips');
  if (p.input === 'ips') {
    $('#targetLabel').textContent = 'IP address(es)';
    $('#target').placeholder = '203.0.113.7, 2001:db8::7';
    $('#targetHelp').textContent = 'Public IPv4 or IPv6, separated by commas.';
  } else if (p.input === 'target') {
    $('#targetLabel').textContent = p.id === 'cname' ? 'Hostname' : `${p.label} address`;
    $('#target').placeholder = p.suffix ? `my-site${p.suffix}` : 'something.example.com';
    $('#targetHelp').textContent = p.suffix ? `Just the name is fine: we add ${p.suffix}.` : 'The hostname your host gave you.';
  }
  updateRecord();
}

function compute() {
  if (!picked) return { ok: false, note: 'pick a host' };
  const owner = (s) => s.split('/')[0].toLowerCase();
  const p = picked;
  if (p.input === 'repo') {
    const repo = cleanRepo($('#repo').value);
    if (!repo) return { ok: false, note: 'enter owner/repo' };
    return { ok: true, type: 'CNAME', value: `${owner(repo)}.github.io.`, form: { repo } };
  }
  if (p.id === 'hosted') {
    if (!D.sitesOrg) return { ok: false, note: 'hosting isn\'t switched on yet' };
    return { ok: true, type: 'CNAME', value: `${D.sitesOrg.toLowerCase()}.github.io.`, form: {} };
  }
  if (p.id === 'vercel') return { ok: true, type: 'CNAME', value: 'cname.vercel-dns.com.', form: {} };
  const raw = $('#target').value.trim().toLowerCase();
  if (p.input === 'ips') {
    const ips = raw.split(/[\s,]+/).filter(Boolean);
    if (!ips.length) return { ok: false, note: 'enter an IP address' };
    const bad = ips.find((ip) => !(IPV4.test(ip) || (ip.includes(':') && /^[0-9a-f:.]+$/.test(ip))));
    if (bad) return { ok: false, note: `"${bad}" isn't an IP address` };
    return { ok: true, multi: ips.map((ip) => [ip.includes(':') ? 'AAAA' : 'A', ip]), form: { target: ips.join(', ') } };
  }
  let host = raw.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (!host) return { ok: false, note: p.hint || 'enter a hostname' };
  if (p.suffix && !host.includes('.')) host += p.suffix;
  if (p.suffix && !host.endsWith(p.suffix)) return { ok: false, note: `a ${p.label} address ends in ${p.suffix}` };
  if (!host.split('.').every((l) => HOST_LABEL.test(l)) || host.split('.').length < 2) return { ok: false, note: `"${host}" isn't a hostname` };
  if (host.endsWith(D.domain)) return { ok: false, note: `point at your real host, not back into ${D.domain}` };
  return { ok: true, type: 'CNAME', value: `${host}.`, form: { target: host } };
}

function updateRecord() {
  const r = compute();
  const name = current || 'yourname';
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, Math.max(n, s.length + 1));
  let text;
  if (!r.ok) text = `${pad(name, 14)} ?      …`;
  else if (r.multi) text = r.multi.map(([t, v]) => `${pad(name, 14)}${pad(t, 7)}${v}`).join('\n');
  else text = `${pad(name, 14)}${pad(r.type, 7)}${r.value}`;
  $('#record').textContent = text;
  $('#recordNote').textContent = r.ok ? `${name}.${D.domain}` : r.note;
  const send = $('#sendBtn');
  const sendGh = $('#sendGh');
  const ready = r.ok && verdict(current).kind === 'free';
  for (const b of [send, sendGh]) b.setAttribute('aria-disabled', String(!ready));
  if (ready) {
    const desc = $('#desc').value.trim();
    const q = new URLSearchParams({
      template: 'request.yml',
      title: `Request: ${current}`,
      subdomain: current,
      provider: picked.label,
      ...r.form,
      ...(desc ? { description: desc } : {}),
    });
    sendGh.href = `https://github.com/${D.repo}/issues/new?${q}`;
    send.href = `me/?${new URLSearchParams({ new: '', name: current, provider: picked.label, ...r.form, ...(desc ? { description: desc } : {}) })}`;
  } else { send.removeAttribute('href'); sendGh.removeAttribute('href'); }
}
for (const id of ['#target', '#desc']) $(id).addEventListener('input', updateRecord);

function cleanRepo(s) {
  const m = String(s || '').trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').match(/^([^/\s]+)\/([^/\s#?]+)/);
  return m && REPO.test(`${m[1]}/${m[2]}`) ? `${m[1]}/${m[2]}` : null;
}

// Repo preview (GitHub's public API, no login).
let repoTimer;
$('#repo').addEventListener('input', () => {
  updateRecord();
  clearTimeout(repoTimer);
  repoTimer = setTimeout(previewRepo, 450);
});
async function previewRepo() {
  const card = $('#repoCard');
  const repo = cleanRepo($('#repo').value);
  if (!repo) { card.hidden = true; return; }
  card.hidden = false;
  card.textContent = `Looking up ${repo}…`;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`);
    if (r.status === 404) { card.replaceChildren(el('span', { className: 'bad', textContent: `Can't find ${repo}. Is it public and spelled right?` })); return; }
    if (!r.ok) throw new Error(String(r.status));
    const info = await r.json();
    const bits = [el('b', { textContent: info.full_name }), ` · ★ ${info.stargazers_count}${info.language ? ` · ${info.language}` : ''}`];
    if (info.description) bits.push(el('br'), info.description);
    card.replaceChildren(...bits);
    if (info.archived) card.append(el('span', { className: 'note', textContent: 'This repo is archived: unarchive it to deploy.' }));
    const pkg = await fetch(`https://raw.githubusercontent.com/${info.full_name}/${encodeURIComponent(info.default_branch)}/package.json`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
    const fw = pkg ? D.frameworks.find((f) => deps[f.dep]) : null;
    const label = fw ? fw.label : pkg ? 'a Node project (npm run build)' : 'plain HTML';
    card.append(el('span', { className: 'note', textContent: `Builds as ${label}${fw && fw.id === 'next' ? ' (static export; API routes and SSR need Vercel)' : ''}.` }));
  } catch {
    card.textContent = 'Couldn\'t check the repo right now. The bot will check it when you send the request.';
  }
}

// ── The zone ────────────────────────────────────────────────────
$('#filter').addEventListener('input', (e) => renderZone(e.target.value));
function renderZone(q) {
  const box = $('#zonefile');
  const needle = q.trim().toLowerCase();
  const rows = D.names
    .filter((n) => !n.name.includes('.'))
    .filter((n) => !needle || [n.name, n.owner, n.host, n.target, n.description || ''].some((s) => String(s).toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [el('div', { className: 'zf-comment', textContent: `; ${D.domain} · ${rows.length} record${rows.length === 1 ? '' : 's'}${needle ? ` matching "${q.trim()}"` : ''} · updated ${new Date(D.generatedAt).toLocaleDateString()}` })];
  for (const n of rows) {
    const url = `https://${n.name}.${D.domain}`;
    out.push(el('div', { className: 'zf-row', role: 'listitem' }, [
      el('a', { href: url, textContent: n.name, target: '_blank', rel: 'noopener' }),
      el('span', { className: 'zf-type', textContent: n.type }),
      el('span', { className: 'zf-target', textContent: n.target, title: n.target }),
      el('span', { className: 'zf-note', textContent: `; @${n.owner} · ${n.host}${n.description ? ` · ${n.description}` : ''}`, title: n.description || '' }),
    ]));
  }
  if (rows.length === 0) out.push(el('div', { className: 'zf-comment', textContent: needle ? '; nothing matches. Maybe it\'s free? Type it in the bar above.' : '; no names yet. Be the first.' }));
  box.replaceChildren(...out);
}

// ── Commands ────────────────────────────────────────────────────
function renderCommands() {
  const seen = new Set();
  for (const c of D.commands) {
    const key = `${c.admin ? 'a' : 'u'}${c.usage}`;
    if (seen.has(key)) continue;
    seen.add(key);
    $(c.admin ? '#cmdAdmin' : '#cmdUser').append(el('dt', { textContent: c.usage }), el('dd', { textContent: c.does.replace(/`/g, '') }));
  }
}
