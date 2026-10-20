import { useMemo, useState } from 'preact/hooks';
import { call, ago, when, SITE } from './api.js';
import { Act, Empty, Fail, Head, Mono, Pill, Skeleton, User, useCap, useLoad, useSession, useToast } from './ui.jsx';
import { Lookup, Notes } from './ops.jsx';
import { IssueLink, NameLink, Progress, QueueLink } from './ui.jsx';

const lc = (s) => String(s || '').toLowerCase();
const KIND = { request: 'Request', 'private-request': 'Private request', report: 'Report', application: 'Application', deploy: 'Failing deploy' };
const STATE_PILL = { new: ['info', 'new'], triaged: ['', 'triaged'], assigned: ['signal', 'assigned'], decided: ['ok', '✓ decided'] };
/** The queue copy on our GitHub server (zone.emuHost), e.g. maintainers/queue#5 → its issue page. */
let serverHost = 'github.samsprojects.xyz';
export const setServerHost = (h) => { if (h) serverHost = h; };
const copyUrl = (_me, copy) => {
  const [full, n] = String(copy || '').split('#');
  return full && n ? `https://${serverHost}/${full}/issues/${n}` : null;
};

// ── Overview ───────────────────────────────────────────────────
export function Overview() {
  const { me } = useSession();
  const q = useLoad(() => call('/v2/queue'));
  const c = useLoad(() => call('/v2/cosigns'));
  const d = useLoad(() => call('/v2/duty'));
  const ev = useLoad(() => call('/v2/events?limit=12'));
  const items = (q.data && q.data.items) || [];
  const open = items.filter((i) => i.state !== 'decided');
  const mine = open.filter((i) => lc(i.assignee) === lc(me.login));
  const overdue = open.filter((i) => i.overdue);
  const confirmable = ((c.data && c.data.cosigns) || []).filter((x) => x.canConfirm);
  const now = Date.now();
  const onNow = ((d.data && d.data.shifts) || []).filter((s) => s.starts_at <= now && s.ends_at > now);
  const iAmOn = onNow.some((s) => lc(s.login) === lc(me.login));
  return (
    <div class="view">
      <div class="hello">
        <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {me.login}</h1>
        <p class="dim">{me.person ? `${me.person.rank}${me.person.rolesets && me.person.rolesets.length && me.person.rank !== 'owner' ? ` · ${me.person.rolesets.join(', ')}` : ''}` : 'Not on the roster'}</p>
      </div>
      <div class="tiles">
        <a class="tile" href="#/queue?f=mine"><span>Assigned to you</span><b>{q.loading && !q.data ? '…' : mine.length}</b></a>
        <a class={`tile ${overdue.length ? 'warn' : ''}`} href="#/queue?f=overdue"><span>Overdue</span><b>{q.loading && !q.data ? '…' : overdue.length}</b></a>
        <a class="tile" href="#/queue"><span>Open in the queue</span><b>{q.loading && !q.data ? '…' : open.length}</b></a>
        <a class={`tile ${confirmable.length ? 'signal' : ''}`} href="#/access"><span>Waiting for your cosign</span><b>{c.loading && !c.data ? '…' : confirmable.length}</b></a>
      </div>
      <div class="cols">
        <section class="panel">
          <Head title="Duty">
            {iAmOn ? <Act cap="duty.take" action="duty-end" args={{}} kind="quiet" onDone={d.reload}>End my shift</Act>
              : <Act cap="duty.take" action="duty-take" args={{ hours: 8 }} kind="primary" onDone={d.reload}>Go on duty · 8 h</Act>}
          </Head>
          {d.error ? <Fail error={d.error} reload={d.reload} /> : !d.data ? <Skeleton rows={2} /> : !d.data.rotation
            ? <p class="dim">No rotation. Everyone counts as on duty, so elevations up to write go through on their own.</p>
            : onNow.length
              ? <ul class="list">{onNow.map((s) => <li key={s.id}><span class="dot live" /> <User login={s.login} /> <span class="dim">until {when(s.ends_at)}</span></li>)}</ul>
              : <p class="warn-text">Nobody is on duty. Elevations need a lead to cosign until someone is.</p>}
        </section>
        <section class="panel">
          <Head title="Your queue" count={mine.length}><a class="btn quiet" href="#/queue">All →</a></Head>
          {q.error ? <Fail error={q.error} reload={q.reload} /> : !q.data ? <Skeleton rows={3} /> : mine.length === 0
            ? <p class="dim">Nothing assigned to you. New items go to whoever is on duty first.</p>
            : <ul class="list">{mine.slice(0, 6).map((i) => <li key={i.id}><Pill kind={i.overdue ? 'bad' : ''}>{KIND[i.kind] || i.kind}</Pill> <QueueLink q={i} /> <Progress p={i.progress} /> <span class="dim">due {ago(i.due_at)}</span></li>)}</ul>}
        </section>
      </div>
      <section class="panel">
        <Head title="Recent activity"><a class="btn quiet" href="#/audit">Audit →</a></Head>
        {ev.error ? <Fail error={ev.error} reload={ev.reload} /> : !ev.data ? <Skeleton rows={5} /> : <Events rows={ev.data.events} />}
      </section>
    </div>
  );
}

