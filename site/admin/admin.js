// awesomeprojects.tech console. A thin UI over the bot: every action posts a real slash command
// as the signed-in maintainer (so it's logged as them), then shows the bot's answer.
// Permissions are enforced by the bot, not here: this page only hides what you can't use.
'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k !== null && k !== undefined) n.append(k);
  return n;
};
const lc = (s) => String(s || '').toLowerCase();
const LOG_TITLE = '📜 Bot activity log';
const CONSOLE_TITLE = '🛠️ Admin console';
const KEY = 'ap.console.token';

let D = null; // ../data.json
let R = ''; // owner/repo
let token = null;
let me = null;
let role = 'none'; // owner | maintainer | none
let live = { config: null, reserved: null };
let openItems = [];
let consoleIssue = null;

// ── GitHub API ─────────────────────────────────────────────────
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message; } catch { /* plain text */ }
    const e = new Error(`${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return raw ? text : text ? JSON.parse(text) : null;
}
async function allPages(path) {
  const out = [];
  for (let page = 1; page < 10; page++) {
    const d = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...d);
    if (d.length < 100) break;
  }
  return out;
}
async function gql(query, variables = {}) {
  const d = await api('/graphql', { method: 'POST', body: { query, variables } });
  if (d.errors) throw new Error(d.errors[0].message);
  return d.data;
}
const renderMarkdown = (text) => api('/markdown', { method: 'POST', body: { text, mode: 'gfm', context: R }, raw: true });
const fileJson = async (p) => JSON.parse(atob((await api(`/repos/${R}/contents/${p}`)).content.replace(/\n/g, '')));

// ── Toasts ─────────────────────────────────────────────────────
function toast(title, { body, html, kind = '', ms = 6000 } = {}) {
  const t = el('div', { className: `toast ${kind}` }, [el('b', { textContent: title })]);
  if (body) t.append(el('div', { textContent: body }));
  if (html) { const d = el('div', { className: 'md' }); d.innerHTML = html; t.append(d); }
  $('#toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  t.addEventListener('click', () => t.remove());
  return t;
}

// ── The command line: preview, then post as you ────────────────
let pending = null;
function propose(command, target) {
  if (role === 'none') { toast('Not a maintainer', { body: 'The bot would ignore this command from you.', kind: 'err' }); return; }
  pending = { command, target };
  $('#cmdText').textContent = command;
  $('#cmdWhere').textContent = target === 'console' ? `on ${consoleIssue ? `#${consoleIssue.number}` : 'the admin console issue'} as @${me.login}` : `on #${target} as @${me.login}`;
  $('#cmdline').hidden = false;
  $('#cmdRun').focus();
}
$('#cmdCancel').addEventListener('click', () => { pending = null; $('#cmdline').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cmdline').hidden) $('#cmdCancel').click(); });
$('#cmdRun').addEventListener('click', async () => {
  if (!pending) return;
  const { command, target } = pending;
  pending = null;
  $('#cmdline').hidden = true;
  try {
    const number = target === 'console' ? (await ensureConsole()).number : target;
    const posted = await api(`/repos/${R}/issues/${number}/comments`, { method: 'POST', body: { body: command } });
    const waiting = toast(`Posted ${command.split(' ')[0]} on #${number}`, { body: 'Waiting for the bot…', ms: 0 });
    watchForBot(number, posted.created_at, waiting);
  } catch (e) {
    toast('Couldn\'t post', { body: e.message, kind: 'err' });
  }
});

async function ensureConsole() {
  if (consoleIssue) return consoleIssue;
  const found = openItems.find((i) => i.title === CONSOLE_TITLE && !i.pull_request);
  if (found) return (consoleIssue = found);
  consoleIssue = await api(`/repos/${R}/issues`, {
    method: 'POST',
    body: { title: CONSOLE_TITLE, body: 'Maintainer commands from the [console](https://awesomeprojects.tech/admin/) (and by hand) land here, so this thread is the audit trail. Every change is also posted to the 📜 Bot activity log.' },
  });
  return consoleIssue;
}

/** Poll until the bot comments or edits its comment after `since`. */
async function watchForBot(number, since, waitingToast) {
  const started = Date.now();
  while (Date.now() - started < 150000) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const comments = await api(`/repos/${R}/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=100`);
      const bot = comments.filter((c) => c.user && c.user.type === 'Bot' && c.updated_at > since).pop();
      if (bot) {
        waitingToast.remove();
        const text = bot.body.replace(/^<!--.*?-->\n?/, '').split('<details>\n<summary>🤖')[0].trim();
        toast(`The bot answered on #${number}`, { html: await renderMarkdown(text), kind: 'ok', ms: 15000 });
        setTimeout(loadAll, 1500);
        return;
      }
    } catch { /* keep waiting */ }
  }
  waitingToast.remove();
  toast(`No answer yet on #${number}`, { body: 'The bot may be queued. Check the issue in a minute.', kind: 'err', ms: 10000 });
}

