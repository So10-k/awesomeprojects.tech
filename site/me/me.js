// My domains: a DNS manager over the panel server. Records edits, checks and requests go to the bot
// privately (api.awesomeprojects.tech), which checks you own the name and runs the same rules as always.
'use strict';

const $ = (s, root = document) => root.querySelector(s);
const lc = (s) => String(s || '').toLowerCase();
const h = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k);
  return n;
};
const BASE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

let D = null; // ../data.json
let snapshot = { sites: [] }; // the bot's latest look at hosted sites
let ident = { enabled: false, identity: null }; // the managed enterprise account
let contact = { email: null, turnOn: '' }; // email notifications (opt-in)
let me = null;
let requests = [];
let pick = { kind: 'name', id: null }; // name | req | new
const pending = new Map(); // full name → records (optimistic, until data.json catches up)

function toast(title, body, kind = '') {
  const t = h('div', { className: `toast ${kind}` }, h('b', { textContent: title }), body || '');
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

// ── Data helpers ───────────────────────────────────────────────
const entriesUnder = (base) => D.names.filter((n) => n.name === base || n.name.endsWith(`.${base}`));
const recordsOf = (full) => (pending.has(full) ? pending.get(full) : (D.names.find((n) => n.name === full) || {}).records || null);
const myTop = () => D.names.filter((n) => !n.name.includes('.') && lc(n.owner) === lc(me.login)).sort((a, b) => a.name.localeCompare(b.name));
function rows(base) {
  const fulls = new Set([...entriesUnder(base).map((n) => n.name), ...[...pending.keys()].filter((k) => k === base || k.endsWith(`.${base}`))]);
  const out = [];
  for (const full of [...fulls].sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)))) {
    const r = recordsOf(full);
    if (!r) continue;
    for (const [type, v] of Object.entries(r)) {
      for (const x of [].concat(v)) out.push({ full, type, value: x, label: full === base ? '@' : full.slice(0, -(base.length + 1)) });
    }
  }
  return out;
}
const show = (type, v) => (type === 'MX' ? (typeof v === 'string' ? `10 ${v}` : `${v.priority ?? 10} ${v.host}`) : String(v));

/** Records object for `full` after removing `old` and/or adding `add` ({ type, value }). */
function nextRecords(full, { old, add }) {
  const cur = JSON.parse(JSON.stringify(recordsOf(full) || {}));
  if (old) {
    if (old.type === 'CNAME') delete cur.CNAME;
    else {
      const list = [].concat(cur[old.type] || []).filter((x) => JSON.stringify(x) !== JSON.stringify(old.value));
      if (list.length) cur[old.type] = list; else delete cur[old.type];
    }
  }
  if (add) {
    if (add.type === 'CNAME') {
      if (Object.keys(cur).some((t) => t !== 'CNAME')) throw new Error('A CNAME can\'t sit next to other records on the same name. Remove those first, or use another name.');
      cur.CNAME = add.value;
    } else {
      if (cur.CNAME) throw new Error('This name has a CNAME, so it can\'t have other records too.');
      const list = [].concat(cur[add.type] || []);
      if (list.some((x) => JSON.stringify(x) === JSON.stringify(add.value))) throw new Error('That record already exists.');
      cur[add.type] = [...list, add.value];
    }
  }
  if (cur.TXT && cur.TXT.length === 1) cur.TXT = cur.TXT[0];
  return Object.keys(cur).length ? cur : null;
}

// ── Running things ─────────────────────────────────────────────
async function run(box, action, args, busy, onDone) {
  box.hidden = false;
  box.className = 'result busy md';
  box.textContent = busy;
  try {
    const job = await Panel.run(action, args);
    box.className = `result md ${job.state === 'done' ? 'ok' : 'err'}`;
    box.innerHTML = Panel.md(job.message || (job.state === 'done' ? 'Done.' : 'That didn\'t work.'));
    if (job.state === 'done' && onDone) onDone();
    return job;
  } catch (e) {
    box.className = 'result err';
    box.textContent = e.status === 401 ? 'Your sign-in expired. Sign in again.' : e.message;
    return null;
  }
}