function Events({ rows }) {
  if (!rows || !rows.length) return <Empty title="Nothing yet">Every command, review and change lands here.</Empty>;
  return (
    <table class="t">
      <tbody>{rows.map((e) => (
        <tr key={e.id}>
          <td class="w-time dim">{ago(e.at)}</td>
          <td class="w-kind"><Mono>{e.kind}</Mono></td>
          <td>{e.summary.replace(/\*\*/g, '').slice(0, 220)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

// ── Queue ──────────────────────────────────────────────────────
export function Queue({ params }) {
  const { me } = useSession();
  const q = useLoad(() => call('/v2/queue'));
  const roster = useLoad(() => call('/v2/roster'));
  const [f, setF] = useState(params.get('f') || 'open');
  const items = (q.data && q.data.items) || [];
  const shown = items.filter((i) => (f === 'open' ? i.state !== 'decided' : f === 'mine' ? i.state !== 'decided' && lc(i.assignee) === lc(me.login) : f === 'overdue' ? i.overdue : i.state === 'decided'));
  const people = ((roster.data && roster.data.people) || []).filter((p) => p.status === 'active');
  const counts = { open: items.filter((i) => i.state !== 'decided').length, mine: items.filter((i) => i.state !== 'decided' && lc(i.assignee) === lc(me.login)).length, overdue: items.filter((i) => i.overdue).length, decided: items.filter((i) => i.state === 'decided').length };
  return (
    <div class="view">
      <Head title="Queue">
        <div class="seg" role="tablist" aria-label="Filter">
          {[['open', 'Open'], ['mine', 'Mine'], ['overdue', 'Overdue'], ['decided', 'Decided']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={f === k} onClick={() => { setF(k); history.replaceState(null, '', `#/queue?f=${k}`); }}>{label} <span class="count">{counts[k]}</span></button>
          ))}
        </div>
        <button class="btn quiet" type="button" onClick={q.reload} title="Refresh (r)">↻</button>
      </Head>
      {q.error ? <Fail error={q.error} reload={q.reload} /> : !q.data ? <Skeleton rows={6} /> : shown.length === 0
        ? <Empty title={f === 'overdue' ? 'Nothing overdue' : f === 'mine' ? 'Nothing assigned to you' : 'The queue is clear'}>Requests, reports and applications show up here as soon as they’re filed, with a deadline and someone assigned.</Empty>
        : (
          <div class="scroll-x"><table class="t">
            <thead><tr><th>Item</th><th>Kind</th><th>Progress</th><th>State</th><th>Assignee</th><th>Due</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>{shown.map((i) => (
              <tr key={i.id} class={i.overdue ? 'is-late' : ''}>
                <td><QueueLink q={i} />{i.copy && <a class="sub-link dim" href={copyUrl(me, i.copy)} target="_blank" rel="noopener" title="The copy on our server">↗</a>}{i.note && <div class="sub dim">📝 {i.note}</div>}</td>
                <td><Pill>{KIND[i.kind] || i.kind}</Pill></td>
                <td class="nowrap"><Progress p={i.progress} />{i.progress && i.progress.next && <div class="sub dim">next: {i.progress.next.label.toLowerCase()}</div>}</td>
                <td><Pill kind={(STATE_PILL[i.state] || [''])[0]}>{(STATE_PILL[i.state] || ['', i.state])[1]}</Pill></td>
                <td><User login={i.assignee} /></td>
                <td class={`nowrap ${i.overdue ? 'bad-text' : 'dim'}`}>{i.state === 'decided' ? ago(i.decided_at) : i.overdue ? `▲ ${ago(i.due_at)}` : ago(i.due_at)}</td>
                <td class="w-actions">{i.state !== 'decided' && i.copy && (
                  <div class="row-actions">
                    {lc(i.assignee) !== lc(me.login) && <Act cap="queue.work" action="queue" args={{ verb: 'claim', copy: i.copy }} onDone={q.reload}>Claim</Act>}
                    {lc(i.assignee) === lc(me.login) && <Act cap="queue.work" action="queue" args={{ verb: 'unassign', copy: i.copy }} kind="quiet" onDone={q.reload}>Hand back</Act>}
                    <AssignMenu copy={i.copy} people={people} onDone={q.reload} />
                    {i.kind === 'application' && <><Act cap="roster.vote" action="queue" args={{ verb: 'vote', vote: 'yes', copy: i.copy }}>Vote yes</Act><Act cap="roster.vote" action="queue" args={{ verb: 'vote', vote: 'no', copy: i.copy }} kind="quiet">no</Act></>}
                  </div>
                )}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
    </div>
  );
}

function AssignMenu({ copy, people, onDone }) {
  const v = useCap('queue.assign');
  const [who, setWho] = useState('');
  if (v === 'deny' || !people.length) return null;
  return (
    <span class="assign">
      <select aria-label="Assign to" value={who} onChange={(e) => setWho(e.currentTarget.value)}>
        <option value="">Assign…</option>
        {people.map((p) => <option key={p.github} value={p.github}>@{p.github}</option>)}
      </select>
      {who && <Act cap="queue.assign" action="queue" args={{ verb: 'assign', user: who, copy }} onDone={() => { setWho(''); onDone(); }}>Assign</Act>}
    </span>
  );
}

// ── Requests (public issues + private requests) ────────────────
export function Requests() {
  const pub = useLoad(() => call('/api/queue'));
  const priv = useLoad(() => call('/api/requests?scope=all'));
  const issues = ((pub.data && pub.data.items) || []).filter((i) => i.labels.includes('request') || i.labels.includes('takedown') || i.pull_request);
  const privOpen = ((priv.data && priv.data.requests) || []).filter((r) => !['live', 'rejected', 'cancelled'].includes(r.state));
  const label = (i) => ['ready', 'on-hold', 'needs-changes', 'approving'].find((l) => i.labels.includes(l));
  const LP = { ready: 'ok', 'on-hold': 'warn', 'needs-changes': 'bad', approving: 'info' };
  return (
    <div class="view">
      <section class="panel">
        <Head title="Public requests and reports" count={issues.length}><button class="btn quiet" type="button" onClick={pub.reload}>↻</button></Head>
        {pub.error ? <Fail error={pub.error} reload={pub.reload} /> : !pub.data ? <Skeleton rows={4} /> : issues.length === 0 ? <Empty title="Nothing open">New requests and reports appear here, checked by the bot first.</Empty> : (
          <table class="t">
            <thead><tr><th>#</th><th>Title</th><th>From</th><th>State</th><th>Opened</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>{issues.map((i) => {
              const report = i.labels.includes('takedown');
              const l = label(i);
              return (
                <tr key={i.number}>
                  <td class="dim"><Mono>{i.number}</Mono></td>
                  <td><IssueLink number={i.number}>{i.title}</IssueLink>{i.pull_request && <span class="dim"> · PR</span>}</td>
                  <td><User login={i.user.login} /></td>
                  <td>{report ? <Pill kind="bad">report</Pill> : l ? <Pill kind={LP[l]}>{l}</Pill> : <Pill>checking</Pill>}</td>
                  <td class="dim nowrap">{ago(Date.parse(i.created_at))}</td>
                  <td class="w-actions"><div class="row-actions">
                    {report ? <>
                      <Act cap="abuse.takedown" action="takedown" args={() => { const r = window.prompt('Reason for the takedown (shown publicly)'); return r === null ? null : { number: i.number, reason: r }; }} kind="danger">Take down</Act>
                      <Act cap="abuse.dismiss" action="dismiss" args={() => { const r = window.prompt('Why are you leaving it up?'); return r === null ? null : { number: i.number, reason: r }; }} kind="quiet">Dismiss</Act>
                    </> : <>
                      <Act cap="request.approve" action="approve" args={{ number: i.number }} kind="primary" onDone={pub.reload}>Approve</Act>
                      <Act cap="request.hold" action={i.labels.includes('on-hold') ? 'unhold' : 'hold'} args={{ number: i.number }} kind="quiet" onDone={pub.reload}>{i.labels.includes('on-hold') ? 'Release' : 'Hold'}</Act>
                      <Act cap="request.reject" action="reject" args={() => { const r = window.prompt('Reason (shown to the requester)'); return r === null ? null : { number: i.number, reason: r }; }} kind="quiet" onDone={pub.reload}>Reject</Act>
                    </>}
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>
      <section class="panel">
        <Head title="Private requests" count={privOpen.length}><button class="btn quiet" type="button" onClick={priv.reload}>↻</button></Head>
        {priv.error ? <Fail error={priv.error} reload={priv.reload} /> : !priv.data ? <Skeleton rows={3} /> : privOpen.length === 0 ? <Empty title="No private requests waiting">People who request privately from My domains show up here.</Empty> : (
          <table class="t">
            <thead><tr><th>Name</th><th>From</th><th>State</th><th>Updated</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>{privOpen.map((r) => <PrivRow key={r.id} r={r} reload={priv.reload} />)}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function PrivRow({ r, reload }) {
  const can = useCap('request.approve');
  const [busy, setBusy] = useState('');
  const decide = async (decision) => {
    const reason = decision === 'reject' || decision === 'hold' ? window.prompt(decision === 'reject' ? 'Reason (shown to the requester)' : 'Why hold it?') : '';
    if (reason === null) return;
    setBusy(decision);
    try { await call(`/api/requests/${encodeURIComponent(r.id)}/decide`, { method: 'POST', body: { decision, reason } }); reload(); } catch (e) { alert(e.message); } finally { setBusy(''); }
  };
  return (
    <tr>
      <td><Mono>{r.name}</Mono></td>
      <td><User login={r.requester} /></td>
      <td><Pill kind={r.state === 'ready' ? 'ok' : r.state === 'on-hold' ? 'warn' : r.state === 'needs-changes' ? 'bad' : ''}>{r.state}</Pill></td>
      <td class="dim">{ago(r.updatedAt || r.updated_at)}</td>
      <td class="w-actions">{can !== 'deny' && <div class="row-actions">
        <button class="btn primary" type="button" disabled={!!busy || can === 'cosign'} title={can === 'cosign' ? 'Trainees approve public requests, where a second maintainer can cosign' : undefined} onClick={() => decide('approve')}>Approve</button>
        <button class="btn quiet" type="button" disabled={!!busy} onClick={() => decide(r.state === 'on-hold' ? 'unhold' : 'hold')}>{r.state === 'on-hold' ? 'Release' : 'Hold'}</button>
        <button class="btn quiet" type="button" disabled={!!busy || can === 'cosign'} onClick={() => decide('reject')}>Reject</button>
      </div>}</td>
    </tr>
  );
}

// ── Names ──────────────────────────────────────────────────────
export function Names({ params }) {
  const { zone } = useSession();
  const life = useLoad(() => call('/v2/lifecycle'));
  const terms = useMemo(() => Object.fromEntries(((life.data && life.data.rows) || []).map((r) => [r.name, r])), [life.data]);
  const [q, setQ] = useState(params.get('q') || '');
  const names = useMemo(() => ((zone && zone.names) || []).filter((n) => !n.name.includes('.')).sort((a, b) => a.name.localeCompare(b.name)), [zone]);
  const needle = lc(q.trim());
  const shown = names.filter((n) => !needle || [n.name, n.owner, n.target, n.host, n.description || ''].some((s) => lc(s).includes(needle)));
  return (
    <div class="view">
      <Head title="Names" count={names.length}>
        <input class="input search" type="search" placeholder="Filter names, owners, targets" value={q} onInput={(e) => setQ(e.currentTarget.value)} data-autofocus aria-label="Filter names" />
      </Head>
      {!zone ? <Skeleton rows={8} /> : shown.length === 0 ? <Empty title="No name matches">It might be free: check it on the website.</Empty> : (
        <div class="scroll-x"><table class="t">
          <thead><tr><th>Name</th><th>Points to</th><th>Owner</th><th>Site</th><th>Renews</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>{shown.map((n) => (
            <tr key={n.name}>
              <td><NameLink name={n.name} />{n.description && <div class="sub dim clip-2" title={n.description}>{n.description}</div>}</td>
              <td class="dim"><span class="clip" title={`${n.type} ${n.target}`}><Mono>{n.type} {String(n.target).replace(/\.$/, '')}</Mono></span></td>
              <td><User login={n.owner} /></td>
              <td>{n.status ? <Pill kind={n.status === 'active' ? 'ok' : n.status === 'locked' ? 'warn' : 'bad'}>{n.status}</Pill> : <span class="dim">{n.host}</span>}</td>
              <td class="nowrap"><Term t={terms[n.name]} hold={n.hold} /></td>
              <td class="w-actions"><div class="row-actions">
                {terms[n.name] && <Renew name={n.name} onDone={life.reload} />}
                {n.status && <Act cap="site.sync" action="redeploy" args={{ name: n.name }} kind="quiet">Redeploy</Act>}
                {n.status && <SiteStatus name={n.name} status={n.status} />}
                <Act cap="abuse.takedown" action="takedown" args={() => { const r = window.prompt(`Take down ${n.name}? Reason (public):`); return r === null ? null : { name: n.name, reason: r }; }} kind="danger">Take down</Act>
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <CreateName />
    </div>
  );
}

function Term({ t, hold }) {
  if (hold || (t && t.state === 'hold')) return <Pill kind="bad">on hold</Pill>;
  if (!t) return <span class="dim">—</span>;
  const days = Math.ceil((Number(t.expires_at) - Date.now()) / 86400e3);
  return <span class={days <= 30 ? 'warn-text' : 'dim'} title={`Term started ${when(t.term_start)}`}>{new Date(Number(t.expires_at)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}{days <= 30 ? ` (${days} d)` : ''}</span>;
}

/** Renew a name for its owner (maintainers can; the owner does it in My domains). */
function Renew({ name, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await call('/api/renew', { method: 'POST', body: { name } });
      toast({ kind: 'ok', title: `Renewed ${name}`, body: `Good until ${new Date(r.expiresAt).toLocaleDateString()}.${r.wasOnHold ? ' The hold comes off in about a minute.' : ''}` });
      onDone();
    } catch (e) { toast({ kind: 'err', title: 'Couldn’t renew', body: e.message }); } finally { setBusy(false); }
  };
  return <button class="btn quiet" type="button" disabled={busy} onClick={go}>Renew</button>;
}

const HOSTS = [['cname', 'Any host (CNAME)'], ['server', 'A server (IP)'], ['github-pages', 'GitHub Pages'], ['vercel', 'Vercel'], ['netlify', 'Netlify'], ['cloudflare-pages', 'Cloudflare Pages'], ['render', 'Render'], ['railway', 'Railway'], ['fly', 'Fly.io'], ['hosted', 'Hosted by us']];
/** Make a name for someone: the same checks as a request (force skips the ones that can be skipped). */
export function CreateName() {
  const v = useCap('name.create');
  const [f, setF] = useState({ name: '', owner: '', provider: 'cname', target: '', repo: '', description: '', force: false });
  if (v === 'deny') return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const needsRepo = ['github-pages', 'vercel', 'netlify', 'cloudflare-pages'].includes(f.provider);
  const needsTarget = !needsRepo && f.provider !== 'hosted';
  const ready = f.name.trim() && f.owner.trim() && (!needsTarget || f.target.trim());
  return (
    <section class="panel">
      <Head title="Make a name for someone" />
      <form class="create" onSubmit={(e) => e.preventDefault()}>
        <label>Name<input class="input" value={f.name} onInput={set('name')} placeholder="alice" /></label>
        <label>Owner<input class="input" value={f.owner} onInput={set('owner')} placeholder="@alice" /></label>
        <label>Where it points<select value={f.provider} onChange={set('provider')}>{HOSTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {needsTarget && <label>{f.provider === 'server' ? 'IP address' : 'Target'}<input class="input" value={f.target} onInput={set('target')} placeholder={f.provider === 'server' ? '203.0.113.7' : 'alice.example.com'} /></label>}
        {(needsRepo || f.provider === 'hosted') && <label>Repository<input class="input" value={f.repo} onInput={set('repo')} placeholder={f.provider === 'hosted' ? 'optional: a template or repo to start from' : 'alice/portfolio'} /></label>}
        <label class="wide">Description<input class="input" value={f.description} onInput={set('description')} placeholder="What it is" /></label>
        <label class="check"><input type="checkbox" checked={f.force} onChange={set('force')} /> Force past the checks that can be skipped</label>
        <Act cap="name.create" action="create" kind="primary" disabled={!ready}
          args={() => ({ name: f.name.trim(), owner: f.owner.trim().replace(/^@/, ''), provider: f.provider, target: f.target.trim(), repo: f.repo.trim(), description: f.description.trim(), force: f.force })}
          onDone={(job) => { if (job.ok !== false) setF({ name: '', owner: '', provider: 'cname', target: '', repo: '', description: '', force: false }); }}>Create</Act>
      </form>
    </section>
  );
}

function SiteStatus({ name, status }) {
  const v = useCap('site.status');
  const [to, setTo] = useState('');
  if (v === 'deny') return null;
  return (
    <span class="assign">
      <select aria-label={`Status of ${name}`} value={to} onChange={(e) => setTo(e.currentTarget.value)}>
        <option value="">Status…</option>
        {['active', 'locked', 'suspended', 'archived'].filter((s) => s !== status).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {to && <Act cap="site.status" action="site" args={{ name, status: to }} confirm={`Set ${name} to ${to}?`} onDone={() => setTo('')}>Set</Act>}
    </span>
  );
}

// ── People ─────────────────────────────────────────────────────
const RANK_PILL = { owner: 'signal', lead: 'info', maintainer: 'ok', trainee: 'warn' };
export function People() {
  const r = useLoad(() => call('/v2/roster'));
  const { me } = useSession();
  const manage = useCap('roster.manage') === 'allow';
  const [add, setAdd] = useState('');
  const [open, setOpen] = useState('');
  const counts = useLoad(() => call('/v2/notes'));
  const noteCount = Object.fromEntries(((counts.data && counts.data.people) || []).map((x) => [x.subject, x.n]));
  const sets = Object.keys((me && me.rolesets) || {});
  return (
    <div class="view">
      <Head title="People" count={r.data ? r.data.people.length : undefined}>
        {manage && <form class="inline" onSubmit={(e) => e.preventDefault()}>
          <input class="input" placeholder="@github-user" value={add} onInput={(e) => setAdd(e.currentTarget.value)} aria-label="GitHub user to add" />
          {add.trim() && <Act cap="roster.manage" action="promote" args={{ user: add.trim() }} kind="primary" onDone={() => { setAdd(''); r.reload(); }}>Add as trainee</Act>}
        </form>}
      </Head>
      {r.error ? <Fail error={r.error} reload={r.reload} /> : !r.data ? <Skeleton rows={4} /> : (
        <div class="scroll-x"><table class="t">
          <thead><tr><th>Person</th><th>Rank</th><th>Rolesets</th><th>Accounts</th><th>Status</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>{r.data.people.flatMap((p) => [
            <tr key={p.github}>
              <td class="person-cell"><img src={`https://github.com/${p.github}.png?size=48`} alt="" width="24" height="24" /><User login={p.github} />{p.onDuty && <span class="dot live" title="On duty" />}</td>
              <td>{manage && p.rank !== 'owner'
                ? <RankPicker p={p} reload={r.reload} />
                : <Pill kind={RANK_PILL[p.rank]}>{p.rank}</Pill>}{p.probationUntil && <div class="sub dim">probation until {p.probationUntil}</div>}</td>
              <td>{p.rank === 'owner' || p.rank === 'lead' ? <span class="dim">every area</span> : <div class="chips">{sets.map((s) => {
                const has = (p.rolesets || []).includes(s);
                return manage
                  ? <Act key={s} cap="roster.manage" action="roleset" args={{ user: p.github, changes: [`${has ? '-' : '+'}${s}`] }} kind={has ? 'chip on' : 'chip'} onDone={r.reload} title={`${has ? 'Remove' : 'Add'} ${s}`}>{s}</Act>
                  : has ? <Pill key={s}>{s}</Pill> : null;
              })}</div>}</td>
              <td class="dim"><Mono>{p.accounts && p.accounts.everyday ? p.accounts.everyday : '—'}</Mono>{p.accounts && p.accounts.duty && <div class="sub"><Mono>{p.accounts.duty}</Mono></div>}</td>
              <td>{p.status === 'active' ? <Pill kind="ok">active</Pill> : <Pill kind="warn">{p.status}</Pill>}</td>
              <td class="w-actions"><div class="row-actions">
                <button class="btn quiet" type="button" aria-expanded={open === p.github} onClick={() => setOpen(open === p.github ? '' : p.github)}>Notes{noteCount[lc(p.github)] ? ` · ${noteCount[lc(p.github)]}` : ''}</button>
                {manage && p.rank !== 'owner' && <Act cap="roster.manage" action="demote" args={{ user: p.github }} kind="danger" confirm={`Remove @${p.github} from the roster? Their rooms access and duty grants end.`} onDone={r.reload}>Remove</Act>}
              </div></td>
            </tr>,
            open === p.github && <tr key={`${p.github}-notes`} class="drawer"><td colSpan={6}><Notes login={p.github} /></td></tr>,
          ])}</tbody>
        </table></div>
      )}
      <Lookup />
    </div>
  );
}

function RankPicker({ p, reload }) {
  const [to, setTo] = useState('');
  return (
    <span class="assign">
      <select aria-label={`Rank of @${p.github}`} value={to || p.rank} onChange={(e) => setTo(e.currentTarget.value === p.rank ? '' : e.currentTarget.value)}>
        {['trainee', 'maintainer', 'lead'].map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      {to && <Act cap="roster.manage" action="rank" args={{ user: p.github, rank: to }} kind="primary" onDone={() => { setTo(''); reload(); }}>Save</Act>}
    </span>
  );
}

// ── Duty ───────────────────────────────────────────────────────
export function Duty() {
  const d = useLoad(() => call('/v2/duty'));
  const r = useLoad(() => call('/v2/roster'));
  const { me } = useSession();
  const [hours, setHours] = useState(8);
  const [plan, setPlan] = useState([]);
  const [weeks, setWeeks] = useState(4);
  const canPlan = useCap('duty.schedule') === 'allow';
  const now = Date.now();
  const shifts = (d.data && d.data.shifts) || [];
  const people = ((r.data && r.data.people) || []).filter((p) => p.status === 'active');
  const iAmOn = shifts.some((s) => lc(s.login) === lc(me.login) && s.starts_at <= now && s.ends_at > now);
  // A two-week strip, one row per person on the rotation.
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const span = 14 * 86400e3;
  const who = [...new Set(shifts.map((s) => s.login))];
  return (
    <div class="view">
      <Head title="Duty">
        {iAmOn ? <Act cap="duty.take" action="duty-end" args={{}} onDone={d.reload}>End my shift</Act> : (
          <span class="inline">
            <label class="visually-hidden" for="hrs">Hours</label>
            <select id="hrs" value={hours} onChange={(e) => setHours(Number(e.currentTarget.value))}>{[2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} h</option>)}</select>
            <Act cap="duty.take" action="duty-take" args={{ hours }} kind="primary" onDone={d.reload}>Go on duty</Act>
          </span>
        )}
      </Head>
      <p class="dim lede">On duty you can elevate your duty account up to write by yourself, and new queue items come to you first. Off duty, a lead confirms elevations.</p>
      {d.error ? <Fail error={d.error} reload={d.reload} /> : !d.data ? <Skeleton rows={3} /> : !shifts.length
        ? <Empty title="No rotation yet">Until there is one, everyone counts as on duty. {canPlan ? 'Plan weekly turns below.' : 'A lead plans the rotation.'}</Empty>
        : (
          <div class="strip" role="img" aria-label="Duty shifts for the next two weeks">
            <div class="strip-days">{Array.from({ length: 14 }, (_, i) => { const dd = new Date(t0 + i * 86400e3); return <span key={i} class={dd.getDay() === 1 ? 'mon' : ''}>{dd.toLocaleDateString(undefined, { weekday: 'narrow' })}<b>{dd.getDate()}</b></span>; })}</div>
            {who.map((login) => (
              <div class="strip-row" key={login}>
                <span class="strip-who"><User login={login} /></span>
                <div class="strip-lane">
                  {shifts.filter((s) => s.login === login && s.ends_at > t0 && s.starts_at < t0 + span).map((s) => {
                    const a = Math.max(0, (s.starts_at - t0) / span) * 100;
                    const b = Math.min(1, (s.ends_at - t0) / span) * 100;
                    const live = s.starts_at <= now && s.ends_at > now;
                    return <span key={s.id} class={`shift ${live ? 'live' : ''}`} style={{ left: `${a}%`, width: `${Math.max(0.6, b - a)}%` }} title={`${login}: ${when(s.starts_at)} → ${when(s.ends_at)}`} />;
                  })}
                  <span class="now" style={{ left: `${((now - t0) / span) * 100}%` }} aria-hidden="true" />
                </div>
              </div>
            ))}
          </div>
        )}
      {canPlan && (
        <section class="panel">
          <Head title="Plan a rotation" />
          <p class="dim">Weekly turns from next Monday 00:00 UTC, in the order you pick. It replaces shifts that haven’t started; current shifts keep running.</p>
          <div class="chips">{people.map((p) => {
            const at = plan.indexOf(p.github);
            return <button key={p.github} type="button" class={`chip ${at >= 0 ? 'on' : ''}`} aria-pressed={at >= 0} onClick={() => setPlan(at >= 0 ? plan.filter((x) => x !== p.github) : [...plan, p.github])}>{at >= 0 && <b>{at + 1}</b>}@{p.github}</button>;
          })}</div>
          <div class="inline" style={{ marginTop: '12px' }}>
            <label for="wk" class="dim">Weeks</label>
            <input id="wk" class="input num" type="number" min="1" max="26" value={weeks} onInput={(e) => setWeeks(Number(e.currentTarget.value) || 4)} />
            <Act cap="duty.schedule" action="duty-plan" args={{ people: plan, weeks }} kind="primary" disabled={!plan.length} onDone={() => { setPlan([]); d.reload(); }}>{plan.length ? `Plan ${weeks} weeks` : 'Pick people first'}</Act>
          </div>
        </section>
      )}
      {shifts.length > 0 && (
        <section class="panel">
          <Head title="Upcoming" />
          <table class="t"><tbody>{shifts.filter((s) => s.ends_at > now).slice(0, 20).map((s) => (
            <tr key={s.id}><td><User login={s.login} /></td><td class="dim">{when(s.starts_at)} → {when(s.ends_at)}</td><td>{s.starts_at <= now ? <Pill kind="signal">on now</Pill> : <span class="dim">{ago(s.starts_at)}</span>}</td><td class="dim">{s.note}</td></tr>
          ))}</tbody></table>
        </section>
      )}
    </div>
  );
}

// ── Access: cosigns, grants, elevate ───────────────────────────
export function Access() {
  const c = useLoad(() => call('/v2/cosigns'));
  const g = useLoad(() => call('/api/grants'));
  const { zone } = useSession();
  const hosted = ((zone && zone.names) || []).filter((n) => n.status);
  const [name, setName] = useState('');
  const [perm, setPerm] = useState('write');
  const [hours, setHours] = useState(2);
  return (
    <div class="view">
      <section class="panel">
        <Head title="Waiting for a second maintainer" count={c.data ? c.data.cosigns.length : undefined}><button class="btn quiet" type="button" onClick={c.reload}>↻</button></Head>
        {c.error ? <Fail error={c.error} reload={c.reload} /> : !c.data ? <Skeleton rows={2} /> : c.data.cosigns.length === 0
          ? <Empty title="Nothing to confirm">When a trainee does something sensitive, or someone elevates off duty, it waits here for a second pair of eyes.</Empty>
          : <table class="t"><tbody>{c.data.cosigns.map((x) => (
            <tr key={x.id}>
              <td><Mono>{x.id}</Mono></td><td><Mono>{x.command}</Mono></td><td><User login={x.actor} /></td><td class="dim nowrap">expires {ago(x.expiresAt)}</td>
              <td class="w-actions">{x.canConfirm ? <Act cap="cosign" action="cosign" args={{ id: x.id }} kind="primary" onDone={c.reload}>Confirm</Act> : <span class="dim">{x.cap.startsWith('elevate.') ? 'needs a lead' : 'not yours to confirm'}</span>}</td>
            </tr>
          ))}</tbody></table>}
      </section>
      <section class="panel">
        <Head title="Elevate my duty account" />
        <form class="inline wrap" onSubmit={(e) => e.preventDefault()}>
          <select aria-label="Site" value={name} onChange={(e) => setName(e.currentTarget.value)}><option value="">Site…</option>{hosted.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}</select>
          <select aria-label="Permission" value={perm} onChange={(e) => setPerm(e.currentTarget.value)}>{['read', 'triage', 'write', 'security', 'maintain', 'admin'].map((p) => <option key={p}>{p}</option>)}</select>
          <select aria-label="Hours" value={hours} onChange={(e) => setHours(Number(e.currentTarget.value))}>{[1, 2, 4, 8, 12].map((h) => <option key={h} value={h}>{h} h</option>)}</select>
          <Act cap="elevate.basic" action="elevate" args={() => (name ? { name, permission: perm, hours } : (alert('Pick a site.'), null))} kind="primary" onDone={g.reload}>Elevate</Act>
        </form>
        <p class="dim">Caps: read 14 d, triage 7 d, write 12 h, security 8 h, maintain 4 h, admin 2 h. Maintain and admin wait for the owner.</p>
      </section>
      <section class="panel">
        <Head title="Active and pending access" count={g.data ? g.data.grants.length : undefined} />
        {g.error ? <Fail error={g.error} reload={g.reload} /> : !g.data ? <Skeleton rows={2} /> : g.data.grants.length === 0 ? <Empty title="Nobody holds extra access">Elevations and standing grants show up here until they end.</Empty> : (
          <table class="t">
            <thead><tr><th>Grant</th><th>Who</th><th>Repo</th><th>Permission</th><th>Ends</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>{g.data.grants.map((x) => (
              <tr key={x.id}>
                <td><Mono>{x.id}</Mono></td><td><Mono>{x.login}</Mono><div class="sub"><User login={x.personal} /></div></td><td><Mono>{x.repo}</Mono></td>
                <td><Pill kind={x.state === 'pending' ? 'warn' : ['maintain', 'admin'].includes(x.permission) ? 'bad' : ''}>{x.permission}{x.state === 'pending' ? ' · pending' : ''}</Pill></td>
                <td class="dim nowrap">{x.standing ? 'standing' : ago(x.expires_at)}</td>
                <td class="w-actions"><div class="row-actions">
                  {x.state === 'pending' && <Act cap="access.approve" action="access-approve" args={{ id: x.id }} kind="primary" onDone={g.reload}>Approve</Act>}
                  {x.state === 'pending' && <Act cap="access.approve" action="access-deny" args={{ id: x.id }} kind="quiet" onDone={g.reload}>Deny</Act>}
                  <Act action="access-revoke" args={{ id: x.id }} kind="danger" onDone={g.reload}>End now</Act>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ── Audit ──────────────────────────────────────────────────────
export function Audit({ params }) {
  const [kind, setKind] = useState(params.get('kind') || '');
  const [rows, setRows] = useState([]);
  const ev = useLoad(async () => { const d = await call(`/v2/events?limit=150${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`); setRows(d.events); return d; }, [kind]);
  const more = async () => { const last = rows[rows.length - 1]; if (!last) return; const d = await call(`/v2/events?limit=150&before=${last.at}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`); setRows([...rows, ...d.events]); };
  return (
    <div class="view">
      <Head title="Audit">
        <div class="seg" role="tablist" aria-label="Kind">
          {[['', 'Everything'], ['log', 'Bot log'], ['cosign', 'Cosigns'], ['roster', 'Roster']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>{l}</button>)}
        </div>
      </Head>
      {ev.error ? <Fail error={ev.error} reload={ev.reload} /> : !ev.data ? <Skeleton rows={10} /> : (
        <>
          <Events rows={rows} />
          {rows.length >= 150 && <p><button class="btn" type="button" onClick={more}>Older</button></p>}
        </>
      )}
    </div>
  );
}

// ── Settings ───────────────────────────────────────────────────
export function Settings() {
  const { zone } = useSession();
  const edit = useCap('config.edit');
  const settings = Object.entries((zone && zone.settings) || {});
  const [vals, setVals] = useState({});
  return (
    <div class="view">
      <Head title="Settings" />
      <p class="dim lede">Each change is a bot PR to <Mono>config.json</Mono>, so it’s in the history. {edit !== 'allow' && 'Only the owner can change these.'}</p>
      {!zone ? <Skeleton rows={8} /> : (
        <table class="t settings">
          <tbody>{settings.map(([k, s]) => {
            const cur = Array.isArray(s.value) ? s.value.join(', ') : s.value === undefined ? '' : String(s.value);
            const v = vals[k] ?? cur;
            return (
              <tr key={k}>
                <td><Mono>{k}</Mono><div class="sub dim">{s.help}</div></td>
                <td class="w-input">{s.type === 'bool'
                  ? <select disabled={edit !== 'allow'} value={v} onChange={(e) => setVals({ ...vals, [k]: e.currentTarget.value })} aria-label={k}><option value="true">on</option><option value="false">off</option></select>
                  : <input class="input" disabled={edit !== 'allow'} value={v} onInput={(e) => setVals({ ...vals, [k]: e.currentTarget.value })} aria-label={k} />}</td>
                <td class="w-actions">{vals[k] !== undefined && vals[k] !== cur && <Act cap="config.edit" action="config" args={{ key: k, value: vals[k] }} kind="primary" onDone={() => { const n = { ...vals }; delete n[k]; setVals(n); }}>Save</Act>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      <section class="panel">
        <Head title="Run" />
        <div class="row-actions">
          <Act cap="ops.run" action="ops">Daily checks now</Act>
          <Act cap="ops.run" action="health">Dangling-name check</Act>
          <Act cap="dns.deploy" action="deploy">Redeploy DNS + website</Act>
          <Act cap="org.setup" action="org-setup">Re-apply org setup</Act>
          <Act cap="ops.botcheck" action="bot-check">Check the bot’s tokens</Act>
          <Act cap="announce" action="announce" args={() => { const t = window.prompt('Banner text for the website, My domains and the console (empty to clear):', zone && zone.announcement || ''); return t === null ? null : { text: t }; }}>Banner…</Act>
          <Act cap="registry.lock" action={zone && zone.locked ? 'unlock' : 'lock'} args={() => (zone && zone.locked ? {} : (() => { const r = window.prompt('Why pause new requests? (shown to requesters)'); return r === null ? null : { reason: r }; })())} kind="danger">{zone && zone.locked ? 'Resume requests' : 'Pause requests'}</Act>
        </div>
      </section>
    </div>
  );
}
