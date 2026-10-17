#!/usr/bin/env node
// The subdomain bot. Runs from .github/workflows/bot.yml on main's code only:
// pull requests are read as data (git objects + JSON.parse), never checked out or executed.
//
//   issues              requests (the easy way: a form, no fork), transfers, takedown reports
//   pull_request_target the PR way: review, label, set the "subdomain-review" status, comment
//   issue_comment       slash commands (scripts/commands.js has the full list)
//   discussion_comment  read-only commands in Discussions (/help /available /whois /mine /verify /stats)
//   repository_dispatch actions from the panel (api.awesomeprojects.tech): same commands, no public comment
//   schedule            weekly health check for names that point at nothing
//
// Every change it makes is logged in the "📜 Bot activity log" discussion.
//
// Locally: GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo DRY_RUN=1 node scripts/bot.js pr 12
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const R = require('./rules');
const { review, STATE_LABELS, REASON_LABELS } = require('./review');
const { MARK, reviewComment, requestComment, simpleComment } = require('./comment');
const Q = require('./requests');
const P = require('./providers');
const F = require('./frameworks');
const C = require('./commands');
const S = require('./sites');
const { github, git, readTree, diff, checkTargets, verifySite } = require('./lib');

const root = path.join(__dirname, '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const config = readJson('config.json');
const reserved = readJson('reserved.json');
const repo = process.env.GITHUB_REPOSITORY;
const [owner] = repo.split('/');
const repoUrl = `https://github.com/${repo}`;
const maintainers = [owner, ...(config.maintainers || [])].map((s) => s.toLowerCase());
const dryRun = !!process.env.DRY_RUN;
const gh = github(process.env.GITHUB_TOKEN, { dryRun });
// Site repos (classic and/or managed org): create, configure, lock, archive. For the managed org this
// must be a *provisioned* enterprise owner — the setup user can't join orgs.
const ghBot = process.env.BOT_PAT ? github(String(process.env.BOT_PAT).trim(), { dryRun }) : null;
const ORG = config.sitesOrg || '';
// Managed-user enterprise: SCIM only (setup user). Org/repo work uses BOT_PAT above.
const EMU = config.emu || {};
const ghEmu = process.env.EMU_ADMIN_TOKEN ? github(String(process.env.EMU_ADMIN_TOKEN).trim(), { dryRun }) : null;
const emuHostingOn = !!(EMU.org && ghEmu && ghBot);
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;

const lc = (s) => String(s || '').toLowerCase();
const isMaintainer = (login) => maintainers.includes(lc(login));
const isAdmin = (login, association) => isMaintainer(login) || association === 'OWNER';
const R_ = `/repos/${repo}`;
const humans = (comments) => comments.filter((c) => c.user && c.user.type !== 'Bot');
const MANAGED = [...STATE_LABELS, ...REASON_LABELS];

// ── Small GitHub helpers ────────────────────────────────────────
async function upsertComment(number, kind, body) {
  const comments = await gh.all(`${R_}/issues/${number}/comments`);
  const mine = comments.find((c) => c.user && c.user.type === 'Bot' && (c.body || '').startsWith(MARK(kind)));
  if (mine) return gh.patch(`${R_}/issues/comments/${mine.id}`, { body });
  return gh.post(`${R_}/issues/${number}/comments`, { body });
}
const reply = (number, body) => gh.post(`${R_}/issues/${number}/comments`, { body });
const react = (commentId, content) => gh.post(`${R_}/issues/comments/${commentId}/reactions`, { content }).catch(() => {});

async function setLabels(number, current, wanted, managed = MANAGED) {
  for (const l of current) {
    if (managed.includes(l) && !wanted.includes(l)) await gh.del(`${R_}/issues/${number}/labels/${encodeURIComponent(l)}`).catch(() => {});
  }
  const add = wanted.filter((l) => !current.includes(l));
  if (add.length) await gh.post(`${R_}/issues/${number}/labels`, { labels: add });
}

const close = (number, reason = 'completed') => gh.patch(`${R_}/issues/${number}`, { state: 'closed', state_reason: reason });
async function deploy() {
  await gh.post(`${R_}/actions/workflows/deploy.yml/dispatches`, { ref: 'main' });
  await gh.post(`${R_}/actions/workflows/site.yml/dispatches`, { ref: 'main' }).catch(() => {}); // the website's list of names
}

function fetchRefs(...specs) {
  git(['fetch', '--no-tags', '--quiet', 'origin', ...specs]);
}
function mainTree() {
  fetchRefs('+refs/heads/main:refs/bot/main');
  return readTree('refs/bot/main');
}
const mainFile = (f) => {
  fetchRefs('+refs/heads/main:refs/bot/main');
  return git(['show', `refs/bot/main:${f}`]);
};

// ── Activity log (a Discussion) ─────────────────────────────────
const LOG_TITLE = '📜 Bot activity log';
/**
 * Every change is recorded in the private audit log (the console's Activity tab). The public
 * discussion only gets one digest a day (see ops), so watchers aren't emailed for every action.
 * Without the panel server, lines go straight to the discussion as before.
 */
async function activityLog(line) {
  console.log(`[log] ${line}`);
  if (dryRun) return;
  if (process.env.PANEL_API && process.env.PANEL_BOT_SECRET) {
    try {
      const res = await fetch(`${process.env.PANEL_API}/bot/activity`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${String(process.env.PANEL_BOT_SECRET).trim()}`, 'Content-Type': 'application/json', 'User-Agent': 'awesomeprojects-bot' },
        body: JSON.stringify({ line }),
      });
      if (res.ok) return;
    } catch { /* fall through to the discussion */ }
  }
  return postToLog(line);
}
async function postToLog(line) {
  try {
    const [o, n] = repo.split('/');
    const d = await gh.graphql(`query($o:String!,$n:String!){repository(owner:$o,name:$n){id hasDiscussionsEnabled
      discussionCategories(first:25){nodes{id name}}
      discussions(first:50,orderBy:{field:CREATED_AT,direction:ASC}){nodes{id title}}}}`, { o, n });
    const r = d.repository;
    if (!r.hasDiscussionsEnabled) return;
    let disc = r.discussions.nodes.find((x) => x.title === LOG_TITLE);
    if (!disc) {
      const cat = r.discussionCategories.nodes.find((c) => /announcements/i.test(c.name)) || r.discussionCategories.nodes[0];
      const made = await gh.graphql(`mutation($r:ID!,$c:ID!,$t:String!,$b:String!){createDiscussion(input:{repositoryId:$r,categoryId:$c,title:$t,body:$b}){discussion{id}}}`,
        { r: r.id, c: cat.id, t: LOG_TITLE, b: 'Every change the bot makes (approvals, removals, transfers, bans, config) is posted here, newest at the bottom. Subscribe to follow along.' });
      disc = made.createDiscussion.discussion;
    }
    await gh.graphql(`mutation($d:ID!,$b:String!){addDiscussionComment(input:{discussionId:$d,body:$b}){comment{id}}}`, { d: disc.id, b: line });
  } catch (e) {
    console.warn(`activity log: ${e.message}`);
  }
}

// ── GitHub Pages: checks on the repo, and how it'll be built ─────
async function repoChecks(entry, author) {
  const out = { findings: [], pagesOwners: [], plan: null, branch: 'main' };
  const site = entry && entry.site;
  if (!site || site.provider !== 'github-pages' || !site.repo) return out;
  const add = (level, text, extra = {}) => out.findings.push({ check: 'repo', level, text, ...extra });

  let r;
  try { r = await gh.get(`/repos/${site.repo}`); } catch {
    add('error', `I can't find [${site.repo}](https://github.com/${site.repo}). Is it public, and spelled right?`);
    return out;
  }
  out.branch = r.default_branch;
  const link = `[${r.full_name}](${r.html_url})`;
  if (r.archived) add('error', `${link} is archived. Unarchive it first.`);
  if (lc(r.owner.login) === lc(author) || isMaintainer(author)) {
    add('pass', `${link} is yours`);
  } else if (r.owner.type === 'Organization') {
    out.pagesOwners.push(lc(r.owner.login)); // this check covers the github.io match
    const member = await gh.get(`/orgs/${r.owner.login}/public_members/${author}`).then(() => true, () => false);
    if (member) add('pass', `${link} belongs to @${r.owner.login}, and you're a public member`);
    else add('hold', `${link} belongs to the @${r.owner.login} organization. Make your membership public ([people](https://github.com/orgs/${r.owner.login}/people) → your name → Public) and comment \`/recheck\`, or a maintainer will confirm.`, { waitingFor: 'maintainer', label: 'pages-mismatch' });
  } else {
    out.pagesOwners.push(lc(r.owner.login));
    add('error', `${link} belongs to @${r.owner.login}. Use a repo of your own.`);
  }

  try {
    const tree = await gh.get(`/repos/${r.full_name}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`);
    const files = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
    const raw = async (p) => {
      try {
        const c = await gh.get(`/repos/${r.full_name}/contents/${p}?ref=${encodeURIComponent(r.default_branch)}`);
        return Buffer.from(c.content, 'base64').toString('utf8');
      } catch { return null; }
    };
    const { config: cfg, problems } = F.readConfig(files.includes(F.CONFIG_FILE) ? await raw(F.CONFIG_FILE) : null);
    for (const p of problems) add('error', p);
    const dir = String(cfg.directory || '').replace(/^\.\/?/, '').replace(/\/$/, '');
    const rel = dir ? files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)) : files;
    let pkg = null;
    if (rel.includes('package.json')) {
      try { pkg = JSON.parse(await raw(`${dir ? `${dir}/` : ''}package.json`)); } catch { add('error', '`package.json` isn\'t valid JSON.'); }
    }
    out.plan = F.plan({ pkg, files: new Set(rel), config: cfg });
    add('info', `Builds as **${out.plan.label}**${out.plan.warnings.length ? ', see the ⚠️ notes below' : ''}`);
  } catch (e) {
    add('info', `Couldn't read the repo's files (${e.message}). The build detects the framework itself.`);
  }
  return out;
}

async function repoChecksFor(entries, author) {
  const all = { findings: [], pagesOwners: [] };
  for (const e of entries) {
    const r = await repoChecks(e, author);
    all.findings.push(...r.findings);
    all.pagesOwners.push(...r.pagesOwners);
  }
  return all;
}

// ── Pull requests ───────────────────────────────────────────────
async function reviewPR(number, { overrideHolds = false, overrideAll = false, by = '' } = {}) {
  const pr = await gh.get(`${R_}/pulls/${number}`);
  if ((pr.state !== 'open' && !dryRun) || pr.base.ref !== 'main') return null;

  fetchRefs('+refs/heads/main:refs/bot/main', `+refs/pull/${number}/head:refs/bot/pr`);
  const mergeBase = git(['merge-base', 'refs/bot/main', 'refs/bot/pr']).trim();
  const main = readTree('refs/bot/main');
  const prTree = readTree('refs/bot/pr');

  // main + this PR's changes (so files merged since the PR branched still count).
  const base = main.entries;
  const head = { ...base };
  const invalid = {};
  const changes = [];
  for (const c of diff(mergeBase, 'refs/bot/pr')) {
    const n = /^domains\/[^/]+\.json$/.test(c.file) ? R.nameFromFile(c.file) : null;
    if (!n) { changes.push(c); continue; }
    if (c.status === 'D') { delete head[n]; changes.push({ status: 'D', file: c.file }); continue; }
    if (prTree.invalid[n]) { invalid[n] = prTree.invalid[n]; delete head[n]; } else head[n] = prTree.entries[n];
    changes.push({ status: base[n] ? 'M' : 'A', file: c.file });
  }

  // PRs the bot opened itself are reviewed like a maintainer's.
  const author = pr.user.type === 'Bot' ? owner : pr.user.login;
  const profile = await gh.get(`/users/${author}`).catch(() => null);
  const comments = humans(await gh.all(`${R_}/issues/${number}/comments`));
  const labels = pr.labels.map((l) => l.name);
  const changed = changes.map((c) => head[R.nameFromFile(c.file)]).filter(Boolean);
  const dns = await checkTargets(changed);
  const rc = await repoChecksFor(changed, author);

  const result = review({
    author, profile, changes, base, head, invalid, comments, labels, dns,
    reserved, config, maintainers, overrideHolds, overrideAll, by, extra: rc.findings, pagesOwners: rc.pagesOwners,
  });
  console.log(`PR #${number} by ${author}: ${result.verdict}`);
  for (const f of result.findings) console.log(`  ${f.level.padEnd(6)} ${f.check}: ${f.text}`);

  const state = { ready: 'success', 'on-hold': 'pending', 'needs-changes': 'failure', rejected: 'failure' }[result.verdict];
  const description = { ready: 'Ready for a maintainer', 'on-hold': 'On hold', 'needs-changes': 'Needs changes', rejected: 'Not accepted' }[result.verdict];
  await gh.post(`${R_}/statuses/${pr.head.sha}`, { state, context: 'subdomain-review', description, target_url: runUrl });
  await setLabels(number, labels, result.labels);
  await upsertComment(number, 'review', reviewComment(result, { autoMerging: result.autoMerge }));

  if (result.verdict === 'rejected') {
    await close(number, 'not_planned');
    await activityLog(`⛔ **Rejected** PR #${number} by @${author} (automatic)`);
  } else if (result.autoMerge && !overrideHolds) {
    if (await mergePR(pr, result)) await activityLog(`🤖 **Auto-merged** PR #${number} by @${author}`);
  }
  return { pr, result };
}

async function mergePR(pr, result) {
  // Another merge can land on main a moment earlier ("Base branch was modified"): wait and retry.
  for (let attempt = 1; ; attempt++) {
    try {
      await gh.put(`${R_}/pulls/${pr.number}/merge`, { merge_method: 'squash', sha: pr.head.sha });
      break;
    } catch (e) {
      if (e.status === 405 && /base branch was modified/i.test(e.message) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      await reply(pr.number, `⚠️ I couldn't merge this automatically (${e.message}). Comment \`/approve\` to try again, or merge it by hand.`);
      return false;
    }
  }
  await deploy();
  await reconcileSites().catch((e) => console.warn(`sites: ${e.message}`));
  if (result) await upsertComment(pr.number, 'review', reviewComment(result, { merged: true }));
  return true;
}

async function onPullRequestComment(number, comment, cmd, rest) {
  const by = comment.user.login;
  const admin = isAdmin(by, comment.author_association);
  switch (cmd) {
    case '/approve': {
      await react(comment.id, 'eyes');
      const force = admin && /\bforce\b/i.test(rest);
      const res = await reviewPR(number, { overrideHolds: admin, overrideAll: force, by });
      if (!res || !admin) return; // non-maintainers: their approval is a consent, read by the review
      if (res.result.verdict !== 'ready') return reply(number, `@${by} I can't merge this yet: it's **${res.result.verdict}** (see the checks above).`);
      if (await mergePR(res.pr, res.result)) await activityLog(`✅ **${force ? `Force-approved (${res.result.overridden} overridden)` : 'Approved'}** PR #${number} by @${res.pr.user.login} · by @${by}`);
      return;
    }
    case '/accept':
    case '/recheck':
      await react(comment.id, 'eyes');
      return reviewPR(number);
    case '/cancel': {
      const pr = await gh.get(`${R_}/pulls/${number}`);
      if (lc(pr.user.login) !== lc(by) && !admin) return react(comment.id, 'confused');
      await reply(number, '👋 Cancelled.');
      return close(number, 'not_planned');
    }
    case '/reject': {
      const pr = await gh.get(`${R_}/pulls/${number}`);
      await gh.post(`${R_}/statuses/${pr.head.sha}`, { state: 'failure', context: 'subdomain-review', description: 'Rejected by a maintainer' });
      await setLabels(number, pr.labels.map((l) => l.name), ['rejected']);
      await upsertComment(number, 'review', simpleComment('review', '⛔ Not accepted', rest ? `A maintainer closed this request:\n\n> ${rest}` : 'A maintainer closed this request.'));
      await activityLog(`⛔ **Rejected** PR #${number} by @${pr.user.login} · by @${by}${rest ? `: ${rest}` : ''}`);
      return close(number, 'not_planned');
    }
    case '/hold':
      await gh.post(`${R_}/issues/${number}/labels`, { labels: ['manual-hold'] });
      if (rest) await reply(number, `⏸️ On hold: ${rest}`);
      await activityLog(`⏸️ **Held** PR #${number} · by @${by}${rest ? `: ${rest}` : ''}`);
      return reviewPR(number);
    case '/unhold':
      await gh.del(`${R_}/issues/${number}/labels/manual-hold`).catch(() => {});
      return reviewPR(number);
    default:
      return reply(number, `\`${cmd}\` doesn't apply to pull requests. \`/help\` lists what does.`);
  }
}

// ── Bot-made changes ────────────────────────────────────────────
/** Commit `changes` ([{ file, content | null }]) on a branch, open a PR, mark it reviewed, merge it. */
async function botChange({ title, body, changes, tag }) {
  const sha = (await gh.get(`${R_}/git/ref/heads/main`)).object.sha;
  const branch = `bot/${tag || Date.now().toString(36)}`;
  await gh.post(`${R_}/git/refs`, { ref: `refs/heads/${branch}`, sha })
    .catch(() => gh.patch(`${R_}/git/refs/heads/${branch}`, { sha, force: true }));
  for (const c of changes) {
    const existing = await gh.get(`${R_}/contents/${c.file}?ref=${branch}`).catch(() => null);
    if (c.content === null) {
      if (existing) await gh.del(`${R_}/contents/${c.file}`, { message: title, sha: existing.sha, branch });
    } else {
      await gh.put(`${R_}/contents/${c.file}`, {
        message: title, branch, content: Buffer.from(c.content).toString('base64'), ...(existing ? { sha: existing.sha } : {}),
      });
    }
  }
  const pr = await gh.post(`${R_}/pulls`, { title, head: branch, base: 'main', body });
  // The bot worked this change out itself, so it passes review.
  await gh.post(`${R_}/statuses/${pr.head.sha}`, { state: 'success', context: 'subdomain-review', description: 'Made by the bot', target_url: runUrl });
  const merged = await mergePR(pr, null);
  return { pr, merged };
}

// ── Requests (the issue form) ───────────────────────────────────
async function onRequest(issue, { comment, cmd, force = false } = {}) {
  if (issue.state !== 'open') return;
  const author = issue.user.login;
  const by = comment ? comment.user.login : author;
  const admin = comment ? isAdmin(by, comment.author_association) : false;
  const approving = admin && cmd === '/approve';
  const forcing = approving && force;
  const labels = issue.labels.map((l) => l.name);
  const built = P.buildRequest(Q.parseForm(issue.body), author, { sitesOrg: ORG, emuOrg: emuHostingOn ? EMU.org : '' });
  const { name } = built;
  const say = (result, opts) => upsertComment(issue.number, 'request', requestComment(result, { name, domain: R.DOMAIN, ...opts }));

  if (config.locked && !isMaintainer(author) && !approving) {
    await setLabels(issue.number, labels, ['on-hold']);
    return say(null, { locked: config.locked });
  }

  const comments = humans(await gh.all(`${R_}/issues/${issue.number}/comments`));
  const ev = await evaluateRequest({ built, author, comments, labels, overrideHolds: approving, overrideAll: forcing, by });
  if (ev.problems.length) {
    await setLabels(issue.number, labels, ['needs-changes']);
    return say(null, { problems: ev.problems });
  }
  const { file, exists, rc, result } = ev;
  console.log(`request #${issue.number} ${name} by ${author}: ${result.verdict}`);
  if (!comment && ['ready', 'on-hold'].includes(result.verdict)) await notify(`🌱 Request **${name}** by @${author}: ${result.verdict} · ${issue.html_url}`);
  for (const f of result.findings) console.log(`  ${f.level.padEnd(6)} ${f.check}: ${f.text}`);
  await setLabels(issue.number, labels, result.labels);

  if (result.verdict === 'rejected') {
    await say(result, { entry: built.entry, plan: rc.plan });
    await activityLog(`⛔ **Rejected** request #${issue.number} for \`${name}\` by @${author} (automatic)`);
    return close(issue.number, 'not_planned');
  }
  const goLive = result.verdict === 'ready' && (approving || result.autoMerge);
  if (!goLive) {
    if (approving) await reply(issue.number, `@${by} I can't approve this yet: it's **${result.verdict}** (see above).`);
    return say(result, { entry: built.entry, plan: rc.plan });
  }

  if (result.overridden) built.entry.forced = lc(by);
  const { pr, merged } = await botChange({
    title: `${exists ? 'Update' : 'Add'} ${name}`,
    body: `Requested by @${author} in #${issue.number}; ${approving ? `${forcing ? 'force-' : ''}approved by @${by}` : 'auto-approved'}.`,
    changes: [{ file, content: JSON.stringify(built.entry, null, 2) + '\n' }],
    tag: `request-${issue.number}`,
  });
  if (!merged) return say(result, { entry: built.entry, plan: rc.plan });
  const guide = P.setupGuide({ provider: built.provider, name, repo: built.entry.site && built.entry.site.repo, branch: rc.branch, sourceRepo: repo });
  await say(result, { live: true, guide, prUrl: pr.html_url });
  await setLabels(issue.number, result.labels, ['live'], [...MANAGED, 'live']);
  await activityLog(`✅ **${exists ? 'Updated' : 'Added'}** \`${name}.${R.DOMAIN}\` for @${author} · ${approving ? `${forcing ? `force-approved (${result.overridden} overridden)` : 'approved'} by @${by}` : 'auto-approved'} · #${issue.number} → #${pr.number}`);
  return close(issue.number, 'completed');
}

/** Review a request (from an issue or the panel) the same way. `built` is P.buildRequest's output. */
async function evaluateRequest({ built, author, comments = [], labels = [], overrideHolds = false, overrideAll = false, by = '' }) {
  const { entries } = mainTree();
  const { name } = built;
  const problems = [...built.problems];
  const taken = name && entries[name] && R.ownerOf(entries[name]) !== lc(author) && !isMaintainer(author);
  if (taken) problems.push(`\`${name}\` is taken by @${R.ownerOf(entries[name])}. Pick another name, or [ask for it](${repoUrl}/issues/new?template=transfer.yml&title=${encodeURIComponent(`Transfer: ${name}`)}&subdomain=${encodeURIComponent(name)}).`);
  if (problems.length) return { problems, entries };
  const file = `domains/${name}.json`;
  const exists = !!entries[name];
  const head = { ...entries, [name]: built.entry };
  const profile = await gh.get(`/users/${author}`).catch(() => null);
  const rc = await repoChecks(built.entry, author);
  const dns = await checkTargets([built.entry]);
  // A hosted site points at our own org's github.io on purpose.
  const pagesOwners = [...rc.pagesOwners, ...(S.isHosted(built.entry) && ORG ? [lc(ORG)] : [])];
  if (S.isHosted(built.entry) && !exists) {
    const tpl = (S.TEMPLATES.find((t) => t.id === built.entry.site.template) || S.TEMPLATES[0]).label;
    rc.findings.push({ check: 'repo', level: 'info', text: `We'll create a private repo, [${built.entry.site.repo}](https://github.com/${built.entry.site.repo}), from the **${tpl}** template, and invite you` });
    rc.findings.push(...(await hostingGuards(author, entries, profile)));
  }
  const result = review({
    author, profile, changes: [{ status: exists ? 'M' : 'A', file }], base: entries, head, comments, labels, dns,
    reserved, config, maintainers, overrideHolds, overrideAll, by, extra: rc.findings, pagesOwners,
  });
  return { problems: [], entries, file, exists, rc, result };
}

async function onRequestComment(issue, comment, cmd, rest) {
  const by = comment.user.login;
  const admin = isAdmin(by, comment.author_association);
  switch (cmd) {
    case '/approve':
    case '/accept':
    case '/recheck':
      await react(comment.id, 'eyes');
      return onRequest(issue, { comment, cmd, force: cmd === '/approve' && /\bforce\b/i.test(rest) });
    case '/cancel':
      if (lc(issue.user.login) !== lc(by) && !admin) return react(comment.id, 'confused');
      await reply(issue.number, '👋 Cancelled. Open a new request any time.');
      return close(issue.number, 'not_planned');
    case '/reject':
      await setLabels(issue.number, issue.labels.map((l) => l.name), ['rejected']);
      await upsertComment(issue.number, 'request', simpleComment('request', '⛔ Not accepted', rest ? `A maintainer closed this request:\n\n> ${rest}` : 'A maintainer closed this request.'));
      await activityLog(`⛔ **Rejected** request #${issue.number} by @${issue.user.login} · by @${by}${rest ? `: ${rest}` : ''}`);
      return close(issue.number, 'not_planned');
    case '/hold':
      await gh.post(`${R_}/issues/${issue.number}/labels`, { labels: ['manual-hold'] });
      if (rest) await reply(issue.number, `⏸️ On hold: ${rest}`);
      await activityLog(`⏸️ **Held** request #${issue.number} · by @${by}${rest ? `: ${rest}` : ''}`);
      return onRequest({ ...issue, labels: [...issue.labels, { name: 'manual-hold' }] });
    case '/unhold':
      await gh.del(`${R_}/issues/${issue.number}/labels/manual-hold`).catch(() => {});
      return onRequest({ ...issue, labels: issue.labels.filter((l) => l.name !== 'manual-hold') });
    default:
      return reply(issue.number, `\`${cmd}\` doesn't apply here. \`/help\` lists what does.`);
  }
}

// ── Transfers ───────────────────────────────────────────────────
async function onTransfer(issue) {
  if (issue.state !== 'open') return;
  const { entries } = mainTree();
  const form = Q.parseForm(issue.body);
  const to = (form['New owner'] || '').trim().replace(/^@/, '') || issue.user.login;
  const profile = await gh.get(`/users/${to}`).catch(() => null);
  const comments = humans(await gh.all(`${R_}/issues/${issue.number}/comments`));
  const plan = Q.planTransfer({ form, author: issue.user.login, entries, comments, maintainers, config, profile });
  const labels = issue.labels.map((l) => l.name);
  const managed = ['needs-changes', 'on-hold', 'ready'];

  if (plan.problems.length) {
    await setLabels(issue.number, labels, ['needs-changes'], managed);
    return upsertComment(issue.number, 'transfer', simpleComment('transfer', '✏️ This transfer can\'t go ahead yet',
      `${plan.problems.map((p) => `- ${p}`).join('\n')}\n\nEdit the issue to fix it and I'll check again.`));
  }
  if (!plan.ok) {
    await setLabels(issue.number, labels, ['on-hold'], managed);
    const asks = plan.waiting.map((w) => `- @${w.who}, reply \`${w.cmd}\` ${w.why}.`).join('\n');
    const days = config.consentTimeoutDays ?? 30;
    return upsertComment(issue.number, 'transfer', simpleComment('transfer', `⏸️ Transfer of \`${plan.name}\`: waiting for a reply`,
      `**From** @${plan.from} → **to** @${plan.to}\n\n${asks}\n\nIf the current owner doesn't answer within ${days} days, a maintainer can approve it instead.`));
  }

  await setLabels(issue.number, labels, ['ready'], managed);
  const { pr, merged } = await botChange({
    title: `Transfer ${plan.name} to @${plan.to}`,
    body: `Transfer of \`${plan.name}\` from @${plan.from} to @${plan.to}, approved by both in #${issue.number}.`,
    changes: plan.changes,
    tag: `transfer-${issue.number}`,
  });
  await upsertComment(issue.number, 'transfer', simpleComment('transfer', merged ? '🎉 Transferred' : '✅ Approved: waiting for a maintainer to merge',
    `\`${plan.name}\` ${merged ? 'now belongs to' : 'will belong to'} @${plan.to} (#${pr.number}). The DNS records stay the same; [open a request](${repoUrl}/issues/new?template=request.yml&subdomain=${plan.name}) to point it somewhere else.`));
  if (merged) {
    await activityLog(`🔁 **Transferred** \`${plan.name}\` from @${plan.from} to @${plan.to} · #${issue.number} → #${pr.number}`);
    await close(issue.number);
  }
}

// ── Removals & takedowns ────────────────────────────────────────
async function removeName({ name, entries, why, issue, by }) {
  const changes = Q.takedownChanges(entries, name);
  const { pr, merged } = await botChange({
    title: `Remove ${name}`,
    body: `Removes \`${name}\`${changes.length > 1 ? ' and everything under it' : ''}: ${why}${issue ? ` (#${issue})` : ''}.`,
    changes,
    tag: `remove-${name}-${Date.now().toString(36)}`,
  });
  if (merged) await activityLog(`🧹 **Removed** \`${name}\` (owner @${R.ownerOf(entries[name])}) · ${why}${by ? ` · by @${by}` : ''}${issue ? ` · #${issue}` : ''} → #${pr.number}`);
  return { pr, merged };
}

async function onTakedown(issue, comment, cmd, rest) {
  if (issue.state !== 'open') return;
  const { entries } = mainTree();
  const form = Q.parseForm(issue.body);
  const plan = Q.planTakedown({ form, author: issue.user.login, entries });
  const by = comment ? comment.user.login : issue.user.login;
  const admin = comment ? isAdmin(by, comment.author_association) : isMaintainer(by);

  if (cmd === '/dismiss') {
    await upsertComment(issue.number, 'takedown', simpleComment('takedown', 'Closed without changes', rest ? `> ${rest}` : 'A maintainer reviewed this and is leaving the subdomain up.'));
    await activityLog(`🗂️ **Dismissed** report #${issue.number} about \`${plan.name}\` · by @${by}${rest ? `: ${rest}` : ''}`);
    return close(issue.number, 'not_planned');
  }
  if (plan.problems.length) {
    return upsertComment(issue.number, 'takedown', simpleComment('takedown', '✏️ Can\'t find that subdomain', plan.problems.join('\n')));
  }
  const done = async (why) => {
    const { pr, merged } = await removeName({ name: plan.name, entries, why, issue: issue.number, by });
    await upsertComment(issue.number, 'takedown', simpleComment('takedown', merged ? '🧹 Removed' : '✅ Approved: waiting for a maintainer to merge',
      `\`${plan.name}.${R.DOMAIN}\` ${merged ? 'is gone; DNS updates in a few minutes' : 'will be removed'} (#${pr.number}).`));
    if (merged) await close(issue.number);
  };
  if (cmd === '/takedown') {
    const owns = lc(by) === plan.owner || (plan.byOwner && lc(by) === lc(issue.user.login));
    if (!admin && !owns) return react(comment.id, 'confused');
    await react(comment.id, 'rocket');
    return done(admin ? `taken down by a maintainer${rest ? `: ${rest}` : ''}` : 'removed by its owner');
  }
  if (plan.byOwner && !comment) return done('removed by its owner');
  if (comment) return;

  // A report: summarize it for the maintainers and let the owner know.
  const r = plan.records || {};
  const target = typeof r.CNAME === 'string' ? r.CNAME : (r.A || r.AAAA || []).join(', ') || '(TXT/MX only)';
  const live = await verifySite(`${plan.name}.${R.DOMAIN}`);
  const alive = live.status ? `HTTP ${live.status}${live.title ? ` · “${live.title}”` : ''}` : live.error ? `❌ ${live.error}` : '❌ no DNS answer';
  const label = { phishing: 'abuse', malware: 'abuse', impersonation: 'abuse', dangling: 'dangling' }[plan.reason];
  if (label) await gh.post(`${R_}/issues/${issue.number}/labels`, { labels: [label] });
  await upsertComment(issue.number, 'takedown', simpleComment('takedown', `🚩 Report for \`${plan.name}\``,
    `| | |\n|---|---|\n| **Owner** | @${plan.owner} |\n| **Points at** | \`${target}\` |\n| **Right now** | ${alive} |\n| **Reason** | ${Q.TAKEDOWN_REASONS[plan.reason]} |\n\n` +
    `@${plan.owner}, someone reported your subdomain. If you'd like to respond, comment here.\n\n` +
    `**Maintainers:** \`/takedown <note>\` removes it (and anything under it) right away; \`/dismiss <reason>\` closes this report.`));
  await activityLog(`🚩 **Report** #${issue.number} about \`${plan.name}\` (${Q.TAKEDOWN_REASONS[plan.reason]})`);
  await notify(`🚩 Report about **${plan.name}** (${Q.TAKEDOWN_REASONS[plan.reason]}) · ${issue.html_url}`);
}

// ── Commands that work anywhere ─────────────────────────────────
/** Returns markdown to post, or undefined if `cmd` isn't one of these. */
async function anywhereCommand({ cmd, args, rest, by, admin, number, kind, form }) {
  const entriesNow = () => mainTree().entries;
  switch (cmd) {
    case '/help':
      return `### 🤖 Commands\n\n${C.helpTable({ admin: true })}`;
    case '/available':
      return C.availability(args[0] || (form && form['Subdomain']), entriesNow(), reserved, { repoUrl });
    case '/whois':
      return C.whois(args[0] || (form && form['Subdomain']), entriesNow(), { repoUrl });
    case '/mine':
      return C.mine(by, entriesNow(), config);
    case '/stats': {
      const open = await gh.all(`${R_}/issues?labels=request&state=open`).then((l) => l.length, () => undefined);
      return C.stats(entriesNow(), { openRequests: open });
    }
    case '/verify': {
      const name = Q.cleanName(args[0] || (form && form['Subdomain']) || '');
      if (!name) return 'Usage: `/verify <name>`';
      const v = await verifySite(`${name}.${R.DOMAIN}`);
      const dnsCell = v.dns.length ? v.dns.slice(0, 4).map((d) => `\`${d}\``).join('<br>') + (v.dns.length > 4 ? '<br>…' : '') : '❌ no answer';
      const https = v.status ? `${v.status < 400 ? '✅' : '⚠️'} HTTP ${v.status}${v.title ? ` · “${v.title}”` : ''}${v.ms !== null ? ` · ${v.ms} ms` : ''}` : v.error ? `❌ ${v.error}` : '—';
      return `### 🔎 \`${name}.${R.DOMAIN}\`\n\n| | |\n|---|---|\n| **DNS** | ${dnsCell} |\n| **HTTPS** | ${https} |${v.hint ? `\n\n> 💡 ${v.hint}` : ''}`;
    }
    case '/transfer': {
      const name = Q.cleanName(args[0] || '');
      const to = String(args[1] || '').replace(/^@/, '');
      if (!name) return 'Usage: `/transfer <name> @user`';
      const link = `${repoUrl}/issues/new?template=transfer.yml&title=${encodeURIComponent(`Transfer: ${name}`)}&subdomain=${encodeURIComponent(name)}${to ? `&new_owner=${encodeURIComponent(to)}` : ''}`;
      return `🔁 [**Start the transfer of \`${name}\`${to ? ` to @${to}` : ''} →**](${link}) (pre-filled; just press *Create*).`;
    }
    case '/txt': {
      if (kind === 'discussion') return undefined;
      if (args.length < 3) return 'Usage: `/txt <name> <label> <value>`, e.g. `/txt alice _vercel vc-domain-verify=alice.awesomeprojects.tech,abc123`';
      const entries = entriesNow();
      const name = Q.cleanName(args[0]);
      const label = lc(args[1]).replace(/\.$/, '').replace(new RegExp(`\\.?${name}$`), '');
      const value = args.slice(2).join(' ');
      if (!entries[name]) return `\`${name}\` isn't registered.`;
      if (R.baseOf(name) !== name) return `Use the top-level name: \`/txt ${R.baseOf(name)} ${label}.${name.split('.').slice(0, -1).join('.')} …\``;
      const nameOwner = R.ownerOf(entries[name]);
      if (nameOwner !== lc(by) && !admin) return `Only @${nameOwner} can add records under \`${name}\`.`;
      if (!label || !label.split('.').every((l) => /^_?[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/.test(l))) return `\`${label}\` isn't a valid label. Examples: \`_vercel\`, \`_github-pages-challenge-${by}\`, \`s1._domainkey\`.`;
      const full = `${label}.${name}`;
      const existing = entries[full];
      if (existing && existing.records && existing.records.CNAME) return `\`${full}\` has a CNAME, so it can't have TXT records too.`;
      const txts = existing ? [].concat(existing.records.TXT || []) : [];
      if (txts.includes(value)) return `\`${full}\` already has that value.`;
      const entry = existing
        ? { ...existing, records: { ...existing.records, TXT: [...txts, value] } }
        : { owner: { github: nameOwner }, description: 'Verification record', records: { TXT: value } };
      const errs = [...R.checkName(full, reserved), ...R.checkEntry(full, entry)];
      if (errs.length) return `Can't add it: ${errs.join('; ')}`;
      const { pr, merged } = await botChange({
        title: `Add TXT ${full}`, body: `\`/txt\` by @${by}${number ? ` in #${number}` : ''}.`,
        changes: [{ file: `domains/${full}.json`, content: JSON.stringify(entry, null, 2) + '\n' }],
        tag: `txt-${full}-${Date.now().toString(36)}`,
      });
      if (!merged) return `I opened #${pr.number} but couldn't merge it. A maintainer will.`;
      await activityLog(`🔐 **TXT added** \`${full}\` · by @${by} → #${pr.number}`);
      return `✅ Added \`TXT\` at \`${full}.${R.DOMAIN}\` (#${pr.number}). It's live in a minute or two.`;
    }
    case '/remove': {
      if (kind === 'discussion') return undefined;
      const entries = entriesNow();
      const name = Q.cleanName(args[0] || '');
      if (!name || !entries[name]) return name ? `\`${name}\` isn't registered.` : 'Usage: `/remove <name>`';
      const mineOrParent = R.ownerOf(entries[name]) === lc(by) || (R.baseOf(name) !== name && R.ownerOf(entries[R.baseOf(name)]) === lc(by));
      if (!mineOrParent && !admin) return `Only its owner can remove \`${name}\`. To report it, [open a takedown](${repoUrl}/issues/new?template=takedown.yml&subdomain=${encodeURIComponent(name)}).`;
      const { pr, merged } = await removeName({ name, entries, why: mineOrParent ? 'removed by its owner' : 'removed by a maintainer', issue: number, by });
      return merged ? `🧹 Removed \`${name}.${R.DOMAIN}\` (#${pr.number}).` : `I opened #${pr.number} but couldn't merge it.`;
    }
    case '/takedown': {
      if (kind === 'report' && !args.length) return undefined; // handled by the report
      if (kind === 'discussion') return undefined;
      if (!admin) return undefined;
      const entries = entriesNow();
      const name = Q.cleanName(args[0] || '');
      if (!name || !entries[name]) return name ? `\`${name}\` isn't registered.` : 'Usage: `/takedown <name> <note>`';
      const note = args.slice(1).join(' ');
      const { pr, merged } = await removeName({ name, entries, why: `taken down by a maintainer${note ? `: ${note}` : ''}`, issue: number, by });
      return merged ? `🧹 Took down \`${name}.${R.DOMAIN}\` (#${pr.number}).` : `I opened #${pr.number} but couldn't merge it.`;
    }
    case '/ban': case '/unban': case '/limit': case '/reserve': case '/unreserve': case '/lock': case '/unlock': case '/promote': case '/demote': case '/config': case '/announce': {
      if (kind === 'discussion') return undefined;
      const current = { config: JSON.parse(mainFile('config.json')), reserved: JSON.parse(mainFile('reserved.json')) };
      const edit = C.adminEdit(cmd, args, { ...current, entries: mainTree().entries, owner });
      if (edit.error) return edit.error;
      const changes = [];
      if (edit.config) changes.push({ file: 'config.json', content: JSON.stringify(edit.config, null, 2) + '\n' });
      if (edit.reserved) changes.push({ file: 'reserved.json', content: JSON.stringify(edit.reserved, null, 2) + '\n' });
      const { pr, merged } = await botChange({ title: `${cmd} ${rest}`.trim().slice(0, 80), body: `\`${cmd} ${rest}\` by @${by}${number ? ` in #${number}` : ''}.`, changes, tag: `admin-${cmd.slice(1)}-${Date.now().toString(36)}` });
      if (!merged) return `I opened #${pr.number} but couldn't merge it.`;
      await activityLog(`${edit.message} · by @${by} → #${pr.number}`);
      let extra = '';
      if ((cmd === '/promote' || cmd === '/demote') && ORG && ghBot) {
        extra = await syncTeam(edit.config.maintainers).then((t) => `\n\n✅ ${t}`, (e) => `\n\n⚠️ couldn't update the ${ORG} team: ${e.message}`);
      }
      return `${edit.message} (#${pr.number}).${extra}`;
    }
    case '/site': {
      if (kind === 'discussion') return undefined;
      const name = Q.cleanName(args[0] || '');
      const status = lc(args[1]);
      if (!name || !status) return 'Usage: `/site <name> <active|locked|suspended|archived>`';
      return setSiteStatus(name, status, by);
    }
    case '/site-sync': {
      if (kind === 'discussion') return undefined;
      needOrg();
      const name = Q.cleanName(args[0] || '');
      const d = mainTree().entries[name];
      if (!d || !S.isHosted(d)) return `\`${name}\` isn't a hosted site.`;
      const res = await provisionSite(name, d, { rewriteWorkflow: true });
      await activityLog(`🔄 **Re-synced** [${res.full}](https://github.com/${res.full}) · by @${by}`);
      return `🔄 [${res.full}](https://github.com/${res.full}) is back to standard:\n\n${res.lines.join('\n')}`;
    }
    case '/repo-access': {
      if (kind === 'discussion') return undefined;
      const name = Q.cleanName(args[0] || '');
      const u = String(args[1] || '').replace(/^@/, '');
      if (!name || !u || !args[2]) return 'Usage: `/repo-access <name> @user <read|write|maintain|none>`';
      return repoAccessCmd(name, u, lc(args[2]), by);
    }
    case '/redeploy': {
      if (kind === 'discussion') return undefined;
      needHosting();
      const name = Q.cleanName(args[0] || '');
      const d = mainTree().entries[name];
      if (!d || !S.isHosted(d)) return `\`${name}\` isn't a hosted site.`;
      if (R.ownerOf(d) !== lc(by) && !admin) return `Only @${R.ownerOf(d)} can redeploy \`${name}\`.`;
      if (S.statusOf(d) !== 'active') return `\`${name}\` is ${S.statusOf(d)}, so it can't be redeployed.`;
      await apiFor(d.site.repo).post(`/repos/${d.site.repo}/actions/workflows/deploy.yml/dispatches`, { ref: 'main' });
      await activityLog(`🚀 **Redeploy** \`${name}\` · by @${by}`);
      return `🚀 Redeploying \`${name}.${R.DOMAIN}\`: [watch it](https://github.com/${d.site.repo}/actions). Live in about a minute.`;
    }
    case '/site-collab': {
      if (kind === 'discussion') return undefined;
      needHosting();
      const name = Q.cleanName(args[0] || '');
      const u = lc(String(args[1] || '').replace(/^@/, ''));
      const op = lc(args[2] || 'add');
      const d = mainTree().entries[name];
      if (!d || !S.isHosted(d)) return `\`${name}\` isn't a hosted site.`;
      const siteOwner = R.ownerOf(d);
      if (siteOwner !== lc(by) && !admin) return `Only @${siteOwner} can change who works on \`${name}\`.`;
      if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/.test(u) || u === siteOwner) return 'Usage: `/site-collab <name> @user <add|remove>`';
      const full = d.site.repo;
      if (op === 'remove') {
        await applyAccess(full, u, 'archived');
        await activityLog(`👥 **Collaborator removed** @${u} from [${full}](https://github.com/${full}) · by @${by}`);
        return `👥 @${u} no longer has access to \`${name}\`.`;
      }
      if (S.statusOf(d) !== 'active') return `\`${name}\` is ${S.statusOf(d)}, so nobody new can be added.`;
      if ((config.bannedUsers || []).map(lc).includes(u)) return `@${u} isn't allowed here.`;
      const rapi = apiFor(full);
      const ownerIn = lc(loginIn(full, siteOwner));
      const current = (await rapi.all(`/repos/${full}/collaborators?affiliation=${collabAffiliation(full)}`).catch(() => [])).map((c) => lc(c.login)).filter((x) => x !== ownerIn);
      const pending = (await rapi.all(`/repos/${full}/invitations`).catch(() => [])).map((i) => lc(i.invitee && i.invitee.login)).filter((x) => x && x !== ownerIn);
      const max = config.maxCollaboratorsPerSite ?? 2;
      if (!admin && new Set([...current, ...pending]).size >= max) return `\`${name}\` already has ${max} collaborator${max === 1 ? '' : 's'} (the limit). Remove one first.`;
      const seats = await seatUsage();
      if (!admin && seats.max && !seated(seats, u) && seats.used >= seats.max) return `Hosting is full right now (${seats.used}/${seats.max} seats), so new collaborators need a maintainer.`;
      if (isEmuRepo(full)) {
        // Managed enterprise: they get (or keep) a managed account, then direct write access. No invite to accept.
        const profile = await gh.get(`/users/${u}`).catch(() => null);
        if (!profile) return `@${u} isn't a GitHub account.`;
        const acct = await emuProvision(profile.login, profile.id, by);
        await rapi.put(`/repos/${full}/collaborators/${acct.managed}`, { permission: S.collaboratorRole(await haveRoles(full)) });
        await activityLog(`👥 **Collaborator added** @${u} (${acct.managed}) to [${full}](https://github.com/${full}) · by @${by}`);
        return `👥 @${u} can now push to [${full}](https://github.com/${full}) as **${acct.managed}**. They sign in at https://github.com/enterprises/${EMU.enterprise}/sso with their GitHub account.`;
      }
      await rapi.put(`/repos/${full}/collaborators/${u}`, { permission: S.collaboratorRole(await haveRoles(full)) });
      await activityLog(`👥 **Collaborator added** @${u} to [${full}](https://github.com/${full}) · by @${by}`);
      return `👥 Invited @${u} to [${full}](https://github.com/${full}) with write access. They need to accept the invite.`;
    }
    case '/suspend-user': {
      if (kind === 'discussion') return undefined;
      const u = lc(String(args[0] || '').replace(/^@/, ''));
      if (!u) return 'Usage: `/suspend-user @user <reason>`';
      if (isMaintainer(u)) return 'Demote them first.';
      const lines = [];
      const current = { config: JSON.parse(mainFile('config.json')), reserved: JSON.parse(mainFile('reserved.json')) };
      const ban = C.adminEdit('/ban', args, current);
      if (!ban.error) {
        const { merged, pr } = await botChange({ title: `/ban @${u}`, body: `\`/suspend-user\` by @${by}.`, changes: [{ file: 'config.json', content: JSON.stringify(ban.config, null, 2) + '\n' }], tag: `suspend-${u}-${Date.now().toString(36)}` });
        lines.push(merged ? `🔨 banned (#${pr.number})` : `⚠️ couldn't merge the ban (#${pr.number})`);
      } else lines.push(`ℹ️ ${ban.error}`);
      const { entries } = mainTree();
      for (const [name, d] of Object.entries(entries)) {
        if (!S.isHosted(d) || R.ownerOf(d) !== u || ['suspended', 'archived'].includes(S.statusOf(d))) continue;
        lines.push(await setSiteStatus(name, 'suspended', by).then((m) => `⏸️ \`${name}\`: ${m.split('\n')[0]}`, (e) => `⚠️ \`${name}\`: ${e.message}`));
      }
      if (EMU.enterprise && ghEmu) lines.push(await emuSetActive(u, false, by).catch((e) => `⚠️ managed account: ${e.message}`));
      await activityLog(`🚫 **Suspended user** @${u} · by @${by}${args.length > 1 ? `: ${args.slice(1).join(' ')}` : ''}`);
      await notify(`🚫 Suspended @${u} (by @${by})`);
      return `### 🚫 @${u} suspended\n\n${lines.map((l) => `- ${l}`).join('\n') || '- nothing else to do'}`;
    }
    case '/create': {
      if (kind === 'discussion') return undefined;
      const force = args.some((a) => lc(a) === 'force');
      const rest2 = args.filter((a) => lc(a) !== 'force');
      const [nm, who, host, extra] = rest2;
      if (!nm || !who || !host) return 'Usage: `/create <name> @user <host> [target|repo|template] [force]`';
      const alias = HOST_ALIASES[lc(host)] || lc(host);
      const r = await createFor({
        name: nm, owner: who, provider: alias, force,
        repo: alias === 'github-pages' ? extra || '' : '',
        template: alias === 'hosted' ? extra || '' : '',
        target: !['github-pages', 'hosted', 'vercel'].includes(alias) ? rest2.slice(3).join(' ') : '',
      }, by);
      return r.message;
    }
    case '/emu-create': case '/emu-suspend': case '/emu-restore': {
      if (kind === 'discussion') return undefined;
      const u = String(args[0] || '').replace(/^@/, '');
      if (!u) return `Usage: \`${cmd} @user\``;
      if (cmd === '/emu-create') {
        const profile = await gh.get(`/users/${u}`).catch(() => null);
        if (!profile) return `@${u} isn't a GitHub account.`;
        return (await emuProvision(profile.login, profile.id, by)).message;
      }
      return emuSetActive(u, cmd === '/emu-restore', by);
    }
    case '/make-repo': {
      if (kind === 'discussion') return undefined;
      return makeRepo(args[0], args[1], args[2], by);
    }
    case '/ops':
      if (kind === 'discussion') return undefined;
      return ops({ by: `@${by}` });
    case '/seats': {
      if (kind === 'discussion') return undefined;
      const st = await seatUsage();
      const where = [ORG && `classic \`${ORG}\``, EMU.org && `managed \`${EMU.org}\``].filter(Boolean).join(' + ') || '(no hosting org)';
      return `### 💺 Seats (${where})\n\n**${st.used}**${st.max ? ` of ${st.max}` : ''} seats on hosted sites${st.people.length ? `: ${st.people.map((p) => `@${p}`).join(', ')}` : ''}.`;
    }
    case '/org-setup': {
      if (kind === 'discussion') return undefined;
      const out = await orgSetup();
      const which = [ORG, EMU.org].filter(Boolean).join(' + ') || '(none)';
      await activityLog(`🏗️ **Org setup** ${which} · by @${by}`);
      return out;
    }
    case '/bot-check':
      if (kind === 'discussion') return undefined;
      return botCheck();
    case '/deploy':
      await deploy();
      await activityLog(`🚀 **Deploy** started · by @${by}`);
      return `🚀 Deploying DNS and the website now. [Watch it](${repoUrl}/actions).`;
    case '/health': {
      const n = await health();
      return n ? `🩺 ${n} name${n === 1 ? '' : 's'} point at nothing. See the [health issue](${repoUrl}/issues?q=is%3Aopen+label%3Ahealth).` : '🩺 Everything resolves.';
    }
    default:
      return undefined;
  }
}

async function onIssueComment(issue, comment) {
  const parsed = C.parseCommand(comment.body);
  if (!parsed) return;
  try {
    return await runIssueCommand(issue, comment, parsed);
  } catch (e) {
    // Never fail silently: say what broke, where it can be seen.
    console.error(e);
    await react(comment.id, 'confused');
    await reply(issue.number, `⚠️ @${comment.user.login}, \`${parsed.cmd}\` failed: ${String(e.message).split('\n')[0].slice(0, 300)}${runUrl ? ` ([log](${runUrl}))` : ''}. Nothing was changed; try again, or tell a maintainer.`).catch(() => {});
    throw e;
  }
}

async function runIssueCommand(issue, comment, parsed) {
  const { cmd, args, rest } = parsed;
  const by = comment.user.login;
  const admin = isAdmin(by, comment.author_association);
  const labels = issue.labels.map((l) => l.name);
  const kind = issue.pull_request ? 'pr' : labels.includes('request') ? 'request' : labels.includes('transfer') ? 'transfer' : labels.includes('takedown') ? 'report' : 'issue';

  if (C.ADMIN_ONLY.has(cmd) && !admin) {
    await react(comment.id, 'confused');
    return reply(issue.number, `@${by} \`${cmd}\` is for maintainers.`);
  }
  if (C.OWNER_ONLY.has(cmd) && lc(by) !== lc(owner) && comment.author_association !== 'OWNER') {
    await react(comment.id, 'confused');
    return reply(issue.number, `@${by} \`${cmd}\` is for the owner, @${owner}.`);
  }
  const form = kind === 'request' || kind === 'report' ? Q.parseForm(issue.body) : null;
  const text = await anywhereCommand({ cmd, args, rest, by, admin, number: issue.number, kind, form });
  if (text !== undefined) { await react(comment.id, 'eyes'); return reply(issue.number, text); }

  if (kind === 'pr') return onPullRequestComment(issue.number, comment, cmd, rest);
  if (kind === 'request') return onRequestComment(issue, comment, cmd, rest);
  if (kind === 'transfer' && ['/approve', '/accept', '/recheck'].includes(cmd)) { await react(comment.id, 'eyes'); return onTransfer(issue); }
  if (kind === 'report' && ['/takedown', '/dismiss'].includes(cmd)) return onTakedown(issue, comment, cmd, rest);
  return reply(issue.number, `\`${cmd}\` doesn't apply here. \`/help\` lists what does.`);
}

async function onDiscussionComment({ comment, discussion }) {
  if (comment.user.type === 'Bot') return;
  const parsed = C.parseCommand(comment.body);
  if (!parsed) return;
  const answer = C.READ_ONLY.has(parsed.cmd)
    ? await anywhereCommand({ ...parsed, by: comment.user.login, admin: false, kind: 'discussion' })
    : `\`${parsed.cmd}\` works in issues and pull requests. Here I can answer \`/help\`, \`/available\`, \`/whois\`, \`/mine\`, \`/verify\` and \`/stats\`.`;
  await gh.graphql(`mutation($d:ID!,$b:String!,$r:ID){addDiscussionComment(input:{discussionId:$d,body:$b,replyToId:$r}){comment{id}}}`,
    { d: discussion.node_id, b: answer, r: comment.parent_id ? null : comment.node_id });
}

// ── Weekly health check ─────────────────────────────────────────
async function health() {
  const { entries } = mainTree();
  const dns = await checkTargets(Object.values(entries));
  const dead = Object.entries(entries).filter(([, d]) => {
    const c = d.records && d.records.CNAME;
    return typeof c === 'string' && dns[c.toLowerCase().replace(/\.$/, '')] === false;
  });
  const open = await gh.get(`${R_}/issues?labels=health&state=open`);
  const issue = open[0];
  console.log(`health: ${dead.length} dangling of ${Object.keys(entries).length}`);
  if (!dead.length) {
    if (issue) { await reply(issue.number, '✅ Everything resolves now.'); await close(issue.number); }
    return 0;
  }
  const rows = dead.map(([n, d]) => `| \`${n}\` | @${R.ownerOf(d)} | \`${d.records.CNAME}\` |`).join('\n');
  const body = `${MARK('health')}\nThese subdomains point at hostnames that don't exist. Someone else could claim the target and take the name over, so please fix or remove yours.\n\n| Subdomain | Owner | Points at |\n|---|---|---|\n${rows}\n\n` +
    `Owners: [open a request](${repoUrl}/issues/new?template=request.yml) with the new target, or comment \`/remove <name>\`. Maintainers can remove leftovers after ${config.consentTimeoutDays ?? 30} days with \`/takedown <name>\`.\n\n_Last checked ${new Date().toISOString().slice(0, 10)}._`;
  if (issue) await gh.patch(`${R_}/issues/${issue.number}`, { body });
  else await gh.post(`${R_}/issues`, { title: '🩺 Subdomains pointing at nothing', body, labels: ['health'] });
  return dead.length;
}

// ── Notifications (optional Discord webhook) ───────────────────
async function notify(text) {
  const hook = String(process.env.DISCORD_WEBHOOK || '').trim();
  if (!hook || dryRun) return;
  await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: String(text).slice(0, 1900), allowed_mentions: { parse: [] } }) })
    .catch((e) => console.warn(`discord: ${e.message}`));
}

// ── Hosted sites: repos in the sites org ───────────────────────
function needOrg() {
  if (!ORG) throw new Error('`sitesOrg` isn\'t set in config.json.');
  if (!ghBot) throw new Error('The `BOT_PAT` secret isn\'t set.');
}
/** Hosting works if either org is set up (classic sites org, or managed org + SCIM + org-owner BOT_PAT). */
function needHosting() {
  if ((ORG && ghBot) || emuHostingOn) return;
  if (EMU.org && ghEmu && !ghBot) throw new Error('The `BOT_PAT` secret isn\'t set (needs a provisioned owner of the managed org — the setup user can\'t join orgs).');
  if (EMU.org && !ghEmu) throw new Error('The `EMU_ADMIN_TOKEN` secret isn\'t set (setup user, SCIM only).');
  needOrg();
}
const ok = (t) => `✅ ${t}`;
const warn = (t) => `⚠️ ${t}`;
async function step(lines, label, fn) {
  try { const r = await fn(); lines.push(ok(r || label)); } catch (e) { lines.push(warn(`${label}: ${String(e.message).slice(0, 200)}`)); }
}

/** Seats used by hosted sites = outside collaborators in the sites org (each is an enterprise seat). */
async function seatUsage() {
  const people = [
    ...(ORG && ghBot ? (await ghBot.all(`/orgs/${ORG}/outside_collaborators`).catch(() => [])).map((u) => lc(u.login)) : []),
    // Managed users are seats too (listed via the org-owner token; setup user isn't in the org).
    ...(EMU.org && ghBot ? (await ghBot.all(`/orgs/${EMU.org}/members`).catch(() => [])).map((u) => lc(u.login)) : []),
  ];
  return { used: people.length, max: config.maxSeats || 0, people };
}
/** Does this person already hold a seat (as themselves, or as their managed account)? */
const seated = (seats, personal) => seats.people.includes(lc(personal)) || (!!EMU.shortcode && seats.people.includes(lc(managedLoginOf(personal))));

/** Cost and safety guards before we create a hosted site for someone. */
async function hostingGuards(author, entries, profile) {
  if (isMaintainer(author)) return [];
  const out = [];
  const mine = Object.values(entries).filter((d) => S.isHosted(d) && R.ownerOf(d) === lc(author) && S.statusOf(d) !== 'archived').length;
  const per = config.hostedPerOwner ?? 1;
  if (mine >= per) out.push({ check: 'repo', level: 'error', text: `You already have ${mine} hosted site${mine === 1 ? '' : 's'} (the limit is ${per}). Point this name somewhere else, or archive one first.` });
  const minAge = config.hostedMinAccountAgeDays ?? 30;
  if (profile && (Date.now() - Date.parse(profile.created_at)) / 86400e3 < minAge) {
    out.push({ check: 'repo', level: 'hold', text: `Hosting needs a GitHub account at least ${minAge} days old, so a maintainer will take a look.`, waitingFor: 'maintainer', label: 'new-account' });
  }
  const seats = await seatUsage();
  if (seats.max && !seated(seats, author) && seats.used >= seats.max) {
    out.push({ check: 'repo', level: 'hold', text: `Hosting is full right now (${seats.used}/${seats.max} seats). A maintainer will decide.`, waitingFor: 'maintainer', label: 'seats' });
  }
  return out;
}

/** Is the bot's token what we think? (owner command) */
async function botCheck() {
  const emuLine = await emuCheck();
  const lines = ['### 🤖 Bot check', ''];
  if (!ORG) lines.push('**Classic sites org:** off (`sitesOrg` is empty).', '');
  if (!ghBot) {
    lines.push(EMU.org
      ? '**`BOT_PAT`:** ❌ not set. Use a **provisioned** owner of `' + EMU.org + '` (the setup user can\'t join orgs).'
      : '**`BOT_PAT`:** ❌ not set.');
    lines.push('', emuLine);
    return lines.join('\n');
  }
  const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${String(process.env.BOT_PAT).trim()}`, 'User-Agent': 'awesomeprojects-bot' } });
  if (!res.ok) return `❌ GitHub rejected \`BOT_PAT\` (${res.status}). Create a new token and set it again.\n\n${emuLine}`;
  const me = await res.json();
  const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const want = ['repo', 'workflow', 'admin:org'];
  const missing = want.filter((w) => !scopes.includes(w) && !(w === 'admin:org' && scopes.includes('write:org')));
  const extra = scopes.filter((x) => ['delete_repo', 'admin:enterprise', 'site_admin'].includes(x));
  const orgRows = [];
  if (ORG) {
    const m = await ghBot.get(`/user/memberships/orgs/${ORG}`).catch(() => null);
    orgRows.push(`| **In ${ORG}** | ${m ? `${m.role === 'admin' ? '✅ owner' : `⚠️ ${m.role}`} (${m.state})` : '❌ not a member'} |`);
  }
  if (EMU.org) {
    const m = await ghBot.get(`/user/memberships/orgs/${EMU.org}`).catch(() => null);
    const managed = EMU.shortcode && String(me.login).toLowerCase().endsWith(`_${lc(EMU.shortcode)}`);
    orgRows.push(`| **In ${EMU.org}** | ${m ? `${m.role === 'admin' ? '✅ owner' : `⚠️ ${m.role}`} (${m.state})` : '❌ not a member'} |`);
    orgRows.push(`| **Managed login** | ${managed ? '✅' : '⚠️ expected a provisioned `*_'+lc(EMU.shortcode)+'` account (setup user can\'t own the org)'} |`);
  }
  lines.push(
    '| | |',
    '|---|---|',
    `| **BOT_PAT account** | @${me.login} |`,
    `| **Scopes** | ${scopes.map((x) => `\`${x}\``).join(' ') || '(fine-grained token)'} |`,
    `| **Missing** | ${missing.length ? missing.map((x) => `❌ \`${x}\``).join(' ') : '✅ none'} |`,
    `| **Riskier than needed** | ${extra.length ? extra.map((x) => `⚠️ \`${x}\``).join(' ') : '✅ no'} |`,
    ...orgRows,
    '',
    emuLine,
  );
  return lines.join('\n');
}
/** The managed enterprise's setup-user token: right account, right scopes, SCIM reachable. */
async function emuCheck() {
  if (!EMU.enterprise) return '**Managed accounts:** off (`emu` isn\'t set in config.json).';
  if (!process.env.EMU_ADMIN_TOKEN) return '**Managed accounts:** ❌ the `EMU_ADMIN_TOKEN` secret isn\'t set.';
  const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${String(process.env.EMU_ADMIN_TOKEN).trim()}`, 'User-Agent': 'awesomeprojects-bot' } });
  if (!res.ok) return `**Managed accounts:** ❌ GitHub rejected \`EMU_ADMIN_TOKEN\` (${res.status}).`;
  const me = await res.json();
  const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim());
  const missing = ['scim:enterprise', 'admin:org', 'repo', 'workflow'].filter((x) => !scopes.includes(x));
  const scim = await ghEmu.get(`/scim/v2/enterprises/${EMU.enterprise}/Users?count=1`).then(
    (r) => `✅ ${r.totalResults} managed account${r.totalResults === 1 ? '' : 's'}`,
    (e) => {
      const msg = String(e.message || e);
      if (/Open SCIM|Azure AD, Okta, or Ping/i.test(msg)) {
        return '❌ enable **Open SCIM configuration** (Enterprise → Identity provider → Single sign-on configuration)';
      }
      return `❌ ${msg.slice(0, 120)}`;
    },
  );
  const cf = process.env.CLOUDFLARE_PAGES_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID ? '✅ set' : '❌ `CLOUDFLARE_PAGES_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` missing';
  return [
    `**Managed accounts** (enterprise \`${EMU.enterprise}\`, org \`${EMU.org}\`)`,
    '',
    '| | |',
    '|---|---|',
    `| **Setup user** | ${me.login}${me.login === `${lc(EMU.shortcode)}_admin` ? ' ✅' : ' ⚠️ expected the setup user'} |`,
    `| **Missing scopes** | ${missing.length ? missing.map((x) => `❌ \`${x}\``).join(' ') : '✅ none'} |`,
    `| **SCIM** | ${scim} |`,
    `| **Cloudflare Pages** | ${cf} |`,
  ].join('\n');
}

/** The maintainers team = config maintainers (it gives them access to every site repo). */
async function syncTeam(maintainersList) {
  needOrg();
  const slug = S.TEAM.slug;
  await ghBot.get(`/orgs/${ORG}/teams/${slug}`).catch(() => ghBot.post(`/orgs/${ORG}/teams`, { name: S.TEAM.name, privacy: 'closed', description: 'awesomeprojects.tech maintainers: maintain access to every site repo' }));
  const want = new Set((maintainersList || []).map(lc));
  const have = new Set((await ghBot.all(`/orgs/${ORG}/teams/${slug}/members`).catch(() => [])).map((u) => lc(u.login)));
  const botLogin = lc((await ghBot.get('/user')).login);
  const changes = [];
  for (const u of want) if (!have.has(u)) { await ghBot.put(`/orgs/${ORG}/teams/${slug}/memberships/${u}`, { role: 'member' }); changes.push(`+@${u}`); }
  for (const u of have) if (!want.has(u) && u !== botLogin) { await ghBot.del(`/orgs/${ORG}/teams/${slug}/memberships/${u}`); changes.push(`−@${u}`); }
  return changes.length ? `maintainers team: ${changes.join(' ')}` : 'maintainers team already in sync';
}

/** Owner command: safe org defaults, rulesets, Actions allow-list, maintainers team, in every org we host in. */
async function orgSetup() {
  needHosting();
  const out = [];
  if (ORG && ghBot) out.push(await orgSetupFor(ghBot, ORG, { managed: false }));
  // Managed org: BOT_PAT (provisioned owner). Setup user / EMU_ADMIN_TOKEN cannot join orgs.
  if (EMU.org && ghBot) out.push(await orgSetupFor(ghBot, EMU.org, { managed: true }));
  return out.join('\n\n');
}
async function orgSetupFor(api, org, { managed }) {
  const lines = [];
  const mine = (d) => S.isHosted(d) && lc(orgOf(d.site.repo)) === lc(org);
  await step(lines, 'org defaults (no default access, members can\'t create repos or Pages)', async () => { await api.patch(`/orgs/${org}`, S.ORG_SETTINGS); });
  await step(lines, 'Actions: only GitHub\'s actions and our build workflow', async () => {
    const pol = S.actionsPolicy(repo);
    await api.put(`/orgs/${org}/actions/permissions`, pol.permissions);
    await api.put(`/orgs/${org}/actions/permissions/selected-actions`, pol.selected);
  });
  await step(lines, 'custom properties (ap_status, ap_owner, ap_name, ap_template)', async () => { await api.patch(`/orgs/${org}/properties/schema`, { properties: S.PROPERTIES }); });
  for (const rs of [S.workflowRuleset(config), S.branchRuleset(), S.frozenRuleset()]) {
    await step(lines, `ruleset “${rs.name}”`, async () => {
      const existing = (await api.get(`/orgs/${org}/rulesets`)).find((x) => x.name === rs.name);
      if (existing) await api.put(`/orgs/${org}/rulesets/${existing.id}`, rs);
      else await api.post(`/orgs/${org}/rulesets`, rs);
    });
  }
  if (!managed) await step(lines, 'maintainers team', () => syncTeam(config.maintainers));
  await step(lines, 'custom repository roles', async () => {
    const avail = await api.get(`/orgs/${org}/repository-fine-grained-permissions`).then((l) => l.map((x) => x.name), () => []);
    const existing = (await api.get(`/orgs/${org}/custom-repository-roles`).catch(() => ({ custom_roles: [] }))).custom_roles || [];
    const made = [];
    for (const role of S.repoRoles(avail)) {
      const cur = existing.find((r) => r.name === role.name);
      if (cur) await api.patch(`/orgs/${org}/custom-repository-roles/${cur.id}`, role);
      else await api.post(`/orgs/${org}/custom-repository-roles`, role);
      made.push(`${role.name} (${role.base_role}${role.permissions.length ? ` + ${role.permissions.length}` : ''})`);
    }
    roleCache = null;
    delete roleCaches[ORG];
    return `repository roles: ${made.join(', ')}`;
  });
  if (!managed) await step(lines, 'maintainers org role', async () => {
    const avail = await api.get(`/orgs/${org}/organization-fine-grained-permissions`).then((l) => l.map((x) => x.name), () => []);
    const role = S.orgRole(avail);
    if (!role.permissions.length) return 'maintainers org role: no permissions available on this plan, skipped';
    const list = (await api.get(`/orgs/${org}/organization-roles`).catch(() => ({ roles: [] }))).roles || [];
    let cur = list.find((r) => r.name === role.name);
    if (cur) await api.patch(`/orgs/${org}/organization-roles/${cur.id}`, role);
    else cur = await api.post(`/orgs/${org}/organization-roles`, role);
    await api.put(`/orgs/${org}/organization-roles/teams/${S.TEAM.slug}/${cur.id}`);
    return `org role ${role.name} (${role.permissions.join(', ')}) → ${S.TEAM.slug}`;
  });
  await step(lines, 'owner access on existing sites', async () => {
    const { entries } = mainTree();
    let n = 0;
    for (const [, d] of Object.entries(entries)) {
      if (!mine(d) || S.statusOf(d) === 'archived') continue;
      await applyAccess(d.site.repo, d.owner.github, S.statusOf(d)).then(() => n++, () => {});
    }
    return `custom roles applied on ${n} site${n === 1 ? '' : 's'}`;
  });
  await step(lines, 'properties on existing sites', async () => {
    const { entries } = mainTree();
    let n = 0;
    for (const [name, d] of Object.entries(entries)) {
      if (!mine(d)) continue;
      await setProperties(name, d).then(() => n++, () => {});
    }
    return `properties set on ${n} site repo${n === 1 ? '' : 's'}`;
  });
  return `### 🏗️ ${org} setup\n\n${lines.join('\n')}`;
}