// ── Sidebar ────────────────────────────────────────────────────
// ── The managed enterprise account ─────────────────────────────
function identityBox() {
  if (!ident.enabled) return null;
  const i = ident.identity;
  const result = h('div', { className: 'result', hidden: true });
  const body = h('div', { className: 'body' });
  if (!i) {
    const get = h('button', { className: 'btn primary', type: 'button', textContent: 'Get my enterprise account' });
    get.addEventListener('click', () => run(result, 'emu-account', {}, 'Creating your account…', async () => { ident = await Panel.identity().catch(() => ident); render(); }));
    body.append(h('p', {}, 'Hosted sites live in our GitHub enterprise. Your enterprise account is created for you and linked to this GitHub account: no new password, you just confirm it\'s you.'), get, result);
  } else {
    body.append(
      h('div', { className: 'facts' }, h('span', { className: 'fact', textContent: `@${i.managed_login || i.user_name}` }), h('span', { className: `pill ${i.status === 'active' ? 'active' : 'suspended'}`, textContent: i.status })),
      i.status === 'active'
        ? h('p', {}, 'Sign in to GitHub as your enterprise account any time: ', h('a', { href: ident.signIn, target: '_blank', rel: 'noopener', textContent: 'enterprise sign-in →' }))
        : h('p', { textContent: 'This account is suspended. Contact a maintainer.' }));
  }
  return h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'Enterprise account' })), body);
}

// ── Email (opt-in) ─────────────────────────────────────────────
function emailBox() {
  const body = h('div', { className: 'body' });
  if (contact.email) {
    const off = h('button', { className: 'btn', type: 'button', textContent: 'Turn email off' });
    off.addEventListener('click', async () => { contact = await Panel.contactOff().catch(() => contact); toast('Email is off', 'We won\'t email you any more.'); render(); });
    body.append(h('p', {}, 'We email ', h('b', { textContent: contact.email }), ' about your names (renewals, a failing deploy) and, for maintainers, duty and the queue.'), off);
  } else {
    const on = h('a', { className: 'btn primary', href: contact.turnOn || '#', textContent: 'Email me' });
    body.append(h('p', { textContent: 'Get an email when a name needs renewing or a deploy fails (and, for maintainers, duty and queue mail). You sign in to GitHub once more so we can read your verified address. We keep only that address.' }), on);
  }
  return h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'Email' })), body);
}

function renderSide() {
  const top = myTop();
  const unlimited = me.role === 'owner' || me.role === 'maintainer';
  const limit = Object.entries(D.limits || {}).find(([u]) => lc(u) === lc(me.login))?.[1] ?? D.maxPerOwner;
  $('#nameCount').textContent = unlimited ? `(${top.length})` : `(${top.length}/${limit})`;
  const list = $('#nameList');
  list.replaceChildren();
  for (const n of top) {
    const b = h('button', { className: 'side-item', type: 'button', ariaCurrent: String(pick.kind === 'name' && pick.id === n.name) },
      n.name, h('small', { textContent: n.status && n.status !== 'active' ? n.status : n.host }));
    b.addEventListener('click', () => { pick = { kind: 'name', id: n.name }; render(); });
    list.append(b);
  }
  if (!top.length) list.append(h('p', { className: 'side-empty', textContent: 'No names yet.' }));
  const rl = $('#reqList');
  rl.replaceChildren();
  for (const r of requests.slice(0, 20)) {
    const b = h('button', { className: 'side-item', type: 'button', ariaCurrent: String(pick.kind === 'req' && pick.id === r.id) },
      r.name, h('small', {}, h('span', { className: `pill ${r.state}`, textContent: r.state })));
    b.addEventListener('click', () => { pick = { kind: 'req', id: r.id }; render(); });
    rl.append(b);
  }
  if (!requests.length) rl.append(h('p', { className: 'side-empty', textContent: 'None.' }));
}