function askReason(title, label, initial = '') {
  const d = $('#reasonDialog');
  $('#reasonTitle').textContent = title;
  $('#reasonLabel').textContent = label;
  $('#reasonInput').value = initial;
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? $('#reasonInput').value.trim() : null), { once: true });
  });
}

// ── Sign in ────────────────────────────────────────────────────
function getToken() { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY); }
$('#tokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#token').value.trim();
  $('#signinError').textContent = '';
  try {
    await signIn(t);
    (($('#remember').checked) ? localStorage : sessionStorage).setItem(KEY, t);
    $('#token').value = '';
  } catch (err) {
    token = null;
    $('#signinError').textContent = err.status === 401 ? 'GitHub didn\'t accept that token.' : `Couldn't sign in: ${err.message}`;
  }
});
$('#signOut').addEventListener('click', () => {
  sessionStorage.removeItem(KEY);
  localStorage.removeItem(KEY);
  location.reload();
});

async function signIn(t) {
  token = t;
  me = await api('/user');
  try { live.config = await fileJson('config.json'); } catch { live.config = null; }
  const maint = (live.config ? live.config.maintainers : D.maintainers || []).map(lc);
  role = lc(me.login) === lc(D.owner) ? 'owner' : maint.includes(lc(me.login)) ? 'maintainer' : 'none';
  $('#signin').hidden = true;
  $('#app').hidden = false;
  $('#who').hidden = false;
  $('#whoAvatar').src = `${me.avatar_url}&s=56`;
  $('#whoName').textContent = `@${me.login}`;
  $('#whoRole').textContent = role === 'none' ? 'visitor' : role;
  $('#whoRole').classList.toggle('none', role === 'none');
  $('#notMaintainer').hidden = role !== 'none';
  $('#ownerTab').hidden = role !== 'owner';
  await loadAll();
}

// ── Tabs ───────────────────────────────────────────────────────
for (const b of $$('.tabs button')) {
  b.addEventListener('click', () => {
    for (const x of $$('.tabs button')) x.setAttribute('aria-selected', String(x === b));
    for (const p of $$('.panel')) p.hidden = p.dataset.panel !== b.dataset.tab;
    if (b.dataset.tab === 'log') loadLog();
  });
}

// ── Data ───────────────────────────────────────────────────────
async function loadAll() {
  try {
    [openItems, live.config, live.reserved] = await Promise.all([
      allPages(`/repos/${R}/issues?state=open`),
      fileJson('config.json').catch(() => live.config),
      fileJson('reserved.json').catch(() => D.reserved),
    ]);
  } catch (e) {
    toast('Couldn\'t load from GitHub', { body: e.message, kind: 'err' });
    return;
  }
  consoleIssue = openItems.find((i) => i.title === CONSOLE_TITLE && !i.pull_request) || consoleIssue;
  const cfg = live.config || {};
  $('#lockedBanner').hidden = !cfg.locked;
  $('#lockedBanner').textContent = cfg.locked ? `🔒 Requests are paused${typeof cfg.locked === 'string' ? `: ${cfg.locked}` : ''}.` : '';
  renderQueue();
  renderReports();
  renderNames();
  renderPeople(cfg);
  renderMaint(cfg);
  renderOwner(cfg);
}