/** Our custom repository roles that exist in the org (cached per run). */
let roleCache = null;
const roleCaches = {};
async function haveRoles(full) {
  const org = full ? orgOf(full) : ORG;
  if (org === ORG && roleCache) return roleCache;
  if (!roleCaches[org]) roleCaches[org] = ((await apiFor(`${org}/x`).get(`/orgs/${org}/custom-repository-roles`).catch(() => ({ custom_roles: [] }))).custom_roles || []).map((r) => r.name);
  if (org === ORG) roleCache = roleCaches[org];
  return roleCaches[org];
}

/** Owner access for a status: the custom role (or built-in fallback), or none. */
async function applyAccess(full, user, status) {
  const api = apiFor(full);
  const who = isEmuRepo(full) ? managedLoginOf(user) : user;
  const perm = S.ownerRole(status, await haveRoles(full));
  if (perm) {
    if (isEmuRepo(full)) await api.put(`/orgs/${orgOf(full)}/memberships/${who}`, { role: 'member' }).catch(() => {});
    return api.put(`/repos/${full}/collaborators/${who}`, { permission: perm });
  }
  await api.del(`/repos/${full}/collaborators/${who}`).catch(() => {});
  for (const inv of await api.all(`/repos/${full}/invitations`).catch(() => [])) {
    if (lc(inv.invitee && inv.invitee.login) === lc(who)) await api.del(`/repos/${full}/invitations/${inv.id}`).catch(() => {});
  }
}
/** A person's managed login (EMU): their SCIM userName + _shortcode. */
const managedLoginOf = (personal) => `${emuUserName(personal)}_${lc(EMU.shortcode || '')}`;