// ── A name: the DNS manager ────────────────────────────────────
function renderName(n) {
  const pane = $('#pane');
  const host = `${n.name}.${D.domain}`;
  const hosted = n.host === 'Hosted by us';
  const result = h('div', { className: 'result', hidden: true });
  const facts = h('div', { className: 'facts' },
    h('span', { className: 'fact', textContent: n.host }),
    n.repo ? h('span', { className: 'fact' }, h('a', { href: repoUrl(D, n.repo), target: '_blank', rel: 'noopener', textContent: n.repo })) : null,
    n.status ? h('span', { className: `pill ${n.status}`, textContent: n.status }) : null,
    n.description ? h('span', { className: 'fact', textContent: n.description }) : null);
  const check = h('button', { className: 'btn', type: 'button', textContent: 'Check it' });
  check.addEventListener('click', () => run(result, 'verify', { name: n.name }, 'Checking DNS and HTTPS…'));

  // Records table
  const table = h('table', { className: 'records' }, h('thead', {}, h('tr', {}, ...['Type', 'Name', 'Content', ''].map((t) => h('th', { textContent: t })))));
  const tbody = h('tbody');
  for (const r of rows(n.name)) {
    const managed = hosted && r.full === n.name;
    const actions = h('td', { className: 'a' });
    if (managed) actions.append(h('span', { className: 'lock', textContent: '🔒 managed' }));
    else {
      const edit = h('button', { className: 'icon-btn', type: 'button', textContent: 'Edit' });
      edit.addEventListener('click', () => openForm({ label: r.label === '@' ? '' : r.label, type: r.type, value: r.value, old: r }));
      const del = h('button', { className: 'icon-btn del', type: 'button', textContent: 'Delete' });
      del.addEventListener('click', () => {
        if (!confirm(`Delete ${r.type} ${r.label === '@' ? host : `${r.label}.${host}`} → ${show(r.type, r.value)}?`)) return;
        save(r.full, { old: r });
      });
      actions.append(edit, del);
    }
    tbody.append(h('tr', {},
      h('td', { className: 't', textContent: r.type }),
      h('td', { className: 'n' }, r.label === '@' ? '@' : r.label, h('span', { textContent: r.label === '@' ? '' : `.${n.name}` })),
      h('td', { className: 'c', textContent: show(r.type, r.value) + (pending.has(r.full) ? '  (updating…)' : '') }),
      actions));
  }
  table.append(tbody);

  // Add / edit form
  const form = h('form', { className: 'rec-form', hidden: true });
  const type = h('select', { name: 'type' }, ...['A', 'AAAA', 'CNAME', 'TXT', 'MX'].map((t) => new Option(t, t)));
  const label = h('input', { name: 'label', placeholder: '@ or www', spellcheck: false, autocomplete: 'off' });
  const content = h('input', { name: 'content', placeholder: '', spellcheck: false, autocomplete: 'off', required: true });
  const prio = h('input', { name: 'prio', type: 'number', min: 0, max: 65535, value: 10, hidden: true, style: 'width:5rem' });
  const hint = { A: '203.0.113.7', AAAA: '2001:db8::7', CNAME: 'something.example.com', TXT: 'verification string', MX: 'mx1.example.com' };
  const syncType = () => { content.placeholder = hint[type.value]; prio.hidden = type.value !== 'MX'; };
  type.addEventListener('change', syncType);
  let editing = null;
  const cancel = h('button', { className: 'btn', type: 'button', textContent: 'Cancel' });
  cancel.addEventListener('click', () => { form.hidden = true; editing = null; });
  form.append(
    h('label', {}, 'Type', type),
    h('label', {}, 'Name', h('div', { className: 'suffix-wrap' }, label, h('span', { textContent: `.${n.name}` }))),
    h('label', {}, 'Content', h('div', { className: 'row' }, prio, content)),
    h('div', { className: 'row' }, h('button', { className: 'btn primary', type: 'submit', textContent: 'Save' }), cancel));
  function openForm(v = {}) {
    form.hidden = false;
    editing = v.old || null;
    type.value = v.type || 'A';
    label.value = v.label || '';
    content.value = v.value ? (v.type === 'MX' ? (typeof v.value === 'string' ? v.value : v.value.host) : String(v.value)) : '';
    prio.value = v.type === 'MX' && typeof v.value === 'object' ? v.value.priority ?? 10 : 10;
    syncType();
    content.focus();
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const lab = lc(label.value.trim()).replace(/^@$/, '').replace(new RegExp(`\\.?${n.name.replace(/[.]/g, '\\.')}(\\.${D.domain.replace(/[.]/g, '\\.')})?$`), '');
    if (lab && !lab.split('.').every((l) => /^_?[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/.test(l))) { toast('That name isn\'t valid', 'Use letters, numbers, dashes, and a leading _ for verification records.', 'err'); return; }
    const full = lab ? `${lab}.${n.name}` : n.name;
    if (hosted && full === n.name) { toast('Managed record', `${host} itself points at your hosted site. Add records under it instead (like www).`, 'err'); return; }
    let value = content.value.trim();
    if (type.value === 'MX') value = { host: lc(value).replace(/\.$/, ''), priority: Number(prio.value) || 10 };
    else if (type.value !== 'TXT') value = lc(value).replace(/\.$/, '');
    try {
      if (editing && editing.full !== full) {
        save(editing.full, { old: editing }, { quiet: true });
        save(full, { add: { type: type.value, value } });
      } else save(full, { old: editing, add: { type: type.value, value } });
      form.hidden = true;
    } catch (err) { toast('Can\'t add that', err.message, 'err'); }
  });
  const add = h('button', { className: 'btn primary', type: 'button', textContent: '＋ Add record' });
  add.addEventListener('click', () => openForm({ label: '' }));

  function save(full, change, { quiet } = {}) {
    const records = nextRecords(full, change);
    run(result, 'records', { name: full, records }, quiet ? 'Saving…' : `Saving ${full}.${D.domain}…`, () => {
      pending.set(full, records);
      renderName(n);
      setTimeout(refreshData, 90000);
    });
  }

  // Danger zone
  const transfer = h('a', { className: 'btn', target: '_blank', rel: 'noopener', textContent: 'Transfer…', href: `https://github.com/${D.repo}/issues/new?template=transfer.yml&title=${encodeURIComponent(`Transfer: ${n.name}`)}&subdomain=${encodeURIComponent(n.name)}` });
  const remove = h('button', { className: 'btn danger', type: 'button', textContent: 'Remove name…' });
  remove.addEventListener('click', () => {
    const typed = prompt(`This removes ${host} and every record under it${hosted ? ', and archives its repo' : ''}. Anyone could claim it afterwards.\n\nType ${n.name} to confirm.`);
    if (lc(typed || '').trim() !== n.name) return;
    run(result, 'remove', { name: n.name }, 'Removing…', () => setTimeout(refreshData, 90000));
  });

  fill(pane,
    identityBox(),
    emailBox(),
    h('div', { className: 'pane-head' },
      h('div', {}, h('h1', {}, h('a', { href: `https://${host}`, target: '_blank', rel: 'noopener', textContent: host })), facts),
      check),
    result,
    h('section', { className: 'card-box' },
      h('header', {}, h('h2', { textContent: 'DNS records' }), add),
      table, form),
    hosted ? hostedBox(n, result) : null,
    h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'Name' })),
      h('div', { className: 'body' }, h('div', { className: 'danger-row' }, transfer, remove))));
}

