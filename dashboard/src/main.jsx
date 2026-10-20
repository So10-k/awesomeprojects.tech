import '@fontsource-variable/funnel-sans';
import '@fontsource-variable/martian-mono';
import '../../brand/tokens.css';
import './app.css';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { call, signIn, signOut, signedIn, zone as loadZone, SITE } from './api.js';
import { Session, ToastHost, useSession } from './ui.jsx';
import { Access, Audit, Duty, Names, Overview, People, Queue, Requests, Settings, setServerHost } from './views.jsx';
import { Abuse, Infra, Sites } from './ops.jsx';

const VIEWS = [
  { id: 'overview', label: 'Overview', key: 'o', view: Overview },
  { id: 'queue', label: 'Queue', key: 'q', view: Queue },
  { id: 'requests', label: 'Requests', key: 'r', view: Requests },
  { id: 'abuse', label: 'Abuse', key: 'b', view: Abuse },
  { id: 'names', label: 'Names', key: 'n', view: Names },
  { id: 'sites', label: 'Sites', key: 'h', view: Sites },
  { id: 'people', label: 'People', key: 'p', view: People },
  { id: 'duty', label: 'Duty', key: 'd', view: Duty },
  { id: 'access', label: 'Access & cosigns', key: 'a', view: Access },
  { id: 'infra', label: 'Infra', key: 'i', view: Infra },
  { id: 'audit', label: 'Audit', key: 'l', view: Audit },
  { id: 'settings', label: 'Settings', key: 's', view: Settings },
];