/** Custom properties drive org rulesets (e.g. locked/suspended sites are frozen by GitHub itself). */
async function setProperties(name, entry) {
  const repoName = entry.site.repo.split('/')[1];
  await apiFor(entry.site.repo).patch(`/orgs/${orgOf(entry.site.repo)}/properties/values`, {
    repository_names: [repoName],
    properties: S.propertyValues({ status: S.statusOf(entry), owner: entry.owner.github, name, template: entry.site.template }),
  });
}

/** Template files for a new site, filled in, plus the managed workflow and build config. */
function siteFiles({ name, owner, template, cloudflare = false }) {
  const dir = path.join(root, 'templates', template || 'html');
  const vars = { name, host: `${name}.${R.DOMAIN}`, owner, year: String(new Date().getFullYear()) };
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else files.push({ path: path.relative(dir, full).split(path.sep).join('/'), content: S.fillTemplate(fs.readFileSync(full, 'utf8'), vars) });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  else files.push(...S.starterFiles({ name, owner, sourceRepo: repo }).filter((f) => !f.path.startsWith('.github/')));
  files.push({ path: '.github/workflows/deploy.yml', content: cloudflare ? S.deployWorkflowCf(repo, S.cfProject(name)) : S.deployWorkflow(repo) });
  if (!files.some((f) => f.path === 'awesomeprojects.json')) files.push({ path: 'awesomeprojects.json', content: JSON.stringify({ framework: 'auto' }, null, 2) + '\n' });
  return files;
}