// ── A hosted site: deploys and collaborators ───────────────────
const ago = (iso) => {
  if (!iso) return 'never';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} days ago`;
};
function hostedBox(n, result) {
  const snap = (snapshot.sites || []).find((x) => x.name === n.name) || {};
  const dep = snap.deploy || {};
  const depText = dep.conclusion === 'success' ? '✅ deployed' : dep.conclusion === 'failure' ? '❌ last deploy failed' : dep.conclusion ? `⏳ ${dep.conclusion}` : 'no deploys yet';
  const facts = h('div', { className: 'facts' },
    h('span', { className: 'fact' }, dep.url ? h('a', { href: dep.url, target: '_blank', rel: 'noopener', textContent: depText }) : depText, dep.at ? ` · ${ago(dep.at)}` : ''),
    h('span', { className: 'fact', textContent: snap.https ? '🔒 HTTPS' : '🔓 HTTPS pending' }),
    snap.sizeMB !== undefined ? h('span', { className: 'fact', textContent: `${snap.sizeMB} MB` }) : null,
    h('span', { className: 'fact', textContent: `last push ${ago(snap.pushedAt)}` }));
  const redeploy = h('button', { className: 'btn primary', type: 'button', textContent: 'Redeploy', disabled: n.status && n.status !== 'active' });
  redeploy.addEventListener('click', () => run(result, 'redeploy', { name: n.name }, 'Starting a deploy…'));
  // Collaborators
  const list = h('ul', { className: 'chips' });
  const people = [...new Set([...(snap.collaborators || []), ...(snap.pendingInvites || []).map((p) => `${p} (invited)`)])].filter((p) => lc(p) !== lc(n.owner));
  for (const p of people) {
    const login = p.replace(/ \(invited\)$/, '');
    const x = h('button', { type: 'button', textContent: '×', ariaLabel: `Remove ${login}` });
    x.addEventListener('click', () => { if (confirm(`Remove @${login} from ${n.name}?`)) run(result, 'site-collab', { name: n.name, user: login, op: 'remove' }, 'Removing…'); });
    list.append(h('li', {}, `@${p}`, x));
  }
  if (!people.length) list.append(h('li', { className: 'empty', textContent: 'Just you.' }));
  const who = h('input', { placeholder: '@friend', spellcheck: false, autocomplete: 'off' });
  const managed = isManagedRepo(D, n.repo); // managed: we give their enterprise account access, no invite to accept
  const add = h('form', { className: 'inline' }, who, h('button', { className: 'btn', type: 'submit', textContent: managed ? 'Add' : 'Invite' }));
  add.addEventListener('submit', (e) => { e.preventDefault(); if (who.value.trim()) run(result, 'site-collab', { name: n.name, user: who.value.trim(), op: 'add' }, `${managed ? 'Adding' : 'Inviting'} ${who.value.trim()}…`); });
  return h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'Your site' }), redeploy),
    h('div', { className: 'body' },
      facts,
      h('p', {}, 'Push to ', h('code', { textContent: 'main' }), ' and it\'s live a minute later. Workflows are managed for you.'),
      h('div', { className: 'danger-row' },
        h('a', { className: 'btn', href: repoUrl(D, n.repo), target: '_blank', rel: 'noopener', textContent: 'Open the repo' }),
        // Managed repos have no invite: their enterprise account already has access, after signing in.
        isManagedRepo(D, n.repo)
          ? (D.signIn ? h('a', { className: 'btn', href: D.signIn, target: '_blank', rel: 'noopener', textContent: 'Enterprise sign-in' }) : null)
          : h('a', { className: 'btn', href: `https://github.com/${n.repo}/invitations`, target: '_blank', rel: 'noopener', textContent: 'Accept your invite' }),
        h('a', { className: 'btn', href: `${repoUrl(D, n.repo)}/actions`, target: '_blank', rel: 'noopener', textContent: 'Deploy logs' })),
      h('h3', { className: 'sub-h', textContent: `Collaborators (up to ${D.settings && D.settings.maxCollaboratorsPerSite ? D.settings.maxCollaboratorsPerSite.value : 2})` }),
      list, add,
      snapshot.at ? h('p', { className: 'help', textContent: `Status checked ${ago(new Date(snapshot.at).toISOString())}.` }) : null));
}