function useRoute() {
  const parse = () => {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    return { id: VIEWS.some((v) => v.id === path) ? path : 'overview', params: new URLSearchParams(qs || '') };
  };
  const [r, setR] = useState(parse);
  useEffect(() => { const f = () => setR(parse()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}
const go = (id, qs = '') => { location.hash = `#/${id}${qs ? `?${qs}` : ''}`; };

function SignIn({ error }) {
  const [keep, setKeep] = useState(false);
  return (
    <main class="signin">
      <div class="signin-card">
        <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="var(--signal)" /><rect x="17.6" y="8.5" width="3.4" height="15" rx="1.7" fill="var(--bg)" /></svg>
        <h1>Console</h1>
        <p class="dim">For awesomeprojects.tech maintainers. Sign in with GitHub: we only learn who you are.</p>
        {error && <p class="bad-text" role="alert">{error}</p>}
        <button class="btn primary big" type="button" onClick={() => signIn(keep)}>Sign in with GitHub</button>
        <label class="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.currentTarget.checked)} /> Keep me signed in on this device</label>
        <a class="dim" href={SITE}>← awesomeprojects.tech</a>
      </div>
    </main>
  );
}

/** ⌘K: jump anywhere, or run the common things. */
function Palette({ open, onClose }) {
  const { me, zone } = useSession();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef(null);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current && input.current.focus(), 0); } }, [open]);
  const items = useMemo(() => {
    const out = VIEWS.map((v) => ({ label: `Go to ${v.label}`, hint: `g ${v.key}`, run: () => go(v.id) }));
    const caps = (me && me.capabilities) || {};
    if (caps['duty.take'] !== 'deny') out.push({ label: 'Duty: go on duty or end my shift', hint: '', run: () => go('duty') });
    out.push({ label: 'Open the website', hint: '', run: () => window.open(SITE, '_blank') });
    out.push({ label: 'Open the queue on our server', hint: '', run: () => window.open(`https://${(zone && zone.emuHost) || 'github.samsprojects.xyz'}/maintainers/queue/issues`, '_blank') });
    out.push({ label: 'Sign out', hint: '', run: signOut });
    const n = q.trim().toLowerCase().replace(/\.awesomeprojects\.tech$/, '');
    const names = ((zone && zone.names) || []).filter((x) => n && !x.name.includes('.') && x.name.includes(n)).slice(0, 6);
    for (const x of names) out.unshift({ label: `Name: ${x.name}`, hint: `@${x.owner}`, run: () => go('names', `q=${encodeURIComponent(x.name)}`) });
    return out.filter((x) => !n || x.label.toLowerCase().includes(n) || x.label.startsWith('Name:'));
  }, [q, me, zone]);
  if (!open) return null;
  const pick = (x) => { onClose(); x.run(); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(items.length - 1, v + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
    else if (e.key === 'Enter' && items[i]) { e.preventDefault(); pick(items[i]); }
    else if (e.key === 'Escape') onClose();
  };
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input ref={input} class="palette-in" placeholder="Jump to… or type a name" value={q} onInput={(e) => { setQ(e.currentTarget.value); setI(0); }} onKeyDown={key}
          role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={`pal-${i}`} />
        <ul class="palette-list" id="pal-list" role="listbox">
          {items.map((x, n) => (
            <li key={x.label} id={`pal-${n}`} role="option" aria-selected={n === i} class={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => pick(x)}>
              <span>{x.label}</span>{x.hint && <kbd>{x.hint}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li class="dim">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const { me, zone } = useSession();
  const [pal, setPal] = useState(false);
  const [nav, setNav] = useState(false);
  const View = (VIEWS.find((v) => v.id === route.id) || VIEWS[0]).view;
  useEffect(() => {
    let g = false;
    const onKey = (e) => {
      const t = e.target;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal((v) => !v); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { const s = document.querySelector('[data-autofocus]'); if (s) { e.preventDefault(); s.focus(); } return; }
      if (g) { g = false; const v = VIEWS.find((x) => x.key === e.key); if (v) { e.preventDefault(); go(v.id); } return; }
      if (e.key === 'g') { g = true; setTimeout(() => { g = false; }, 900); }
      if (e.key === '?') setPal(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setNav(false); document.querySelector('#main') && document.querySelector('#main').focus({ preventScroll: true }); }, [route.id]);
  const caps = me.capabilities || {};
  const hidden = { settings: false, people: false };
  return (
    <div class={`shell ${nav ? 'nav-open' : ''}`}>
      <aside class="side" aria-label="Sections">
        <a class="wordmark" href="#/overview" aria-label="Console home">
          <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="var(--signal)" /><rect x="17.6" y="8.5" width="3.4" height="15" rx="1.7" fill="var(--bg)" /></svg>
          <span>console</span>
        </a>
        <button class="btn palette-btn" type="button" onClick={() => setPal(true)}><span>Jump to…</span><kbd>⌘K</kbd></button>
        <nav>
          {VIEWS.filter((v) => !hidden[v.id]).map((v) => (
            <a key={v.id} href={`#/${v.id}`} aria-current={route.id === v.id ? 'page' : undefined}>
              <span>{v.label}</span><kbd class="nav-key">g {v.key}</kbd>
            </a>
          ))}
        </nav>
        <div class="me">
          {me.avatar && <img src={`${me.avatar}${me.avatar.includes('?') ? '&' : '?'}s=48`} alt="" width="28" height="28" />}
          <div><b>@{me.login}</b><span class="dim">{me.person ? me.person.rank : 'visitor'}{me.onDuty ? ' · on duty' : ''}</span></div>
          <button class="btn quiet" type="button" onClick={signOut} aria-label="Sign out">⏻</button>
        </div>
      </aside>
      <div class="main-col">
        <header class="top">
          <button class="btn quiet menu" type="button" aria-label="Menu" aria-expanded={nav} onClick={() => setNav((v) => !v)}>☰</button>
          <span class="crumb">{(VIEWS.find((v) => v.id === route.id) || {}).label}</span>
          {zone && zone.announcement && <span class="banner"><span class="dot live" /> {zone.announcement}</span>}
          {caps['request.approve'] === 'cosign' && <span class="pill warn" title="Some actions need a second maintainer">trainee</span>}
        </header>
        <main id="main" tabIndex={-1}>
          {me.person && me.person.status === 'active' ? <View key={route.id + route.params} params={route.params} /> : (
            <div class="view"><div class="empty"><b>You’re not an active maintainer</b><p>This console is for the people on <a href={`${SITE}/maintainers/`}>the roster</a>. Want to help? <a href={`https://github.com/So10-k/awesomeprojects.tech/issues/new?template=maintainer-application.yml`}>Apply</a>.</p></div></div>
          )}
        </main>
      </div>
      <Palette open={pal} onClose={() => setPal(false)} />
    </div>
  );
}

function App() {
  const [me, setMe] = useState(null);
  const [zone, setZone] = useState(null);
  const [err, setErr] = useState('');
  const refresh = () => call('/v2/me').then(setMe, (e) => setErr(e.message));
  useEffect(() => {
    if (!signedIn()) return;
    refresh();
    loadZone().then((z) => { setZone(z); setServerHost(z.emuHost); }, () => {});
  }, []);
  if (!signedIn()) return <SignIn />;
  if (!me) return err ? <SignIn error={err} /> : <div class="boot" aria-busy="true"><span class="dot live" /> Loading the console…</div>;
  return <Session.Provider value={{ me, zone, refresh }}><ToastHost><Shell /></ToastHost></Session.Provider>;
}

render(<App />, document.getElementById('app'));
