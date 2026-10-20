import data from '../generated/data.json';

export const D = data;
/** Top-level names (alice), not names under names (blog.alice). */
export const topNames = data.names.filter((n) => !n.name.includes('.')).sort((a, b) => a.name.localeCompare(b.name));
export const fqdn = (name) => `${name}.${data.domain}`;
/** A record value for display: no trailing dot, lists joined. */
export const shown = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? '')).replace(/\.$/, '');
/** Every record of a name as rows: [type, value]. */
export function recordRows(records = {}) {
  const rows = [];
  for (const [type, v] of Object.entries(records)) {
    if (type === 'MX' && Array.isArray(v)) for (const mx of v) rows.push([type, typeof mx === 'object' ? `${mx.priority ?? ''} ${shown(mx.target ?? mx.host ?? '')}`.trim() : shown(mx)]);
    else if (type === 'TXT') for (const t of [].concat(v)) rows.push([type, typeof t === 'object' ? `${t.name ? `${t.name} ` : ''}"${t.value ?? ''}"` : `"${t}"`]);
    else if (Array.isArray(v)) for (const x of v) rows.push([type, shown(x)]);
    else if (v && typeof v === 'object') rows.push([type, JSON.stringify(v)]);
    else rows.push([type, shown(v)]);
  }
  return rows;
}
/** The host in plain words: the bot names known hosts; a bare record type means "somewhere else". */
const BY_TYPE = { A: 'Own server', AAAA: 'Own server', CNAME: 'Other host', TXT: 'Records only', MX: 'Email only' };
export const hostName = (n) => BY_TYPE[n.host] || n.host;
export const HOST_LABEL = { hosted: 'Hosted by us', 'github-pages': 'GitHub Pages', vercel: 'Vercel', netlify: 'Netlify', 'cloudflare-pages': 'Cloudflare Pages', render: 'Render', railway: 'Railway', fly: 'Fly.io', cname: 'Other host', server: 'Own server', email: 'Email only', other: 'Other' };
export const hostLabel = (h) => HOST_LABEL[h] || h;
