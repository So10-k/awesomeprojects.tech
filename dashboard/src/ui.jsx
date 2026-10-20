import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { run, md } from './api.js';

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

/**
 * A button that runs a bot action, gated by a capability:
 * deny → not shown (or shown disabled with why, if `explain`), cosign → runs and says it needs a second maintainer.
 */
export function Act({ cap, action, args, children, kind = '', confirm, onDone, explain = false, title, disabled = false }) {
  const v = useCap(cap);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (cap && v === 'deny' && !explain) return null;
  const go = async () => {
    if (confirm && !window.confirm(confirm)) return;
    const a = typeof args === 'function' ? args() : args;
    if (a === null) return;
    setBusy(true);
    const t = toast({ kind: 'busy', title: 'Sent to the bot…', body: '' });
    try {
      const job = await run(action, a, (u) => t.update({ title: u.summary || 'Working…' }));
      const ok = job.state === 'done' && job.ok !== false;
      t.update({ kind: ok ? 'ok' : 'err', title: job.summary || (ok ? 'Done' : 'That didn’t work'), body: job.message || '', link: job.link });
      if (onDone) onDone(job);
    } catch (e) {
      t.update({ kind: 'err', title: 'That didn’t work', body: e.message });
    } finally { setBusy(false); }
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
export const User = ({ login }) => (login ? <a class="user" href={`https://github.com/${login}`} target="_blank" rel="noopener">@{login}</a> : <span class="dim">—</span>);
