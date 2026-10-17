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
let panelReqs = []; // private requests (panel mode)
let snapshot = { sites: [] }; // the bot's latest look at hosted sites (panel mode)
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
  if (spec.bulk) {
    const waiting = toast(`Running ${spec.bulk.length} actions`, { body: spec.command, ms: 0 });
    let ok = 0;
    for (const b of spec.bulk) {
      const job = await Panel.run(b.action, b.args).catch((e) => ({ state: 'error', message: e.message }));
      if (job.state === 'done') ok++;
    }
    waiting.remove();
    toast(ok === spec.bulk.length ? 'All done' : `${ok} of ${spec.bulk.length} worked`, { kind: ok === spec.bulk.length ? 'ok' : 'err', ms: 10000 });
    setTimeout(loadAll, 1500);
    return;
  }
  if (spec.request) {
    try {
      await Panel.requestDo(spec.request, 'decide', { decision: spec.decision, reason: spec.reason || '' });
      toast('Done', { body: `${spec.command}. ${spec.decision === 'approve' ? 'The bot is setting it up.' : ''}`, kind: 'ok' });
      setTimeout(loadAll, 1200);
    } catch (e) { toast('Couldn\'t do that', { body: e.message, kind: 'err' }); }
    return;
  }
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
  for (const t of $$('[data-owner-only]')) t.hidden = role !== 'owner';
  for (const t of $$('[data-panel-only]')) if (mode !== 'panel') t.hidden = true;
  selectTab(mode === 'panel' ? 'overview' : 'queue');
  if (role !== 'none') await loadAll();
}
function selectTab(name) {
  for (const x of $$('.tabs button')) x.setAttribute('aria-selected', String(x.dataset.tab === name));
  for (const p of $$('.panel')) p.hidden = p.dataset.panel !== name;
  if (name === 'log') loadLog();
  if (name === 'overview') renderOverview();
}

// ── Tabs ───────────────────────────────────────────────────────
for (const b of $$('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

// ── Data ───────────────────────────────────────────────────────
async function loadAll() {
  try {
    if (mode === 'panel') {
      const [q, pr, snap] = await Promise.all([Panel.queue(), Panel.requests({ scope: 'all' }).catch(() => ({ requests: [] })), Panel.sites().catch(() => ({ sites: [] }))]);
      snapshot = snap || { sites: [] };
      openItems = q.items.map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) }));
      panelReqs = pr.requests || [];
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
  if (mode === 'panel') {
    renderSites();
    setupCreate();
    renderSettings(cfg);
    if (!$('[data-panel="overview"]').hidden) renderOverview();
  }
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
  const laneOf = (state) => (state === 'ready' ? 'Ready' : state === 'needs-changes' ? 'Needs changes' : 'Waiting on someone');
  const openPanel = panelReqs.filter((r) => ['checking', 'ready', 'on-hold', 'needs-changes', 'approving'].includes(r.state));
  for (const [name, test] of lanes) {
    const mine = items.filter((i) => test(labelsOf(i)));
    const priv = openPanel.filter((r) => laneOf(r.state) === name);
    if (name === 'Ready') ready = mine.length + priv.length;
    const lane = el('section', { className: 'lane' }, [el('h2', {}, [name, el('span', { textContent: String(mine.length + priv.length) })])]);
    const cards = el('div', { className: 'cards' });
    for (const r of priv) cards.append(privateCard(r));
    for (const i of mine) {
      const l = labelsOf(i);
      let acts;
      if (l.includes('transfer')) acts = [['Approve for owner', 'primary', onItem('approve', i, '/approve')]];
      else {
        acts = [['Approve', 'primary', onItem('approve', i, '/approve')], ['Force', 'danger', () => propose({ action: 'approve', args: { number: i.number, force: true }, command: '/approve force', target: i.number })]];
        acts.push(l.includes('manual-hold')
          ? ['Unhold', '', onItem('unhold', i, '/unhold')]
          : ['Hold', '', withReason('hold', { number: i.number }, '/hold', `Hold #${i.number}`, 'Why (shown on the request, optional)')]);
        acts.push(['Reject', 'danger', withReason('reject', { number: i.number }, '/reject', `Reject #${i.number}`, 'Reason (shown to the requester)')]);
        acts.push(['Recheck', '', onItem('recheck', i, '/recheck')]);
      }
      cards.append(card(i, acts));
    }
    if (!mine.length && !priv.length) cards.append(el('p', { className: 'empty', textContent: name === 'Ready' ? 'Nothing to approve. 🎉' : 'Empty.' }));
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
  $('#announceNow').textContent = cfg.announcement ? `Showing now: “${cfg.announcement}”` : 'A banner on the website, My domains and here. Nothing showing now.';
  document.querySelector('.announce')?.remove();
  if (cfg.announcement) document.body.prepend(el('div', { className: 'announce', role: 'status' }, ['📣 ', cfg.announcement]));
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
      announce: { action: 'announce', args: { text: String(v.text || '').trim() }, command: `/announce ${String(v.text || '').trim()}` },
    }[f.dataset.cmd];
    propose({ ...spec, target: 'console' });
  });
}
for (const b of $$('[data-action]')) {
  b.addEventListener('click', () => {
    if (b.dataset.action === 'announce-off') return propose({ action: 'announce', args: { text: 'off' }, command: '/announce off', target: 'console' });
    propose({ action: b.dataset.action, args: {}, command: `/${b.dataset.action}`, target: 'console' });
  });
}