// ── A request ──────────────────────────────────────────────────
const ICON = { pass: '✅', info: 'ℹ️', hold: '⏸️', error: '✏️', reject: '⛔' };
const LABELS = { format: 'Format & records', ownership: 'Ownership', account: 'Account age', bot: 'Bot check', limit: 'Subdomains you own', name: 'Name check', target: 'Target is live', repo: 'Repository', consent: 'Consent' };
const STATE_TEXT = {
  checking: 'The bot is checking it…',
  ready: 'Everything checks out. A maintainer will approve it soon.',
  'on-hold': 'Waiting on a maintainer\'s look. Nothing for you to do.',
  'needs-changes': 'A few things to fix: edit the request below.',
  approving: 'Approved! Setting it up…',
  live: 'It\'s live.',
  rejected: 'This request wasn\'t accepted.',
  cancelled: 'You cancelled this request.',
};
let reqTimer = null;

async function renderRequest(id) {
  clearTimeout(reqTimer);
  const pane = $('#pane');
  let data;
  try { data = await Panel.request(id); } catch (e) { pane.replaceChildren(h('p', { className: 'error', textContent: e.message })); return; }
  const r = data.request;
  const open = !['live', 'rejected', 'cancelled'].includes(r.state);
  const findings = (r.review && r.review.findings) || [];
  const table = h('table', { className: 'records check-table' }, h('tbody', {},
    ...Object.entries(LABELS).map(([k, label]) => {
      const fs = findings.filter((f) => f.check === k);
      if (!fs.length) return null;
      const rank = { pass: 0, info: 1, hold: 2, error: 3, reject: 4 };
      const worst = fs.reduce((a, f) => (rank[f.level] > rank[a.level] ? f : a));
      const shown = worst.level === 'pass' || worst.level === 'info' ? fs : fs.filter((f) => f.level !== 'pass');
      const cell = h('td', { className: 'md' });
      cell.innerHTML = shown.map((f) => Panel.md(f.text).replace(/^<p>|<\/p>$/g, '')).join('<br>');
      return h('tr', {}, h('td', { textContent: ICON[worst.level] }), h('td', { textContent: label }), cell);
    })));
  const thread = h('div', { className: 'thread' });
  for (const n of data.notes) {
    const body = h('div', { className: 'md' });
    body.innerHTML = Panel.md(n.body);
    thread.append(h('article', { className: `msg ${n.author === 'bot' ? 'bot' : ''}` },
      h('header', {}, h('b', { textContent: n.author === 'bot' ? '🤖 bot' : `@${n.author}` }), new Date(n.created_at).toLocaleString()), body));
  }
  const noteForm = h('form', { className: 'note-form' }, h('textarea', { name: 'body', placeholder: 'Write to the maintainers…', required: true }), h('div', { className: 'row' }, h('button', { className: 'btn', type: 'submit', textContent: 'Send' })));
  noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await Panel.requestDo(id, 'note', { body: noteForm.body.value }); renderRequest(id); } catch (err) { toast('Couldn\'t send', err.message, 'err'); }
  });
  const actions = h('div', { className: 'danger-row' });
  if (open && r.state !== 'approving') {
    const edit = h('button', { className: 'btn', type: 'button', textContent: 'Edit request' });
    edit.addEventListener('click', () => renderNew({ editing: r }));
    const cancel = h('button', { className: 'btn danger', type: 'button', textContent: 'Cancel request' });
    cancel.addEventListener('click', async () => {
      if (!confirm(`Cancel your request for ${r.name}?`)) return;
      await Panel.requestDo(id, 'cancel').catch((err) => toast('Couldn\'t cancel', err.message, 'err'));
      await loadRequests();
      render();
    });
    actions.append(edit, cancel);
  }
  const guide = r.result && r.result.guide ? h('div', { className: 'md' }) : null;
  if (guide) guide.innerHTML = Panel.md(r.result.guide);
  fill(pane,
    h('div', { className: 'pane-head' },
      h('div', {}, h('h1', { textContent: `${r.name}.${D.domain}` }),
        h('div', { className: 'facts' }, h('span', { className: `pill ${r.state}`, textContent: r.state }), h('span', { className: 'fact', textContent: r.form.provider }), h('span', { className: 'fact', textContent: `asked ${new Date(r.createdAt).toLocaleDateString()}` }))),
      actions),
    h('p', { className: 'lede', textContent: STATE_TEXT[r.state] || '' }),
    guide ? h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'Next steps' })), h('div', { className: 'body' }, guide)) : null,
    findings.length ? h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'What the bot checked' })), table) : null,
    h('section', { className: 'card-box' }, h('header', {}, h('h2', { textContent: 'Conversation' })), h('div', { className: 'body' }, data.notes.length ? thread : h('p', { className: 'muted', textContent: 'No messages yet.' }), open ? noteForm : null)));
  if (['checking', 'approving'].includes(r.state)) reqTimer = setTimeout(() => { if (pick.kind === 'req' && pick.id === id) { renderRequest(id); loadRequests().then(renderSide); } }, 4000);
}