/** Replace a repo's content with `files` in ONE commit (git data API). */
async function commitFiles(full, files, message) {
  const api = apiFor(full);
  const ref = await api.get(`/repos/${full}/git/ref/heads/main`);
  const tree = await api.post(`/repos/${full}/git/trees`, { tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) });
  const commit = await api.post(`/repos/${full}/git/commits`, { message, tree: tree.sha, parents: [ref.object.sha] });
  await api.patch(`/repos/${full}/git/refs/heads/main`, { sha: commit.sha });
  return commit.sha;
}

/** Create (or bring back to standard) a hosted site's repo. Idempotent. */
async function provisionSite(name, entry, { rewriteWorkflow = false } = {}) {
  const full = entry.site.repo;
  const cf = S.onCloudflare(entry);
  if (cf) needEmu(); else needOrg();
  const api = apiFor(full);
  const org = orgOf(full);
  const repoName = full.split('/')[1];
  const owner = entry.owner.github;
  const status = S.statusOf(entry);
  const lines = [];
  // Managed enterprise: the owner needs a managed account first (created on the fly).
  if (cf && status !== 'archived') {
    await step(lines, `managed account for @${owner}`, async () => {
      const profile = await gh.get(`/users/${owner}`);
      const r = await emuProvision(profile.login, profile.id, 'bot');
      return `managed account ${r.managed}`;
    });
  }
  let existing = await api.get(`/repos/${full}`).catch(() => null);
  if (existing && existing.archived && status === 'archived') return { created: false, full, lines: [ok('archived (access removed, DNS off)')] };
  const created = !existing;
  if (created) {
    existing = await api.post(`/orgs/${org}/repos`, { name: repoName, ...S.repoSettings({ name, owner }), auto_init: true });
    lines.push(ok(`created [${full}](https://github.com/${full})`));
  } else {
    if (existing.archived && status !== 'archived') await api.patch(`/repos/${full}`, { archived: false });
    await step(lines, 'repo settings', async () => { await api.patch(`/repos/${full}`, S.repoSettings({ name, owner })); });
  }
  await step(lines, 'topic', async () => { await api.put(`/repos/${full}/topics`, { names: [S.TOPIC] }); });
  await step(lines, 'properties', () => setProperties(name, entry));
  await step(lines, 'Dependabot alerts', async () => { await api.put(`/repos/${full}/vulnerability-alerts`); });
  await step(lines, 'secret scanning', async () => {
    await api.patch(`/repos/${full}`, { security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } });
  });
  if (cf) await step(lines, `Cloudflare Pages project on ${name}.${R.DOMAIN}`, async () => `Cloudflare Pages project ${await ensureCfProject(name)}`);
  if (created) {
    const files = siteFiles({ name, owner, template: entry.site.template, cloudflare: cf });
    await step(lines, `${entry.site.template || 'html'} template (${files.length} files, one commit)`, async () => {
      await new Promise((r) => setTimeout(r, 1500)); // let auto_init land
      await commitFiles(full, files, `Start ${name}.${R.DOMAIN} from the ${entry.site.template || 'html'} template`);
    });
  }
  // On re-sync, put the managed workflow back.
  const managedWorkflow = cf ? S.deployWorkflowCf(repo, S.cfProject(name)) : S.deployWorkflow(repo);
  for (const f of rewriteWorkflow ? [{ path: '.github/workflows/deploy.yml', content: managedWorkflow }] : []) {
    await step(lines, f.path, async () => {
      const cur = await api.get(`/repos/${full}/contents/${f.path}`).catch(() => null);
      if (cur && Buffer.from(cur.content || '', 'base64').toString('utf8') === f.content) return `${f.path} already up to date`;
      await api.put(`/repos/${full}/contents/${f.path}`, {
        message: `Update ${f.path} (managed by awesomeprojects.tech)`,
        content: Buffer.from(f.content).toString('base64'),
        ...(cur ? { sha: cur.sha } : {}),
      });
    });
  }
  let pagesNew = false;
  if (!cf) {
    await step(lines, `Pages on ${name}.${R.DOMAIN}`, async () => {
      const pages = await api.get(`/repos/${full}/pages`).catch(() => null);
      if (!pages) { await api.post(`/repos/${full}/pages`, { build_type: 'workflow' }); pagesNew = true; }
      await api.put(`/repos/${full}/pages`, { build_type: 'workflow', cname: `${name}.${R.DOMAIN}`, public: true });
    });
  }
  // The starter commit's deploy may have run before everything existed: start one now.
  if ((created || pagesNew || rewriteWorkflow) && status !== 'archived') {
    await step(lines, 'first deploy started', async () => {
      await new Promise((r) => setTimeout(r, 3000));
      await api.post(`/repos/${full}/actions/workflows/deploy.yml/dispatches`, { ref: 'main' });
    });
  }
  if (!cf) await step(lines, 'maintainers team access', async () => { await api.put(`/orgs/${org}/teams/${S.TEAM.slug}/repos/${full}`, { permission: S.TEAM.permission }); });
  const who = cf ? managedLoginOf(owner) : owner;
  await step(lines, `@${who}: ${S.ownerRole(status, await haveRoles(full)) || 'no'} access (${status})`, async () => { await applyAccess(full, owner, status); });
  if (status === 'archived') await step(lines, 'archived', async () => { await api.patch(`/repos/${full}`, { archived: true }); });
  return { created, full, lines };
}

