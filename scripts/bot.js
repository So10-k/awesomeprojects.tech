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
async function activityLog(line) {
  console.log(`[log] ${line}`);
  if (dryRun) return;
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
async function reviewPR(number, { overrideHolds = false } = {}) {
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
    reserved, config, maintainers, overrideHolds, extra: rc.findings, pagesOwners: rc.pagesOwners,
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
  if (result) await upsertComment(pr.number, 'review', reviewComment(result, { merged: true }));
  return true;
}

async function onPullRequestComment(number, comment, cmd, rest) {
  const by = comment.user.login;
  const admin = isAdmin(by, comment.author_association);
  switch (cmd) {
    case '/approve': {
      await react(comment.id, 'eyes');
      const res = await reviewPR(number, { overrideHolds: admin });
      if (!res || !admin) return; // non-maintainers: their approval is a consent, read by the review
      if (res.result.verdict !== 'ready') return reply(number, `@${by} I can't merge this yet: it's **${res.result.verdict}** (see the checks above).`);
      if (await mergePR(res.pr, res.result)) await activityLog(`✅ **Approved** PR #${number} by @${res.pr.user.login} · by @${by}`);
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
async function onRequest(issue, { comment, cmd } = {}) {
  if (issue.state !== 'open') return;
  const author = issue.user.login;
  const by = comment ? comment.user.login : author;
  const admin = comment ? isAdmin(by, comment.author_association) : false;
  const approving = admin && cmd === '/approve';
  const labels = issue.labels.map((l) => l.name);
  const built = P.buildRequest(Q.parseForm(issue.body), author);
  const { name } = built;
  const say = (result, opts) => upsertComment(issue.number, 'request', requestComment(result, { name, domain: R.DOMAIN, ...opts }));

  if (config.locked && !isMaintainer(author) && !approving) {
    await setLabels(issue.number, labels, ['on-hold']);
    return say(null, { locked: config.locked });
  }

  const { entries } = mainTree();
  const problems = [...built.problems];
  const taken = name && entries[name] && R.ownerOf(entries[name]) !== lc(author) && !isMaintainer(author);
  if (taken) problems.push(`\`${name}\` is taken by @${R.ownerOf(entries[name])}. Pick another name, or [ask for it](${repoUrl}/issues/new?template=transfer.yml&title=${encodeURIComponent(`Transfer: ${name}`)}&subdomain=${encodeURIComponent(name)}).`);
  if (problems.length) {
    await setLabels(issue.number, labels, ['needs-changes']);
    return say(null, { problems });
  }

  const file = `domains/${name}.json`;
  const exists = !!entries[name];
  const head = { ...entries, [name]: built.entry };
  const profile = await gh.get(`/users/${author}`).catch(() => null);
  const comments = humans(await gh.all(`${R_}/issues/${issue.number}/comments`));
  const rc = await repoChecks(built.entry, author);
  const dns = await checkTargets([built.entry]);
  const result = review({
    author, profile, changes: [{ status: exists ? 'M' : 'A', file }], base: entries, head, comments, labels, dns,
    reserved, config, maintainers, overrideHolds: approving, extra: rc.findings, pagesOwners: rc.pagesOwners,
  });
  console.log(`request #${issue.number} ${name} by ${author}: ${result.verdict}`);
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

  const { pr, merged } = await botChange({
    title: `${exists ? 'Update' : 'Add'} ${name}`,
    body: `Requested by @${author} in #${issue.number}; ${approving ? `approved by @${by}` : 'auto-approved'}.`,
    changes: [{ file, content: JSON.stringify(built.entry, null, 2) + '\n' }],
    tag: `request-${issue.number}`,
  });
  if (!merged) return say(result, { entry: built.entry, plan: rc.plan });
  const guide = P.setupGuide({ provider: built.provider, name, repo: built.entry.site && built.entry.site.repo, branch: rc.branch, sourceRepo: repo });
  await say(result, { live: true, guide, prUrl: pr.html_url });
  await setLabels(issue.number, result.labels, ['live'], [...MANAGED, 'live']);
  await activityLog(`✅ **${exists ? 'Updated' : 'Added'}** \`${name}.${R.DOMAIN}\` for @${author} · ${approving ? `approved by @${by}` : 'auto-approved'} · #${issue.number} → #${pr.number}`);
  return close(issue.number, 'completed');
}

async function onRequestComment(issue, comment, cmd, rest) {
  const by = comment.user.login;
  const admin = isAdmin(by, comment.author_association);
  switch (cmd) {
    case '/approve':
    case '/accept':
    case '/recheck':
      await react(comment.id, 'eyes');
      return onRequest(issue, { comment, cmd });
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
    case '/ban': case '/unban': case '/limit': case '/reserve': case '/unreserve': case '/lock': case '/unlock': case '/promote': case '/demote': {
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
      return `${edit.message} (#${pr.number}).`;
    }
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

// ── Panel actions (repository_dispatch from api.awesomeprojects.tech) ──
/** Tell the panel how it went. `job` is the dispatch payload (id, actor, at, summary). */
async function reportResult(job, { ok, message, link }) {
  console.log(`panel result ${job.id}: ${ok ? 'ok' : 'error'}: ${String(message).split('\n')[0]}`);
  const api = process.env.PANEL_API;
  const secret = String(process.env.PANEL_BOT_SECRET || '').trim();
  if (!api || !secret || dryRun) return;
  const body = JSON.stringify({ id: job.id, actor: job.actor, at: job.at, summary: job.summary, ok, message, link });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${api}/bot/result`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'User-Agent': 'awesomeprojects-bot' },
        body,
      });
      console.log(`panel: reported (${res.status})`);
      if (res.ok) return;
      if (res.status === 401) return console.warn('panel: the Worker rejected the bot secret (PANEL_BOT_SECRET differs from the Worker\'s BOT_SECRET?)');
    } catch (e) {
      console.warn(`panel: couldn't report (${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

/** Change where one of your names points, from the "My domains" panel. Same checks as a request. */
async function selfUpdate(u, actor) {
  const built = P.buildRequest({
    Subdomain: u.name, 'Where should it point?': u.provider, 'GitHub repository': u.repo || '', Target: u.target || '', Description: u.description || '',
  }, actor);
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
    reserved, config, maintainers, extra: rc.findings, pagesOwners: rc.pagesOwners,
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

async function onPanel(p) {
  const id = String(p.id || '');
  const actor = String(p.actor || '');
  const admin = isMaintainer(actor);
  const finish = (r) => reportResult(p, r);
  try {
    if (!id || !actor) return console.warn('panel: missing id/actor');
    if (p.update) return finish(await selfUpdate(p.update, actor));
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
    return finish(text === undefined ? { ok: false, message: `\`${parsed.cmd}\` needs a request or report.` } : { ok: !/^(Usage|Only|Can't|I opened)/.test(text) && !/isn't (registered|banned|reserved|a maintainer)/.test(text), message: text });
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
  if (mode === 'issue') return onIssue(await gh.get(`${R_}/issues/${num}`));

  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event === 'pull_request_target') return reviewPR(payload.pull_request.number);
  if (event === 'schedule') return health();
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
