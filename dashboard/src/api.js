// The panel server (api.awesomeprojects.tech): sign-in, reads (/v2 and /api) and actions (queued for the bot).
export const API = import.meta.env.VITE_PANEL_API || 'https://api.awesomeprojects.tech';
export const SITE = 'https://awesomeprojects.tech';
const KEY = 'ap.console';

// Pick the session out of the URL after GitHub sends us back.
const frag = new URLSearchParams(location.hash.slice(1));
if (frag.get('session')) {
  (localStorage.getItem('ap.keep') === '1' ? localStorage : sessionStorage).setItem(KEY, frag.get('session'));
  history.replaceState(null, '', `${location.pathname}${location.search}#/overview`);
}
const token = () => sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
export const signedIn = () => !!token();
export function signIn(keep) {
  localStorage.setItem('ap.keep', keep ? '1' : '0');
  location.href = `${API}/auth/login?${new URLSearchParams({ return: '/', origin: location.origin })}`;
}
export function signOut() { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); location.hash = ''; location.reload(); }

export class ApiError extends Error {}
export async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new ApiError('Signed out. Sign in again.'); }
  if (!res.ok) throw new ApiError(data.error || `The panel said ${res.status}.`);
  return data;
}

/** Queue an action for the bot and wait for its answer. onUpdate gets { state, summary }. */
export async function run(action, args = {}, onUpdate = () => {}) {
  const { id, summary } = await call('/api/action', { method: 'POST', body: { action, args } });
  onUpdate({ state: 'queued', summary });
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, Date.now() - t0 < 30000 ? 2500 : 6000));
    const job = await call(`/api/status/${id}`).catch(() => null);
    if (job && job.state !== 'queued') return job;
  }
  return { state: 'error', summary, message: 'The bot hasn’t answered yet (GitHub may be slow). Check the activity log in a minute.' };
}

/** The public zone (names, settings, commands) from the website. */
export const zone = () => fetch(`${SITE}/data.json`, { cache: 'no-cache' }).then((r) => r.json());

/** Small, safe Markdown for the bot's answers (escapes everything first). */
export function md(src) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(src || '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      out.push(`<table>${rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if (/^#{1,4}\s/.test(l)) out.push(`<p><b>${inline(l.replace(/^#+\s/, ''))}</b></p>`);
    else if (/^\s*[-*]\s/.test(l)) out.push(`<p class="li">${inline(l.replace(/^\s*[-*]\s/, ''))}</p>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}

export const ago = (ms) => {
  if (!ms) return '—';
  const d = (Date.now() - Number(ms)) / 1000;
  if (d < 0) { const f = -d; return f < 3600 ? `in ${Math.round(f / 60)} min` : f < 86400 ? `in ${Math.round(f / 3600)} h` : `in ${Math.round(f / 86400)} d`; }
  return d < 60 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
};
export const when = (ms) => (ms ? new Date(Number(ms)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