/** After merges: make every hosted entry's repo exist, and archive repos whose name is gone. */
async function reconcileSites() {
  if ((!ORG || !ghBot) && !emuHostingOn) return;
  const { entries } = mainTree();
  const hosted = Object.entries(entries).filter(([, d]) => S.isHosted(d) && ghBot && (!isEmuRepo(d.site.repo) || emuHostingOn));
  const repos = [
    ...(ORG && ghBot ? await ghBot.all(`/orgs/${ORG}/repos?type=all`) : []),
    ...(EMU.org && ghBot ? await ghBot.all(`/orgs/${EMU.org}/repos?type=all`).catch(() => []) : []),
  ];
  const byName = new Map(repos.map((r) => [lc(r.full_name), r]));
  for (const [name, d] of hosted) {
    const r = byName.get(lc(d.site.repo));
    if (!r) {
      const res = await provisionSite(name, d);
      console.log(`sites: provisioned ${res.full}\n  ${res.lines.join('\n  ')}`);
      await activityLog(`🏗️ **Created** [${res.full}](https://github.com/${res.full}) for @${d.owner.github}`);
    } else if (r.archived !== (S.statusOf(d) === 'archived')) {
      await provisionSite(name, d);
    }
  }
  const live = new Set(hosted.map(([, d]) => lc(d.site.repo)));
  for (const r of repos) {
    if (!(r.topics || []).includes(S.TOPIC) || r.archived || live.has(lc(r.full_name))) continue;
    const rapi = apiFor(r.full_name);
    for (const c of await rapi.all(`/repos/${r.full_name}/collaborators?affiliation=${isEmuRepo(r.full_name) ? 'direct' : 'outside'}`).catch(() => [])) await rapi.del(`/repos/${r.full_name}/collaborators/${c.login}`).catch(() => {});
    await rapi.patch(`/repos/${r.full_name}`, { archived: true });
    await activityLog(`🗄️ **Archived** [${r.full_name}](${r.html_url}): its name was removed`);
  }
}

