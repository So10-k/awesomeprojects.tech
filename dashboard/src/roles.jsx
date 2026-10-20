// Roles, qualifications and teams: the owner (or whoever has acl.manage) shapes who can do what.
// Changes save instantly in the panel; the bot then updates the team rooms and the handbook.
import { useState } from 'preact/hooks';
import { call } from './api.js';
import { Empty, Fail, Head, Mono, Pill, Skeleton, User, useCap, useLoad, useToast } from './ui.jsx';

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'r-$1').slice(0, 31);
const KIND_LABEL = { request: 'Requests', 'private-request': 'Private requests', report: 'Reports', application: 'Applications', deploy: 'Failing deploys' };

export function RolesTeams() {
  const r = useLoad(() => call('/v2/acl'));
  const manage = useCap('acl.manage') === 'allow';
  const toast = useToast();
  const [edit, setEdit] = useState(null); // { kind: 'role'|'qual'|'team', id, draft }
  const d = r.data;
  const save = async (body) => {
    try {
      await call('/api/acl', { method: 'POST', body: { ...body, version: d.version } });
      toast({ kind: 'ok', title: 'Saved', body: 'The team rooms and the handbook catch up in a minute.' });
      setEdit(null);
      r.reload();
    } catch (e) { toast({ kind: 'err', title: 'Not saved', body: e.message }); }
  };
  const del = (kind, id, name) => { if (window.confirm(`Delete ${name}? It's removed from everyone who has it.`)) save({ op: `${kind}.del`, id }); };
  if (r.error) return <div class="view"><Fail error={r.error} reload={r.reload} /></div>;
  if (!d) return <div class="view"><Skeleton rows={10} /></div>;
  const m = d.model;
  return (
    <div class="view">
      <Head title="Roles & teams">
        {manage && <>
          <button class="btn" type="button" onClick={() => setEdit({ kind: 'team', id: '', draft: { name: '', description: '', lead: '', members: [], roles: [], kinds: [] } })}>New team</button>
          <button class="btn" type="button" onClick={() => setEdit({ kind: 'role', id: '', draft: { name: '', description: '', caps: {} } })}>New role</button>
          <button class="btn" type="button" onClick={() => setEdit({ kind: 'qual', id: '', draft: { name: '', description: '', gates: [] } })}>New qualification</button>
        </>}
      </Head>
      <p class="dim lede">Ranks and rolesets are the base. <b>Roles</b> add capabilities (alone, or with a cosign). <b>Qualifications</b> are required before some capabilities work at all. <b>Teams</b> share roles, get their kind of queue item first, and have a lead who assigns work and confirms cosigns. Give people roles and qualifications on their page. {!manage && 'Only the owner can change these.'}</p>

      {edit && <Editor edit={edit} d={d} onCancel={() => setEdit(null)} onSave={save} />}

      <section class="panel">
        <Head title="Teams" count={Object.keys(m.teams).length} />
        {Object.keys(m.teams).length === 0 ? <Empty title="No teams yet">A team could be “Trust & Safety” (handles reports, has an abuse role, a lead) or “Hosting” (failing deploys).</Empty> : (
          <div class="cards">{Object.entries(m.teams).map(([id, t]) => (
            <article key={id} class="card">
              <header><b>{t.name}</b> <Mono>team-{id}</Mono></header>
              {t.description && <p class="dim">{t.description}</p>}
              <dl class="kv">
                <dt>Lead</dt><dd><User login={t.lead} /></dd>
                <dt>Members</dt><dd>{t.members.length ? t.members.map((x) => <span key={x}><User login={x} /> </span>) : <span class="dim">—</span>}</dd>
                <dt>Handles</dt><dd>{t.kinds.map((k) => <Pill key={k}>{KIND_LABEL[k] || k}</Pill>)}{!t.kinds.length && <span class="dim">nothing routed</span>}</dd>
                <dt>Roles</dt><dd>{t.roles.map((x) => <Pill key={x} kind="info">{(m.roles[x] || {}).name || x}</Pill>)}{!t.roles.length && <span class="dim">—</span>}</dd>
              </dl>
              {manage && <div class="row-actions"><button class="btn quiet" type="button" onClick={() => setEdit({ kind: 'team', id, draft: { ...t } })}>Edit</button><button class="btn quiet danger-text" type="button" onClick={() => del('team', id, t.name)}>Delete</button></div>}
            </article>
          ))}</div>
        )}
      </section>

      <section class="panel">
        <Head title="Roles" count={Object.keys(m.roles).length} />
        {Object.keys(m.roles).length === 0 ? <Empty title="No roles yet">A role is a named bundle, like “Abuse desk” (take down: allow, ban: cosign) or “DNS operator”.</Empty> : (
          <table class="t"><thead><tr><th>Role</th><th>Gives</th><th>Who has it</th><th /></tr></thead><tbody>{Object.entries(m.roles).map(([id, role]) => {
            const holders = d.people.filter((p) => p.roles.some((x) => x.id === id));
            return (
              <tr key={id}>
                <td><b>{role.name}</b> <Mono>{id}</Mono>{role.description && <div class="sub dim">{role.description}</div>}</td>
                <td><div class="chips">{Object.entries(role.caps).map(([c, g]) => <Pill key={c} kind={g === 'cosign' ? 'warn' : 'ok'}>{c}{g === 'cosign' ? ' · cosign' : ''}</Pill>)}</div></td>
                <td>{holders.length ? holders.map((p) => <span key={p.github}><User login={p.github} /> </span>) : <span class="dim">nobody</span>}</td>
                <td class="w-actions">{manage && <div class="row-actions"><button class="btn quiet" type="button" onClick={() => setEdit({ kind: 'role', id, draft: { ...role, caps: { ...role.caps } } })}>Edit</button><button class="btn quiet danger-text" type="button" onClick={() => del('role', id, role.name)}>Delete</button></div>}</td>
              </tr>
            );
          })}</tbody></table>
        )}
      </section>

      <section class="panel">
        <Head title="Qualifications" count={Object.keys(m.quals).length} />
        {Object.keys(m.quals).length === 0 ? <Empty title="No qualifications yet">A qualification is something you must have first, like “Abuse-trained” before anyone can take a name down.</Empty> : (
          <table class="t"><thead><tr><th>Qualification</th><th>Needed for</th><th>Who has it</th><th /></tr></thead><tbody>{Object.entries(m.quals).map(([id, q]) => (
            <tr key={id}>
              <td><b>{q.name}</b> <Mono>{id}</Mono>{q.description && <div class="sub dim">{q.description}</div>}</td>
              <td><div class="chips">{q.gates.map((c) => <Pill key={c}>{c}</Pill>)}{!q.gates.length && <span class="dim">nothing yet</span>}</div></td>
              <td>{Object.entries(m.people).filter(([, p]) => (p.quals || []).includes(id)).map(([login]) => <span key={login}><User login={login} /> </span>)}</td>
              <td class="w-actions">{manage && <div class="row-actions"><button class="btn quiet" type="button" onClick={() => setEdit({ kind: 'qual', id, draft: { ...q, gates: [...q.gates] } })}>Edit</button><button class="btn quiet danger-text" type="button" onClick={() => del('qual', id, q.name)}>Delete</button></div>}</td>
            </tr>
          ))}</tbody></table>
        )}
      </section>

      <section class="panel">
        <Head title="Who has what" />
        <div class="scroll-x"><table class="t">
          <thead><tr><th>Person</th><th>Rank</th><th>Teams</th><th>Roles</th><th>Can alone</th><th>With a cosign</th></tr></thead>
          <tbody>{d.people.map((p) => {
            const v = Object.values(p.access);
            return (
              <tr key={p.github}>
                <td><User login={p.github} /></td><td><Pill>{p.rank}</Pill></td>
                <td>{p.teams.map((t) => <Pill key={t} kind="info">{(m.teams[t] || {}).name || t}</Pill>)}</td>
                <td>{[...new Set(p.roles.map((x) => x.id))].map((x) => <Pill key={x}>{(m.roles[x] || {}).name || x}</Pill>)}</td>
                <td class="num">{v.filter((x) => x.result === 'allow').length}</td><td class="num">{v.filter((x) => x.result === 'cosign').length}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </section>
    </div>
  );
}

function Editor({ edit, d, onCancel, onSave }) {
  const [f, setF] = useState(edit.draft);
  const [id, setId] = useState(edit.id);
  const isNew = !edit.id;
  const set = (k, v) => setF({ ...f, [k]: v });
  const toggle = (k, v) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);
  const finalId = isNew ? id || slug(f.name) : edit.id;
  const title = { role: 'role', qual: 'qualification', team: 'team' }[edit.kind];
  const submit = (e) => {
    e.preventDefault();
    const body = { op: `${edit.kind}.put`, id: finalId, name: f.name, description: f.description };
    if (edit.kind === 'role') body.caps = f.caps;
    if (edit.kind === 'qual') body.gates = f.gates;
    if (edit.kind === 'team') Object.assign(body, { lead: f.lead, members: f.members, roles: f.roles, kinds: f.kinds });
    onSave(body);
  };
  return (
    <form class="panel editor" onSubmit={submit}>
      <Head title={`${isNew ? 'New' : 'Edit'} ${title}`}>
        <button class="btn quiet" type="button" onClick={onCancel}>Cancel</button>
        <button class="btn primary" type="submit" disabled={!f.name.trim() || !finalId}>Save</button>
      </Head>
      <div class="create">
        <label>Name<input class="input" value={f.name} onInput={(e) => set('name', e.currentTarget.value)} placeholder={edit.kind === 'team' ? 'Trust & Safety' : edit.kind === 'role' ? 'Abuse desk' : 'Abuse-trained'} required /></label>
        <label>Id {isNew ? '' : '(fixed)'}<input class="input" value={finalId} disabled={!isNew} onInput={(e) => setId(slug(e.currentTarget.value))} /></label>
        <label class="wide">Description<input class="input" value={f.description} onInput={(e) => set('description', e.currentTarget.value)} placeholder="What it's for" /></label>
      </div>
      {edit.kind === 'role' && (
        <div class="cap-matrix">
          {Object.entries(d.areas).map(([area, caps]) => (
            <fieldset key={area}>
              <legend>{area}</legend>
              {caps.map((c) => (
                <label key={c} class={`cap-row ${d.caps[c].locked ? 'locked' : ''}`} title={d.caps[c].locked ? 'Stays with the owner' : d.caps[c].does}>
                  <span><Mono>{c}</Mono><small class="dim">{d.caps[c].does}</small></span>
                  <select disabled={d.caps[c].locked} value={f.caps[c] || ''} onChange={(e) => { const caps = { ...f.caps }; if (e.currentTarget.value) caps[c] = e.currentTarget.value; else delete caps[c]; set('caps', caps); }}>
                    <option value="">—</option><option value="cosign">with a cosign</option><option value="allow">alone</option>
                  </select>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      {edit.kind === 'qual' && (
        <div>
          <p class="dim">Nobody (except the owner) can use these without this qualification, whatever their rank or roles:</p>
          {Object.entries(d.areas).map(([area, caps]) => <div key={area} class="gate-row"><span class="dim">{area}</span><div class="chips">{caps.map((c) => <button key={c} type="button" class={`chip ${f.gates.includes(c) ? 'on' : ''}`} aria-pressed={f.gates.includes(c)} onClick={() => toggle('gates', c)}>{c}</button>)}</div></div>)}
        </div>
      )}
      {edit.kind === 'team' && (
        <div class="team-edit">
          <label>Lead<select value={f.lead} onChange={(e) => set('lead', e.currentTarget.value)}><option value="">nobody</option>{d.people.map((p) => <option key={p.github} value={p.github.toLowerCase()}>@{p.github}</option>)}</select></label>
          <div><span class="dim">Members</span><div class="chips">{d.people.map((p) => { const l = p.github.toLowerCase(); return <button key={l} type="button" class={`chip ${f.members.includes(l) || f.lead === l ? 'on' : ''}`} aria-pressed={f.members.includes(l)} onClick={() => toggle('members', l)}>@{p.github}</button>; })}</div></div>
          <div><span class="dim">Roles everyone on the team gets</span><div class="chips">{Object.entries(d.model.roles).map(([rid, role]) => <button key={rid} type="button" class={`chip ${f.roles.includes(rid) ? 'on' : ''}`} onClick={() => toggle('roles', rid)}>{role.name}</button>)}{!Object.keys(d.model.roles).length && <span class="dim">make a role first</span>}</div></div>
          <div><span class="dim">Queue items it handles (they go to the team first)</span><div class="chips">{d.kinds.map((k) => <button key={k} type="button" class={`chip ${f.kinds.includes(k) ? 'on' : ''}`} onClick={() => toggle('kinds', k)}>{KIND_LABEL[k] || k}</button>)}</div></div>
        </div>
      )}
    </form>
  );
}