// ── Activity ───────────────────────────────────────────────────
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
async function loadLog({ more = false } = {}) {
  const box = $('#log');
  if (!more) box.replaceChildren(el('li', { className: 'muted', textContent: 'Loading…' }));
  try {
    if (mode === 'panel') {
      const f = Object.fromEntries(new FormData($('#logFilter')));
      const q = { ...(f.actor ? { actor: f.actor } : {}), ...(f.q ? { q: f.q } : {}), ...(more && logCursor ? { before: logCursor } : {}) };
      const { entries, cursor } = await Panel.audit(q);
      logCursor = cursor;
      $('#logMore').hidden = !cursor;
      if (!more) box.replaceChildren();
      else box.querySelector('li.end')?.remove();
      for (const a of entries) {
        const md = el('div', { className: 'md' });
        md.innerHTML = `<span class="state ${a.state}">${a.state}</span>${Panel.md(`@${a.actor} · \`${String(a.summary).replace(/`/g, '')}\``).replace(/^<p>|<\/p>$/g, '')}`;
        if (a.result) md.append(el('span', { className: 'result', textContent: a.result }));
        if (a.link) md.append(el('a', { href: a.link, target: '_blank', rel: 'noopener', textContent: ' open →' }));
        box.append(el('li', {}, [el('time', { dateTime: new Date(a.at).toISOString(), textContent: when(a.at) }), md]));
      }
      if (!entries.length && !more) box.append(el('li', { className: 'muted', textContent: 'Nothing matches.' }));
      if (!cursor) box.append(el('li', { className: 'end' }, [el('span'), el('a', { href: `https://github.com/${R}/discussions`, target: '_blank', rel: 'noopener', textContent: 'Public activity log on GitHub →' })]));
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

