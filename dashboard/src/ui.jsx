import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { start, wait, md } from './api.js';

/** Who's signed in and what they may do (GET /v2/me), plus the public zone. */
export const Session = createContext({ me: null, zone: null, refresh: () => {} });
export const useSession = () => useContext(Session);
/** allow | cosign | deny for a capability, for the signed-in person. */
export const useCap = (cap) => {
  const { me } = useSession();
  return (me && me.capabilities && me.capabilities[cap]) || 'deny';
};

/** Load something; re-run with reload(). Keeps the last data while reloading (no flashing). */
export function useLoad(fn, deps = []) {
  const [state, set] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    set((s) => ({ ...s, loading: true }));
    Promise.resolve().then(fn).then(
      (data) => { if (n === seq.current) set({ data, error: null, loading: false }); },
      (error) => { if (n === seq.current) set((s) => ({ ...s, error, loading: false })); },
    );
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

// ── Toasts ─────────────────────────────────────────────────────
const Toasts = createContext(() => {});
export const useToast = () => useContext(Toasts);
export function ToastHost({ children }) {
  const [list, setList] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setList((l) => [...l.slice(-3), { id, ...t }]);
    if (t.kind !== 'busy') setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.kind === 'err' ? 12000 : 8000);
    return {
      update: (u) => {
        setList((l) => l.map((x) => (x.id === id ? { ...x, ...u } : x)));
        if (u.kind && u.kind !== 'busy') setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), u.kind === 'err' ? 12000 : 9000);
      },
    };
  }, []);
  return (
    <Toasts.Provider value={push}>
      {children}
      <div class="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} class={`toast ${t.kind || ''}`}>
            <div class="toast-head">
              <span class="toast-dot" aria-hidden="true" />
              <b>{t.title}</b>
              <button class="x" type="button" aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>×</button>
            </div>
            {t.body && <div class="toast-body" dangerouslySetInnerHTML={{ __html: md(t.body) }} />}
            {t.link && <a class="toast-link" href={t.link} target="_blank" rel="noopener">Open ↗</a>}
          </div>
        ))}
      </div>
    </Toasts.Provider>
  );
}

// ── Background jobs (actions the bot is still doing) ───────────
const Jobs = createContext({ list: [], add: () => {}, done: () => {} });
export const useJobs = () => useContext(Jobs);
export function JobsHost({ children }) {
  const [list, setList] = useState([]);
  const add = useCallback((id, summary) => setList((l) => [...l, { id, summary, at: Date.now() }]), []);
  const done = useCallback((id) => setList((l) => l.filter((x) => x.id !== id)), []);
  return <Jobs.Provider value={{ list, add, done }}>{children}</Jobs.Provider>;
}
/** The top bar's "2 working…" with what they are. */
export function JobsTray() {
  const { list } = useJobs();
  if (!list.length) return null;
  return (
    <span class="jobs" title={list.map((j) => j.summary).join('\n')} aria-live="polite">
      <span class="spin" aria-hidden="true" /> {list.length} working · <span class="dim">{list[list.length - 1].summary}</span>
    </span>
  );
}

/**
 * A button that runs an action, gated by a capability. It never makes you wait: quick actions finish at once,
 * the rest show in the "working" tray and a toast when the bot is done (onDone runs then, to refresh).
 * deny → not shown (or disabled with why, if `explain`); cosign → runs and says it needs a second maintainer.
 */
export function Act({ cap, action, args, children, kind = '', confirm, onDone, explain = false, title, disabled = false }) {
  const v = useCap(cap);
  const toast = useToast();
  const jobs = useJobs();
  const [busy, setBusy] = useState(false);
  if (cap && v === 'deny' && !explain) return null;
  const go = async () => {
    if (confirm && !window.confirm(confirm)) return;
    const a = typeof args === 'function' ? args() : args;
    if (a === null) return;
    setBusy(true);
    let first;
    try { first = await start(action, a); } catch (e) { toast({ kind: 'err', title: 'That didn’t work', body: e.message }); setBusy(false); return; }
    setBusy(false);
    if (first.done) {
      toast({ kind: first.ok === false ? 'err' : 'ok', title: first.ok === false ? 'Not done' : first.summary || 'Done', body: first.message || '' });
      if (onDone) onDone(first);
      return;
    }
    jobs.add(first.id, first.summary);
    const t = toast({ kind: 'busy', title: first.summary || 'Sent to the bot', body: 'The bot is on it (usually under a minute). Keep working.' });
    wait(first.id, first.summary).then((job) => {
      jobs.done(first.id);
      const ok = job.state === 'done' && job.ok !== false;
      t.update({ kind: ok ? 'ok' : 'err', title: job.summary || (ok ? 'Done' : 'That didn’t work'), body: job.message || '', link: job.link });
      if (onDone) onDone(job);
    });
  };
  return (
    <button class={`btn ${kind}`} type="button" onClick={go} disabled={busy || disabled || (cap && v === 'deny')}
      title={title || (v === 'cosign' ? 'You’re a trainee: a second maintainer confirms this' : v === 'deny' ? 'You can’t do this' : undefined)}>
      {busy ? <span class="spin" aria-hidden="true" /> : null}{children}{v === 'cosign' && <span class="cos">cosign</span>}
    </button>
  );
}

export const Pill = ({ kind = '', children }) => <span class={`pill ${kind}`}>{children}</span>;
export function Empty({ title, children }) {
  return <div class="empty"><b>{title}</b>{children && <p>{children}</p>}</div>;
}
export function Skeleton({ rows = 4 }) {
  return <div class="skel" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <span key={i} style={{ width: `${70 + ((i * 37) % 30)}%` }} />)}</div>;
}
export function Fail({ error, reload }) {
  return <div class="fail" role="alert"><b>Couldn’t load this.</b> <span>{String((error && error.message) || error)}</span> <button class="btn quiet" type="button" onClick={reload}>Try again</button></div>;
}
/** Section header with an optional count and actions on the right. */
export function Head({ title, count, children }) {
  return (
    <header class="head">
      <h2>{title}{count !== undefined && <span class="count">{count}</span>}</h2>
      <div class="head-actions">{children}</div>
    </header>
  );
}
export const Mono = ({ children }) => <span class="mono">{children}</span>;
/** A person: opens their page in the console. */
export const User = ({ login }) => (login ? <a class="user" href={`#/u/${encodeURIComponent(login)}`}>@{login}</a> : <span class="dim">—</span>);
/** A name: opens its page in the console. */
export const NameLink = ({ name }) => <a href={`#/n/${encodeURIComponent(name)}`}><Mono>{name}</Mono></a>;
/** A public issue or PR: opens its page in the console. */
export const IssueLink = ({ number, children }) => <a href={`#/i/${number}`}>{children || `#${number}`}</a>;

/** A small progress bar for a workflow. */
export const Progress = ({ p }) => (p && p.total ? <span class="progress" title={`${p.done} of ${p.total}${p.next ? ` · next: ${p.next.label}` : ''}`}><span style={{ width: `${p.pct}%` }} /></span> : null);
/** A queue item: its public issue's page when it has one. */
export const QueueLink = ({ q }) => {
  const n = (/#(\d+)$/.exec(String(q.source || '')) || [])[1];
  return n && !String(q.source).startsWith('panel:') ? <IssueLink number={n}>{q.title}</IssueLink> : <span>{q.title}</span>;
};
