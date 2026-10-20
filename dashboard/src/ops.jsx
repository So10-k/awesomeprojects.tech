// Abuse, Sites and Infra: the console's operational views.
import { useState } from 'preact/hooks';
import { call, ago, when, SITE } from './api.js';
import { Act, Empty, Fail, Head, Mono, NameLink, Pill, Progress, QueueLink, Skeleton, User, useCap, useLoad, useSession } from './ui.jsx';

const lc = (s) => String(s || '').toLowerCase();
const ask = (q, fallback = '') => { const r = window.prompt(q, fallback); return r === null ? null : r; };

// ── Abuse ──────────────────────────────────────────────────────
export function Abuse() {
  const { zone } = useSession();
  const q = useLoad(() => call('/v2/queue'));
  const inf = useLoad(() => call('/v2/infra'));
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [lim, setLim] = useState({ user: '', n: 0 });
  const reports = ((q.data && q.data.items) || []).filter((i) => i.kind === 'report' && i.state !== 'decided');
  const late = reports.filter((i) => i.overdue);
  const banned = (zone && zone.bannedUsers) || [];
  const limits = Object.entries((zone && zone.limits) || {});
  const watch = inf.data && inf.data.bot && inf.data.bot.abuse;
  const known = (zone && zone.names || []).some((n) => n.name === lc(name.trim()).replace(/\.awesomeprojects\.tech$/, ''));
  return (
    <div class="view">
      <div class="tiles">
        <a class={`tile ${reports.length ? 'signal' : ''}`} href="#/abuse"><span>Open reports</span><b>{q.data ? reports.length : '…'}</b></a>
        <a class={`tile ${late.length ? 'warn' : ''}`} href="#/queue?f=overdue"><span>Overdue reports</span><b>{q.data ? late.length : '…'}</b></a>
        <div class="tile"><span>Banned accounts</span><b>{zone ? banned.length : '…'}</b></div>
        <div class="tile"><span>Certificate watch</span><b class="small">{!inf.data ? '…' : watch && watch.lastScan ? ago(watch.lastScan) : 'not run yet'}</b></div>
      </div>

      <section class="panel">
        <Head title="Reports" count={reports.length}><button class="btn quiet" type="button" onClick={q.reload}>↻</button></Head>
        {q.error ? <Fail error={q.error} reload={q.reload} /> : !q.data ? <Skeleton rows={3} /> : reports.length === 0
          ? <Empty title="No open reports">Takedown reports and the certificate watch's flags land here, assigned to someone with the abuse roleset.</Empty>
          : (
            <table class="t">
              <thead><tr><th>Report</th><th>Assignee</th><th>Due</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody>{reports.map((i) => (
                <tr key={i.id} class={i.overdue ? 'is-late' : ''}>
                  <td><QueueLink q={i} /> <Progress p={i.progress} /></td>
                  <td><User login={i.assignee} /></td>
                  <td class={`nowrap ${i.overdue ? 'bad-text' : 'dim'}`}>{i.overdue ? `▲ ${ago(i.due_at)}` : ago(i.due_at)}</td>
                  <td class="w-actions">{i.copy && <Act cap="queue.work" action="queue" args={{ verb: 'claim', copy: i.copy }} onDone={q.reload}>Claim</Act>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        <p class="dim">The certificate watch checks new certificates for our names every 6 hours{watch && watch.webRisk ? ' and asks Google Web Risk about each target' : ''}. A phishing-style hostname, or a certificate for a name we don’t have, opens a report.</p>
      </section>

      <div class="cols">
        <section class="panel">
          <Head title="Take a name down" />
          <form class="inline wrap" onSubmit={(e) => e.preventDefault()}>
            <input class="input" placeholder="name" value={name} onInput={(e) => setName(e.currentTarget.value)} aria-label="Name to take down" />
            <Act cap="abuse.takedown" action="takedown" kind="danger" disabled={!known}
              args={() => { const r = ask(`Take down ${name.trim()} and everything under it? The reason is public:`); return r === null ? null : { name: name.trim(), reason: r }; }}
              onDone={() => setName('')}>Take down</Act>
          </form>
          <p class="dim">{name.trim() && !known ? 'That name isn’t in the zone.' : 'Removes the name and everything under it at once, in a public commit.'}</p>
        </section>
        <section class="panel">
          <Head title="Ban someone" />
          <form class="inline wrap" onSubmit={(e) => e.preventDefault()}>
            <input class="input" placeholder="@github-user" value={user} onInput={(e) => setUser(e.currentTarget.value)} aria-label="GitHub user to ban" />
            <Act cap="user.ban" action="ban" kind="danger" disabled={!user.trim()}
              args={() => { const r = ask(`Ban @${user.trim().replace(/^@/, '')} from requesting names? Reason (public):`); return r === null ? null : { user: user.trim().replace(/^@/, ''), reason: r }; }}
              onDone={() => setUser('')}>Ban</Act>
          </form>
          {banned.length > 0 && (
            <table class="t"><tbody>{banned.map((b) => (
              <tr key={b}><td><User login={b} /></td><td class="w-actions"><Act cap="user.ban" action="unban" args={{ user: b }} kind="quiet" confirm={`Unban @${b}?`}>Unban</Act></td></tr>
            ))}</tbody></table>
          )}
        </section>
      </div>

      <section class="panel">
        <Head title="Name limits" count={limits.length} />
        <p class="dim">Everyone gets {zone ? zone.maxPerOwner : 3} names. Raise it for someone who needs more, or set 0 to stop new requests without a ban.</p>
        <form class="inline wrap" onSubmit={(e) => e.preventDefault()}>
          <input class="input" placeholder="@github-user" value={lim.user} onInput={(e) => setLim({ ...lim, user: e.currentTarget.value })} aria-label="GitHub user" />
          <input class="input num" type="number" min="0" max="100" value={lim.n} onInput={(e) => setLim({ ...lim, n: Number(e.currentTarget.value) })} aria-label="Limit" />
          <Act cap="user.limit" action="limit" disabled={!lim.user.trim()} args={() => ({ user: lim.user.trim().replace(/^@/, ''), n: lim.n })} onDone={() => setLim({ user: '', n: 0 })}>Set limit</Act>
        </form>
        {limits.length > 0 && <table class="t"><tbody>{limits.map(([u, n]) => <tr key={u}><td><User login={u} /></td><td><Mono>{n}</Mono></td></tr>)}</tbody></table>}
      </section>
    </div>
  );
}

// ── Sites ──────────────────────────────────────────────────────
const DEPLOY = { success: ['ok', 'deployed'], failure: ['bad', 'failing'], in_progress: ['info', 'building'], queued: ['info', 'queued'] };
export function Sites() {
  const s = useLoad(() => call('/api/sites'));
  const sites = ((s.data && s.data.sites) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const failing = sites.filter((x) => x.deploy && x.deploy.conclusion === 'failure');
  return (
    <div class="view">
      <Head title="Hosted sites" count={sites.length}>
        {s.data && s.data.at && <span class="dim">checked {ago(s.data.at)}</span>}
        <Act cap="ops.run" action="ops" kind="quiet" onDone={s.reload}>Check now</Act>
      </Head>
      {s.data && s.data.seats && s.data.seats.max ? <p class="dim lede">Seats: {s.data.seats.used} of {s.data.seats.max}. {failing.length ? <span class="bad-text">{failing.length} failing.</span> : 'Nothing failing.'}</p> : null}
      {s.error ? <Fail error={s.error} reload={s.reload} /> : !s.data ? <Skeleton rows={5} /> : sites.length === 0 ? <Empty title="No hosted sites">Sites we host show up here after the daily checks.</Empty> : (
        <div class="scroll-x"><table class="t">
          <thead><tr><th>Site</th><th>Owner</th><th>Status</th><th>Last deploy</th><th>Size</th><th>Last push</th><th class="w-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>{sites.map((x) => {
            const d = x.deploy && (DEPLOY[x.deploy.conclusion] || ['', x.deploy.conclusion]);
            return (
              <tr key={x.name} class={x.deploy && x.deploy.conclusion === 'failure' ? 'is-late' : ''}>
                <td><NameLink name={x.name} /><div class="sub dim"><Mono>{x.repo}</Mono></div>{x.error && <div class="sub bad-text">{x.error}</div>}</td>
                <td><User login={x.owner} />{(x.collaborators || []).length > 1 && <div class="sub dim">+{x.collaborators.length - 1} collaborator{x.collaborators.length === 2 ? '' : 's'}</div>}</td>
                <td><Pill kind={x.status === 'active' ? 'ok' : x.status === 'locked' ? 'warn' : 'bad'}>{x.status}</Pill>{x.https === false && <div class="sub warn-text nowrap">no HTTPS yet</div>}</td>
                <td>{d ? <a href={x.deploy.url} target="_blank" rel="noopener"><Pill kind={d[0]}>{d[1]}</Pill></a> : <span class="dim">—</span>}{x.deploy && <div class="sub dim">{ago(Date.parse(x.deploy.at))}</div>}</td>
                <td class="dim nowrap">{x.sizeMB !== undefined ? `${x.sizeMB} MB` : '—'}</td>
                <td class="dim nowrap">{x.pushedAt ? ago(Date.parse(x.pushedAt)) : '—'}</td>
                <td class="w-actions"><div class="row-actions">
                  <Act cap="site.sync" action="redeploy" args={{ name: x.name }} kind="quiet">Redeploy</Act>
                  <Act cap="site.sync" action="site-sync" args={{ name: x.name }} kind="quiet" confirm={`Put ${x.name} back to standard (workflow, settings, access)?`}>Re-sync</Act>
                </div></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}

// ── Infra ──────────────────────────────────────────────────────
const ENDPOINTS = [['website', 'Website'], ['api', 'Panel API'], ['rdap', 'RDAP'], ['whois', 'WHOIS'], ['console', 'Console'], ['server', 'GitHub server']];
const RUNS = [['dns', 'DNS deploy'], ['website', 'Website'], ['panel', 'Panel'], ['console', 'Console'], ['bot', 'Bot']];
const runPill = (c) => (c === 'success' ? ['ok', 'passed'] : c === 'failure' ? ['bad', 'failed'] : c === 'cancelled' ? ['warn', 'cancelled'] : ['info', c || '—']);

export function Infra() {
  const r = useLoad(() => call('/v2/infra'));
  const d = r.data || {};
  const b = d.bot || {};
  const stale = b.at && Date.now() - b.at > 3 * 3600e3;
  return (
    <div class="view">
      <Head title="Infra">
        <span class={stale ? 'warn-text' : 'dim'}>{b.at ? `snapshot ${ago(b.at)}${stale ? ': the hourly sweep may be stuck' : ''}` : 'no snapshot yet'}</span>
        <button class="btn quiet" type="button" onClick={r.reload}>↻</button>
      </Head>
      {r.error ? <Fail error={r.error} reload={r.reload} /> : !r.data ? <Skeleton rows={8} /> : (
        <>
          <div class="health" role="list" aria-label="Endpoints">
            {ENDPOINTS.filter(([k]) => b.endpoints && b.endpoints[k]).map(([k, label]) => {
              const e = b.endpoints[k];
              return <div class={`health-cell ${e.ok ? 'up' : 'down'}`} role="listitem" key={k}><span class={`dot ${e.ok ? 'ok' : 'bad'}`} /><b>{label}</b><span class="dim">{e.ok ? `${e.ms} ms` : 'down'}</span></div>;
            })}
            {!b.endpoints && <Empty title="No checks yet">The bot checks every endpoint once an hour.</Empty>}
          </div>
          <div class="cols">
            <section class="panel">
              <Head title="GitHub server" />
              {!b.ghes ? <p class="dim">Not live.</p> : (
                <dl class="kv">
                  <dt>Host</dt><dd><a href={`https://${b.ghes.host}`} target="_blank" rel="noopener"><Mono>{b.ghes.host}</Mono></a></dd>
                  <dt>Version</dt><dd><Mono>{b.ghes.version || '—'}</Mono></dd>
                  <dt>License</dt><dd>{b.ghes.license
                    ? <>{b.ghes.license.used} of {b.ghes.license.seats} seats · <span class={b.ghes.license.daysLeft < 30 ? 'warn-text' : ''}>expires in {b.ghes.license.daysLeft} d</span></>
                    : <span class="dim">the bot can’t read it (it isn’t a site admin)</span>}</dd>
                </dl>
              )}
            </section>
            <section class="panel">
              <Head title="Code" />
              <dl class="kv">
                <dt>Platform</dt><dd>{b.platform ? <><Mono>{b.platform.sha}</Mono> <span class="dim">{ago(b.platform.at)}</span><div class="sub dim">{b.platform.message}</div></> : '—'}</dd>
                <dt>Panel build</dt><dd><Mono>{(d.panel && d.panel.version) || '—'}</Mono></dd>
              </dl>
            </section>
          </div>
          <section class="panel">
            <Head title="Last runs on main" />
            <table class="t"><tbody>{RUNS.map(([k, label]) => {
              const w = b.workflows && b.workflows[k];
              const p = runPill(w && w.conclusion);
              return <tr key={k}><td>{label}</td><td>{w ? <a href={w.url} target="_blank" rel="noopener"><Pill kind={p[0]}>{p[1]}</Pill></a> : <span class="dim">—</span>}</td><td class="dim nowrap">{w ? ago(w.at) : ''}</td><td class="dim">{w ? w.title : ''}</td></tr>;
            })}</tbody></table>
          </section>
          <div class="cols">
            <section class="panel">
              <Head title="Registry" />
              <dl class="kv">
                <dt>Names on a term</dt><dd>{d.lifecycle ? `${d.lifecycle.active || 0} active · ${d.lifecycle.hold || 0} on hold · ${d.lifecycle.released || 0} released` : '—'}</dd>
                <dt>Queue</dt><dd>{d.queue ? <>{d.queue.open} open{d.queue.overdue ? <span class="bad-text"> · {d.queue.overdue} overdue</span> : ''}</> : '—'}</dd>
                <dt>Hosted sites</dt><dd>{d.sites ? <>{d.sites.count}{d.sites.failing ? <span class="bad-text"> · {d.sites.failing} failing</span> : ''} <span class="dim">checked {ago(d.sites.at)}</span></> : '—'}</dd>
              </dl>
            </section>
            <section class="panel">
              <Head title="Email and the watch" />
              <dl class="kv">
                <dt>Email</dt><dd>{b.email ? 'sending' : <span class="warn-text">not set up (SMTP_USER / SMTP_PASS): messages wait</span>}</dd>
                <dt>Outbox</dt><dd>{d.outbox ? `${d.outbox.waiting} waiting${d.outbox.failed ? ` (${d.outbox.failed} with errors)` : ''} · ${d.outbox.contacts} people turned email on` : '—'}</dd>
                <dt>Certificate watch</dt><dd>{b.abuse && b.abuse.lastScan ? `last scan ${ago(b.abuse.lastScan)}` : 'not run yet'} · Web Risk {b.abuse && b.abuse.webRisk ? 'on' : 'off'}</dd>
              </dl>
            </section>
          </div>
          <p class="dim">Backups of the GitHub server run on the host itself, so they aren’t shown here. <a href={`${SITE}/status/`} target="_blank" rel="noopener">Public status page →</a></p>
        </>
      )}
    </div>
  );
}

// ── Notes about a person (used by People) ──────────────────────
export function Notes({ login }) {
  const n = useLoad(() => call(`/v2/notes?login=${encodeURIComponent(login)}`), [login]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { await call('/api/notes', { method: 'POST', body: { login, body: text } }); setText(''); n.reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div class="notes">
      {n.error ? <Fail error={n.error} reload={n.reload} /> : !n.data ? <Skeleton rows={2} /> : n.data.notes.length === 0
        ? <p class="dim">No notes about @{login} yet.</p>
        : <ul class="list">{n.data.notes.map((x) => <li key={x.id}><span class="dim nowrap">{when(x.at)} · @{x.author}</span> {x.body}</li>)}</ul>}
      <form class="inline wrap" onSubmit={(e) => { e.preventDefault(); if (text.trim()) save(); }}>
        <input class="input grow" placeholder={`Private note about @${login} (only maintainers see it)`} value={text} onInput={(e) => setText(e.currentTarget.value)} maxLength={2000} aria-label={`Note about @${login}`} />
        <button class="btn" type="submit" disabled={busy || !text.trim()}>Add note</button>
      </form>
      {err && <p class="bad-text" role="alert">{err}</p>}
    </div>
  );
}

/** A small "look someone up" box for People: notes, ban and limit for anyone, not just maintainers. */
export function Lookup() {
  const [who, setWho] = useState('');
  const [open, setOpen] = useState('');
  const canNote = useCap('ops.run') !== 'deny';
  if (!canNote) return null;
  return (
    <section class="panel">
      <Head title="Anyone else" />
      <form class="inline wrap" onSubmit={(e) => { e.preventDefault(); setOpen(who.trim().replace(/^@/, '')); }}>
        <input class="input" placeholder="@github-user" value={who} onInput={(e) => setWho(e.currentTarget.value)} aria-label="GitHub user to look up" />
        <button class="btn" type="submit" disabled={!who.trim()}>Look up</button>
      </form>
      {open && (
        <div class="lookup">
          <p><img src={`https://github.com/${open}.png?size=48`} alt="" width="24" height="24" /> <User login={open} /> · <a href={`#/u/${encodeURIComponent(open)}`}>open their page →</a></p>
          <Notes login={open} />
        </div>
      )}
    </section>
  );
}
