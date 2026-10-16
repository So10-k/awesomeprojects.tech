// Hosting presets: turn a request ("my Vercel app", "my GitHub repo") into DNS records,
// and explain what to do next. Pure; shared by the bot and the portal's preview.
'use strict';

const net = require('node:net');
const R = require('./rules');

const lc = (s) => String(s || '').trim().toLowerCase();

/** Order = order in the request form. `label` must match the form's dropdown exactly. */
const PROVIDERS = [
  { id: 'hosted', label: 'Host it for me (we make you a private repo)', input: 'none' },
  { id: 'github-pages', label: 'My GitHub repo (free hosting on GitHub Pages)', input: 'repo' },
  { id: 'vercel', label: 'Vercel', input: 'none' },
  { id: 'netlify', label: 'Netlify', input: 'target', suffix: '.netlify.app', hint: 'your Netlify site name, e.g. my-site' },
  { id: 'cloudflare-pages', label: 'Cloudflare Pages', input: 'target', suffix: '.pages.dev', hint: 'your project, e.g. my-site' },
  { id: 'render', label: 'Render', input: 'target', suffix: '.onrender.com', hint: 'your service, e.g. my-app' },
  { id: 'railway', label: 'Railway', input: 'target', suffix: '.up.railway.app', hint: 'the CNAME target Railway shows you' },
  { id: 'fly', label: 'Fly.io', input: 'target', suffix: '.fly.dev', hint: 'your app name, e.g. my-app' },
  { id: 'cname', label: 'Another hostname (CNAME)', input: 'target', hint: 'a hostname, e.g. example.netlify.app' },
  { id: 'server', label: 'My own server (IP address)', input: 'ips', hint: 'one or more public IPs' },
];

const byLabelOrId = (v) => PROVIDERS.find((p) => p.id === lc(v) || lc(p.label) === lc(v));