async function setSiteStatus(name, status, by) {
  needHosting();
  const { entries } = mainTree();
  const d = entries[name];
  if (!d) return `\`${name}\` isn't registered.`;
  if (!S.isHosted(d)) return `\`${name}\` isn't hosted by us (it points at ${C.hostOf(d)}).`;
  const from = S.statusOf(d);
  const can = S.canTransition(from, status, { isOwner: lc(by) === lc(owner) });
  if (!can.ok) return can.why;
  const entry = { ...d, site: { ...d.site, status } };
  const { pr, merged } = await botChange({
    title: `${name}: ${from} → ${status}`, body: `\`/site ${name} ${status}\` by @${by}.`,
    changes: [{ file: `domains/${name}.json`, content: JSON.stringify(entry, null, 2) + '\n' }], tag: `site-${name}-${Date.now().toString(36)}`,
  });
  if (!merged) return `I opened #${pr.number} but couldn't merge it.`;
  const res = await provisionSite(name, entry);
  const what = { active: 'active again: the owner can push', locked: 'locked: the owner is read-only, the site stays up', suspended: 'suspended: the owner is read-only and DNS is off', archived: 'archived: access removed, repo archived, DNS off' }[status];
  await activityLog(`🔐 **${name}** ${from} → **${status}** · by @${by} → #${pr.number}`);
  return `🔐 \`${name}\` is now **${what}** (#${pr.number}).\n\n${res.lines.join('\n')}`;
}

async function repoAccessCmd(name, user, level, by) {
  needHosting();
  const { entries } = mainTree();
  const d = entries[name];
  if (!d || !S.isHosted(d)) return `\`${name}\` isn't a hosted site.`;
  if (!(level in S.ACCESS)) return `Access must be one of: ${Object.keys(S.ACCESS).join(', ')}.`;
  const full = d.site.repo;
  if (S.ACCESS[level]) {
    if (isEmuRepo(full)) {
      const profile = await gh.get(`/users/${user}`);
      await emuProvision(profile.login, profile.id, by);
    }
    await apiFor(full).put(`/repos/${full}/collaborators/${loginIn(full, user)}`, { permission: S.ACCESS[level] });
  }
  else await applyAccess(full, user, 'archived');
  await activityLog(`🔑 **Repo access** [${full}](https://github.com/${full}) · @${user}: ${level} · by @${by}`);
  return `🔑 @${user} now has **${level}** access to [${full}](https://github.com/${full})${S.ACCESS[level] ? ' (an invite if they aren\'t in yet; this uses a seat)' : ''}.`;
}