// ── Private requests (panel mode) ──────────────────────────────
const ICONS = { pass: '✅', info: 'ℹ️', hold: '⏸️', error: '✏️', reject: '⛔' };
function privateCard(r) {
  const decide = (decision, label, needReason) => async () => {
    let reason = '';
    if (needReason) {
      reason = await askReason(`${label} ${r.name}`, decision === 'reject' ? 'Reason (the requester sees it)' : 'Why (the requester sees it, optional)');
      if (reason === null) return;
    }
    propose({ request: r.id, decision, reason, command: `${decision} request ${r.name}${reason ? `: ${reason}` : ''}` });
  };
  const c = el('article', { className: 'card' }, [
    el('div', { className: 'card-top' }, [
      el('span', { className: 'card-name' }, [r.name, el('span', { className: 'private-tag', textContent: 'private' })]),
      el('span', { className: 'card-meta', textContent: r.state }),
    ]),
    el('div', { className: 'card-meta' }, [el('a', { href: `https://github.com/${r.requester}`, target: '_blank', rel: 'noopener', textContent: `@${r.requester}` }), ` · ${ago(new Date(r.createdAt).toISOString())} ago · ${r.form.provider}`]),
  ]);
  const det = el('details', { className: 'bot-says' }, [el('summary', { textContent: 'Review & conversation' })]);
  det.addEventListener('toggle', async () => {
    if (!det.open || det.dataset.loaded) return;
    det.dataset.loaded = '1';
    const box = el('div', { className: 'md', textContent: 'Loading…' });
    det.append(box);
    try {
      const d = await Panel.request(r.id);
      const f = (d.request.review && d.request.review.findings) || [];
      box.innerHTML = `<table>${f.filter((x) => x.level !== 'pass').map((x) => `<tr><td>${ICONS[x.level]}</td><td>${Panel.md(x.text).replace(/^<p>|<\/p>$/g, '')}</td></tr>`).join('') || '<tr><td>✅</td><td>Every check passed.</td></tr>'}</table>`;
      const th = el('div', { className: 'thread-mini' });
      for (const n of d.notes) th.append(el('div', { className: `m ${n.internal ? 'internal' : ''}` }, [el('small', { textContent: `${n.author === 'bot' ? '🤖 bot' : `@${n.author}`}${n.internal ? ' · internal' : ''} · ${new Date(n.created_at).toLocaleString()}` }), n.body]));
      const ta = el('textarea', { placeholder: 'Write to the requester, or an internal note…' });
      const internal = el('input', { type: 'checkbox' });
      const send = el('button', { className: 'btn', type: 'button', textContent: 'Send' });
      send.addEventListener('click', async () => {
        if (!ta.value.trim()) return;
        try { await Panel.requestDo(r.id, 'note', { body: ta.value, internal: internal.checked }); det.dataset.loaded = ''; det.open = false; det.open = true; toast('Sent', { kind: 'ok' }); } catch (e) { toast('Couldn\'t send', { body: e.message, kind: 'err' }); }
      });
      box.after(th, el('div', { className: 'note-box' }, [ta, el('label', { className: 'check' }, [internal, ' Internal (maintainers only)']), send]));
    } catch (e) { box.textContent = e.message; }
  });
  c.append(det);
  const row = el('div', { className: 'card-actions' });
  const add = (label, cls, fn) => { const b = el('button', { className: `btn ${cls}`, type: 'button', textContent: label }); b.addEventListener('click', fn); row.append(b); };
  if (r.state !== 'approving') add('Approve', 'primary', decide('approve', 'Approve'));
  if (r.state !== 'approving' && ['needs-changes', 'on-hold', 'ready'].includes(r.state)) add('Force approve', 'danger', decide('force-approve', 'Force approve'));
  add(r.manualHold ? 'Unhold' : 'Hold', '', decide(r.manualHold ? 'unhold' : 'hold', 'Hold', !r.manualHold));
  add('Reject', 'danger', decide('reject', 'Reject', true));
  add('Recheck', '', decide('recheck', 'Recheck'));
  c.append(row);
  return c;
}

