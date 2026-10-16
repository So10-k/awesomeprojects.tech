#!/usr/bin/env node
// The subdomain bot. Runs from .github/workflows/bot.yml on main's code only:
// pull requests are read as data (git objects + JSON.parse), never checked out or executed.
//
//   pull_request_target  review the request, label it, set the "subdomain-review" status, comment
//   issue_comment        /approve /accept /reject /hold /unhold /recheck /takedown /dismiss /help
//   issues               transfer and takedown requests (issue forms)
//   schedule             weekly health check for names that point at nothing
//
// Locally: GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo DRY_RUN=1 node scripts/bot.js pr 12
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const R = require('./rules');
const { review, STATE_LABELS, REASON_LABELS } = require('./review');
const { MARK, COMMANDS, reviewComment, simpleComment } = require('./comment');
const Q = require('./requests');
const { github, git, readTree, diff, checkTargets } = require('./lib');

const root = path.join(__dirname, '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const config = readJson('config.json');
const reserved = readJson('reserved.json');
const repo = process.env.GITHUB_REPOSITORY;
const [owner] = repo.split('/');
const maintainers = [owner, ...(config.maintainers || [])].map((s) => s.toLowerCase());
const dryRun = !!process.env.DRY_RUN;
const gh = github(process.env.GITHUB_TOKEN, { dryRun });
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;

const lc = (s) => String(s || '').toLowerCase();
const isMaintainer = (login) => maintainers.includes(lc(login));
const R_ = `/repos/${repo}`;
const humans = (comments) => comments.filter((c) => c.user && c.user.type !== 'Bot');

// ── Small GitHub helpers ────────────────────────────────────────
async function upsertComment(number, kind, body) {
  const comments = await gh.all(`${R_}/issues/${number}/comments`);
  const mine = comments.find((c) => c.user && c.user.type === 'Bot' && (c.body || '').startsWith(MARK(kind)));
  if (mine) return gh.patch(`${R_}/issues/comments/${mine.id}`, { body });
  return gh.post(`${R_}/issues/${number}/comments`, { body });
}
const reply = (number, body) => gh.post(`${R_}/issues/${number}/comments`, { body });
const react = (commentId, content) => gh.post(`${R_}/issues/comments/${commentId}/reactions`, { content }).catch(() => {});

async function setLabels(number, current, wanted, managed) {
  for (const l of current) {
    if (managed.includes(l) && !wanted.includes(l)) await gh.del(`${R_}/issues/${number}/labels/${encodeURIComponent(l)}`).catch(() => {});
  }
  const add = wanted.filter((l) => !current.includes(l));
  if (add.length) await gh.post(`${R_}/issues/${number}/labels`, { labels: add });
}

const close = (number, reason = 'completed') => gh.patch(`${R_}/issues/${number}`, { state: 'closed', state_reason: reason });
const deploy = () => gh.post(`${R_}/actions/workflows/deploy.yml/dispatches`, { ref: 'main' });

function fetchRefs(...specs) {
  git(['fetch', '--no-tags', '--quiet', 'origin', ...specs]);
}
function mainTree() {
  fetchRefs('+refs/heads/main:refs/bot/main');
  return readTree('refs/bot/main');
}

// ── Pull requests ───────────────────────────────────────────────
async function reviewPR(number, { overrideHolds = false } = {}) {
  const pr = await gh.get(`${R_}/pulls/${number}`);
  if ((pr.state !== 'open' && !dryRun) || pr.base.ref !== 'main') return null;

  fetchRefs('+refs/heads/main:refs/bot/main', `+refs/pull/${number}/head:refs/bot/pr`);
  const mergeBase = git(['merge-base', 'refs/bot/main', 'refs/bot/pr']).trim();
  const main = readTree('refs/bot/main');
  const head_ = readTree('refs/bot/pr');

  // main + this PR's changes (so files merged since the PR branched still count).
  const base = main.entries;
  const head = { ...base };
  const invalid = {};
  const changes = [];
  for (const c of diff(mergeBase, 'refs/bot/pr')) {
    const n = /^domains\/[^/]+\.json$/.test(c.file) ? R.nameFromFile(c.file) : null;
    if (!n) { changes.push(c); continue; }
    if (c.status === 'D') { delete head[n]; changes.push({ status: 'D', file: c.file }); continue; }
    if (head_.invalid[n]) { invalid[n] = head_.invalid[n]; delete head[n]; } else head[n] = head_.entries[n];
    changes.push({ status: base[n] ? 'M' : 'A', file: c.file });
  }

  // PRs the bot opened itself (transfers, takedowns) are reviewed like a maintainer's.
  const author = pr.user.type === 'Bot' ? owner : pr.user.login;
  const profile = await gh.get(`/users/${author}`).catch(() => null);
  const comments = humans(await gh.all(`${R_}/issues/${number}/comments`));
  const labels = pr.labels.map((l) => l.name);
  const changed = changes.map((c) => head[R.nameFromFile(c.file)]).filter(Boolean);
  const dns = await checkTargets(changed);

  const result = review({
    author, profile, changes, base, head, invalid, comments, labels, dns,
    reserved, config, maintainers, overrideHolds,
  });
  console.log(`PR #${number} by ${author}: ${result.verdict}`);
  for (const f of result.findings) console.log(`  ${f.level.padEnd(6)} ${f.check}: ${f.text}`);

  const state = { ready: 'success', 'on-hold': 'pending', 'needs-changes': 'failure', rejected: 'failure' }[result.verdict];
  const description = {
    ready: 'Ready for a maintainer', 'on-hold': 'On hold', 'needs-changes': 'Needs changes', rejected: 'Not accepted',
  }[result.verdict];
  await gh.post(`${R_}/statuses/${pr.head.sha}`, { state, context: 'subdomain-review', description, target_url: runUrl });
  await setLabels(number, labels, result.labels, [...STATE_LABELS, ...REASON_LABELS]);
  await upsertComment(number, 'review', reviewComment(result, { autoMerging: result.autoMerge }));

  if (result.verdict === 'rejected') await close(number, 'not_planned');
  else if (result.autoMerge && !overrideHolds) await mergePR(pr, result);
  return { pr, result };
}

async function mergePR(pr, result) {
  try {
    await gh.put(`${R_}/pulls/${pr.number}/merge`, { merge_method: 'squash', sha: pr.head.sha });
  } catch (e) {
    await reply(pr.number, `⚠️ I couldn't merge this automatically (${e.message}). A maintainer will merge it by hand.`);
    return false;
  }
  await deploy();
  if (result) await upsertComment(pr.number, 'review', reviewComment(result, { merged: true }));
  return true;
}

async function onPullRequestComment(number, comment, cmd, arg) {
  const by = comment.user.login;
  const admin = isMaintainer(by) || comment.author_association === 'OWNER';
  const adminOnly = ['/reject', '/hold', '/unhold'];
  if (adminOnly.includes(cmd) && !admin) return react(comment.id, 'confused');

  switch (cmd) {
    case '/approve': {
      await react(comment.id, 'eyes');
      const res = await reviewPR(number, { overrideHolds: admin });
      if (!res || !admin) return; // non-maintainers: their approval is a consent, read by the review
      if (res.result.verdict === 'ready') await mergePR(res.pr, res.result);
      else await reply(number, `@${by} I can't merge this yet: it's **${res.result.verdict}** (see the checks above).`);
      return;
    }
    case '/accept':
    case '/recheck':
      await react(comment.id, 'eyes');
      return reviewPR(number);
    case '/reject': {
      const pr = await gh.get(`${R_}/pulls/${number}`);
      await gh.post(`${R_}/statuses/${pr.head.sha}`, { state: 'failure', context: 'subdomain-review', description: 'Rejected by a maintainer' });
      await setLabels(number, pr.labels.map((l) => l.name), ['rejected'], [...STATE_LABELS, ...REASON_LABELS]);
      await upsertComment(number, 'review', simpleComment('review', '⛔ Not accepted', arg ? `A maintainer closed this request:\n\n> ${arg}` : 'A maintainer closed this request.'));
      return close(number, 'not_planned');
    }
    case '/hold':
      await gh.post(`${R_}/issues/${number}/labels`, { labels: ['manual-hold'] });
      if (arg) await reply(number, `⏸️ On hold: ${arg}`);
      return reviewPR(number);
    case '/unhold':
      await gh.del(`${R_}/issues/${number}/labels/manual-hold`).catch(() => {});
      return reviewPR(number);
    case '/help':
      return reply(number, COMMANDS.replace('<details>', '<details open>'));
    default:
  }
}

// ── Bot-made changes (transfers, takedowns) ─────────────────────
async function botChange({ issue, title, body, changes }) {
  const sha = (await gh.get(`${R_}/git/ref/heads/main`)).object.sha;
  const branch = `bot/issue-${issue}`;
  await gh.post(`${R_}/git/refs`, { ref: `refs/heads/${branch}`, sha })
    .catch(() => gh.patch(`${R_}/git/refs/heads/${branch}`, { sha, force: true }));
  for (const c of changes) {
    const existing = await gh.get(`${R_}/contents/${c.file}?ref=${branch}`).catch(() => null);
    const message = `${title} (#${issue})`;
    if (c.content === null) {
      if (existing) await gh.del(`${R_}/contents/${c.file}`, { message, sha: existing.sha, branch });
    } else {
      await gh.put(`${R_}/contents/${c.file}`, {
        message, branch, content: Buffer.from(c.content).toString('base64'), ...(existing ? { sha: existing.sha } : {}),
      });
    }
  }
  const pr = await gh.post(`${R_}/pulls`, { title, head: branch, base: 'main', body: `${body}\n\nCloses #${issue}` });
  const merged = await mergePR(pr, null);
  return { pr, merged };
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
    issue: issue.number,
    title: `Transfer ${plan.name} to @${plan.to}`,
    body: `Transfer of \`${plan.name}\` from @${plan.from} to @${plan.to}, approved by both in #${issue.number}.`,
    changes: plan.changes,
  });
  await upsertComment(issue.number, 'transfer', simpleComment('transfer', merged ? '🎉 Transferred' : '✅ Approved: waiting for a maintainer to merge',
    `\`${plan.name}\` ${merged ? 'now belongs to' : 'will belong to'} @${plan.to} (#${pr.number}). The DNS records stay the same, so edit \`domains/${plan.name}.json\` in a new PR to point it somewhere else.`));
  if (merged) await close(issue.number);
}