/** One comment a day on the public activity log: everything that changed in the last 24 hours. */
async function publicDigest(opsLine) {
  let lines = [];
  try {
    const res = await fetch(`${process.env.PANEL_API}/bot/activity?since=${Date.now() - 86400e3}`, { headers: { Authorization: `Bearer ${String(process.env.PANEL_BOT_SECRET || '').trim()}`, 'User-Agent': 'awesomeprojects-bot' } });
    if (res.ok) lines = (await res.json()).lines || [];
  } catch { /* no panel: nothing buffered */ }
  if (!lines.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const shown = lines.slice(-60).map((l) => `- ${l.summary}`).join('\n');
  await postToLog(`### ${day} · ${lines.length} change${lines.length === 1 ? '' : 's'}\n\n${shown}${lines.length > 60 ? `\n- …and ${lines.length - 60} more (see the console's Activity tab)` : ''}\n\n${opsLine}`);
}

// ── Daily ops ──────────────────────────────────────────────────
/** Open (or keep) one issue with `label` in a site repo, assigned to its owner. */
async function siteIssue(full, owner, label, title, body) {
  const api = apiFor(full);
  const open = await api.get(`/repos/${full}/issues?state=open&labels=${encodeURIComponent(label)}`).catch(() => []);
  if (open.length) return open[0];
  return api.post(`/repos/${full}/issues`, { title, body, labels: [label], assignees: [loginIn(full, owner)] }).catch(() => api.post(`/repos/${full}/issues`, { title, body, labels: [label] }));
}
async function closeSiteIssues(full, label, note) {
  const api = apiFor(full);
  for (const i of await api.get(`/repos/${full}/issues?state=open&labels=${encodeURIComponent(label)}`).catch(() => [])) {
    await api.post(`/repos/${full}/issues/${i.number}/comments`, { body: note }).catch(() => {});
    await api.patch(`/repos/${full}/issues/${i.number}`, { state: 'closed', state_reason: 'completed' }).catch(() => {});
  }
}

/**
 * The daily run over every hosted site: enforce HTTPS when the certificate is ready, tell owners when a
 * deploy fails (and close that when it's fixed), lock oversized or long-abandoned sites, count seats,
 * then send the console a snapshot and post a digest.
 */
async function ops({ by = 'schedule' } = {}) {
  needHosting();
  const { entries } = mainTree();
  const hosted = Object.entries(entries).filter(([, d]) => S.isHosted(d) && ghBot && (!isEmuRepo(d.site.repo) || emuHostingOn));
  const acts = [];
  const sites = [];
  for (const [name, d] of hosted) {
    const full = d.site.repo;
    const api = apiFor(full);
    const cf = S.onCloudflare(d);
    const owner = loginIn(full, d.owner.github); // who to @mention inside the site repo
    const status = S.statusOf(d);
    const site = { name, owner: d.owner.github, status, repo: full, platform: cf ? 'cloudflare' : 'github' };
    try {
      const r = await api.get(`/repos/${full}`);
      site.sizeMB = Math.round((r.size || 0) / 102.4) / 10;
      site.pushedAt = r.pushed_at;
      if (status === 'archived') { sites.push(site); continue; }
      const pages = cf ? null : await api.get(`/repos/${full}/pages`).catch(() => null);
      site.https = cf || !!(pages && pages.https_enforced); // Cloudflare always serves HTTPS
      if (!cf && S.httpsReady(pages)) {
        await api.put(`/repos/${full}/pages`, { build_type: 'workflow', cname: pages.cname || `${name}.${R.DOMAIN}`, public: true, https_enforced: true }).then(() => { site.https = true; acts.push(`🔒 HTTPS on for \`${name}\``); }, () => {});
      }
      const runs = await api.get(`/repos/${full}/actions/runs?per_page=1&exclude_pull_requests=true`).catch(() => null);
      const run = runs && runs.workflow_runs && runs.workflow_runs[0];
      if (run) {
        site.deploy = { conclusion: run.conclusion || run.status, url: run.html_url, at: run.created_at };
        if (run.conclusion === 'failure') {
          const i = await siteIssue(full, owner, 'deploy-failed', '⚠️ Your last deploy failed',
            `@${owner}, the last deploy of **https://${name}.${R.DOMAIN}** failed: [see the log](${run.html_url}).\n\nFix it and push again; this issue closes itself once a deploy succeeds. Build options: \`awesomeprojects.json\` ([docs](https://github.com/${repo}/blob/main/docs/HOSTING.md#awesomeprojectsjson)).`);
          if (i && i.created_at && Date.now() - Date.parse(i.created_at) < 86400e3) acts.push(`⚠️ deploy failing on \`${name}\``);
        } else if (run.conclusion === 'success') {
          await closeSiteIssues(full, 'deploy-failed', '✅ The latest deploy worked, so I\'m closing this.');
        }
      }
      const collabs = await api.all(`/repos/${full}/collaborators?affiliation=${collabAffiliation(full)}`).catch(() => []);
      site.collaborators = collabs.map((c) => c.login);
      const invites = await api.all(`/repos/${full}/invitations`).catch(() => []);
      site.pendingInvites = invites.map((i) => (i.invitee ? i.invitee.login : '?'));
      // Size
      const maxMB = config.maxRepoSizeMB || 0;
      if (maxMB && site.sizeMB > maxMB && status === 'active') {
        await setSiteStatus(name, 'locked', 'ops-bot');
        await siteIssue(full, owner, 'too-big', '🔒 This site was locked: the repo is too big', `@${owner}, this repo is ${site.sizeMB} MB; the limit is ${maxMB} MB, so it's read-only for now. Ask a maintainer to unlock it once you have a plan to shrink it (big media usually belongs on a CDN).`);
        site.status = 'locked';
        acts.push(`🔒 locked \`${name}\` (${site.sizeMB} MB)`);
      }
      // Inactivity
      const warned = (await api.get(`/repos/${full}/issues?state=open&labels=inactive`).catch(() => []))[0];
      const what = S.inactivity({ pushedAt: r.pushed_at, status: site.status, warnDays: config.inactivityWarnDays || 0, lockDays: config.inactivityLockDays || 0, warnedAt: warned ? warned.created_at : null });
      if (what === 'warn') {
        await siteIssue(full, owner, 'inactive', '👋 Still using this site?', `@${owner}, nobody has pushed to this site in a while. If you're done with it, remove the name at [My domains](https://awesomeprojects.tech/me/). Otherwise, just close this issue.${config.inactivityLockDays ? ` Sites without a push for ${config.inactivityLockDays} days get locked.` : ''}`);
        acts.push(`👋 asked @${owner} about \`${name}\``);
      } else if (what === 'lock') {
        await setSiteStatus(name, 'locked', 'ops-bot');
        site.status = 'locked';
        acts.push(`💤 locked \`${name}\` (inactive)`);
      }
    } catch (e) {
      site.error = String(e.message).slice(0, 200);
    }
    sites.push(site);
  }
  const seats = await seatUsage();
  const failing = sites.filter((x) => x.deploy && x.deploy.conclusion === 'failure').length;
  const snapshot = { at: Date.now(), org: ORG, emuOrg: EMU.org || '', seats: { used: seats.used, max: seats.max }, sites };
  await panelPost('/bot/sites', snapshot);
  const digest = `📋 **Daily ops** (${by}) · ${sites.length} hosted site${sites.length === 1 ? '' : 's'} · ${failing} failing · seats ${seats.used}${seats.max ? `/${seats.max}` : ''}${acts.length ? `\n${acts.map((a) => `- ${a}`).join('\n')}` : ''}`;
  if (acts.length) await activityLog(digest);
  if (by === 'schedule') await publicDigest(digest);
  if (acts.length || (seats.max && seats.used >= seats.max * 0.9)) await notify(digest.replace(/\*\*/g, '**'));
  return digest;
}

// ── Managed accounts (Enterprise Managed Users) ────────────────
/** Site repos in the managed org (vs classic sitesOrg). */
const isEmuRepo = (full) => !!(EMU.org && lc(String(full).split('/')[0]) === lc(EMU.org));
/** Every site repo uses BOT_PAT. Setup user (EMU_ADMIN_TOKEN) is SCIM-only and can't join orgs. */
function apiFor(full) {
  if (!ghBot) throw new Error(isEmuRepo(full)
    ? 'The `BOT_PAT` secret isn\'t set (needs a provisioned owner of the managed org).'
    : 'The `BOT_PAT` secret isn\'t set.');
  return ghBot;
}
/** A person as they appear in a site repo: their managed login in the managed enterprise. */
const loginIn = (full, personal) => (isEmuRepo(full) ? managedLoginOf(personal) : personal);
const collabAffiliation = (full) => (isEmuRepo(full) ? 'direct' : 'outside');
const orgOf = (full) => String(full).split('/')[0];

/** Cloudflare Pages: a project per hosted site, with its custom domain. */
async function cfApi(method, pathname, body) {
  const token = String(process.env.CLOUDFLARE_PAGES_TOKEN || '').trim();
  const account = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!token || !account) throw new Error('CLOUDFLARE_PAGES_TOKEN / CLOUDFLARE_ACCOUNT_ID aren\'t set.');
  if (dryRun && method !== 'GET') { console.log(`[dry-run] cloudflare ${method} ${pathname}`); return {}; }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${pathname}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.success === false) {
    const e = new Error(`Cloudflare ${method} ${pathname}: ${res.status} ${(d.errors || []).map((x) => x.message).join('; ')}`);
    e.status = res.status;
    throw e;
  }
  return d.result;
}
async function ensureCfProject(name) {
  const project = S.cfProject(name);
  const have = await cfApi('GET', `/pages/projects/${project}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (!have) await cfApi('POST', '/pages/projects', { name: project, production_branch: 'main' });
  const domain = `${name}.${R.DOMAIN}`;
  const domains = await cfApi('GET', `/pages/projects/${project}/domains`).catch(() => []);
  if (!(domains || []).some((d) => d.name === domain)) await cfApi('POST', `/pages/projects/${project}/domains`, { name: domain });
  return project;
}

function needEmu() {
  if (!EMU.enterprise || !EMU.shortcode) throw new Error('The managed-user enterprise isn\'t configured (config.json → emu).');
  if (!ghEmu) throw new Error('The `EMU_ADMIN_TOKEN` secret isn\'t set.');
}
/** SCIM userName from a GitHub login (GitHub then adds _<shortcode>). */
const emuUserName = (login) => lc(login).replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 38 - String(EMU.shortcode || '').length) || 'user';
const scimPath = (p = '') => `/scim/v2/enterprises/${EMU.enterprise}/Users${p}`;
async function scimFind(userName) {
  const r = await ghEmu.get(`${scimPath()}?filter=${encodeURIComponent(`userName eq "${userName}"`)}`).catch(() => null);
  return r && r.Resources && r.Resources[0];
}

/** Create (or re-find) someone's managed account, add it to the managed org, and tell the panel. */
async function emuProvision(personalLogin, personalId, by) {
  needEmu();
  const userName = emuUserName(personalLogin);
  // The repo owner needs enterprise_owner so they can create the managed org after SAML is on
  // (the setup user can't create orgs in the UI once SSO is required).
  const role = lc(personalLogin) === lc(owner) ? 'enterprise_owner' : 'user';
  const body = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    externalId: `gh-${personalId}`,
    active: true,
    userName,
    displayName: personalLogin,
    name: { givenName: personalLogin, familyName: '-' },
    emails: [{ value: `${userName}@users.awesomeprojects.tech`, type: 'work', primary: true }],
    roles: [{ value: role, primary: false }],
  };
  let user = await scimFind(userName);
  if (!user) {
    user = await ghEmu.post(scimPath(), body).catch((e) => {
      const msg = String(e.message || e);
      if (/Open SCIM|Azure AD, Okta, or Ping/i.test(msg)) {
        throw new Error('SCIM is locked until you enable **Open SCIM configuration** (Enterprise → Identity provider → Single sign-on configuration).');
      }
      throw e;
    });
  } else {
    const ops = [];
    if (user.active === false) ops.push({ op: 'replace', path: 'active', value: true });
    const have = [].concat(user.roles || []).map((r) => (r && r.value) || r);
    if (role === 'enterprise_owner' && !have.includes('enterprise_owner')) ops.push({ op: 'replace', path: 'roles', value: [{ value: 'enterprise_owner', primary: false }] });
    if (ops.length) user = await ghEmu.patch(scimPath(`/${user.id}`), { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });
  }
  const managed = `${userName}_${lc(EMU.shortcode)}`;
  const lines = [ok(`account \`${managed}\`${role === 'enterprise_owner' ? ' (enterprise owner)' : ''}`)];
  if (EMU.org && ghBot) await step(lines, `member of ${EMU.org}`, async () => { await ghBot.put(`/orgs/${EMU.org}/memberships/${managed}`, { role: 'member' }); });
  else if (EMU.org && !ghBot) lines.push(warn(`member of ${EMU.org}: BOT_PAT isn't set (provisioned org owner)`));
  await panelPost('/bot/identity', { personal_id: personalId, personal_login: personalLogin, user_name: userName, managed_login: managed, scim_id: user && user.id, status: 'active' });
  await activityLog(`🪪 **Managed account** \`${managed}\` for @${personalLogin}${by && lc(by) !== lc(personalLogin) ? ` · by @${by}` : ''}`);
  return { managed, message: `🪪 Your enterprise account is **${managed}**.\n\nSign in at [github.com/enterprises/${EMU.enterprise}/sso](https://github.com/enterprises/${EMU.enterprise}/sso): you'll confirm it's you with your GitHub account, and no new password is needed.\n\n${lines.join('\n')}` };
}

/** Suspend or re-activate a managed account (SCIM active flag). */
async function emuSetActive(personalLogin, active, by) {
  needEmu();
  const userName = emuUserName(personalLogin);
  const user = await scimFind(userName);
  if (!user) return `@${personalLogin} has no managed account.`;
  await ghEmu.patch(scimPath(`/${user.id}`), { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: active }] });
  const profile = await gh.get(`/users/${personalLogin}`).catch(() => null);
  if (profile) await panelPost('/bot/identity', { personal_id: profile.id, personal_login: profile.login, user_name: userName, managed_login: `${userName}_${lc(EMU.shortcode)}`, scim_id: user.id, status: active ? 'active' : 'suspended' });
  await activityLog(`🪪 **Managed account ${active ? 'restored' : 'suspended'}** \`${userName}_${lc(EMU.shortcode)}\` · by @${by}`);
  return `🪪 \`${userName}_${lc(EMU.shortcode)}\` is ${active ? 'active again' : 'suspended: they can\'t sign in'}.`;
}

// ── Making things for people ───────────────────────────────────
const HOST_ALIASES = {
  hosted: 'hosted', host: 'hosted', us: 'hosted', github: 'github-pages', 'github-pages': 'github-pages', pages: 'github-pages', repo: 'github-pages',
  vercel: 'vercel', netlify: 'netlify', cloudflare: 'cloudflare-pages', 'cloudflare-pages': 'cloudflare-pages', cf: 'cloudflare-pages',
  render: 'render', railway: 'railway', fly: 'fly', cname: 'cname', server: 'server', ip: 'server',
};

/** A maintainer makes a name for someone: same checks (forceable), committed, hosted repos provisioned. */
async function createFor({ name, owner: who, provider, repo: srcRepo = '', target = '', template = '', description = '', force = false }, by) {
  const p = P.byLabelOrId(HOST_ALIASES[lc(provider)] || provider);
  if (!p) return { ok: false, message: `Host must be one of: ${Object.keys(HOST_ALIASES).filter((k, i, a) => a.indexOf(k) === i).join(', ')}.` };
  const person = String(who || '').replace(/^@/, '');
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(person)) return { ok: false, message: 'Give a GitHub username for the owner.' };
  const profile = await gh.get(`/users/${person}`).catch(() => null);
  if (!profile) return { ok: false, message: `@${person} isn't a GitHub account.` };
  const built = P.buildRequest({ Subdomain: name, 'Where should it point?': p.label, Template: template, 'GitHub repository': srcRepo, Target: target, Description: description }, profile.login, { sitesOrg: ORG, emuOrg: emuHostingOn ? EMU.org : '' });
  const ev = await evaluateRequest({ built, author: profile.login, overrideHolds: true, overrideAll: force, by });
  if (ev.problems.length) return { ok: false, message: `Can't create it:\n${ev.problems.map((x) => `- ${x}`).join('\n')}` };
  if (ev.result.verdict !== 'ready') {
    const blockers = ev.result.findings.filter((f) => ['error', 'reject', 'hold'].includes(f.level));
    const forceable = blockers.filter((f) => !f.hard).length;
    return { ok: false, message: `Not created: it's **${ev.result.verdict}**.\n${blockers.map((f) => `- ${f.hard ? '⛔' : '✏️'} ${f.text}`).join('\n')}${forceable ? '\n\nThe ✏️ ones can be overridden: run it again with **force**.' : ''}` };
  }
  if (ev.result.overridden) built.entry.forced = lc(by);
  const { pr, merged } = await botChange({
    title: `${ev.exists ? 'Update' : 'Add'} ${built.name} for @${profile.login}`,
    body: `Created by @${by} for @${profile.login}${force ? ` (forced, ${ev.result.overridden} overridden)` : ''}.`,
    changes: [{ file: ev.file, content: JSON.stringify(built.entry, null, 2) + '\n' }],
    tag: `create-${built.name}-${Date.now().toString(36)}`,
  });
  if (!merged) return { ok: false, message: `I opened #${pr.number} but couldn't merge it.`, link: pr.html_url };
  await activityLog(`🎁 **Created** \`${built.name}.${R.DOMAIN}\` for @${profile.login} · ${C.hostOf(built.entry)}${force ? ` · forced (${ev.result.overridden} overridden)` : ''} · by @${by} → #${pr.number}`);
  const guide = P.setupGuide({ provider: p, name: built.name, repo: built.entry.site && built.entry.site.repo, branch: ev.rc.branch, sourceRepo: repo });
  return { ok: true, message: `🎁 \`${built.name}.${R.DOMAIN}\` is live for @${profile.login}${S.isHosted(built.entry) ? `, with [${built.entry.site.repo}](https://github.com/${built.entry.site.repo}) (they're invited)` : ''}.\n\nSend them these steps:\n\n${guide}`, link: pr.html_url };
}

/** A private repo in the sites org for someone, with no domain. */
async function makeRepo(repoName, who, template, by) {
  needOrg();
  const rn = lc(repoName).replace(/[^a-z0-9._-]/g, '-').slice(0, 100);
  const person = String(who || '').replace(/^@/, '');
  if (!rn || !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(person)) return 'Usage: `/make-repo <repo> @user [template]`';
  const profile = await gh.get(`/users/${person}`).catch(() => null);
  if (!profile) return `@${person} isn't a GitHub account.`;
  const full = `${ORG}/${rn}`;
  if (await ghBot.get(`/repos/${full}`).catch(() => null)) return `[${full}](https://github.com/${full}) already exists.`;
  const tpl = (S.TEMPLATES.find((t) => t.id === lc(template) || lc(t.label) === lc(template)) || S.TEMPLATES[0]).id;
  const lines = [];
  await ghBot.post(`/orgs/${ORG}/repos`, { name: rn, private: true, description: `@${profile.login}'s repo`, has_wiki: false, has_projects: false, auto_init: true });
  lines.push(ok(`created [${full}](https://github.com/${full})`));
  await step(lines, 'topic', async () => { await ghBot.put(`/repos/${full}/topics`, { names: ['awesomeprojects-repo'] }); });
  await step(lines, 'properties', async () => { await ghBot.patch(`/orgs/${ORG}/properties/values`, { repository_names: [rn], properties: S.propertyValues({ status: 'active', owner: profile.login, name: rn, template: tpl }) }); });
  await step(lines, `${tpl} template`, async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const files = siteFiles({ name: rn, owner: profile.login, template: tpl }).filter((f) => !f.path.startsWith('.github/'));
    await commitFiles(full, files, `Start from the ${tpl} template`);
  });
  await step(lines, 'Dependabot alerts', async () => { await ghBot.put(`/repos/${full}/vulnerability-alerts`); });
  await step(lines, 'maintainers team access', async () => { await ghBot.put(`/orgs/${ORG}/teams/${S.TEAM.slug}/repos/${full}`, { permission: S.TEAM.permission }); });
  await step(lines, `@${profile.login} invited`, async () => { await ghBot.put(`/repos/${full}/collaborators/${profile.login}`, { permission: S.ownerRole('active', await haveRoles()) }); });
  await activityLog(`📦 **Repo made** [${full}](https://github.com/${full}) for @${profile.login} · by @${by}`);
  return `📦 [${full}](https://github.com/${full}) is ready for @${profile.login} (they're invited; it uses a seat).\n\n${lines.join('\n')}`;
}