/** "https://github.com/Alice/Site.git" → "Alice/Site" (or null). */
function cleanRepo(s) {
  const m = String(s || '').trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
    .match(/^([^/\s]+)\/([^/\s#?]+)/);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return R.REPO.test(repo) ? repo : null;
}

function cleanHost(s) {
  return lc(s).replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '').replace(/^`|`$/g, '');
}

/**
 * Build a domains/ entry from a request form.
 * form: { Subdomain, 'Where should it point?', 'GitHub repository', Target, Description }
 * returns { name, provider, entry, problems }
 */
function buildRequest(form, author, { sitesOrg } = {}) {
  const { cleanName } = require('./requests');
  const problems = [];
  const name = cleanName(form['Subdomain'] || '');
  const provider = byLabelOrId(form['Where should it point?'] || '');
  const description = String(form['Description'] || '').trim().slice(0, 200) || undefined;
  if (!name) problems.push('Pick a name.');
  if (!provider) { problems.push('Pick where it should point.'); return { name, provider: null, entry: null, problems }; }

  let records = null;
  let site = { provider: provider.id };
  if (provider.input === 'repo') {
    const repo = cleanRepo(form['GitHub repository']);
    if (!repo) problems.push('Enter your GitHub repository as `owner/repo`, e.g. `alice/portfolio`.');
    else { records = { CNAME: `${lc(repo.split('/')[0])}.github.io` }; site.repo = repo; }
  } else if (provider.id === 'hosted') {
    if (!sitesOrg) problems.push('Hosting with us isn\'t switched on yet. Pick another option for now.');
    else if (name.includes('.')) problems.push('Hosted sites need a top-level name.');
    else {
      records = { CNAME: `${lc(sitesOrg)}.github.io` };
      site = { provider: 'hosted', repo: `${sitesOrg}/${name}`, status: 'active' };
    }
  } else if (provider.id === 'vercel') {
    records = { CNAME: 'cname.vercel-dns.com' };
  } else if (provider.input === 'target') {
    let host = cleanHost(form['Target']);
    if (!host) problems.push(`Enter ${provider.hint}.`);
    else {
      if (provider.suffix && !host.includes('.')) host += provider.suffix;
      if (provider.suffix && !host.endsWith(provider.suffix)) problems.push(`A ${provider.label} address ends in \`${provider.suffix}\`.`);
      records = { CNAME: host };
    }
  } else if (provider.input === 'ips') {
    const ips = String(form['Target'] || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const A = ips.filter((ip) => net.isIPv4(ip));
    const AAAA = ips.filter((ip) => net.isIPv6(ip));
    const bad = ips.filter((ip) => !net.isIP(ip));
    if (!ips.length) problems.push('Enter your server\'s IP address.');
    for (const b of bad) problems.push(`\`${b}\` isn't an IP address.`);
    records = {};
    if (A.length) records.A = A;
    if (AAAA.length) records.AAAA = AAAA;
  }

  const entry = records && {
    owner: { github: author },
    ...(description ? { description } : {}),
    records,
    site,
  };
  return { name, provider, entry, problems };
}

/** One-click file for a user's repo: builds and deploys it to GitHub Pages on every push. */
function pagesWorkflow(sourceRepo) {
  return `name: Deploy to awesomeprojects.tech
on:
  push:
    branches: [main, master]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  site:
    uses: ${sourceRepo}/.github/workflows/pages-site.yml@main
`;
}

/** Markdown: what to do after the name is live. */
function setupGuide({ provider, name, repo, branch = 'main', sourceRepo, domain = R.DOMAIN }) {
  const host = `${name}.${domain}`;
  const p = typeof provider === 'string' ? byLabelOrId(provider) : provider;
  switch (p && p.id) {
    case 'hosted':
      return [
        `**1. Accept your invite** to [${repo}](https://github.com/${repo}) (check your email or [github.com/${repo}/invitations](https://github.com/${repo}/invitations)).`,
        `**2. Edit and push.** It already has a starter page, and it's live at **https://${host}** a minute after each push. Next.js, Vite, Astro and more are detected automatically.`,
        `**3. Manage your name** (records, status) at [awesomeprojects.tech/me](https://awesomeprojects.tech/me/), and check it with \`/verify ${name}\`.`,
      ].join('\n\n');
    case 'github-pages': {
      const file = encodeURIComponent('.github/workflows/awesomeprojects.yml');
      const value = encodeURIComponent(pagesWorkflow(sourceRepo));
      return [
        `**1. Add the deploy workflow** → [**one click: create \`.github/workflows/awesomeprojects.yml\`**](https://github.com/${repo}/new/${branch}?filename=${file}&value=${value}) and press *Commit*.`,
        `It builds Next.js (as a static export), Vite, Astro, Gatsby, Nuxt, SvelteKit, Create React App, Docusaurus, Eleventy or plain HTML: whatever it finds. Fine-tune it with an [\`awesomeprojects.json\`](https://github.com/${sourceRepo}/blob/main/docs/HOSTING.md#awesomeprojectsjson) in your repo.`,
        `**2. Turn on Pages** → [Settings → Pages](https://github.com/${repo}/settings/pages): *Source* = **GitHub Actions**, *Custom domain* = \`${host}\`, then tick **Enforce HTTPS** once it's offered.`,
        `**3. Check it** → comment \`/verify ${name}\` any time.`,
      ].join('\n\n');
    }
    case 'vercel':
      return `**1.** Vercel → your project → **Settings → Domains** → add \`${host}\`.\n\n**2.** If Vercel asks for a TXT record, add it in [My domains](https://awesomeprojects.tech/me/) → *DNS records* (or comment \`/txt ${name} _vercel <value>\`).\n\n**3.** Check it with *Check it* in My domains, or \`/verify ${name}\`.`;
    case 'netlify':
      return `Netlify → your site → **Domain management → Add a domain** → \`${host}\`. Then comment \`/verify ${name}\`.`;
    case 'cloudflare-pages':
      return `Cloudflare → Workers & Pages → your project → **Custom domains** → \`${host}\`. Then comment \`/verify ${name}\`.`;
    case 'render':
    case 'railway':
    case 'fly':
      return `Add \`${host}\` as a custom domain in your ${p.label} dashboard. Then comment \`/verify ${name}\`.`;
    case 'server':
      return `Point your web server at \`${host}\` and get a certificate (Caddy does it automatically; or \`certbot --nginx -d ${host}\`). Then comment \`/verify ${name}\`.`;
    default:
      return `Make sure your host knows about \`${host}\`, then comment \`/verify ${name}\`.`;
  }
}

module.exports = { PROVIDERS, byLabelOrId, cleanRepo, cleanHost, buildRequest, setupGuide, pagesWorkflow };