// ── Takedowns ───────────────────────────────────────────────────
async function removeName(issue, plan, why) {
  const { pr, merged } = await botChange({
    issue: issue.number,
    title: `Remove ${plan.name}`,
    body: `Removes \`${plan.name}\`${plan.changes.length > 1 ? ' and everything under it' : ''}: ${why}`,
    changes: plan.changes,
  });
  await upsertComment(issue.number, 'takedown', simpleComment('takedown', merged ? '🧹 Removed' : '✅ Approved: waiting for a maintainer to merge',
    `\`${plan.name}.${R.DOMAIN}\` ${merged ? 'is gone; DNS updates in a few minutes' : 'will be removed'} (#${pr.number}).`));
  if (merged) await close(issue.number);
}

async function onTakedown(issue, comment, cmd, arg) {
  if (issue.state !== 'open') return;
  const { entries } = mainTree();
  const form = Q.parseForm(issue.body);
  const plan = Q.planTakedown({ form, author: issue.user.login, entries });
  const by = comment ? comment.user.login : issue.user.login;
  const admin = isMaintainer(by) || (comment && comment.author_association === 'OWNER');

  if (cmd === '/dismiss') {
    if (!admin) return react(comment.id, 'confused');
    await upsertComment(issue.number, 'takedown', simpleComment('takedown', 'Closed without changes', arg ? `> ${arg}` : 'A maintainer reviewed this and is leaving the subdomain up.'));
    return close(issue.number, 'not_planned');
  }
  if (plan.problems.length) {
    return upsertComment(issue.number, 'takedown', simpleComment('takedown', '✏️ Can\'t find that subdomain', plan.problems.join('\n')));
  }
  if (cmd === '/takedown') {
    const owns = lc(by) === plan.owner || plan.byOwner && lc(by) === lc(issue.user.login);
    if (!admin && !owns) return react(comment.id, 'confused');
    await react(comment.id, 'rocket');
    return removeName(issue, plan, admin ? `taken down by a maintainer${arg ? `: ${arg}` : ''}` : 'removed by its owner');
  }
  if (plan.byOwner && !comment) return removeName(issue, plan, 'removed by its owner');
  if (comment) return;

  // A report: summarize it for the maintainers and let the owner know.
  const r = plan.records || {};
  const target = typeof r.CNAME === 'string' ? r.CNAME : (r.A || r.AAAA || []).join(', ') || '(TXT/MX only)';
  const dns = typeof r.CNAME === 'string' ? await checkTargets([{ records: r }]) : {};
  const alive = typeof r.CNAME === 'string' ? (dns[r.CNAME.toLowerCase().replace(/\.$/, '')] === false ? '❌ doesn\'t resolve' : '✅ resolves') : '—';
  const label = { phishing: 'abuse', malware: 'abuse', impersonation: 'abuse', dangling: 'dangling' }[plan.reason];
  if (label) await gh.post(`${R_}/issues/${issue.number}/labels`, { labels: [label] });
  await upsertComment(issue.number, 'takedown', simpleComment('takedown', `🚩 Report for \`${plan.name}\``,
    `| | |\n|---|---|\n| **Owner** | @${plan.owner} |\n| **Points at** | \`${target}\` |\n| **Target** | ${alive} |\n| **Reason** | ${Q.TAKEDOWN_REASONS[plan.reason]} |\n\n` +
    `@${plan.owner}, someone reported your subdomain. If you'd like to respond, comment here.\n\n` +
    `**Maintainers:** \`/takedown <note>\` removes it (and anything under it) right away; \`/dismiss <reason>\` closes this report.`));
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
    return;
  }
  const rows = dead.map(([n, d]) => `| \`${n}\` | @${R.ownerOf(d)} | \`${d.records.CNAME}\` |`).join('\n');
  const body = `${MARK('health')}\nThese subdomains point at hostnames that don't exist. Someone else could claim the target and take the name over, so please fix or remove yours.\n\n| Subdomain | Owner | Points at |\n|---|---|---|\n${rows}\n\n` +
    `Owners: update the target, or open a [takedown request](../issues/new?template=takedown.yml) ("I own it and want it removed"). Maintainers can remove leftovers after ${config.consentTimeoutDays ?? 30} days.\n\n_Last checked ${new Date().toISOString().slice(0, 10)}._`;
  if (issue) await gh.patch(`${R_}/issues/${issue.number}`, { body });
  else await gh.post(`${R_}/issues`, { title: '🩺 Subdomains pointing at nothing', body, labels: ['health'] });
}