// ── Panel actions (repository_dispatch from api.awesomeprojects.tech) ──
/** Tell the panel how it went. `job` is the dispatch payload (id, actor, at, summary). */
async function reportResult(job, { ok, message, link }) {
  console.log(`panel result ${job.id}: ${ok ? 'ok' : 'error'}:\n${String(message)}`);
  return panelPost('/bot/result', { id: job.id, actor: job.actor, at: job.at, summary: job.summary, ok, message, link });
}

/** Change where one of your names points, from the "My domains" panel. Same checks as a request. */
async function selfUpdate(u, actor) {
  const built = P.buildRequest({
    Subdomain: u.name, 'Where should it point?': u.provider, 'GitHub repository': u.repo || '', Target: u.target || '', Description: u.description || '',
  }, actor, { sitesOrg: ORG, emuOrg: emuHostingOn ? EMU.org : '' });
  if (built.problems.length) return { ok: false, message: built.problems.join(' ') };
  const { entries } = mainTree();
  const name = built.name;
  const current = entries[name];
  if (!current) return { ok: false, message: `\`${name}\` isn't registered. Request it on the website first.` };
  if (R.ownerOf(current) !== lc(actor) && !isMaintainer(actor)) return { ok: false, message: `Only @${R.ownerOf(current)} can change \`${name}\`.` };
  const entry = { ...built.entry, owner: current.owner, ...(built.entry.description ? {} : current.description ? { description: current.description } : {}) };
  const file = `domains/${name}.json`;
  const profile = await gh.get(`/users/${actor}`).catch(() => null);
  const rc = await repoChecks(entry, actor);
  const dns = await checkTargets([entry]);
  const result = review({
    author: actor, profile, changes: [{ status: 'M', file }], base: entries, head: { ...entries, [name]: entry }, dns,
    reserved, config, maintainers, extra: rc.findings, pagesOwners: [...rc.pagesOwners, ...(S.isHosted(entry) && ORG ? [lc(ORG)] : [])],
  });
  if (result.verdict !== 'ready') {
    const issues = result.findings.filter((f) => ['error', 'reject', 'hold'].includes(f.level)).map((f) => `- ${f.text}`).join('\n');
    const link = `${repoUrl}/issues/new?template=request.yml&title=${encodeURIComponent(`Request: ${name}`)}&subdomain=${encodeURIComponent(name)}`;
    return {
      ok: false,
      message: result.verdict === 'on-hold'
        ? `This change needs a maintainer's look:\n${issues}\n\n[Open it as a request](${link}) and they'll review it.`
        : `Can't apply that:\n${issues}`,
    };
  }
  const { pr, merged } = await botChange({
    title: `Update ${name}`, body: `Updated by @${actor} from the panel.`,
    changes: [{ file, content: JSON.stringify(entry, null, 2) + '\n' }], tag: `update-${name}-${Date.now().toString(36)}`,
  });
  if (!merged) return { ok: false, message: `I opened #${pr.number} but couldn't merge it. A maintainer will.`, link: pr.html_url };
  await activityLog(`✏️ **Updated** \`${name}\` → ${C.fmtRecords(entry.records)} · by @${actor} (panel) → #${pr.number}`);
  const guide = P.setupGuide({ provider: built.provider, name, repo: entry.site && entry.site.repo, branch: rc.branch, sourceRepo: repo });
  return { ok: true, message: `✅ \`${name}.${R.DOMAIN}\` now points at ${C.fmtRecords(entry.records)}. DNS updates in a minute.\n\n${guide}`, link: pr.html_url };
}

/** POST to the panel server with the bot secret. */
async function panelPost(pathname, body) {
  const api = process.env.PANEL_API;
  const secret = String(process.env.PANEL_BOT_SECRET || '').trim();
  if (!api || !secret || dryRun) return console.log(`[panel] ${pathname} ${JSON.stringify(body).slice(0, 300)}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${api}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': 'awesomeprojects-bot' }, body: JSON.stringify(body) });
      console.log(`panel ${pathname}: ${res.status}`);
      if (res.ok || res.status === 401 || res.status === 404) return;
    } catch (e) { console.warn(`panel ${pathname}: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const panelForm = (f = {}) => ({ Subdomain: f.name, 'Where should it point?': f.provider, Template: f.template || '', 'GitHub repository': f.repo || '', Target: f.target || '', Description: f.description || '' });
const reviewSummary = (ev) => (ev.problems.length
  ? { verdict: 'needs-changes', findings: ev.problems.map((t) => ({ check: 'format', level: 'error', text: t })) }
  : { verdict: ev.result.verdict, findings: ev.result.findings, plan: ev.rc.plan || null });

/** A private request from the panel: review it, or (approved by a maintainer) make it live. */
async function onPanelRequest(p) {
  const author = p.kind === 'approve' ? p.requester : p.actor;
  const built = P.buildRequest(panelForm(p.form), author, { sitesOrg: ORG, emuOrg: emuHostingOn ? EMU.org : '' });
  const ev = await evaluateRequest({ built, author, labels: p.manualHold ? ['manual-hold'] : [], overrideHolds: p.kind === 'approve', overrideAll: p.kind === 'approve' && !!p.force, by: p.actor });
  const rev = { ...reviewSummary(ev), entry: built.entry || null };
  console.log(`panel request ${p.request} (${p.kind}) ${built.name}: ${rev.verdict}`);
  if (p.kind === 'review') {
    if (['ready', 'on-hold'].includes(rev.verdict)) await notify(`🌱 Private request **${built.name}** by @${author}: ${rev.verdict} · https://awesomeprojects.tech/admin/`);
    return panelPost('/bot/request', { request: p.request, kind: 'review', verdict: rev.verdict, review: rev });
  }

  // Approve
  if (rev.verdict !== 'ready') {
    return panelPost('/bot/request', { request: p.request, kind: 'failed', verdict: rev.verdict, review: rev, message: `Couldn't approve it yet: it's **${rev.verdict}**.\n\n${rev.findings.filter((f) => ['error', 'reject'].includes(f.level)).map((f) => `- ${f.text}`).join('\n')}` });
  }
  if (ev.result.overridden) built.entry.forced = lc(p.actor);
  const { pr, merged } = await botChange({
    title: `${ev.exists ? 'Update' : 'Add'} ${built.name}`,
    body: `Requested privately by @${author}; ${p.force ? 'force-' : ''}approved by @${p.actor} in the panel.`,
    changes: [{ file: ev.file, content: JSON.stringify(built.entry, null, 2) + '\n' }],
    tag: `preq-${p.request}`,
  });
  if (!merged) return panelPost('/bot/request', { request: p.request, kind: 'failed', verdict: 'ready', message: `I opened ${pr.html_url} but couldn't merge it. A maintainer will.` });
  const guide = P.setupGuide({ provider: built.provider, name: built.name, repo: built.entry.site && built.entry.site.repo, branch: ev.rc.branch, sourceRepo: repo });
  await activityLog(`✅ **${ev.exists ? 'Updated' : 'Added'}** \`${built.name}.${R.DOMAIN}\` for @${author} · approved by @${p.actor} (panel) → #${pr.number}`);
  return panelPost('/bot/request', { request: p.request, kind: 'live', result: { pr: pr.html_url, guide }, message: `🎉 **${built.name}.${R.DOMAIN} is live!** DNS updates in a minute.\n\n${guide}` });
}

/**
 * The DNS manager: set (or, with records = null, delete) the records of a name you own
 * or of a name under it ("blog.alice", "_vercel.alice").
 */
async function setRecords(full, records, actor) {
  const { entries } = mainTree();
  const name = Q.cleanName(full);
  const base = R.baseOf(name);
  const parent = entries[base];
  if (!parent) return { ok: false, message: `\`${base}\` isn't registered.` };
  const owns = R.ownerOf(parent) === lc(actor) || isMaintainer(actor);
  if (!owns) return { ok: false, message: `Only @${R.ownerOf(parent)} can change records under \`${base}\`.` };
  const existing = entries[name];
  if (name === base) {
    if (records === null) return { ok: false, message: 'Use *Remove* to give up the whole name.' };
    if (S.isHosted(parent)) return { ok: false, message: `\`${name}\` is hosted by us, so its own record is managed for you. Add records *under* it instead (like \`www.${name}\` or \`_verify.${name}\`).` };
  }
  const file = `domains/${name}.json`;
  if (records === null) {
    if (!existing) return { ok: false, message: `\`${name}\` has no records.` };
    const { pr, merged } = await botChange({ title: `Remove records ${name}`, body: `From My domains, by @${actor}.`, changes: [{ file, content: null }], tag: `rec-${name}-${Date.now().toString(36)}` });
    if (!merged) return { ok: false, message: `I opened #${pr.number} but couldn't merge it.`, link: pr.html_url };
    await activityLog(`🧾 **Records removed** \`${name}\` · by @${actor} (panel) → #${pr.number}`);
    return { ok: true, message: `🗑️ Removed the records at \`${name}.${R.DOMAIN}\`.`, link: pr.html_url };
  }
  const entry = { ...(existing || { owner: { github: R.ownerOf(parent) } }), records };
  if (name !== base && entry.site) delete entry.site;
  const errs = [...R.checkName(name, reserved), ...R.checkEntry(name, entry)];
  const dns = await checkTargets([entry]);
  for (const [h, v] of Object.entries(dns)) {
    if (v === false && !S.isPendingHostedTarget(name, entry, h)) errs.push(`\`${h}\` doesn't exist yet. Set up the target first.`);
  }
  if (errs.length) return { ok: false, message: `Can't save that:\n${errs.map((e) => `- ${e}`).join('\n')}` };
  const { pr, merged } = await botChange({
    title: `${existing ? 'Update' : 'Add'} records ${name}`, body: `From My domains, by @${actor}.`,
    changes: [{ file, content: JSON.stringify(entry, null, 2) + '\n' }], tag: `rec-${name}-${Date.now().toString(36)}`,
  });
  if (!merged) return { ok: false, message: `I opened #${pr.number} but couldn't merge it.`, link: pr.html_url };
  await activityLog(`🧾 **Records** \`${name}\` → ${C.fmtRecords(records)} · by @${actor} (panel) → #${pr.number}`);
  return { ok: true, message: `✅ \`${name}.${R.DOMAIN}\` → ${C.fmtRecords(records)}. Live in a minute.`, link: pr.html_url };
}

async function onPanel(p) {
  if (p.kind === 'review' || p.kind === 'approve') {
    return onPanelRequest(p).catch(async (e) => {
      console.error(e);
      await panelPost('/bot/request', { request: p.request, kind: 'failed', verdict: 'needs-changes', message: `Something broke while checking this (${String(e.message).slice(0, 200)}). A maintainer has been told.` });
    });
  }
  const id = String(p.id || '');
  const actor = String(p.actor || '');
  const admin = isMaintainer(actor);
  const finish = (r) => reportResult(p, r);
  try {
    if (!id || !actor) return console.warn('panel: missing id/actor');
    if (p.update) return finish(await selfUpdate(p.update, actor));
    if (p.records) return finish(await setRecords(p.records.name, p.records.records, actor));
    if (p.create) return finish(admin ? await createFor(p.create, actor) : { ok: false, message: 'That needs a maintainer.' });
    if (p.emu) {
      if ((config.bannedUsers || []).map(lc).includes(lc(actor))) return finish({ ok: false, message: 'This account can\'t get an enterprise account.' });
      const r = await emuProvision(actor, Number(p.actorId), actor);
      return finish({ ok: true, message: r.message });
    }
    const parsed = C.parseCommand(p.command);
    if (!parsed) return finish({ ok: false, message: 'Unknown action.' });
    // The Worker checked roles; check again here, from main's config.
    if (C.ADMIN_ONLY.has(parsed.cmd) && !admin) return finish({ ok: false, message: 'That needs a maintainer.' });
    if (C.OWNER_ONLY.has(parsed.cmd) && lc(actor) !== lc(owner)) return finish({ ok: false, message: 'That needs the owner.' });
    const as = { id: 0, user: { login: actor, type: 'User' }, author_association: lc(actor) === lc(owner) ? 'OWNER' : 'NONE', body: p.command };
    if (p.target) {
      const issue = await gh.get(`${R_}/issues/${Number(p.target)}`);
      if (issue.state !== 'open') return finish({ ok: false, message: `#${issue.number} is already closed.`, link: issue.html_url });
      await runIssueCommand(issue, as, parsed);
      const after = await gh.get(`${R_}/issues/${issue.number}`);
      const labels = after.labels.map((l) => l.name);
      return finish({
        ok: true,
        message: `\`${parsed.cmd}\` on #${issue.number}: now **${after.state === 'closed' ? (labels.includes('live') ? 'live 🎉' : 'closed') : labels.find((l) => STATE_LABELS.includes(l)) || 'updated'}**`,
        link: after.html_url,
      });
    }
    const text = await anywhereCommand({ ...parsed, by: actor, admin, kind: 'panel' });
    return finish(text === undefined ? { ok: false, message: `\`${parsed.cmd}\` needs a request or report.` } : { ok: !/^(Usage|Only|Can't|I opened|Not created|❌)/.test(text) && !/isn't (registered|banned|reserved|a maintainer|a hosted site|a GitHub account)/.test(text), message: text });
  } catch (e) {
    console.error(e);
    return finish({ ok: false, message: `Something broke: ${String(e.message).split('\n')[0].slice(0, 300)}`, link: runUrl });
  }
}

// ── Router ──────────────────────────────────────────────────────
async function onIssue(issue) {
  const labels = issue.labels.map((l) => l.name);
  if (labels.includes('request')) return onRequest(issue);
  if (labels.includes('transfer')) return onTransfer(issue);
  if (labels.includes('takedown')) return onTakedown(issue);
}

async function main() {
  const [mode, num] = (process.env.TARGET || process.argv.slice(2).join(' ')).trim().split(/\s+/);
  if (mode === 'pr') return reviewPR(Number(num));
  if (mode === 'health') return health();
  if (mode === 'bot-check') return console.log(await botCheck());
  if (mode === 'ops') return console.log(await ops({ by: 'manual' }));
  if (mode === 'issue') return onIssue(await gh.get(`${R_}/issues/${num}`));

  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event === 'pull_request_target') return reviewPR(payload.pull_request.number);
  if (event === 'schedule') return payload.schedule === '17 9 * * 1' ? health() : ops();
  if (event === 'issues') return onIssue(payload.issue);
  if (event === 'issue_comment') {
    if (payload.comment.user.type === 'Bot') return;
    return onIssueComment(payload.issue, payload.comment);
  }
  if (event === 'discussion_comment') return onDiscussionComment(payload);
  if (event === 'repository_dispatch' && payload.action === 'panel') return onPanel(payload.client_payload || {});
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { anywhereCommand };