// ── Overview (panel mode) ──────────────────────────────────────
async function renderOverview() {
  if (mode !== 'panel') return;
  const top = D.names.filter((n) => !n.name.includes('.'));
  const hostedN = top.filter((n) => n.host === 'Hosted by us');
  const people = new Set(top.map((n) => n.owner)).size;
  let st = { requests: {}, last30: 0, actions7: 0, topActors: [], perDay: [] };
  try { st = await Panel.stats(); } catch { /* keep zeros */ }
  const open = ['checking', 'ready', 'on-hold', 'needs-changes', 'approving'].reduce((a, k) => a + (st.requests[k] || 0), 0)
    + openItems.filter((i) => labelsOf(i).includes('request')).length;
  const cards = [
    [top.length, 'names'], [people, 'people'], [hostedN.length, 'hosted sites'],
    [open, 'open requests', open > 0], [st.requests.ready || 0, 'ready to approve', (st.requests.ready || 0) > 0],
    [openItems.filter((i) => labelsOf(i).includes('takedown')).length, 'open reports'], [st.actions7, 'actions this week'],
    [snapshot.seats ? `${snapshot.seats.used}${snapshot.seats.max ? `/${snapshot.seats.max}` : ''}` : '—', 'enterprise seats used', snapshot.seats && snapshot.seats.max && snapshot.seats.used >= snapshot.seats.max * 0.9],
    [(snapshot.sites || []).filter((x) => x.deploy && x.deploy.conclusion === 'failure').length, 'failing deploys', (snapshot.sites || []).some((x) => x.deploy && x.deploy.conclusion === 'failure')],
  ];
  $('#statGrid').replaceChildren(...cards.map(([n, label, warn]) => el('div', { className: `stat ${warn ? 'warn' : ''}` }, [el('b', { textContent: String(n) }), el('span', { textContent: label })])));
  // Requests per day (30 bars)
  const today = Math.floor(Date.now() / 86400000);
  const byDay = Object.fromEntries((st.perDay || []).map((d) => [d.day, d.n]));
  const max = Math.max(1, ...Object.values(byDay));
  const bars = [];
  for (let d = today - 29; d <= today; d++) bars.push(el('i', { title: `${new Date(d * 86400000).toLocaleDateString()}: ${byDay[d] || 0}`, style: `height:${((byDay[d] || 0) / max) * 100}%` }));
  $('#perDay').replaceChildren(...(Object.keys(byDay).length ? bars : []));
  // Hosts
  const hosts = {};
  for (const n of top) hosts[n.host] = (hosts[n.host] || 0) + 1;
  const hmax = Math.max(1, ...Object.values(hosts));
  $('#hosts').replaceChildren(...Object.entries(hosts).sort((a, b) => b[1] - a[1]).map(([k, v]) => el('div', { className: 'hbar' }, [el('span', { textContent: k }), el('i', { style: `width:${(v / hmax) * 100}%` }), el('b', { textContent: String(v) })])));
  $('#topActors').replaceChildren(...(st.topActors.length ? st.topActors.map((a) => el('li', {}, [`@${a.actor} `, el('span', { textContent: `${a.n}` })])) : [el('li', { className: 'muted', textContent: 'Nobody yet.' })]));
  try {
    const { entries } = await Panel.audit({ limit: 6 });
    $('#recent').replaceChildren(...entries.map((a) => el('li', {}, [el('time', { textContent: when(a.at) }), el('span', { textContent: `@${a.actor} · ${a.summary}` })])));
  } catch { $('#recent').replaceChildren(el('li', { className: 'muted', textContent: 'Activity unavailable.' })); }
}