const labelsOf = (i) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const subdomainOf = (i) => {
  const m = String(i.body || '').match(/### Subdomain\s+([^\n#]+)/);
  return (m && m[1].trim().toLowerCase().replace(/\.awesomeprojects\.tech\.?$/, '')) || i.title.replace(/^(Request|Transfer|Takedown):\s*/i, '');
};

function card(i, actions) {
  const labels = labelsOf(i);
  const kind = i.pull_request ? 'PR' : labels.includes('transfer') ? 'Transfer' : labels.includes('takedown') ? 'Report' : 'Request';
  const c = el('article', { className: 'card' }, [
    el('div', { className: 'card-top' }, [
      el('a', { className: 'card-name', href: i.html_url, target: '_blank', rel: 'noopener', textContent: i.pull_request ? i.title : subdomainOf(i) }),
      el('span', { className: 'card-meta', textContent: `${kind} #${i.number}` }),
    ]),
    el('div', { className: 'card-meta' }, [`@${i.user.login} · ${ago(i.created_at)} ago · `, el('a', { href: i.html_url, target: '_blank', rel: 'noopener', textContent: `${i.comments} comment${i.comments === 1 ? '' : 's'}` })]),
    el('div', { className: 'labels' }, labels.filter((l) => !['request'].includes(l)).map((l) => el('span', { className: `label ${l}`, textContent: l }))),
  ]);
  const det = el('details', { className: 'bot-says' }, [el('summary', { textContent: 'What the bot says' })]);
  det.addEventListener('toggle', async () => {
    if (!det.open || det.dataset.loaded) return;
    det.dataset.loaded = '1';
    const box = el('div', { className: 'md', textContent: 'Loading…' });
    det.append(box);
    try {
      const comments = await allPages(`/repos/${R}/issues/${i.number}/comments`);
      const bot = comments.find((x) => x.user.type === 'Bot' && /^<!-- subdomain-bot:/.test(x.body));
      box.innerHTML = bot ? await renderMarkdown(bot.body.split('<details>\n<summary>🤖')[0]) : '<p>No review yet.</p>';
    } catch (e) { box.textContent = e.message; }
  });
  c.append(det);
  const row = el('div', { className: 'card-actions' });
  for (const [label, cls, fn] of actions) {
    const b = el('button', { className: `btn ${cls}`, type: 'button', textContent: label });
    b.addEventListener('click', fn);
    row.append(b);
  }
  c.append(row);
  return c;
}

const withReason = (cmd, number, title, label) => async () => {
  const r = await askReason(title, label);
  if (r !== null) propose(r ? `${cmd} ${r}` : cmd, number);
};

function renderQueue() {
  const items = openItems.filter((i) => {
    const l = labelsOf(i);
    return l.includes('request') || l.includes('transfer') || (i.pull_request && !i.title.startsWith('Remove '));
  });
  const lanes = [
    ['Ready', (l) => l.includes('ready')],
    ['Waiting on someone', (l) => !l.includes('ready') && !l.includes('needs-changes')],
    ['Needs changes', (l) => l.includes('needs-changes')],
  ];
  const box = $('#lanes');
  box.replaceChildren();
  let total = 0;
  for (const [name, test] of lanes) {
    const mine = items.filter((i) => test(labelsOf(i)));
    if (name === 'Ready') total = mine.length;
    const lane = el('section', { className: 'lane' }, [el('h2', {}, [name, el('span', { textContent: String(mine.length) })])]);
    const cards = el('div', { className: 'cards' });
    for (const i of mine) {
      const l = labelsOf(i);
      const acts = [['Approve', 'primary', () => propose('/approve', i.number)]];
      if (l.includes('manual-hold')) acts.push(['Unhold', '', () => propose('/unhold', i.number)]);
      else acts.push(['Hold', '', withReason('/hold', i.number, `Hold #${i.number}`, 'Why (public, optional)')]);
      acts.push(['Reject', 'danger', withReason('/reject', i.number, `Reject #${i.number}`, 'Reason (public)')]);
      acts.push(['Recheck', '', () => propose('/recheck', i.number)]);
      cards.append(card(i, l.includes('transfer') ? [['Approve for owner', 'primary', () => propose('/approve', i.number)]] : acts));
    }
    if (!mine.length) cards.append(el('p', { className: 'empty', textContent: name === 'Ready' ? 'Nothing to approve. 🎉' : 'Empty.' }));
    lane.append(cards);
    box.append(lane);
  }
  $('#countQueue').textContent = total ? String(total) : '';
}

function renderReports() {
  const items = openItems.filter((i) => labelsOf(i).includes('takedown'));
  const box = $('#reports');
  box.replaceChildren();
  for (const i of items) {
    box.append(card(i, [
      ['Take down', 'danger', withReason('/takedown', i.number, `Take down ${subdomainOf(i)}`, 'Note (public, optional)')],
      ['Dismiss', '', withReason('/dismiss', i.number, `Dismiss report #${i.number}`, 'Why it stays up (public)')],
    ]));
  }
  if (!items.length) box.append(el('p', { className: 'empty', textContent: 'No open reports.' }));
  $('#countReports').textContent = items.length ? String(items.length) : '';
}

function renderNames() {
  const q = lc($('#nameFilter').value.trim());
  const tbody = $('#namesTable tbody');
  tbody.replaceChildren();
  const rows = D.names.filter((n) => !q || [n.name, n.owner, n.target, n.host].some((s) => lc(s).includes(q)));
  for (const n of rows) {
    const verify = el('button', { className: 'btn', type: 'button', textContent: 'Verify' });
    verify.addEventListener('click', () => propose(`/verify ${n.name}`, 'console'));
    const down = el('button', { className: 'btn danger', type: 'button', textContent: 'Take down' });
    down.addEventListener('click', async () => {
      const r = await askReason(`Take down ${n.name}.${D.domain}`, 'Note (public, optional)');
      if (r !== null) propose(`/takedown ${n.name}${r ? ` ${r}` : ''}`, 'console');
    });
    tbody.append(el('tr', {}, [
      el('td', {}, [el('a', { href: `https://${n.name}.${D.domain}`, target: '_blank', rel: 'noopener', textContent: n.name })]),
      el('td', {}, [el('a', { href: `https://github.com/${n.owner}`, target: '_blank', rel: 'noopener', textContent: `@${n.owner}` })]),
      el('td', { textContent: `${n.type} ${n.target}` }),
      el('td', { textContent: n.host }),
      el('td', {}, [verify, ' ', down]),
    ]));
  }
  if (!rows.length) tbody.append(el('tr', {}, [el('td', { colSpan: 5, className: 'muted', textContent: 'Nothing matches.' })]));
}
$('#nameFilter').addEventListener('input', renderNames);

function chips(list, items, onRemove, empty) {
  const box = $(list);
  box.replaceChildren();
  for (const [text, arg] of items) {
    const x = el('button', { type: 'button', textContent: '×', title: 'Remove', ariaLabel: `Remove ${text}` });
    x.addEventListener('click', () => onRemove(arg));
    box.append(el('li', {}, [text, x]));
  }
  if (!items.length) box.append(el('li', { className: 'empty', textContent: empty }));
}

function renderPeople(cfg) {
  chips('#bannedList', (cfg.bannedUsers || []).map((u) => [`@${u}`, u]), (u) => propose(`/unban @${u}`, 'console'), 'nobody');
  chips('#limitList', Object.entries(cfg.limits || {}).map(([u, n]) => [`@${u}: ${n}`, u]), (u) => propose(`/limit @${u} ${cfg.maxPerOwner || 3}`, 'console'), 'none: everyone gets the default');
}

function renderMaint(cfg) {
  $('#lockState').textContent = cfg.locked ? `Paused${typeof cfg.locked === 'string' ? `: "${cfg.locked}"` : ''}.` : 'Open: requests are being reviewed.';
  const reserved = live.reserved || D.reserved;
  $('#reservedCount').textContent = `(${reserved.length})`;
  chips('#reservedList', reserved.map((r) => [r, r]), (r) => propose(`/unreserve ${r}`, 'console'), 'none');
}

function renderOwner(cfg) {
  const box = $('#maintList');
  box.replaceChildren();
  const ownerLi = el('li', { className: 'empty' }, [el('img', { src: `https://github.com/${D.owner}.png?size=40`, width: 20, height: 20, alt: '' }), `@${D.owner} (owner)`]);
  box.append(ownerLi);
  for (const m of cfg.maintainers || []) {
    const x = el('button', { type: 'button', textContent: 'demote', ariaLabel: `Demote ${m}` });
    x.addEventListener('click', () => propose(`/demote @${m}`, 'console'));
    box.append(el('li', {}, [el('img', { src: `https://github.com/${m}.png?size=40`, width: 20, height: 20, alt: '' }), `@${m}`, x]));
  }
  $('#repoSettings').href = `https://github.com/${R}/settings`;
  $('#ghActions').href = `https://github.com/${R}/actions`;
}

// Forms → commands
for (const f of $$('form[data-cmd]')) {
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const user = String(v.user || '').trim().replace(/^@/, '');
    const cmd = {
      ban: () => `/ban @${user}${v.reason ? ` ${v.reason}` : ''}`,
      limit: () => `/limit @${user} ${v.n}`,
      lock: () => `/lock${v.reason ? ` ${v.reason}` : ''}`,
      reserve: () => `/reserve ${String(v.name).trim().toLowerCase()}`,
      promote: () => `/promote @${user}`,
    }[f.dataset.cmd]();
    propose(cmd, 'console');
  });
}
for (const b of $$('[data-action]')) b.addEventListener('click', () => propose(`/${b.dataset.action}`, 'console'));

