// Sign-in with GitHub through api.awesomeprojects.tech, and running panel actions.
// Shared by /me/ and /admin/. The session is a signed bearer token in sessionStorage (or
// localStorage with "keep me signed in"), never a cookie.
'use strict';

/** Web link to a site repo: hosted repos live in the managed enterprise (data.emuHost), the rest on github.com. */
function repoUrl(data, full) {
  const org = String(full || '').split('/')[0].toLowerCase();
  const managed = data && data.emuHost && data.emuOrg && org === String(data.emuOrg).toLowerCase();
  return managed ? `https://${data.emuHost}/${full}` : `https://github.com/${full}`;
}
const isManagedRepo = (data, full) => repoUrl(data, full).indexOf('https://github.com/') !== 0;

const Panel = (() => {
  const KEY = 'ap.session';
  let api = 'https://api.awesomeprojects.tech';

  // Pick the session out of the URL after GitHub sends us back, then clean the URL.
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('session')) {
    (localStorage.getItem('ap.keep') === '1' ? localStorage : sessionStorage).setItem(KEY, frag.get('session'));
    history.replaceState(null, '', location.pathname + location.search);
  }
  const token = () => sessionStorage.getItem(KEY) || localStorage.getItem(KEY);

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  return {
    setApi(url) { if (url) api = url.replace(/\/$/, ''); },
    get api() { return api; },
    signedIn: () => !!token(),
    login(keep) {
      localStorage.setItem('ap.keep', keep ? '1' : '0');
      location.href = `${api}/auth/login?return=${encodeURIComponent(location.pathname)}`;
    },
    logout() { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); },
    /** Is the panel server up? */
    async up() {
      try { const r = await fetch(`${api}/health`, { signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; }
    },
    call,
    me: () => call('/api/me'),
    queue: () => call('/api/queue'),
    audit: (q = {}) => call(`/api/audit?${new URLSearchParams({ limit: 200, ...q })}`),
    stats: () => call('/api/stats'),
    sites: () => call('/api/sites'),
    grants: () => call('/api/grants'),
    identity: (q = {}) => call(`/api/identity?${new URLSearchParams(q)}`),
    requests: (q = {}) => call(`/api/requests?${new URLSearchParams(q)}`),
    request: (id) => call(`/api/requests/${encodeURIComponent(id)}`),
    newRequest: (form) => call('/api/requests', { method: 'POST', body: form }),
    requestDo: (id, verb, body = {}) => call(`/api/requests/${encodeURIComponent(id)}/${verb}`, { method: 'POST', body }),
    /**
     * Queue an action and wait for the bot. onUpdate(state) is called as it changes.
     * Resolves with the finished job ({ state: 'done'|'error', message, link }).
     */
    async run(action, args, onUpdate = () => {}) {
      const { id, summary } = await call('/api/action', { method: 'POST', body: { action, args } });
      onUpdate({ state: 'queued', summary });
      const started = Date.now();
      while (Date.now() - started < 240000) {
        await new Promise((r) => setTimeout(r, Date.now() - started < 30000 ? 2500 : 6000));
        const job = await call(`/api/status/${id}`).catch(() => null);
        if (job && job.state !== 'queued') return job;
      }
      return { state: 'error', summary, message: 'The bot hasn\'t answered yet (GitHub may be slow). Check back in a minute.' };
    },
  };
})();

/** Small, safe Markdown → HTML for the bot's messages (escapes everything first). */
Panel.md = function md(src) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])@([a-z\d-]{1,39})\b/gi, '$1<a href="https://github.com/$2" target="_blank" rel="noopener">@$2</a>')
    .replace(/&lt;br&gt;/g, '<br>');
  const lines = String(src || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?details[^>]*>|<\/?summary>/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push(`<table>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if (/^#{1,4}\s/.test(l)) out.push(`<h3>${inline(l.replace(/^#+\s/, ''))}</h3>`);
    else if (/^>\s?/.test(l)) out.push(`<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`);
    else if (/^\s*[-*]\s/.test(l)) out.push(`<li>${inline(l.replace(/^\s*[-*]\s/, ''))}</li>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('').replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
};