// ── Sites (panel mode) ─────────────────────────────────────────
const agoShort = (iso) => (iso ? ago(iso) : '—');
const selected = new Set();
function renderSites() {
  const snapBy = new Map((snapshot.sites || []).map((x) => [x.name, x]));
  const q = lc(($('#siteFilter') || {}).value || '');
  const sites = D.names.filter((n) => n.host === 'Hosted by us').filter((n) => !q || [n.name, n.owner, n.status].some((x) => lc(x).includes(q)));
  $('#sitesHelp').textContent = D.emuOrg
    ? `Private repos in ${D.emuOrg} (managed accounts, Cloudflare Pages). Locked/suspended sites are frozen by an org ruleset; suspended and archived ones have no DNS.`
    : D.sitesOrg
      ? `Private repos in ${D.sitesOrg}. Locked/suspended sites are frozen by an org ruleset; suspended and archived ones have no DNS.`
      : 'Hosting isn\'t switched on (set emu.org or sitesOrg in config.json).';
  $('#snapAt').textContent = snapshot.at ? `Checked ${new Date(snapshot.at).toLocaleString()} (daily, or "Run checks now"). Seats: ${snapshot.seats ? `${snapshot.seats.used}${snapshot.seats.max ? `/${snapshot.seats.max}` : ''}` : '?'}` : 'Not checked yet: press "Run checks now".';
  const tbody = $('#sitesTable tbody');
  tbody.replaceChildren();
  for (const n of sites) {
    const sn = snapBy.get(n.name) || {};
    const status = sn.status || n.status || 'active';
    const box = el('input', { type: 'checkbox', checked: selected.has(n.name), ariaLabel: `Select ${n.name}` });
    box.addEventListener('change', () => { if (box.checked) selected.add(n.name); else selected.delete(n.name); $('#sitesSel').textContent = `${selected.size} selected`; });
    const sel = el('select', { className: 'status-select', ariaLabel: `Status of ${n.name}` });
    for (const st of ['active', 'locked', 'suspended', 'archived']) sel.append(new Option(st, st, false, st === status));
    sel.addEventListener('change', () => {
      const to = sel.value;
      sel.value = status;
      propose({ action: 'site', args: { name: n.name, status: to }, command: `/site ${n.name} ${to}`, target: 'console' });
    });
    const dep = sn.deploy || {};
    const depCell = el('td', {}, dep.url ? [el('a', { href: dep.url, target: '_blank', rel: 'noopener', className: dep.conclusion === 'success' ? 'dep-ok' : dep.conclusion === 'failure' ? 'dep-bad' : 'dep-wait', textContent: dep.conclusion || 'running' }), ` ${agoShort(dep.at)}`] : ['—']);
    const btn = (label, fn) => { const b = el('button', { className: 'btn', type: 'button', textContent: label }); b.addEventListener('click', fn); return b; };
    tbody.append(el('tr', {}, [
      el('td', {}, [box]),
      el('td', {}, [el('a', { href: `https://${n.name}.${D.domain}`, target: '_blank', rel: 'noopener', textContent: n.name })]),
      el('td', {}, [el('a', { href: `#`, textContent: `@${n.owner}`, onclick: (e) => { e.preventDefault(); selectTab('people'); showProfile(n.owner); } })]),
      el('td', {}, [sel]),
      depCell,
      el('td', { textContent: sn.https ? '🔒' : sn.at === undefined && !snapshot.at ? '—' : '…' }),
      el('td', { textContent: sn.sizeMB !== undefined ? `${sn.sizeMB} MB` : '—' }),
      el('td', { textContent: agoShort(sn.pushedAt) }),
      el('td', { textContent: `${(sn.collaborators || []).length}${(sn.pendingInvites || []).length ? ` (+${sn.pendingInvites.length} invited)` : ''}` }),
      el('td', {}, [
        btn('Redeploy', () => propose({ action: 'redeploy', args: { name: n.name }, command: `/redeploy ${n.name}`, target: 'console' })), ' ',
        btn('Re-sync', () => propose({ action: 'site-sync', args: { name: n.name }, command: `/site-sync ${n.name}`, target: 'console' })), ' ',
        el('a', { className: 'btn', href: `https://github.com/${n.repo}`, target: '_blank', rel: 'noopener', textContent: 'Repo' }),
      ]),
    ]));
  }
  if (!sites.length) tbody.append(el('tr', {}, [el('td', { colSpan: 10, className: 'muted', textContent: q ? 'Nothing matches.' : 'No hosted sites yet.' })]));
  $('#sitesSel').textContent = `${selected.size} selected`;
}
document.addEventListener('DOMContentLoaded', () => {});
$('#siteFilter').addEventListener('input', renderSites);
$('#selAll').addEventListener('change', (e) => {
  for (const n of D.names.filter((x) => x.host === 'Hosted by us')) { if (e.target.checked) selected.add(n.name); else selected.delete(n.name); }
  renderSites();
});
$('#bulkApply').addEventListener('click', () => {
  const to = $('#bulkStatus').value;
  if (!to || !selected.size) return toast('Pick sites and a status first', { kind: 'err' });
  const names = [...selected];
  propose({ bulk: names.map((n) => ({ action: 'site', args: { name: n, status: to } })), command: `/site ${to} × ${names.length} (${names.join(', ')})`, target: 'console' });
});

