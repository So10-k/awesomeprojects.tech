// Hosted sites: private repos in our org that we create, configure, lock and archive.
// Pure: what a site's repo should look like, and what each status means. scripts/bot.js applies it.
'use strict';

const R = require('./rules');

/**
 *   active     owner can push; site live
 *   locked     owner read-only; site live           (disputes, "please stop changing it")
 *   suspended  owner read-only; DNS off             (abuse under review; DNS off so nobody can take the name over)
 *   archived   owner removed; repo archived; DNS off
 */
const STATUSES = ['active', 'locked', 'suspended', 'archived'];
const OWNER_PERMISSION = { active: 'push', locked: 'pull', suspended: 'pull', archived: null };
const DNS_ON = { active: true, locked: true, suspended: false, archived: false };
const TEAM = { slug: 'site-maintainers', name: 'Site maintainers', permission: 'maintain' };
const TOPIC = 'awesomeprojects-site';

const lc = (s) => String(s || '').toLowerCase();
const isHosted = (d) => !!(d && d.site && d.site.provider === 'hosted');
const statusOf = (d) => (isHosted(d) ? d.site.status || 'active' : null);
/** Should DNS publish this entry's records? */
const dnsEnabled = (d) => !isHosted(d) || DNS_ON[statusOf(d)] !== false;

function checkStatus(s) {
  return STATUSES.includes(s) ? [] : [`"site.status" must be one of: ${STATUSES.join(', ')}`];
}

/** The repo settings we keep every site repo at. */
function repoSettings({ name, domain = R.DOMAIN, owner }) {
  return {
    private: true,
    description: `${name}.${domain}${owner ? ` · @${owner}` : ''}`,
    homepage: `https://${name}.${domain}`,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    has_discussions: false,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
    delete_branch_on_merge: true,
  };
}

/** The workflow every site repo runs (it may only be changed by the bot / org admins). */
function deployWorkflow(platformRepo) {
  return `# Managed by awesomeprojects.tech: changes to .github/workflows are blocked for site owners.
name: Deploy
on:
  push:
    branches: [main]
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
    uses: ${platformRepo}/.github/workflows/pages-site.yml@main
    secrets: inherit
`;
}

/** Cloudflare Pages project for a name (project names max out at 58 characters). */
function cfProject(name) {
  const n = String(name).toLowerCase();
  if (n.length <= 55) return `ap-${n}`;
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `ap-${n.slice(0, 48)}-${h.toString(36).slice(0, 6)}`;
}
/** The workflow for sites in the managed-user enterprise: build without secrets, publish to Cloudflare Pages. */
function deployWorkflowCf(platformRepo, project) {
  // Prefer the private platform repo in the managed org so `secrets: inherit` works (same org).
  return `# Managed by awesomeprojects.tech: changes to .github/workflows are blocked for site owners.
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: deploy
  cancel-in-progress: true
jobs:
  site:
    uses: ${platformRepo}/.github/workflows/cf-pages-site.yml@main
    with:
      project: ${project}
    secrets: inherit
`;
}
const onCloudflare = (d) => !!(d && d.site && d.site.provider === 'hosted' && d.site.platform === 'cloudflare');
/** CNAME we create ourselves on approve (github.io org or Cloudflare Pages project) — may not resolve yet. */
function isPendingHostedTarget(name, entry, host) {
  if (!isHosted(entry) || !host) return false;
  const h = lc(host).replace(/\.$/, '');
  if (onCloudflare(entry)) return h === `${cfProject(name)}.pages.dev`;
  const org = String((entry.site && entry.site.repo) || '').split('/')[0];
  return !!org && h === `${lc(org)}.github.io`;
}

