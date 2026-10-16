// awesomeprojects.tech console. Two ways in:
//   panel  "Sign in with GitHub" through api.awesomeprojects.tech: actions go privately to the bot
//          (repository_dispatch), results come back here, and everything lands in the audit log.
//   token  a fine-grained token: actions are posted as slash-command comments from your account.
// Permissions are enforced by the server and the bot, not here: this page only hides what you can't use.
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
const TOKEN_KEY = 'ap.console.token';

let D = null; // ../data.json
let R = ''; // owner/repo
let mode = null; // 'panel' | 'token'
let token = null; // token mode only
let me = null;
let role = 'none'; // owner | maintainer | none
let live = { config: {}, reserved: [] };
let openItems = [];
let consoleIssue = null;

// ── GitHub API (token mode, and public reads) ──────────────────
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
const fileJson = async (p) => JSON.parse(atob((await api(`/repos/${R}/contents/${p}`)).content.replace(/\n/g, '')));
const renderMarkdown = async (text) => (mode === 'token'
  ? api('/markdown', { method: 'POST', body: { text, mode: 'gfm', context: R }, raw: true }).catch(() => Panel.md(text))
  : Panel.md(text));

// ── Toasts ─────────────────────────────────────────────────────
function toast(title, { body, html, link, kind = '', ms = 6000 } = {}) {
  const t = el('div', { className: `toast ${kind}` }, [el('b', { textContent: title })]);
  if (body) t.append(el('div', { textContent: body }));
  if (html) { const d = el('div', { className: 'md' }); d.innerHTML = html; t.append(d); }
  if (link) t.append(el('a', { href: link, target: '_blank', rel: 'noopener', textContent: 'Open on GitHub →' }));
  $('#toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  t.addEventListener('click', (e) => { if (e.target.tagName !== 'A') t.remove(); });
  return t;
}

// ── The command line: preview, then run ────────────────────────
// spec: { action, args, command, target: number | 'console' | undefined }
let pending = null;
function propose(spec) {
  if (role === 'none') { toast('Not a maintainer', { body: 'The bot would ignore this from you.', kind: 'err' }); return; }
  pending = spec;
  $('#cmdText').textContent = spec.command;
  $('#cmdWhere').textContent = mode === 'panel'
    ? `${typeof spec.target === 'number' ? `on #${spec.target} · ` : ''}privately as @${me.login}`
    : `on ${typeof spec.target === 'number' ? `#${spec.target}` : consoleIssue ? `#${consoleIssue.number}` : 'the admin console issue'} as @${me.login}`;
  $('#cmdRun').textContent = mode === 'panel' ? 'Run' : 'Post';
  $('#cmdline').hidden = false;
  $('#cmdRun').focus();
}
$('#cmdCancel').addEventListener('click', () => { pending = null; $('#cmdline').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cmdline').hidden) $('#cmdCancel').click(); });
$('#cmdRun').addEventListener('click', async () => {
  if (!pending) return;
  const spec = pending;
  pending = null;
  $('#cmdline').hidden = true;
  if (mode === 'panel') return runPanel(spec);
  return runComment(spec);
});

async function runPanel(spec) {
  const waiting = toast(`Running ${spec.command}`, { body: 'Sent to the bot…', ms: 0 });
  try {
    const job = await Panel.run(spec.action, spec.args);
    waiting.remove();
    toast(job.state === 'done' ? 'Done' : 'Didn\'t work', { html: Panel.md(job.message || ''), link: job.link, kind: job.state === 'done' ? 'ok' : 'err', ms: 15000 });
    setTimeout(loadAll, 1500);
  } catch (e) {
    waiting.remove();
    toast('Couldn\'t run that', { body: e.message, kind: 'err' });
  }
}

async function runComment(spec) {
  try {
    const number = typeof spec.target === 'number' ? spec.target : (await ensureConsole()).number;
    const posted = await api(`/repos/${R}/issues/${number}/comments`, { method: 'POST', body: { body: spec.command } });
    const waiting = toast(`Posted ${spec.command.split(' ')[0]} on #${number}`, { body: 'Waiting for the bot…', ms: 0 });
    watchForBot(number, posted.created_at, waiting);
  } catch (e) {
    toast('Couldn\'t post', { body: e.message, kind: 'err' });
  }
}

async function ensureConsole() {
  if (consoleIssue) return consoleIssue;
  const found = openItems.find((i) => i.title === CONSOLE_TITLE && !i.pull_request);
  if (found) return (consoleIssue = found);
  consoleIssue = await api(`/repos/${R}/issues`, {
    method: 'POST',
    body: { title: CONSOLE_TITLE, body: 'Maintainer commands posted from the [console](https://awesomeprojects.tech/admin/) in token mode (and by hand) land here.' },
  });
  return consoleIssue;
}

/** Token mode: poll until the bot comments or edits its comment after `since`. */
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
        toast(`The bot answered on #${number}`, { html: await renderMarkdown(text), link: bot.html_url, kind: 'ok', ms: 15000 });
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
$('#ghLogin').addEventListener('click', () => Panel.login($('#keep').checked));
$('#tokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('#token').value.trim();
  $('#signinError').textContent = '';
  try {
    await signInToken(t);
    ($('#remember').checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
    $('#token').value = '';
  } catch (err) {
    token = null;
    $('#signinError').textContent = err.status === 401 ? 'GitHub didn\'t accept that token.' : `Couldn't sign in: ${err.message}`;
  }
});
$('#signOut').addEventListener('click', () => {
  Panel.logout();
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

async function signInPanel() {
  mode = 'panel';
  me = await Panel.me();
  role = me.role === 'user' ? 'none' : me.role;
  await enter(me.avatar);
}
async function signInToken(t) {
  mode = 'token';
  token = t;
  me = await api('/user');
  try { live.config = await fileJson('config.json'); } catch { live.config = {}; }
  const maint = (live.config.maintainers || D.maintainers || []).map(lc);
  role = lc(me.login) === lc(D.owner) ? 'owner' : maint.includes(lc(me.login)) ? 'maintainer' : 'none';
  await enter(me.avatar_url);
}
async function enter(avatar) {
  $('#signin').hidden = true;
  $('#app').hidden = false;
  $('#who').hidden = false;
  if (avatar) $('#whoAvatar').src = `${avatar}${avatar.includes('?') ? '&' : '?'}s=56`;
  $('#whoName').textContent = `@${me.login}`;
  $('#whoRole').textContent = role === 'none' ? 'visitor' : role;
  $('#whoRole').classList.toggle('none', role === 'none');
  $('#whoMode').textContent = mode === 'panel' ? 'private mode' : 'comment mode';
  $('#notMaintainer').hidden = role !== 'none';
  $('#ownerTab').hidden = role !== 'owner';
  if (role !== 'none') await loadAll();
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
    if (mode === 'panel') {
      const q = await Panel.queue();
      openItems = q.items.map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) }));
      live = { config: q.config || {}, reserved: q.reserved || D.reserved };
    } else {
      [openItems, live.config, live.reserved] = await Promise.all([
        allPages(`/repos/${R}/issues?state=open`),
        fileJson('config.json').catch(() => live.config),
        fileJson('reserved.json').catch(() => D.reserved),
      ]);
    }
  } catch (e) {
    toast('Couldn\'t load the queue', { body: e.message, kind: 'err' });
    return;
  }
  consoleIssue = openItems.find((i) => i.title === CONSOLE_TITLE && !i.pull_request) || consoleIssue;
  const cfg = live.config || {};
  $('#lockedBanner').hidden = !cfg.locked;
  $('#lockedBanner').textContent = cfg.locked ? `🔒 Requests are paused${typeof cfg.locked === 'string' ? `: ${cfg.locked.replace(/[.!]+$/, '')}` : ''}.` : '';
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
    el('div', { className: 'labels' }, labels.filter((l) => l !== 'request').map((l) => el('span', { className: `label ${l}`, textContent: l }))),
  ]);
  const det = el('details', { className: 'bot-says' }, [el('summary', { textContent: 'What the bot says' })]);
  det.addEventListener('toggle', async () => {
    if (!det.open || det.dataset.loaded) return;
    det.dataset.loaded = '1';
    const box = el('div', { className: 'md', textContent: 'Loading…' });
    det.append(box);
    try {
      const comments = await api(`/repos/${R}/issues/${i.number}/comments?per_page=100`);
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

/** An action that asks for an optional reason first. */
const withReason = (action, args, command, title, label) => async () => {
  const r = await askReason(title, label);
  if (r !== null) propose({ action, args: { ...args, reason: r }, command: r ? `${command} ${r}` : command, target: args.number });
};
const onItem = (action, i, command) => () => propose({ action, args: { number: i.number }, command, target: i.number });

function renderQueue() {
  const items = openItems.filter((i) => {
    const l = labelsOf(i);
    return l.includes('request') || l.includes('transfer') || (i.pull_request && !/^(Remove|Add TXT|Update|Transfer) /.test(i.title));
  });
  const lanes = [
    ['Ready', (l) => l.includes('ready')],
    ['Waiting on someone', (l) => !l.includes('ready') && !l.includes('needs-changes')],
    ['Needs changes', (l) => l.includes('needs-changes')],
  ];
  const box = $('#lanes');
  box.replaceChildren();
  let ready = 0;
  for (const [name, test] of lanes) {
    const mine = items.filter((i) => test(labelsOf(i)));
    if (name === 'Ready') ready = mine.length;
    const lane = el('section', { className: 'lane' }, [el('h2', {}, [name, el('span', { textContent: String(mine.length) })])]);
    const cards = el('div', { className: 'cards' });
    for (const i of mine) {
      const l = labelsOf(i);
      let acts;
      if (l.includes('transfer')) acts = [['Approve for owner', 'primary', onItem('approve', i, '/approve')]];
      else {
        acts = [['Approve', 'primary', onItem('approve', i, '/approve')]];
        acts.push(l.includes('manual-hold')
          ? ['Unhold', '', onItem('unhold', i, '/unhold')]
          : ['Hold', '', withReason('hold', { number: i.number }, '/hold', `Hold #${i.number}`, 'Why (shown on the request, optional)')]);
        acts.push(['Reject', 'danger', withReason('reject', { number: i.number }, '/reject', `Reject #${i.number}`, 'Reason (shown to the requester)')]);
        acts.push(['Recheck', '', onItem('recheck', i, '/recheck')]);
      }
      cards.append(card(i, acts));
    }
    if (!mine.length) cards.append(el('p', { className: 'empty', textContent: name === 'Ready' ? 'Nothing to approve. 🎉' : 'Empty.' }));
    lane.append(cards);
    box.append(lane);
  }
  $('#countQueue').textContent = ready ? String(ready) : '';
}

function renderReports() {
  const items = openItems.filter((i) => labelsOf(i).includes('takedown'));
  const box = $('#reports');
  box.replaceChildren();
  for (const i of items) {
    box.append(card(i, [
      ['Take down', 'danger', withReason('takedown', { number: i.number }, '/takedown', `Take down ${subdomainOf(i)}`, 'Note (public, optional)')],
      ['Dismiss', '', withReason('dismiss', { number: i.number }, '/dismiss', `Dismiss report #${i.number}`, 'Why it stays up (public)')],
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
    verify.addEventListener('click', () => propose({ action: 'verify', args: { name: n.name }, command: `/verify ${n.name}`, target: 'console' }));
    const down = el('button', { className: 'btn danger', type: 'button', textContent: 'Take down' });
    down.addEventListener('click', async () => {
      const r = await askReason(`Take down ${n.name}.${D.domain}`, 'Note (public, optional)');
      if (r !== null) propose({ action: 'takedown', args: { name: n.name, reason: r }, command: `/takedown ${n.name}${r ? ` ${r}` : ''}`, target: 'console' });
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
  chips('#bannedList', (cfg.bannedUsers || []).map((u) => [`@${u}`, u]), (u) => propose({ action: 'unban', args: { user: u }, command: `/unban @${u}`, target: 'console' }), 'nobody');
  const def = cfg.maxPerOwner || 3;
  chips('#limitList', Object.entries(cfg.limits || {}).map(([u, n]) => [`@${u}: ${n}`, u]), (u) => propose({ action: 'limit', args: { user: u, n: def }, command: `/limit @${u} ${def}`, target: 'console' }), 'none: everyone gets the default');
}

function renderMaint(cfg) {
  $('#lockState').textContent = cfg.locked ? `Paused${typeof cfg.locked === 'string' ? `: "${cfg.locked}"` : ''}.` : 'Open: requests are being reviewed.';
  const reserved = live.reserved || D.reserved;
  $('#reservedCount').textContent = `(${reserved.length})`;
  chips('#reservedList', reserved.map((r) => [r, r]), (r) => propose({ action: 'unreserve', args: { name: r }, command: `/unreserve ${r}`, target: 'console' }), 'none');
}

function renderOwner(cfg) {
  const box = $('#maintList');
  box.replaceChildren();
  box.append(el('li', { className: 'empty' }, [el('img', { src: `https://github.com/${D.owner}.png?size=40`, width: 20, height: 20, alt: '' }), `@${D.owner} (owner)`]));
  for (const m of cfg.maintainers || []) {
    const x = el('button', { type: 'button', textContent: 'demote', ariaLabel: `Demote ${m}` });
    x.addEventListener('click', () => propose({ action: 'demote', args: { user: m }, command: `/demote @${m}`, target: 'console' }));
    box.append(el('li', {}, [el('img', { src: `https://github.com/${m}.png?size=40`, width: 20, height: 20, alt: '' }), `@${m}`, x]));
  }
  $('#repoSettings').href = `https://github.com/${R}/settings`;
  $('#ghActions').href = `https://github.com/${R}/actions`;
}

// Forms → actions
for (const f of $$('form[data-cmd]')) {
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const u = String(v.user || '').trim().replace(/^@/, '');
    const reason = String(v.reason || '').trim();
    const spec = {
      ban: { action: 'ban', args: { user: u, reason }, command: `/ban @${u}${reason ? ` ${reason}` : ''}` },
      limit: { action: 'limit', args: { user: u, n: Number(v.n) }, command: `/limit @${u} ${v.n}` },
      lock: { action: 'lock', args: { reason }, command: `/lock${reason ? ` ${reason}` : ''}` },
      reserve: { action: 'reserve', args: { name: String(v.name).trim().toLowerCase() }, command: `/reserve ${String(v.name).trim().toLowerCase()}` },
      promote: { action: 'promote', args: { user: u }, command: `/promote @${u}` },
    }[f.dataset.cmd];
    propose({ ...spec, target: 'console' });
  });
}
for (const b of $$('[data-action]')) b.addEventListener('click', () => propose({ action: b.dataset.action, args: {}, command: `/${b.dataset.action}`, target: 'console' }));

// ── Activity ───────────────────────────────────────────────────
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
async function loadLog() {
  const box = $('#log');
  box.replaceChildren(el('li', { className: 'muted', textContent: 'Loading…' }));
  try {
    if (mode === 'panel') {
      const { entries } = await Panel.audit();
      box.replaceChildren();
      for (const a of entries) {
        const md = el('div', { className: 'md' });
        md.innerHTML = `<span class="state ${a.state}">${a.state}</span>${Panel.md(`@${a.actor} · \`${a.summary}\``).replace(/^<p>|<\/p>$/g, '')}`;
        if (a.result) md.append(el('span', { className: 'result', textContent: a.result }));
        if (a.link) md.append(el('a', { href: a.link, target: '_blank', rel: 'noopener', textContent: ' open →' }));
        box.append(el('li', {}, [el('time', { dateTime: new Date(a.at).toISOString(), textContent: when(a.at) }), md]));
      }
      if (!entries.length) box.append(el('li', { className: 'muted', textContent: 'Nothing yet.' }));
      box.append(el('li', {}, [el('span'), el('a', { href: `https://github.com/${R}/discussions`, target: '_blank', rel: 'noopener', textContent: 'Public activity log on GitHub →' })]));
      return;
    }
    const [o, n] = R.split('/');
    const d = await api('/graphql', { method: 'POST', body: { query: `query($o:String!,$n:String!){repository(owner:$o,name:$n){discussions(first:50,orderBy:{field:CREATED_AT,direction:ASC}){nodes{title url comments(last:60){nodes{body createdAt}}}}}}`, variables: { o, n } } });
    const disc = d.data.repository.discussions.nodes.find((x) => x.title === LOG_TITLE);
    box.replaceChildren();
    if (!disc) { box.append(el('li', { className: 'muted', textContent: 'No activity yet.' })); return; }
    for (const c of [...disc.comments.nodes].reverse()) {
      const md = el('div', { className: 'md' });
      md.innerHTML = Panel.md(c.body);
      box.append(el('li', {}, [el('time', { dateTime: c.createdAt, textContent: when(c.createdAt) }), md]));
    }
    box.append(el('li', {}, [el('span'), el('a', { href: disc.url, target: '_blank', rel: 'noopener', textContent: 'Full log on GitHub →' })]));
  } catch (e) {
    box.replaceChildren(el('li', { className: 'muted', textContent: `Couldn't load the log (${e.message}).` }));
  }
}

// ── Boot ───────────────────────────────────────────────────────
fetch('../data.json', { cache: 'no-cache' }).then((r) => r.json()).then(async (data) => {
  D = data;
  R = D.repo;
  Panel.setApi(D.panelApi);
  const q = new URLSearchParams({
    name: 'awesomeprojects console', description: 'awesomeprojects.tech maintainer console (comment mode)',
    target_name: D.owner, expires_in: '30', issues: 'write', pull_requests: 'write', discussions: 'read',
  });
  $('#tokenLink').href = `https://github.com/settings/personal-access-tokens/new?${q}`;
  if (Panel.signedIn()) {
    try { return await signInPanel(); } catch { Panel.logout(); }
  }
  const t = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  if (t) {
    try { return await signInToken(t); } catch { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); token = null; }
  }
  if (!(await Panel.up())) {
    $('#panelDown').hidden = false;
    $('#ghLogin').disabled = true;
    $('#tokenMode').open = true;
  }
}).catch(() => toast('Couldn\'t load the site data', { body: 'Reload the page.', kind: 'err', ms: 0 }));