// ── People: everything about one person ────────────────────────
$('#lookup').addEventListener('submit', (e) => { e.preventDefault(); showProfile(new FormData(e.target).get('user')); });
async function showProfile(raw) {
  const login = String(raw || '').trim().replace(/^@/, '');
  const box = $('#profile');
  if (!login) { box.replaceChildren(); return; }
  const l = lc(login);
  const cfg = live.config || {};
  const names = D.names.filter((n) => lc(n.owner) === l);
  const sites = (snapshot.sites || []).filter((x) => lc(x.owner) === l || (x.collaborators || []).map(lc).includes(l));
  const reqs = panelReqs.filter((r) => lc(r.requester) === l);
  const banned = (cfg.bannedUsers || []).map(lc).includes(l);
  const limit = Object.entries(cfg.limits || {}).find(([u]) => lc(u) === l);
  const isMaint = (cfg.maintainers || []).map(lc).includes(l) || l === lc(D.owner);
  const list = (items, empty) => el('ul', {}, items.length ? items : [el('li', { className: 'muted', textContent: empty })]);
  const recent = el('ul', {}, [el('li', { className: 'muted', textContent: 'Loading…' })]);
  const btn = (label, cls, spec) => { const b = el('button', { className: `btn ${cls}`, type: 'button', textContent: label }); b.addEventListener('click', spec); return b; };
  box.replaceChildren(el('section', { className: 'profile' }, [
    el('div', { className: 'profile-head' }, [
      el('img', { src: `https://github.com/${login}.png?size=96`, width: 48, height: 48, alt: '' }),
      el('h2', {}, [el('a', { href: `https://github.com/${login}`, target: '_blank', rel: 'noopener', textContent: `@${login}` })]),
      isMaint ? el('span', { className: 'label ready', textContent: l === lc(D.owner) ? 'owner' : 'maintainer' }) : null,
      banned ? el('span', { className: 'label rejected', textContent: 'banned' }) : null,
      limit ? el('span', { className: 'label', textContent: `limit ${limit[1]}` }) : null,
    ]),
    el('div', { className: 'cols' }, [
      el('div', {}, [el('h3', { textContent: `Names (${names.length})` }), list(names.map((n) => el('li', { textContent: `${n.name} · ${n.host}${n.status ? ` · ${n.status}` : ''}` })), 'none')]),
      el('div', {}, [el('h3', { textContent: `Hosted repos (${sites.length})` }), list(sites.map((x) => el('li', {}, [el('a', { href: `https://github.com/${x.repo}`, target: '_blank', rel: 'noopener', textContent: x.repo }), ` · ${x.status}${lc(x.owner) !== l ? ' · collaborator' : ''}`])), 'none')]),
      el('div', {}, [el('h3', { textContent: `Private requests (${reqs.length})` }), list(reqs.map((r) => el('li', { textContent: `${r.name} · ${r.state}` })), 'none')]),
      el('div', {}, [el('h3', { textContent: 'Recent actions' }), recent]),
    ]),
    el('div', { className: 'card-actions' }, [
      banned
        ? btn('Unban', '', () => propose({ action: 'unban', args: { user: login }, command: `/unban @${login}`, target: 'console' }))
        : btn('Ban…', 'danger', async () => { const r = await askReason(`Ban @${login}`, 'Reason (optional)'); if (r !== null) propose({ action: 'ban', args: { user: login, reason: r }, command: `/ban @${login}${r ? ` ${r}` : ''}`, target: 'console' }); }),
      btn('Suspend everything…', 'danger', async () => { const r = await askReason(`Suspend @${login}: ban + suspend all their sites`, 'Reason (optional)'); if (r !== null) propose({ action: 'suspend-user', args: { user: login, reason: r }, command: `/suspend-user @${login}${r ? ` ${r}` : ''}`, target: 'console' }); }),
      btn('Set limit…', '', async () => { const n = await askReason(`Name limit for @${login}`, 'Number of names', String(limit ? limit[1] : cfg.maxPerOwner || 3)); if (n) propose({ action: 'limit', args: { user: login, n: Number(n) }, command: `/limit @${login} ${n}`, target: 'console' }); }),
      role === 'owner' && !isMaint ? btn('Make maintainer…', '', () => propose({ action: 'promote', args: { user: login }, command: `/promote @${login}`, target: 'console' })) : null,
    ].filter(Boolean)),
  ]));
  try {
    const { identities, enabled } = await Panel.identity({ login });
    if (enabled) {
      const idn = (identities || [])[0];
      const row = el('div', { className: 'card-actions' }, [el('b', { textContent: 'Enterprise account: ' }), idn ? `${idn.managed_login || idn.user_name} · ${idn.status}` : 'none']);
      const b = (label, cls, action) => { const x = el('button', { className: `btn ${cls}`, type: 'button', textContent: label }); x.addEventListener('click', () => propose({ action, args: { user: login }, command: `/${action} @${login}`, target: 'console' })); return x; };
      if (!idn) row.append(b('Create it…', 'primary', 'emu-create'));
      else if (idn.status === 'active') row.append(b('Suspend…', 'danger', 'emu-suspend'));
      else row.append(b('Restore…', '', 'emu-restore'));
      box.querySelector('.profile').append(row);
    }
  } catch { /* no identities yet */ }
  try {
    const { entries } = await Panel.audit({ actor: login, limit: 8 });
    recent.replaceChildren(...(entries.length ? entries.map((a) => el('li', { textContent: `${when(a.at)} · ${a.summary}` })) : [el('li', { className: 'muted', textContent: 'nothing yet' })]));
  } catch { recent.replaceChildren(el('li', { className: 'muted', textContent: 'unavailable' })); }
}