// ── Router ──────────────────────────────────────────────────────
async function main() {
  const [mode, num] = (process.env.TARGET || process.argv.slice(2).join(' ')).trim().split(/\s+/);
  if (mode === 'pr') return reviewPR(Number(num));
  if (mode === 'health') return health();
  if (mode === 'issue') {
    const issue = await gh.get(`${R_}/issues/${num}`);
    const labels = issue.labels.map((l) => l.name);
    if (labels.includes('transfer')) return onTransfer(issue);
    if (labels.includes('takedown')) return onTakedown(issue);
    return;
  }

  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event === 'pull_request_target') return reviewPR(payload.pull_request.number);
  if (event === 'schedule') return health();
  if (event === 'issues') {
    const labels = payload.issue.labels.map((l) => l.name);
    if (labels.includes('transfer')) return onTransfer(payload.issue);
    if (labels.includes('takedown')) return onTakedown(payload.issue);
    return;
  }
  if (event === 'issue_comment') {
    const { comment, issue } = payload;
    if (comment.user.type === 'Bot') return;
    const m = (comment.body || '').trim().match(/^(\/[a-z-]+)\b[ \t]*(.*)/i);
    if (!m) return;
    const cmd = m[1].toLowerCase();
    const arg = m[2].trim().slice(0, 500);
    if (issue.pull_request) return onPullRequestComment(issue.number, comment, cmd, arg);
    const labels = issue.labels.map((l) => l.name);
    if (labels.includes('transfer') && ['/approve', '/accept', '/recheck'].includes(cmd)) return onTransfer(issue);
    if (labels.includes('takedown') && ['/takedown', '/dismiss'].includes(cmd)) return onTakedown(issue, comment, cmd, arg);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
