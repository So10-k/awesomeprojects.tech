// "My domains": sign in with GitHub, manage your own names. Every action goes to the bot through
// api.awesomeprojects.tech, which checks it's yours and runs the same checks as a request.
'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const lc = (s) => String(s || '').toLowerCase();
let D = null;
let me = null;

function toast(title, body, kind = '') {
  const t = Object.assign(document.createElement('div'), { className: `toast ${kind}` });
  t.append(Object.assign(document.createElement('b'), { textContent: title }), body || '');
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

$('#ghLogin').addEventListener('click', () => Panel.login($('#keep').checked));
$('#signOut').addEventListener('click', () => { Panel.logout(); location.reload(); });

const records = (n) => `${n.name.padEnd(14)} ${n.type.padEnd(6)} ${n.target}`;

function show() {
  $('#signin').hidden = true;
  $('#mine').hidden = false;
  $('#who').hidden = false;
  $('#whoName').textContent = `@${me.login}`;
  if (me.avatar) $('#whoAvatar').src = `${me.avatar}${me.avatar.includes('?') ? '&' : '?'}s=56`;

  const mineAll = D.names.filter((n) => lc(n.owner) === lc(me.login));
  const top = mineAll.filter((n) => !n.name.includes('.'));
  const limit = Object.entries(D.limits || {}).find(([u]) => lc(u) === lc(me.login))?.[1] ?? D.maxPerOwner;
  const unlimited = me.role === 'owner' || me.role === 'maintainer';
  $('#mineCount').textContent = unlimited ? `${top.length}` : `${top.length} of ${limit}`;
  $('#claimMore').hidden = !unlimited && top.length >= limit;
  $('#freshness').textContent = `Updated ${new Date(D.generatedAt).toLocaleString()}. After a change, this list catches up within a couple of minutes.`;

  const box = $('#names');
  box.replaceChildren();
  if (!top.length) {
    const e = Object.assign(document.createElement('div'), { className: 'empty-state' });
    e.append('You don\'t have a name yet.', document.createElement('br'), Object.assign(document.createElement('a'), { className: 'btn primary', href: '../#claim', textContent: 'Find one' }));
    box.append(e);
    return;
  }
  for (const n of top) box.append(nameCard(n, mineAll.filter((x) => x.name.endsWith(`.${n.name}`))));
}

function nameCard(n, under) {
  const c = $('#nameTpl').content.firstElementChild.cloneNode(true);
  const host = `${n.name}.${D.domain}`;
  Object.assign($('.nc-name', c), { href: `https://${host}`, textContent: host });
  $('.nc-host', c).textContent = n.host;
  $('.nc-record', c).textContent = records(n);
  $('.nc-desc', c).textContent = n.description || '';
  for (const u of under) $('.nc-under', c).append(Object.assign(document.createElement('li'), { textContent: `${u.name.slice(0, -n.name.length - 1)} ${u.type}` }));
  $('.nc-confirm-name', c).textContent = n.name;
  $('[data-do="transfer"]', c).href = `https://github.com/${D.repo}/issues/new?template=transfer.yml&title=${encodeURIComponent(`Transfer: ${n.name}`)}&subdomain=${encodeURIComponent(n.name)}`;

  const forms = $$('.nc-form', c);
  const open = (which) => forms.forEach((f) => { f.hidden = f.dataset.form !== which || !f.hidden; });
  for (const f of forms) $('[data-cancel]', f).addEventListener('click', () => { f.hidden = true; });

  // Change: providers from data.json, prefilled with what's there now.
  const form = $('[data-form="change"]', c);
  const sel = form.provider;
  for (const p of D.providers) sel.append(new Option(p.label, p.id));
  const current = D.providers.find((p) => p.label === n.host || p.id === (n.repo ? 'github-pages' : '')) || D.providers.find((p) => p.id === (n.type === 'A' || n.type === 'AAAA' ? 'server' : 'cname'));
  sel.value = current ? current.id : 'cname';
  form.repo.value = n.repo || '';
  form.target.value = n.type === 'CNAME' ? n.target : n.type === 'A' || n.type === 'AAAA' ? n.target : '';
  form.description.value = n.description || '';
  const sync = () => {
    const p = D.providers.find((x) => x.id === sel.value);
    $('[data-for="repo"]', form).hidden = p.input !== 'repo';
    $('[data-for="target"]', form).hidden = !(p.input === 'target' || p.input === 'ips');
    form.target.placeholder = p.input === 'ips' ? '203.0.113.7' : p.suffix ? `my-site${p.suffix}` : 'host.example.com';
  };
  sel.addEventListener('change', sync);
  sync();

  $('[data-do="verify"]', c).addEventListener('click', () => run(c, 'verify', { name: n.name }, 'Checking DNS and HTTPS…'));
  $('[data-do="change"]', c).addEventListener('click', () => open('change'));
  $('[data-do="txt"]', c).addEventListener('click', () => open('txt'));
  $('[data-do="remove"]', c).addEventListener('click', () => open('remove'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = D.providers.find((x) => x.id === sel.value);
    run(c, 'update', {
      name: n.name,
      provider: p.label,
      repo: p.input === 'repo' ? form.repo.value : '',
      target: p.input === 'target' || p.input === 'ips' ? form.target.value : '',
      description: form.description.value,
    }, 'Checking the new target…');
    form.hidden = true;
  });
  $('[data-form="txt"]', c).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    run(c, 'txt', { name: n.name, label: f.label.value, value: f.value.value }, 'Adding the record…');
    f.hidden = true;
  });
  $('[data-form="remove"]', c).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (lc(f.confirm.value.trim()) !== n.name) { toast('Type the name exactly to confirm.', '', 'err'); return; }
    run(c, 'remove', { name: n.name }, 'Removing…');
    f.hidden = true;
  });
  return c;
}

async function run(cardEl, action, args, busyText) {
  const out = $('.nc-result', cardEl);
  out.hidden = false;
  out.className = 'nc-result md busy';
  out.textContent = busyText;
  for (const b of $$('button', cardEl)) b.disabled = true;
  try {
    const job = await Panel.run(action, args);
    out.className = `nc-result md ${job.state === 'done' ? 'ok' : 'err'}`;
    out.innerHTML = Panel.md(job.message || (job.state === 'done' ? 'Done.' : 'That didn\'t work.'));
  } catch (e) {
    out.className = 'nc-result md err';
    out.textContent = e.status === 401 ? 'Your sign-in expired. Sign in again.' : e.message;
  } finally {
    for (const b of $$('button', cardEl)) b.disabled = false;
  }
}

fetch('../data.json', { cache: 'no-cache' }).then((r) => r.json()).then(async (data) => {
  D = data;
  Panel.setApi(D.panelApi);
  if (Panel.signedIn()) {
    try { me = await Panel.me(); return show(); } catch { Panel.logout(); }
  }
  if (!(await Panel.up())) { $('#panelDown').hidden = false; $('#ghLogin').disabled = true; }
}).catch(() => toast('Couldn\'t load your names', 'Reload the page.', 'err'));