// ── Activity log ───────────────────────────────────────────────
function inlineMd(s) {
  const esc = s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])#(\d+)/g, `$1<a href="https://github.com/${R}/issues/$2" target="_blank" rel="noopener">#$2</a>`)
    .replace(/(^|[\s(])@([a-z\d-]+)/gi, '$1<a href="https://github.com/$2" target="_blank" rel="noopener">@$2</a>');
}
async function loadLog() {
  const box = $('#log');
  box.replaceChildren(el('li', { className: 'muted', textContent: 'Loading…' }));
  try {
    const [o, n] = R.split('/');
    const d = await gql(`query($o:String!,$n:String!){repository(owner:$o,name:$n){discussions(first:50,orderBy:{field:CREATED_AT,direction:ASC}){nodes{title url comments(last:60){nodes{body createdAt}}}}}}`, { o, n });
    const disc = d.repository.discussions.nodes.find((x) => x.title === LOG_TITLE);
    box.replaceChildren();
    if (!disc) { box.append(el('li', { className: 'muted', textContent: 'No activity yet.' })); return; }
    for (const c of [...disc.comments.nodes].reverse()) {
      const md = el('div', { className: 'md' });
      md.innerHTML = inlineMd(c.body);
      box.append(el('li', {}, [el('time', { dateTime: c.createdAt, textContent: new Date(c.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }), md]));
    }
    box.append(el('li', {}, [el('span'), el('a', { href: disc.url, target: '_blank', rel: 'noopener', textContent: 'Full log on GitHub →' })]));
  } catch (e) {
    box.replaceChildren(el('li', { className: 'muted', textContent: `Couldn't load the log (${e.message}). Does your token have Discussions: read?` }));
  }
}

// ── Boot ───────────────────────────────────────────────────────
fetch('../data.json', { cache: 'no-cache' }).then((r) => r.json()).then(async (data) => {
  D = data;
  R = D.repo;
  const q = new URLSearchParams({
    name: 'awesomeprojects console', description: 'Sign in to the awesomeprojects.tech maintainer console',
    target_name: D.owner, expires_in: '30', issues: 'write', pull_requests: 'write', discussions: 'read',
  });
  $('#tokenLink').href = `https://github.com/settings/personal-access-tokens/new?${q}`;
  const t = getToken();
  if (t) {
    try { await signIn(t); } catch { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); token = null; }
  }
}).catch(() => toast('Couldn\'t load the site data', { body: 'Reload the page.', kind: 'err', ms: 0 }));
