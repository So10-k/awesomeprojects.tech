// One page per thing: a name, a person, a public issue (request, report, application, PR). Everything you can
// see and do about it in one place. Opened from anywhere in the console: #/n/<name>, #/u/<login>, #/i/<number>.
import { useMemo, useState } from 'preact/hooks';
import { call, ago, when, md, SITE } from './api.js';
import { Act, Empty, Fail, Head, IssueLink, Mono, NameLink, Pill, Progress, QueueLink, Skeleton, User, useCap, useLoad, useSession, useToast } from './ui.jsx';
import { Notes } from './ops.jsx';

const lc = (s) => String(s || '').toLowerCase();
const ask = (q, d = '') => { const r = window.prompt(q, d); return r === null ? null : r; };
const ghes = (zone) => (zone && zone.emuHost) || 'github.samsprojects.xyz';
const REPO = 'So10-k/awesomeprojects.tech';
const day = (ms) => (ms ? new Date(Number(ms)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

/** The page frame: a header with facts and actions, then sections in a two-column grid. */
function Page({ title, kicker, facts, actions, children, back }) {
  return (
    <div class="view profile">
      <a class="back dim" href={back || '#/overview'}>← back</a>
      <header class="p-head">
        <div class="p-title">
          {kicker && <span class="p-kicker">{kicker}</span>}
          <h1>{title}</h1>
          {facts && <div class="p-facts">{facts}</div>}
        </div>
        {actions && <div class="p-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
const Section = ({ title, count, children, actions, wide }) => (
  <section class={`panel ${wide ? 'wide' : ''}`}><Head title={title} count={count}>{actions}</Head>{children}</section>
);
const KV = ({ rows }) => <dl class="kv">{rows.filter(Boolean).map(([k, v]) => [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`}>{v}</dd>])}</dl>;
function Events({ rows }) {
  if (!rows || !rows.length) return <p class="dim">Nothing logged yet.</p>;
  return <table class="t"><tbody>{rows.slice(0, 60).map((e) => <tr key={e.id}><td class="w-time dim nowrap">{ago(e.at)}</td><td class="w-kind"><Mono>{e.kind}</Mono></td><td>{String(e.summary).replace(/\*\*/g, '').slice(0, 240)}</td></tr>)}</tbody></table>;
}

// ── A name ─────────────────────────────────────────────────────
export function NameProfile({ id }) {
  const { zone } = useSession();
  const r = useLoad(() => call(`/v2/name/${encodeURIComponent(id)}`), [id]);
  const toast = useToast();
  const d = r.data;
  if (r.error) return <div class="view"><a class="back dim" href="#/names">← names</a><Fail error={r.error} reload={r.reload} /></div>;
  if (!d) return <div class="view"><Skeleton rows={10} /></div>;
  const e = d.entry || {};
  const site = d.site;
  const hosted = e.site && e.site.provider === 'hosted';
  const top = !d.name.includes('.');
  const life = d.lifecycle;
  const hold = e.hold || (life && life.state === 'hold');
  const renew = async () => {
    try { const x = await call('/api/renew', { method: 'POST', body: { name: d.name.split('.').pop() } }); toast({ kind: 'ok', title: `Renewed ${d.name}`, body: `Good until ${day(x.expiresAt)}.` }); r.reload(); }
    catch (err) { toast({ kind: 'err', title: 'Couldn’t renew', body: err.message }); }
  };
  const owner = e.owner && e.owner.github;
  return (
    <Page back="#/names" kicker={hosted ? 'Hosted name' : top ? 'Name' : 'Record under a name'} title={d.fqdn}
      facts={<>
        <User login={owner} />
        <Pill>{(d.zone && d.zone.host) || Object.keys(e.records || {})[0] || '—'}</Pill>
        {site && <Pill kind={site.status === 'active' ? 'ok' : site.status === 'locked' ? 'warn' : 'bad'}>{site.status}</Pill>}
        {hold ? <Pill kind="bad">on hold</Pill> : life && <span class="dim">renews {day(life.expires_at)}</span>}
        {e.forced && <Pill kind="warn">forced by @{e.forced}</Pill>}
      </>}
      actions={<>
        <a class="btn" href={`https://${d.fqdn}`} target="_blank" rel="noopener">Open ↗</a>
        <Act action="verify" args={{ name: d.name }} kind="quiet">Check DNS + HTTPS</Act>
        {top && life && <button class="btn quiet" type="button" onClick={renew}>Renew</button>}
        {hosted && <Act cap="site.sync" action="redeploy" args={{ name: d.name }} kind="quiet">Redeploy</Act>}
        <Act cap="abuse.takedown" action="takedown" kind="danger" args={() => { const x = ask(`Take down ${d.fqdn}${d.children.length ? ` and ${d.children.length} under it` : ''}? Reason (public):`); return x === null ? null : { name: d.name, reason: x }; }} onDone={r.reload}>Take down</Act>
      </>}>
      <div class="p-grid">
        <Section title="Records">
          <Records name={d.name} records={e.records || {}} hosted={hosted && top} onDone={r.reload} />
        </Section>
        <Section title="Live DNS" actions={<button class="btn quiet" type="button" onClick={r.reload}>↻</button>}>
          <LiveDns dns={d.dns} records={e.records || {}} />
        </Section>
        {top && (
          <Section title="Term">
            {life ? <KV rows={[
              ['Registered', day(life.term_start)], ['Renews by', <span class={life.expires_at - Date.now() < 30 * 864e5 ? 'warn-text' : ''}>{day(life.expires_at)} ({ago(life.expires_at)})</span>],
              ['State', <Pill kind={life.state === 'active' ? 'ok' : 'bad'}>{life.state}</Pill>], ['Last renewed', life.renewed_at ? `${ago(life.renewed_at)}` : '—'],
              ['Reminders sent', life.notified || 'none'],
            ]} /> : <p class="dim">Not on a term yet (the daily checks add it).</p>}
          </Section>
        )}
        <Section title="Owner and details">
          <KV rows={[
            ['Owner', <User login={owner} />],
            ['Description', e.description || <span class="dim">—</span>],
            e.site && ['Host', e.site.provider],
            e.site && e.site.repo && ['Repository', <a href={hosted ? `https://${ghes(zone)}/${e.site.repo}` : `https://github.com/${e.site.repo}`} target="_blank" rel="noopener"><Mono>{e.site.repo}</Mono></a>],
            ['File', <a href={`https://github.com/${REPO}/blob/main/domains/${d.name}.json`} target="_blank" rel="noopener"><Mono>domains/{d.name}.json</Mono></a>],
            ['RDAP', <a href={`https://rdap.awesomeprojects.tech/domain/${d.fqdn}`} target="_blank" rel="noopener">JSON ↗</a>],
            ['Public page', <a href={`${SITE}/n/${d.name}/`} target="_blank" rel="noopener">{SITE.replace('https://', '')}/n/{d.name}</a>],
          ]} />
        </Section>
        {site && <SiteSection name={d.name} site={site} grants={d.grants} zone={zone} onDone={r.reload} />}
        {d.children.length > 0 && (
          <Section title="Under this name" count={d.children.length}>
            <table class="t"><tbody>{d.children.map((c) => <tr key={c.name}><td><NameLink name={c.name} /></td><td class="dim"><Mono>{c.type} {c.target}</Mono></td></tr>)}</tbody></table>
          </Section>
        )}
        <Section title="Requests, reports and PRs" count={d.issues.length}>
          {d.issues.length ? <table class="t"><tbody>{d.issues.map((i) => <tr key={i.number}><td class="dim"><Mono>#{i.number}</Mono></td><td><IssueLink number={i.number}>{i.title}</IssueLink></td><td><Pill kind={i.state === 'open' ? 'info' : ''}>{i.state}</Pill></td><td class="dim nowrap">{ago(i.at)}</td></tr>)}</tbody></table> : <p class="dim">None.</p>}
        </Section>
        <Section title="History" count={d.history.length}>
          {d.history.length ? <table class="t"><tbody>{d.history.map((c) => <tr key={c.sha}><td class="dim nowrap">{ago(c.at)}</td><td><a href={c.url} target="_blank" rel="noopener">{c.message}</a></td><td class="dim"><Mono>{c.sha}</Mono></td></tr>)}</tbody></table> : <p class="dim">No commits found.</p>}
        </Section>
        <Section title="Activity" wide><Events rows={d.events} /></Section>
        <Section title="Raw" wide><pre class="raw">{JSON.stringify(e, null, 2)}</pre></Section>
      </div>
    </Page>
  );
}

const TYPES = ['CNAME', 'A', 'AAAA', 'TXT', 'MX'];
/** Edit a name's records (maintainers can, for anyone; the bot checks and makes the PR). */
function Records({ name, records, hosted, onDone }) {
  const can = useCap('request.approve') !== 'deny';
  const flat = useMemo(() => Object.entries(records).flatMap(([t, v]) => (Array.isArray(v) ? v : [v]).map((x) => ({ type: t, value: typeof x === 'object' ? (t === 'MX' ? `${x.priority ?? 10} ${x.host}` : JSON.stringify(x)) : String(x) }))), [records]);
  const [rows, setRows] = useState(null);
  const edit = rows || flat;
  const locked = ['NS', 'DS'].some((t) => records[t]);
  const toRecords = () => {
    const out = {};
    for (const r of edit) {
      const v = r.value.trim();
      if (!v) continue;
      if (r.type === 'CNAME') out.CNAME = v;
      else if (r.type === 'MX') { const [p, h] = v.split(/\s+/); (out.MX ||= []).push({ priority: Number(p) || 10, host: h || p }); }
      else (out[r.type] ||= []).push(v);
    }
    if (out.TXT && out.TXT.length === 1) out.TXT = out.TXT[0];
    return out;
  };
  return (
    <>
      <table class="t records-edit"><tbody>
        {edit.map((r, i) => (
          <tr key={i}>
            <td class="w-type">{rows ? <select value={r.type} onChange={(ev) => setRows(edit.map((x, j) => (j === i ? { ...x, type: ev.currentTarget.value } : x)))}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select> : <Mono>{r.type}</Mono>}</td>
            <td>{rows ? <input class="input grow" value={r.value} onInput={(ev) => setRows(edit.map((x, j) => (j === i ? { ...x, value: ev.currentTarget.value } : x)))} /> : <Mono>{r.value}</Mono>}</td>
            {rows && <td class="w-actions"><button class="btn quiet" type="button" aria-label="Remove" onClick={() => setRows(edit.filter((_, j) => j !== i))}>×</button></td>}
          </tr>
        ))}
        {!edit.length && <tr><td class="dim">No records.</td></tr>}
      </tbody></table>
      {can && !hosted && !locked && (rows ? (
        <div class="row-actions">
          <button class="btn quiet" type="button" onClick={() => setRows([...edit, { type: 'A', value: '' }])}>+ Record</button>
          <Act action="records" args={() => ({ name, records: toRecords() })} kind="primary" onDone={(j) => { if (j.ok !== false) { setRows(null); onDone(); } }}>Save (a bot PR)</Act>
          <button class="btn quiet" type="button" onClick={() => setRows(null)}>Cancel</button>
        </div>
      ) : <div class="row-actions"><button class="btn quiet" type="button" onClick={() => setRows(flat)}>Edit records</button></div>)}
      {hosted && <p class="dim">Hosted by us: this record is managed. Records under it can be changed.</p>}
      {locked && <p class="dim">Delegated (NS/DS): change it with a pull request.</p>}
    </>
  );
}

function LiveDns({ dns, records }) {
  if (!dns) return <p class="dim">—</p>;
  const want = (t) => [].concat(records[t] || []).map((x) => (typeof x === 'object' ? (x.host || '').replace(/\.$/, '') : String(x).replace(/\.$/, '').toLowerCase()));
  const rows = Object.entries(dns).filter(([, v]) => v && v.length);
  if (!rows.length) return <p class="warn-text">Nothing answers for this name right now{Object.keys(records).length ? ' (it may be on hold, or DNS hasn’t caught up)' : ''}.</p>;
  return (
    <table class="t"><tbody>{rows.map(([t, v]) => {
      const exp = want(t);
      const match = !exp.length || v.every((x) => exp.some((w) => lc(x).replace(/\.$/, '').replace(/^"|"$/g, '').includes(lc(w))));
      return <tr key={t}><td class="w-type"><Mono>{t}</Mono></td><td>{v.map((x) => <div key={x}><Mono>{x}</Mono></div>)}</td><td>{exp.length ? (match ? <Pill kind="ok">matches</Pill> : <Pill kind="warn">differs</Pill>) : <span class="dim">not ours</span>}</td></tr>;
    })}</tbody></table>
  );
}

function SiteSection({ name, site, grants, zone, onDone }) {
  const [who, setWho] = useState('');
  const [to, setTo] = useState('');
  const canStatus = useCap('site.status') !== 'deny';
  return (
    <Section title="Hosted site" actions={<a class="btn quiet" href={`https://${ghes(zone)}/${site.repo}`} target="_blank" rel="noopener">Repo ↗</a>}>
      <KV rows={[
        ['Repository', <Mono>{site.repo}</Mono>], ['Builds on', site.platform === 'cloudflare' ? 'Cloudflare Pages (built on ghe.com)' : 'GitHub Pages'],
        ['Last deploy', site.deploy ? <><a href={site.deploy.url} target="_blank" rel="noopener"><Pill kind={site.deploy.conclusion === 'success' ? 'ok' : site.deploy.conclusion === 'failure' ? 'bad' : 'info'}>{site.deploy.conclusion}</Pill></a> <span class="dim">{ago(Date.parse(site.deploy.at))}</span></> : '—'],
        ['HTTPS', site.https ? 'on' : <span class="warn-text">not yet</span>], ['Size', site.sizeMB !== undefined ? `${site.sizeMB} MB` : '—'], ['Last push', site.pushedAt ? ago(Date.parse(site.pushedAt)) : '—'],
        ['People', <div>{(site.collaborators || []).map((c) => <span key={c} class="chip-row"><Mono>{c}</Mono> <Act cap="site.sync" action="site-collab" args={{ name, user: c, op: 'remove' }} kind="quiet" confirm={`Remove ${c} from ${name}?`} onDone={onDone}>×</Act></span>)}{(site.pendingInvites || []).map((c) => <span key={c} class="dim"> {c} (invited)</span>)}</div>],
      ]} />
      <div class="row-actions">
        <input class="input" placeholder="@github-user" value={who} onInput={(e) => setWho(e.currentTarget.value)} aria-label="Add a collaborator" />
        <Act cap="site.sync" action="site-collab" disabled={!who.trim()} args={() => ({ name, user: who.trim().replace(/^@/, ''), op: 'add' })} onDone={() => { setWho(''); onDone(); }}>Add collaborator</Act>
        <Act cap="site.sync" action="site-sync" args={{ name }} kind="quiet" confirm={`Put ${name} back to standard?`}>Re-sync</Act>
        {canStatus && <span class="assign"><select aria-label="Status" value={to} onChange={(e) => setTo(e.currentTarget.value)}><option value="">Status…</option>{['active', 'locked', 'suspended', 'archived'].filter((s) => s !== site.status).map((s) => <option key={s}>{s}</option>)}</select>{to && <Act cap="site.status" action="site" args={{ name, status: to }} confirm={`Set ${name} to ${to}?`} onDone={() => { setTo(''); onDone(); }}>Set</Act>}</span>}
      </div>
      {grants && grants.length > 0 && (
        <table class="t"><thead><tr><th>Access</th><th>Who</th><th>Ends</th><th /></tr></thead><tbody>{grants.slice(0, 12).map((g) => (
          <tr key={g.id}><td><Pill kind={['maintain', 'admin'].includes(g.permission) ? 'bad' : ''}>{g.permission}</Pill> <span class="dim">{g.state}</span></td><td><Mono>{g.login}</Mono></td><td class="dim nowrap">{g.standing ? 'standing' : ago(g.expires_at)}</td>
            <td class="w-actions">{g.state === 'active' && <Act action="access-revoke" args={{ id: g.id }} kind="quiet" onDone={onDone}>End</Act>}</td></tr>
        ))}</tbody></table>
      )}
    </Section>
  );
}

// ── A person ───────────────────────────────────────────────────
export function PersonProfile({ id }) {
  const r = useLoad(() => call(`/v2/person/${encodeURIComponent(id)}`), [id]);
  const acl = useLoad(() => call('/v2/acl'));
  const { me } = useSession();
  const [lim, setLim] = useState('');
  const d = r.data;
  if (r.error) return <div class="view"><a class="back dim" href="#/people">← people</a><Fail error={r.error} reload={r.reload} /></div>;
  if (!d) return <div class="view"><Skeleton rows={10} /></div>;
  const p = d.person;
  const self = lc(me.login) === lc(d.login);
  const staff = p && p.status === 'active';
  return (
    <Page back="#/people" kicker={staff ? `${p.rank}${d.teams.length ? ` · ${d.teams.join(', ')}` : ''}` : 'Person'} title={<><img class="p-avatar" src={(d.github && d.github.avatar) || `https://github.com/${d.login}.png`} alt="" width="40" height="40" />@{d.login}</>}
      facts={<>
        {d.github && d.github.name && <span>{d.github.name}</span>}
        {d.github && <span class="dim">GitHub since {day(Date.parse(d.github.createdAt))}</span>}
        {d.banned && <Pill kind="bad">banned</Pill>}
        {d.limit !== null && d.limit !== undefined && <Pill kind="warn">limit {d.limit}</Pill>}
        {d.email && <Pill>email on</Pill>}
        {d.leads.length > 0 && <Pill kind="info">lead: {d.leads.join(', ')}</Pill>}
      </>}
      actions={<>
        <a class="btn" href={(d.github && d.github.url) || `https://github.com/${d.login}`} target="_blank" rel="noopener">GitHub ↗</a>
        <a class="btn quiet" href={`https://github.com/${REPO}/issues?q=involves%3A${encodeURIComponent(d.login)}`} target="_blank" rel="noopener">Issues ↗</a>
        {d.banned
          ? <Act cap="user.ban" action="unban" args={{ user: d.login }} kind="quiet" confirm={`Unban @${d.login}?`} onDone={r.reload}>Unban</Act>
          : !staff && <Act cap="user.ban" action="ban" kind="danger" args={() => { const x = ask(`Ban @${d.login}? Reason (public):`); return x === null ? null : { user: d.login, reason: x }; }} onDone={r.reload}>Ban</Act>}
      </>}>
      <div class="p-grid">
        {staff && <AccessSection d={d} acl={acl} self={self} onDone={() => { r.reload(); acl.reload(); }} />}
        <Section title="Names" count={d.names.length} actions={<span class="inline"><input class="input num" type="number" min="0" max="100" placeholder={String(d.maxPerOwner)} value={lim} onInput={(e) => setLim(e.currentTarget.value)} aria-label="Name limit" /><Act cap="user.limit" action="limit" disabled={lim === ''} args={() => ({ user: d.login, n: Number(lim) })} onDone={() => { setLim(''); r.reload(); }}>Set limit</Act></span>}>
          {d.names.length ? <table class="t"><tbody>{d.names.map((n) => <tr key={n.name}><td><NameLink name={n.name} /></td><td class="dim"><Mono>{n.type} {n.target}</Mono></td><td>{n.hold ? <Pill kind="bad">hold</Pill> : n.status ? <Pill>{n.status}</Pill> : null}</td><td class="dim nowrap">{(() => { const t = d.terms.find((x) => x.name === n.name); return t ? `renews ${day(t.expires_at)}` : ''; })()}</td></tr>)}</tbody></table> : <p class="dim">No names.</p>}
        </Section>
        {d.sites.length > 0 && (
          <Section title="Hosted sites" count={d.sites.length}>
            <table class="t"><tbody>{d.sites.map((s) => <tr key={s.name}><td><NameLink name={s.name} /></td><td><Pill kind={s.status === 'active' ? 'ok' : 'warn'}>{s.status}</Pill></td><td class="dim">{lc(s.owner) === lc(d.login) ? 'owner' : 'collaborator'}</td></tr>)}</tbody></table>
          </Section>
        )}
        <Section title="Accounts on our server">
          {d.identity ? <KV rows={[['Everyday', <Mono>{d.identity.managed_login || d.identity.user_name}</Mono>], ['Status', <Pill kind={d.identity.status === 'active' ? 'ok' : 'warn'}>{d.identity.status}</Pill>], ['Updated', ago(d.identity.updated_at)]]} /> : <p class="dim">No account on our server.</p>}
          <div class="row-actions">
            {!d.identity && <Act cap="account.manage" action="emu-create" args={{ user: d.login }} kind="primary" onDone={r.reload}>Make an account</Act>}
            {d.identity && d.identity.status === 'active' && <Act cap="account.manage" action="emu-suspend" args={{ user: d.login }} kind="danger" confirm={`Suspend @${d.login}'s server account?`} onDone={r.reload}>Suspend</Act>}
            {d.identity && d.identity.status !== 'active' && <Act cap="account.manage" action="emu-restore" args={{ user: d.login }} onDone={r.reload}>Restore</Act>}
          </div>
        </Section>
        {staff && (
          <Section title="Work" count={d.queue.filter((q) => q.state !== 'decided').length}>
            {d.queue.length ? <table class="t"><tbody>{d.queue.map((q) => <tr key={q.id}><td><QueueLink q={q} /></td><td><Progress p={q.progress} /></td><td class={`dim nowrap ${q.state !== 'decided' && q.due_at < Date.now() ? 'bad-text' : ''}`}>{q.state === 'decided' ? 'done' : `due ${ago(q.due_at)}`}</td></tr>)}</tbody></table> : <p class="dim">Nothing assigned.</p>}
          </Section>
        )}
        {staff && (
          <Section title="Duty" count={d.shifts.length}>
            {d.shifts.length ? <table class="t"><tbody>{d.shifts.slice(0, 10).map((s) => <tr key={s.id}><td class="dim">{when(s.starts_at)} → {when(s.ends_at)}</td><td>{s.starts_at <= Date.now() && s.ends_at > Date.now() ? <Pill kind="signal">on now</Pill> : <span class="dim">{s.note}</span>}</td></tr>)}</tbody></table> : <p class="dim">No shifts yet.</p>}
          </Section>
        )}
        {d.grants.length > 0 && (
          <Section title="Repository access" count={d.grants.length}>
            <table class="t"><tbody>{d.grants.slice(0, 15).map((g) => <tr key={g.id}><td><Mono>{g.repo}</Mono></td><td><Pill kind={['maintain', 'admin'].includes(g.permission) ? 'bad' : ''}>{g.permission}</Pill></td><td class="dim">{g.state}</td><td class="dim nowrap">{g.standing ? 'standing' : ago(g.expires_at)}</td><td class="w-actions">{g.state === 'active' && <Act action="access-revoke" args={{ id: g.id }} kind="quiet" onDone={r.reload}>End</Act>}</td></tr>)}</tbody></table>
          </Section>
        )}
        {staff && <RosterSection p={p} onDone={r.reload} />}
        <Section title="Private notes" count={d.notes.length} wide><Notes login={d.login} /></Section>
        <Section title="Activity" wide><Events rows={d.events} /></Section>
      </div>
    </Page>
  );
}

function RosterSection({ p, onDone }) {
  const manage = useCap('roster.manage') === 'allow';
  const [rank, setRank] = useState(p.rank);
  const { me } = useSession();
  const sets = Object.keys((me && me.rolesets) || {});
  return (
    <Section title="Roster">
      <KV rows={[['Rank', <Pill>{p.rank}</Pill>], ['Since', p.since || '—'], p.probationUntil && ['Probation until', p.probationUntil], p.mentor && ['Mentor', <User login={p.mentor} />], ['Rolesets', (p.rolesets || []).join(', ') || '—'], ['Status', p.status]]} />
      {manage && p.rank !== 'owner' && (
        <>
          <div class="row-actions">
            <select aria-label="Rank" value={rank} onChange={(e) => setRank(e.currentTarget.value)}>{['trainee', 'maintainer', 'lead'].map((x) => <option key={x}>{x}</option>)}</select>
            {rank !== p.rank && <Act cap="roster.manage" action="rank" args={{ user: p.github, rank }} kind="primary" onDone={onDone}>Save rank</Act>}
            <Act cap="roster.manage" action="demote" args={{ user: p.github }} kind="danger" confirm={`Remove @${p.github} from the roster?`} onDone={onDone}>Remove</Act>
          </div>
          <div class="chips">{sets.map((s) => { const has = (p.rolesets || []).includes(s); return <Act key={s} cap="roster.manage" action="roleset" args={{ user: p.github, changes: [`${has ? '-' : '+'}${s}`] }} kind={has ? 'chip on' : 'chip'} onDone={onDone}>{s}</Act>; })}</div>
        </>
      )}
    </Section>
  );
}

const RESULT_PILL = { allow: ['ok', 'yes'], cosign: ['warn', 'cosign'], deny: ['', 'no'] };
/** What they can do and why, and (for whoever manages access) their roles, qualifications and overrides. */
function AccessSection({ d, acl, self, onDone }) {
  const manage = useCap('acl.manage') === 'allow';
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const a = acl.data;
  const mine = d.model || { roles: [], quals: [], overrides: {} };
  const save = async (patch) => {
    try {
      await call('/api/acl', { method: 'POST', body: { op: 'person.put', login: d.login, roles: mine.roles, quals: mine.quals, overrides: mine.overrides, ...patch, version: a ? a.version : undefined } });
      toast({ kind: 'ok', title: `Saved @${d.login}'s access` });
      onDone();
    } catch (e) { toast({ kind: 'err', title: 'Not saved', body: e.message }); }
  };
  const toggle = (key, id) => { const cur = new Set(mine[key] || []); cur.has(id) ? cur.delete(id) : cur.add(id); save({ [key]: [...cur] }); };
  const access = d.access || {};
  const counts = Object.values(access).reduce((m, v) => ((m[v.result] = (m[v.result] || 0) + 1), m), {});
  return (
    <Section title={self ? 'Your access' : 'Access'} wide actions={<button class="btn quiet" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide every capability' : `Every capability (${counts.allow || 0} yes · ${counts.cosign || 0} cosign)`}</button>}>
      <div class="access-top">
        <div><span class="dim">Teams</span> {d.teams.length ? d.teams.map((t) => <Pill key={t} kind="info">{(a && a.model.teams[t] && a.model.teams[t].name) || t}</Pill>) : <span class="dim">none</span>}</div>
        <div><span class="dim">Roles</span> {a ? (manage
          ? <span class="chips">{Object.entries(a.model.roles).map(([id, r]) => { const has = (mine.roles || []).includes(id); const viaTeam = d.roles.some((x) => x.id === id && x.via !== 'you'); return <button key={id} type="button" class={`chip ${has ? 'on' : ''}`} aria-pressed={has} onClick={() => toggle('roles', id)} title={viaTeam ? 'Also from a team' : ''}>{r.name}{viaTeam && !has ? ' (team)' : ''}</button>; })}{!Object.keys(a.model.roles).length && <a class="dim" href="#/roles">make roles →</a>}</span>
          : d.roles.map((x) => <Pill key={x.id + x.via}>{(a.model.roles[x.id] || {}).name || x.id}</Pill>)) : '…'}</div>
        <div><span class="dim">Qualifications</span> {a ? (manage
          ? <span class="chips">{Object.entries(a.model.quals).map(([id, q]) => { const has = (mine.quals || []).includes(id); return <button key={id} type="button" class={`chip ${has ? 'on' : ''}`} aria-pressed={has} onClick={() => toggle('quals', id)}>{q.name}</button>; })}{!Object.keys(a.model.quals).length && <a class="dim" href="#/roles">make qualifications →</a>}</span>
          : (mine.quals || []).map((q) => <Pill key={q}>{(a.model.quals[q] || {}).name || q}</Pill>)) : '…'}</div>
      </div>
      {open && a && (
        <div class="scroll-x"><table class="t access-matrix">
          <thead><tr><th>Capability</th><th>Can</th><th>Why</th>{manage && <th>Override</th>}</tr></thead>
          <tbody>{Object.entries(a.areas).flatMap(([area, caps]) => [
            <tr key={area} class="area"><td colSpan={manage ? 4 : 3}>{area}</td></tr>,
            ...caps.map((c) => {
              const v = access[c] || { result: 'deny', why: '' };
              const ov = (mine.overrides || {})[c] || '';
              return (
                <tr key={c}>
                  <td><Mono>{c}</Mono><div class="sub dim">{a.caps[c].does}</div></td>
                  <td><Pill kind={RESULT_PILL[v.result][0]}>{RESULT_PILL[v.result][1]}</Pill></td>
                  <td class="dim">{v.why}</td>
                  {manage && <td><select aria-label={`Override ${c}`} value={ov} onChange={(e) => { const o = { ...(mine.overrides || {}) }; if (e.currentTarget.value) o[c] = e.currentTarget.value; else delete o[c]; save({ overrides: o }); }}>
                    <option value="">—</option><option value="allow">allow</option><option value="cosign">cosign</option><option value="deny">deny</option>
                  </select></td>}
                </tr>
              );
            }),
          ])}</tbody>
        </table></div>
      )}
    </Section>
  );
}

// ── A public issue or PR ───────────────────────────────────────
const KIND_LABEL = { request: 'Request', 'private-request': 'Private request', report: 'Takedown report', application: 'Maintainer application', deploy: 'Failing deploy' };
export function IssueProfile({ id }) {
  const r = useLoad(() => call(`/v2/issue/${encodeURIComponent(id)}`), [id]);
  const d = r.data;
  if (r.error) return <div class="view"><a class="back dim" href="#/queue">← queue</a><Fail error={r.error} reload={r.reload} /></div>;
  if (!d) return <div class="view"><Skeleton rows={10} /></div>;
  const it = d.item;
  const open = d.state === 'open';
  const report = d.kind === 'report';
  const nameGuess = (/(?:request|takedown)[:\s]+([a-z0-9-]+)/i.exec(d.title) || [])[1];
  return (
    <Page back="#/queue" kicker={`${KIND_LABEL[d.kind] || d.kind} · #${d.number}`} title={d.title}
      facts={<>
        <User login={d.user} />
        <Pill kind={open ? 'info' : ''}>{open ? 'open' : d.stateReason === 'not_planned' ? 'closed (not planned)' : 'closed'}</Pill>
        {d.labels.map((l) => <Pill key={l}>{l}</Pill>)}
        <span class="dim">{ago(d.at)}</span>
        {nameGuess && <NameLink name={nameGuess.toLowerCase()} />}
      </>}
      actions={<>
        <a class="btn" href={d.url} target="_blank" rel="noopener">On GitHub ↗</a>
        {open && !report && d.kind !== 'application' && <>
          <Act cap="request.approve" action="approve" args={{ number: d.number }} kind="primary" onDone={r.reload}>Approve</Act>
          <Act cap="request.force" action="approve" args={{ number: d.number, force: true }} kind="quiet" confirm="Approve over the automated blockers?" onDone={r.reload}>Force</Act>
          <Act cap="request.hold" action={d.labels.includes('on-hold') ? 'unhold' : 'hold'} args={() => (d.labels.includes('on-hold') ? { number: d.number } : (() => { const x = ask('Why hold it?'); return x === null ? null : { number: d.number, reason: x }; })())} kind="quiet" onDone={r.reload}>{d.labels.includes('on-hold') ? 'Release' : 'Hold'}</Act>
          <Act cap="request.reject" action="reject" args={() => { const x = ask('Reason (shown to the requester)'); return x === null ? null : { number: d.number, reason: x }; }} kind="quiet" onDone={r.reload}>Reject</Act>
          <Act action="recheck" args={{ number: d.number }} kind="quiet" onDone={r.reload}>Re-check</Act>
        </>}
        {open && report && <>
          <Act cap="abuse.takedown" action="takedown" args={() => { const x = ask('Reason for the takedown (public)'); return x === null ? null : { number: d.number, reason: x }; }} kind="danger" onDone={r.reload}>Take down</Act>
          <Act cap="abuse.dismiss" action="dismiss" args={() => { const x = ask('Why are you leaving it up?'); return x === null ? null : { number: d.number, reason: x }; }} kind="quiet" onDone={r.reload}>Dismiss</Act>
        </>}
      </>}>
      <div class="p-grid">
        {it && <WorkflowSection it={it} flow={d.flow} onDone={r.reload} />}
        {it && <AssignSection it={it} onDone={r.reload} />}
        <Section title={d.pr ? 'Pull request' : 'What they wrote'} wide>
          <div class="md" dangerouslySetInnerHTML={{ __html: md(d.body) }} />
          {d.files.length > 0 && <table class="t"><tbody>{d.files.map((f) => <tr key={f.name}><td><Mono>{f.name}</Mono></td><td class="dim">{f.status}</td><td class="dim nowrap">+{f.additions} −{f.deletions}</td></tr>)}</tbody></table>}
        </Section>
        <Section title="Conversation" count={d.comments.length} wide>
          {d.comments.length ? <ol class="thread">{d.comments.map((c) => <li key={c.id} class={c.bot ? 'bot' : ''}><div class="thread-head"><b>{c.bot ? '🤖 bot' : <User login={c.user} />}</b> <span class="dim">{ago(c.at)}</span></div><div class="md" dangerouslySetInnerHTML={{ __html: md(c.body) }} /></li>)}</ol> : <p class="dim">No comments yet.</p>}
        </Section>
      </div>
    </Page>
  );
}

/** A queue item's steps: the bot ticks the automatic ones, you tick the rest. */
function WorkflowSection({ it, flow, onDone }) {
  const can = useCap('workflow.step') !== 'deny';
  const lead = useCap('queue.assign') === 'allow';
  const p = it.progress;
  return (
    <Section title={`${flow ? flow.name : 'Workflow'}: ${p.done} of ${p.total}`} actions={<Progress p={p} />}>
      <ol class="steps">{p.steps.map((s) => (
        <li key={s.id} class={s.done ? 'done' : p.next && p.next.id === s.id ? 'next' : ''}>
          <span class="step-mark" aria-hidden="true">{s.done ? '✓' : ''}</span>
          <div class="step-body">
            <b>{s.label}</b>
            <span class="dim">{s.done ? `${s.by && s.by !== 'bot' ? `@${s.by} · ` : ''}${ago(s.at)}` : s.auto ? 'the bot ticks this' : s.help}</span>
          </div>
          {can && it.copy && (!s.auto || lead) && (s.done
            ? <Act cap="workflow.step" action="queue" args={{ verb: 'step', step: s.id, done: false, copy: it.copy }} kind="quiet" onDone={onDone}>Undo</Act>
            : <Act cap="workflow.step" action="queue" args={{ verb: 'step', step: s.id, copy: it.copy }} kind={s.auto ? 'quiet' : ''} onDone={onDone}>{s.auto ? 'Tick anyway' : 'Done'}</Act>)}
        </li>
      ))}</ol>
    </Section>
  );
}

function AssignSection({ it, onDone }) {
  const { me } = useSession();
  const roster = useLoad(() => call('/v2/roster'));
  const [who, setWho] = useState('');
  const people = ((roster.data && roster.data.people) || []).filter((x) => x.status === 'active');
  const mine = lc(it.assignee) === lc(me.login);
  return (
    <Section title="Queue">
      <KV rows={[['Assigned to', <User login={it.assignee} />], ['State', <Pill>{it.state}</Pill>], ['Due', <span class={it.state !== 'decided' && it.due_at < Date.now() ? 'bad-text' : ''}>{when(it.due_at)} ({ago(it.due_at)})</span>], it.note && ['Note', it.note], ['Copy on our server', <Mono>{it.copy}</Mono>]]} />
      {it.state !== 'decided' && it.copy && (
        <div class="row-actions">
          {!mine && <Act cap="queue.work" action="queue" args={{ verb: 'claim', copy: it.copy }} kind="primary" onDone={onDone}>Claim</Act>}
          {mine && <Act cap="queue.work" action="queue" args={{ verb: 'unassign', copy: it.copy }} kind="quiet" onDone={onDone}>Hand back</Act>}
          <span class="assign"><select aria-label="Assign to" value={who} onChange={(e) => setWho(e.currentTarget.value)}><option value="">Assign…</option>{people.map((x) => <option key={x.github} value={x.github}>@{x.github}</option>)}</select>{who && <Act cap="queue.assign" action="queue" args={{ verb: 'assign', user: who, copy: it.copy }} onDone={() => { setWho(''); onDone(); }}>Assign</Act>}</span>
          <Act cap="queue.work" action="queue" args={() => { const x = ask('A note for whoever works on this (visible to maintainers):', it.note || ''); return x === null ? null : { verb: 'triage', note: x, copy: it.copy }; }} kind="quiet" onDone={onDone}>Note</Act>
          {it.kind === 'application' && <><Act cap="roster.vote" action="queue" args={{ verb: 'vote', vote: 'yes', copy: it.copy }}>Vote yes</Act><Act cap="roster.vote" action="queue" args={{ verb: 'vote', vote: 'no', copy: it.copy }} kind="quiet">Vote no</Act></>}
        </div>
      )}
    </Section>
  );
}

