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
function deployWorkflow(sourceRepo) {
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
    uses: ${sourceRepo}/.github/workflows/pages-site.yml@main
`;
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

/** Org-level rules: site owners can't change workflows (so they can't run arbitrary Actions on our minutes). */
function workflowRuleset() {
  return {
    name: 'awesomeprojects: managed workflows',
    target: 'push',
    enforcement: 'active',
    conditions: { repository_name: { include: ['~ALL'], exclude: [], protected: true } },
    bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
    rules: [{ type: 'file_path_restriction', parameters: { restricted_file_paths: ['.github/workflows/**', '.github/actions/**'] } }],
  };
}
function branchRuleset() {
  return {
    name: 'awesomeprojects: protect main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }, repository_name: { include: ['~ALL'], exclude: [], protected: true } },
    bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
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
  STATUSES, OWNER_PERMISSION, DNS_ON, TEAM, TOPIC, ACCESS, ORG_SETTINGS,
  isHosted, statusOf, dnsEnabled, checkStatus, repoSettings, deployWorkflow, starterFiles,
  workflowRuleset, branchRuleset, actionsPolicy, canTransition, hostedEntry,
};