// ── Create (panel mode) ────────────────────────────────────────
function setupCreate() {
  const host = $('#createHost');
  if (host.options.length) return;
  for (const p of D.providers) host.append(new Option(p.label, p.id));
  for (const sel of [$('#createTpl'), $('#repoTpl')]) for (const t of D.templates || []) sel.append(new Option(t.label, t.id));
  const form = $('#createForm');
  const sync = () => {
    const p = D.providers.find((x) => x.id === host.value);
    form.querySelector('[data-for="template"]').hidden = p.id !== 'hosted';
    form.querySelector('[data-for="repo"]').hidden = p.input !== 'repo';
    form.querySelector('[data-for="target"]').hidden = !(p.input === 'target' || p.input === 'ips');
  };
  host.addEventListener('change', sync);
  sync();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const p = D.providers.find((x) => x.id === v.provider);
    const owner = String(v.owner).trim().replace(/^@/, '');
    const args = { name: String(v.name).trim().toLowerCase(), owner, provider: p.id, template: p.id === 'hosted' ? v.template : '', repo: p.input === 'repo' ? v.repo : '', target: p.input === 'target' || p.input === 'ips' ? v.target : '', description: v.description, force: !!v.force };
    propose({ action: 'create', args, command: `create ${args.name} for @${owner} → ${p.label}${args.force ? ' (FORCE)' : ''}`, target: 'console' });
  });
  $('#repoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    const u = String(v.user).trim().replace(/^@/, '');
    propose({ action: 'make-repo', args: { repo: v.repo, user: u, template: v.template }, command: `/make-repo ${v.repo} @${u} ${v.template}`, target: 'console' });
  });
}

// ── Settings (owner, panel mode) ───────────────────────────────
function renderSettings(cfg) {
  const box = $('#settingsList');
  box.replaceChildren();
  for (const [key, spec] of Object.entries(D.settings || {})) {
    const cur = cfg[key] !== undefined ? cfg[key] : spec.value;
    let input;
    if (spec.type === 'bool') { input = el('select'); input.append(new Option('on', 'true', false, !!cur), new Option('off', 'false', false, !cur)); }
    else if (spec.type === 'int') input = el('input', { type: 'number', min: spec.min, max: spec.max, value: cur });
    else input = el('input', { value: [].concat(cur || []).join(', ') });
    const form = el('form', {}, [input, el('button', { className: 'btn', type: 'submit', textContent: 'Save…' })]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      propose({ action: 'config', args: { key, value: input.value }, command: `/config ${key} ${input.value}`, target: 'console' });
    });
    box.append(el('div', { className: 'setting' }, [el('div', {}, [el('b', { textContent: key }), el('p', { textContent: spec.help })]), form]));
  }
}

// ── Audit search (panel mode) ──────────────────────────────────
let logCursor = null;
$('#logFilter').addEventListener('submit', (e) => { e.preventDefault(); logCursor = null; loadLog(); });
$('#logMore').addEventListener('click', () => loadLog({ more: true }));

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