/** Files a new site repo starts with. */
function starterFiles({ name, owner, domain = R.DOMAIN, sourceRepo }) {
  const host = `${name}.${domain}`;
  return [
    { path: '.github/workflows/deploy.yml', content: deployWorkflow(sourceRepo) },
    {
      path: 'awesomeprojects.json',
      content: JSON.stringify({ framework: 'auto' }, null, 2) + '\n',
    },
    {
      path: 'README.md',
      content: `# ${host}\n\nYour site lives here. Push to \`main\` and it's live at **https://${host}** in about a minute.\n\n` +
        `- **Plain HTML?** Edit \`index.html\` (and add more files next to it).\n` +
        `- **A framework?** Replace this with your Next.js, Vite, Astro, SvelteKit… project: it's detected and built automatically.\n` +
        `- **Fine-tune the build** in \`awesomeprojects.json\` ([options](https://github.com/${sourceRepo}/blob/main/docs/HOSTING.md#awesomeprojectsjson)).\n` +
        `- **Manage your name** (DNS records, TXT, status) at [awesomeprojects.tech/me](https://awesomeprojects.tech/me/).\n\n` +
        `The workflow in \`.github/workflows\` is managed for you, and changes there are blocked. Ask a maintainer if you need a different build.\n`,
    },
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${host}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 400 1.05rem/1.6 ui-sans-serif, system-ui, sans-serif;
      background: linear-gradient(160deg, #0b1020, #16123a 55%, #2a0f3d); color: #e6ebff; }
    main { padding: 2rem; max-width: 40rem; }
    h1 { font: 800 clamp(2rem, 6vw, 3.4rem)/1.05 ui-monospace, Menlo, monospace; letter-spacing: -0.03em; margin: 0 0 1rem;
      background: linear-gradient(90deg, #7cf7d4, #7aa8ff 50%, #ff7ad9); -webkit-background-clip: text; background-clip: text; color: transparent; }
    code { background: rgb(122 168 255 / 0.12); padding: 0.1em 0.35em; border-radius: 5px; }
    a { color: #7aa8ff; }
  </style>
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p>This is <b>${host}</b>${owner ? `, by <a href="https://github.com/${owner}">@${owner}</a>` : ''}. It's live!</p>
    <p>Edit <code>index.html</code> in the repo and push: the new version is up in about a minute.</p>
  </main>
</body>
</html>
`,
    },
  ];
}

/** Custom repository properties on every site repo (org feature): rulesets target them. */
const PROPERTIES = [
  { property_name: 'ap_status', value_type: 'single_select', allowed_values: STATUSES, required: true, default_value: 'active', description: 'awesomeprojects.tech site status (managed by the bot)' },
  { property_name: 'ap_owner', value_type: 'string', description: 'awesomeprojects.tech site owner (GitHub login)' },
  { property_name: 'ap_name', value_type: 'string', description: 'awesomeprojects.tech subdomain' },
  { property_name: 'ap_template', value_type: 'string', description: 'awesomeprojects.tech starter template' },
];
const propertyValues = ({ status, owner, name, template }) => [
  { property_name: 'ap_status', value: status },
  { property_name: 'ap_owner', value: owner },
  { property_name: 'ap_name', value: name },
  ...(template ? [{ property_name: 'ap_template', value: template }] : []),
];
const ADMIN_BYPASS = [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }];

/** Push rules for every site repo: no workflow edits (no arbitrary Actions on our minutes), size and file-type limits. */
function workflowRuleset(cfg = {}) {
  const ext = (cfg.blockedExtensions || []).map((e) => (String(e).startsWith('.') ? `*${e}` : `*.${e}`));
  return {
    name: 'awesomeprojects: managed workflows',
    target: 'push',
    enforcement: 'active',
    conditions: { repository_name: { include: ['~ALL'], exclude: [] } },
    bypass_actors: ADMIN_BYPASS,
    rules: [
      { type: 'file_path_restriction', parameters: { restricted_file_paths: ['.github/workflows/**', '.github/actions/**'] } },
      { type: 'max_file_size', parameters: { max_file_size: Math.min(100, Math.max(1, cfg.maxFileSizeMB || 25)) } },
      ...(ext.length ? [{ type: 'file_extension_restriction', parameters: { restricted_file_extensions: ext } }] : []),
    ],
  };
}

/** Locked and suspended sites: GitHub itself refuses every push and branch change (not just a lower permission). */
function frozenRuleset() {
  return {
    name: 'awesomeprojects: frozen sites',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: ['~ALL'], exclude: [] },
      repository_property: { include: [{ name: 'ap_status', property_values: ['locked', 'suspended'], source: 'custom' }], exclude: [] },
    },
    bypass_actors: ADMIN_BYPASS,
    rules: [{ type: 'update' }, { type: 'creation' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}
function branchRuleset() {
  return {
    name: 'awesomeprojects: protect main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }, repository_name: { include: ['~ALL'], exclude: [] } },
    bypass_actors: ADMIN_BYPASS,
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}

/** Which actions site repos may use. */
function actionsPolicy(sourceRepo) {
  return {
    permissions: { enabled_repositories: 'all', allowed_actions: 'selected' },
    selected: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [`${sourceRepo}/.github/workflows/*`, 'oven-sh/setup-bun@*'] },
  };
}

/** Org-wide defaults: nobody gets repos by default, members can't make repos, owners are explicit. */
const ORG_SETTINGS = {
  default_repository_permission: 'none',
  members_can_create_repositories: false,
  members_can_create_public_repositories: false,
  members_can_create_private_repositories: false,
  members_can_create_internal_repositories: false,
  members_can_fork_private_repositories: false,
  // Pages must stay on (it also gates the bot); only repo admins can change Pages, and owners get write.
  members_can_create_pages: true,
  members_can_create_public_pages: true,
  members_can_create_private_pages: false,
  web_commit_signoff_required: false,
};

/** Who may move a site between statuses. Anything → anything, but some moves need the owner. */
function canTransition(from, to, { isOwner }) {
  if (!STATUSES.includes(to)) return { ok: false, why: `Status must be one of: ${STATUSES.join(', ')}` };
  if (from === to) return { ok: false, why: `It's already ${to}.` };
  if (from === 'archived' && !isOwner) return { ok: false, why: 'Only the owner can bring back an archived site.' };
  return { ok: true };
}

// ── Templates ─────────────────────────────────────────────────
/** Starters for hosted sites. Files live in templates/<id>/ (with {{name}}, {{host}}, {{owner}}). */
const TEMPLATES = [
  { id: 'html', label: 'Plain HTML', blurb: 'One page you edit by hand' },
  { id: 'next', label: 'Next.js', blurb: 'React with the App Router (static export)' },
  { id: 'vite-react', label: 'Vite + React', blurb: 'A fast single-page app' },
  { id: 'astro', label: 'Astro', blurb: 'Content sites and blogs' },
  { id: 'docs', label: 'Docs (VitePress)', blurb: 'Documentation from Markdown' },
];
const fillTemplate = (text, vars) => text.replace(/\{\{(name|host|owner|year)\}\}/g, (_, k) => vars[k] ?? '');

// ── Ops decisions (the daily run) ─────────────────────────────
/** What to do about a site nobody has pushed to in a while. */
function inactivity({ pushedAt, now = Date.now(), status, warnDays = 0, lockDays = 0, warnedAt = null }) {
  if (status !== 'active' || !pushedAt) return 'none';
  const days = (now - Date.parse(pushedAt)) / 86400e3;
  if (lockDays > 0 && days >= lockDays) return 'lock';
  if (warnDays > 0 && days >= warnDays && !warnedAt) return 'warn';
  return 'none';
}
/** Can another hosted collaborator be added? */
function seatsLeft({ used, max }) {
  if (!max) return Infinity;
  return Math.max(0, max - used);
}
/** HTTPS: enforce once GitHub's certificate is ready. */
const httpsReady = (pages) => !!pages && !pages.https_enforced && !!pages.https_certificate && ['approved', 'issued'].includes(pages.https_certificate.state);

// ── Custom roles (Enterprise Cloud) ───────────────────────────
/**
 * Repository roles for site repos. GitHub only lets a custom role ADD to a base role, so each is
 * a base role plus extras; extras GitHub doesn't offer are dropped (see repoRoles).
 *   ap-site-owner         write + read security alerts: build their site, see what's wrong with it
 *   ap-site-collaborator  write: helpers the owner invited
 *   ap-site-locked        triage: a locked/suspended owner can still answer our issues, but not push
 */
const REPO_ROLES = [
  { name: 'ap-site-owner', description: 'awesomeprojects.tech: owner of a hosted site', base_role: 'write', want: ['view_dependabot_alerts', 'read_code_scanning', 'view_secret_scanning_alerts', 'close_issue', 'reopen_issue', 'manage_topics'] },
  { name: 'ap-site-collaborator', description: 'awesomeprojects.tech: collaborator on a hosted site', base_role: 'write', want: [] },
  { name: 'ap-site-locked', description: 'awesomeprojects.tech: owner of a locked or suspended site (no pushes)', base_role: 'triage', want: ['view_dependabot_alerts'] },
];
/** Organization role for the maintainers team: read-only insight into the org, nothing destructive. */
const ORG_ROLE = {
  name: 'ap-maintainer',
  description: 'awesomeprojects.tech maintainers: org insights (audit log, Actions usage, roles), no admin powers',
  want: ['read_audit_logs', 'read_organization_actions_usage_metrics', 'read_organization_custom_repo_role', 'read_organization_custom_org_role', 'read_organization_custom_properties'],
};
function repoRoles(available = []) {
  const ok = new Set(available);
  return REPO_ROLES.map(({ want, ...r }) => ({ ...r, permissions: want.filter((p) => ok.has(p)) }));
}
function orgRole(available = []) {
  const ok = new Set(available);
  const { want, ...r } = ORG_ROLE;
  return { ...r, permissions: want.filter((p) => ok.has(p)) };
}
/** The role an owner gets for a status: our custom role if it exists, else GitHub's built-in. */
function ownerRole(status, haveRoles = []) {
  const custom = { active: 'ap-site-owner', locked: 'ap-site-locked', suspended: 'ap-site-locked' }[status];
  if (!custom) return null;
  return haveRoles.includes(custom) ? custom : OWNER_PERMISSION[status];
}
const collaboratorRole = (haveRoles = []) => (haveRoles.includes('ap-site-collaborator') ? 'ap-site-collaborator' : 'push');

/** "/repo-access" levels → GitHub permissions. */
const ACCESS = { read: 'pull', write: 'push', maintain: 'maintain', none: null };

/** An entry for a hosted site (what ends up in domains/<name>.json). */
function hostedEntry({ name, owner, org, description }) {
  return {
    owner: { github: owner },
    ...(description ? { description } : {}),
    records: { CNAME: `${lc(org)}.github.io` },
    site: { provider: 'hosted', repo: `${org}/${name}`, status: 'active' },
  };
}

module.exports = {
  STATUSES, OWNER_PERMISSION, DNS_ON, TEAM, TOPIC, ACCESS, ORG_SETTINGS, PROPERTIES, TEMPLATES,
  isHosted, statusOf, dnsEnabled, checkStatus, repoSettings, deployWorkflow, starterFiles, propertyValues, fillTemplate,
  workflowRuleset, branchRuleset, frozenRuleset, actionsPolicy, canTransition, hostedEntry, inactivity, seatsLeft, httpsReady,
  isPendingHostedTarget,
  REPO_ROLES, ORG_ROLE, repoRoles, orgRole, ownerRole, collaboratorRole, cfProject, deployWorkflowCf, onCloudflare,
};