// ── New request ────────────────────────────────────────────────
function renderNew({ editing } = {}) {
  const pane = $('#pane');
  const f = editing ? editing.form : {};
  const name = h('input', { name: 'name', placeholder: 'yourname', value: editing ? editing.name : '', disabled: !!editing, spellcheck: false, autocomplete: 'off', required: true });
  const avail = h('p', { className: 'help' });
  const prov = h('select', { name: 'provider' }, ...D.providers.map((p) => new Option(p.label, p.label)));
  prov.value = f.provider || D.providers[0].label;
  const repo = h('input', { name: 'repo', placeholder: 'you/your-site', value: f.repo || '', spellcheck: false });
  const target = h('input', { name: 'target', value: f.target || '', spellcheck: false });
  const desc = h('input', { name: 'description', maxLength: 200, value: f.description || '', placeholder: 'My portfolio' });
  const tpl = h('select', { name: 'template' }, ...(D.templates || []).map((t) => new Option(`${t.label} · ${t.blurb}`, t.id)));
  tpl.value = f.template || 'html';
  const tplL = h('label', {}, 'Start from', tpl);
  const repoL = h('label', {}, 'GitHub repository', repo);
  const targetL = h('label', {}, 'Target', target);
  const sync = () => {
    const p = D.providers.find((x) => x.label === prov.value);
    repoL.hidden = p.input !== 'repo';
    tplL.hidden = p.id !== 'hosted';
    targetL.hidden = !(p.input === 'target' || p.input === 'ips');
    target.placeholder = p.input === 'ips' ? '203.0.113.7' : p.suffix ? `my-site${p.suffix}` : 'host.example.com';
  };
  prov.addEventListener('change', sync);
  const check = () => {
    const v = lc(name.value.trim());
    if (editing || !v) { avail.textContent = ''; return; }
    avail.textContent = !BASE_LABEL.test(v) ? '✏️ a-z, 0-9 and dashes; no dash at the ends'
      : D.reserved.includes(v) ? '⛔ reserved'
        : D.names.some((n) => n.name === v) ? `🔒 taken by @${D.names.find((n) => n.name === v).owner}`
          : `✅ ${v}.${D.domain} is free`;
  };
  name.addEventListener('input', check);
  const result = h('div', { className: 'result', hidden: true });
  const form = h('form', { className: 'form-grid' },
    h('label', {}, 'Name', h('div', { className: 'suffix-wrap' }, name, h('span', { textContent: `.${D.domain}` })), avail),
    h('label', {}, 'Where should it point?', prov), tplL, repoL, targetL,
    h('label', {}, 'One line about it', desc),
    h('div', { className: 'row' }, h('button', { className: 'btn primary', type: 'submit', textContent: editing ? 'Save changes' : 'Send request' })),
    h('p', { className: 'help', textContent: 'Only you and the maintainers can see your request.' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = D.providers.find((x) => x.label === prov.value);
    const body = { name: lc(name.value.trim()), provider: prov.value, template: p.id === 'hosted' ? tpl.value : '', repo: p.input === 'repo' ? repo.value : '', target: p.input === 'target' || p.input === 'ips' ? target.value : '', description: desc.value };
    result.hidden = false;
    result.className = 'result busy';
    result.textContent = 'Sending…';
    try {
      let id;
      if (editing) { await Panel.requestDo(editing.id, 'edit', body); id = editing.id; } else id = (await Panel.newRequest(body)).request.id;
      await loadRequests();
      pick = { kind: 'req', id };
      render();
    } catch (err) {
      result.className = 'result err';
      result.textContent = err.message;
    }
  });
  pane.replaceChildren(h('div', { className: 'pane-head' }, h('h1', { textContent: editing ? `Edit ${editing.name}` : 'Get a new name' })), result,
    h('section', { className: 'card-box' }, h('div', { className: 'body' }, form)));
  sync();
  check();
  if (!editing) {
    // Arriving from the website's "Claim" flow: everything is pre-filled.
    const q = new URLSearchParams(location.search);
    if (q.get('name')) name.value = q.get('name');
    if (q.get('provider') && D.providers.some((p) => p.label === q.get('provider'))) prov.value = q.get('provider');
    if (q.get('repo')) repo.value = q.get('repo');
    if (q.get('target')) target.value = q.get('target');
    if (q.get('description')) desc.value = q.get('description');
    if (q.get('template')) tpl.value = q.get('template');
    sync();
    check();
    name.focus();
  }
}

// ── Shell ──────────────────────────────────────────────────────
function render() {
  renderSide();
  if (pick.kind === 'new') return renderNew();
  if (pick.kind === 'req') return renderRequest(pick.id);
  const n = myTop().find((x) => x.name === pick.id) || myTop()[0];
  if (!n) {
    fill($('#pane'), identityBox(), emailBox(), h('div', { className: 'empty-state' }, h('p', { textContent: 'You don\'t have a name yet.' }), h('button', { className: 'btn primary', type: 'button', textContent: 'Get one', onclick: () => { pick = { kind: 'new' }; render(); } })));
    return;
  }
  pick = { kind: 'name', id: n.name };
  renderSide();
  renderName(n);
}
async function loadRequests() {
  requests = await Panel.requests().then((d) => d.requests, () => []);
}
async function refreshData() {
  const fresh = await fetch('../data.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null);
  if (!fresh) return;
  D = fresh;
  for (const [full, recs] of pending) {
    const cur = (D.names.find((n) => n.name === full) || {}).records || null;
    if (JSON.stringify(cur) === JSON.stringify(recs)) pending.delete(full);
  }
  if (pick.kind === 'name') render();
}

$('#ghLogin').addEventListener('click', () => Panel.login($('#keep').checked));
$('#signOut').addEventListener('click', () => { Panel.logout(); location.reload(); });
$('#newBtn').addEventListener('click', () => { pick = { kind: 'new' }; render(); });

fetch('../data.json', { cache: 'no-cache' }).then((r) => r.json()).then(async (data) => {
  D = data;
  Panel.setApi(D.panelApi);
  if (Panel.signedIn()) {
    try {
      me = await Panel.me();
      $('#signin').hidden = true;
      $('#app').hidden = false;
      $('#who').hidden = false;
      $('#whoName').textContent = `@${me.login}`;
      if (me.avatar) $('#whoAvatar').src = `${me.avatar}${me.avatar.includes('?') ? '&' : '?'}s=56`;
      await loadRequests();
      snapshot = await Panel.sites().catch(() => ({ sites: [] }));
      ident = await Panel.identity().catch(() => ident);
      contact = await Panel.contact().catch(() => contact);
      if (Panel.emailResult === 'saved') toast('Email is on', `We'll email ${contact.email || 'you'}.`);
      if (Panel.emailResult === 'none') toast('No address found', 'GitHub has no verified email for your account. Add one in GitHub settings, then try again.', 'err');
      if (D.announcement) document.body.prepend(h('div', { className: 'announce', role: 'status' }, '📣 ', D.announcement));
      if (new URLSearchParams(location.search).get('new') !== null || new URLSearchParams(location.search).get('name')) pick = { kind: 'new' };
      return render();
    } catch { Panel.logout(); }
  }
  if (!(await Panel.up())) { $('#panelDown').hidden = false; $('#ghLogin').disabled = true; }
}).catch(() => toast('Couldn\'t load your names', 'Reload the page.', 'err'));
