// The review engine: decides what happens to a subdomain request.
// Pure (no network, no git) so every rule is unit-tested; scripts/bot.js gathers the inputs.
'use strict';

const R = require('./rules');

const DAY = 86400000;
const lc = (s) => String(s || '').toLowerCase();

/** Outcomes, worst first. */
const VERDICTS = ['rejected', 'needs-changes', 'on-hold', 'ready'];
/** Labels the bot owns (it adds and removes these; maintainers own "manual-hold"). */
const STATE_LABELS = ['ready', 'needs-changes', 'on-hold', 'rejected'];
const REASON_LABELS = ['new-account', 'maybe-bot', 'nested', 'transfer', 'sensitive-name', 'pages-mismatch'];

/** The rows of the review table, in order. */
const CHECKS = {
  format: 'Format & records',
  ownership: 'Ownership',
  account: 'Account age',
  bot: 'Bot check',
  limit: 'Subdomains you own',
  name: 'Name check',
  target: 'Target is live',
  consent: 'Consent',
};

/** What a GitHub profile looks like to us. */
function profileSignals(profile, now) {
  const ageDays = Math.floor((now - Date.parse(profile.created_at)) / DAY);
  const isBot = profile.type === 'Bot' || /\[bot\]$/i.test(profile.login || '');
  const signals = [];
  if (!profile.public_repos) signals.push('no public repositories');
  if (!profile.followers) signals.push('no followers');
  if (!profile.name && !profile.bio) signals.push('empty profile');
  if (ageDays < 90) signals.push('account under 90 days old');
  if (/\d{4,}$/.test(profile.login || '')) signals.push('username ends in a long number');
  return { ageDays, isBot, botScore: signals.length, signals };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtAge = (d) => (d >= 730 ? `${Math.floor(d / 365)} years` : d >= 60 ? `${Math.floor(d / 30)} months` : plural(d, 'day'));
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Comments that look like "/approve", "/accept"…, by login. */
function consentsFrom(comments) {
  const out = { approve: new Set(), accept: new Set() };
  for (const c of comments || []) {
    const cmd = lc((c.body || '').trim().split(/\s/)[0]);
    const who = lc(c.user && c.user.login);
    if (cmd === '/approve') out.approve.add(who);
    if (cmd === '/accept') out.accept.add(who);
  }
  return out;
}

/** "domains/alice.json" → "alice", or null for anything else. */
const domainName = (file) => (/^domains\/[^/]+\.json$/.test(file) ? R.nameFromFile(file) : null);

/**
 * Review a pull request.
 *
 * input:
 *   author        PR author's login
 *   profile       GET /users/:author (type, created_at, public_repos, followers, name, bio)
 *   changes       [{ status: 'A'|'M'|'D', file }] between main and the PR
 *   base, head    { [name]: data } — main's domains/, and main + this PR's changes
 *   invalid       { [name]: message } files in the PR that aren't valid JSON
 *   comments      the PR's comments ({ user: { login }, body })
 *   labels        the PR's current label names
 *   dns           { [hostname]: true | false } whether CNAME/MX targets resolve (missing = unknown)
 *   reserved, config, maintainers, now
 *   overrideHolds a maintainer said /approve: holds don't block
 *
 * returns { verdict, findings: [{ check, level, text, waitingFor?, label? }], labels, autoMerge, existing, profile }
 *   level: 'pass' | 'info' | 'hold' | 'error' | 'reject'
 */
function review(input) {
  const {
    author, profile, changes, base, head, invalid = {}, comments = [], labels = [], dns = {},
    reserved = [], config = {}, maintainers = [], now = Date.now(), overrideHolds = false,
  } = input;
  const who = lc(author);
  const admins = maintainers.map(lc);
  const isMaintainer = admins.includes(who);
  const findings = [];
  const add = (check, level, text, extra = {}) => findings.push({ check, level, text, ...extra });
  const maxPerOwner = config.maxPerOwner ?? R.MAX_PER_OWNER;
  const consents = consentsFrom(comments);
  const approvedBy = (login) => consents.approve.has(lc(login)) || admins.some((m) => consents.approve.has(m));
  const acceptedBy = (login) => consents.accept.has(lc(login));

  // ── Who's asking ───────────────────────────────────────────────
  let sig = null;
  if (isMaintainer) {
    add('account', 'pass', 'Maintainer');
    add('bot', 'pass', 'Maintainer');
  } else if (!profile) {
    add('account', 'error', 'Could not look up your GitHub account. A maintainer will re-run the check.');
  } else {
    sig = profileSignals(profile, now);
    const rejectDays = config.rejectAccountsYoungerThanDays ?? 7;
    const holdDays = config.holdAccountsYoungerThanDays ?? 30;
    if ((config.bannedUsers || []).map(lc).includes(who)) {
      add('account', 'reject', 'This account is not allowed to request subdomains.');
    } else if (sig.ageDays < rejectDays) {
      const ok = Date.parse(profile.created_at) + rejectDays * DAY;
      add('account', 'reject', `Your account is ${fmtAge(sig.ageDays)} old. Accounts must be at least ${plural(rejectDays, 'day')} old: please try again on ${fmtDate(ok)}.`);
    } else if (sig.ageDays < holdDays) {
      add('account', 'hold', `Your account is ${fmtAge(sig.ageDays)} old, so a maintainer will take a look.`, { waitingFor: 'maintainer', label: 'new-account' });
    } else {
      add('account', 'pass', `${fmtAge(sig.ageDays)} old`);
    }

    if (sig.isBot) {
      add('bot', 'reject', 'Bot accounts cannot request subdomains.');
    } else if (sig.botScore >= (config.holdBotScoreAtLeast ?? 3)) {
      add('bot', 'hold', `Looks like it might be a throwaway account (${sig.signals.join(', ')}). A maintainer will take a look.`, { waitingFor: 'maintainer', label: 'maybe-bot' });
    } else {
      add('bot', 'pass', 'Looks like a real person');
    }
  }

  // ── What changed ───────────────────────────────────────────────
  const maxFiles = config.maxFilesPerRequest ?? 10;
  if (!changes.length) add('format', 'error', 'This pull request does not change anything.');
  if (changes.length > maxFiles && !isMaintainer) add('format', 'error', `Please change at most ${maxFiles} files per request.`);
  const touched = new Set();
  for (const { file } of changes) {
    const n = domainName(file);
    if (n) touched.add(n);
    else if (!isMaintainer) add('format', 'error', `\`${file}\`: only files in \`domains/\` can be changed in a request.`);
  }
  for (const [n, msg] of Object.entries(invalid)) add('format', 'error', `\`domains/${n}.json\` is not valid JSON: ${msg}`);

  // New problems in the tree, for names this PR touches (or whose parent it touches).
  const opts = { reserved, maintainers, maxPerOwner };
  const errKey = (n, e) => `${n}\u0000${e}`;
  const was = new Set(Object.entries(R.checkTree(base, opts)).flatMap(([n, es]) => es.map((e) => errKey(n, e))));
  for (const [n, es] of Object.entries(R.checkTree(head, opts))) {
    if (!touched.has(n) && !touched.has(R.baseOf(n))) continue;
    for (const e of es) {
      if (was.has(errKey(n, e))) continue;
      add(/limit is/.test(e) ? 'limit' : 'format', 'error', `\`${n}\`: ${e}`);
    }
  }

  // ── Per file: ownership, consent, names, targets ──────────────
  for (const { status, file } of changes) {
    const n = domainName(file);
    if (!n || invalid[n]) continue;
    const old = status === 'A' ? undefined : base[n];
    const now_ = status === 'D' ? undefined : head[n];
    const oldOwner = R.ownerOf(old);
    const newOwner = R.ownerOf(now_);
    const parent = R.baseOf(n) !== n ? R.baseOf(n) : null;
    const parentOwner = parent ? R.ownerOf(base[parent] || head[parent]) : null;

    if (!isMaintainer) {
      if (old && oldOwner !== who && !(status === 'D' && parentOwner === who)) {
        add('ownership', 'reject', `\`${n}\` belongs to @${oldOwner}. To ask for it, open a [transfer request](../issues/new?template=transfer.yml).`);
        continue;
      }
      if (status === 'A' && newOwner !== who) {
        add('ownership', 'error', `\`${n}\`: \`owner.github\` must be your username, \`${author}\`.`);
      }
    }

    // A name under someone else's subdomain needs their OK.
    if (status === 'A' && parentOwner && newOwner && parentOwner !== newOwner && !admins.includes(parentOwner)) {
      if (approvedBy(parentOwner)) add('consent', 'pass', `@${parentOwner} approved \`${n}\` under \`${parent}\``);
      else add('consent', 'hold', `\`${n}\` is under \`${parent}\`, which belongs to @${parentOwner}. @${parentOwner}, reply \`/approve\` to allow it.`, { waitingFor: parentOwner, label: 'nested' });
    }

    // Handing a name to someone else needs them to accept.
    if (status === 'M' && newOwner && oldOwner && newOwner !== oldOwner) {
      if (acceptedBy(newOwner)) add('consent', 'pass', `@${newOwner} accepted \`${n}\``);
      else add('consent', 'hold', `This hands \`${n}\` to @${newOwner}. @${newOwner}, reply \`/accept\` to take it.`, { waitingFor: newOwner, label: 'transfer' });
    }

    if (status === 'A' && !parent) {
      const word = (config.holdNamesContaining || []).find((w) => n.includes(lc(w)));
      if (word) add('name', 'hold', `\`${n}\` contains "${word}", which is often used for phishing. A maintainer will take a look.`, { waitingFor: 'maintainer', label: 'sensitive-name' });
    }

    if (now_ && now_.records) {
      const r = now_.records;
      const owner = newOwner || who;
      const pages = typeof r.CNAME === 'string' && r.CNAME.toLowerCase().match(/^([a-z0-9-]+)\.github\.io\.?$/);
      if (pages && pages[1] !== owner && !isMaintainer) {
        add('target', 'hold', `\`${n}\` points at ${pages[1]}.github.io, which isn't your GitHub Pages site (\`${owner}.github.io\`). If it's an organization you're part of, a maintainer will confirm.`, { waitingFor: 'maintainer', label: 'pages-mismatch' });
      }
      const targets = [];
      if (typeof r.CNAME === 'string') targets.push(r.CNAME);
      for (const mx of Array.isArray(r.MX) ? r.MX : []) targets.push(typeof mx === 'string' ? mx : mx && mx.host);
      for (const t of targets.filter(Boolean)) {
        const h = t.toLowerCase().replace(/\.$/, '');
        if (dns[h] === false) add('target', 'error', `\`${h}\` doesn't exist yet. Set up your site first so the name doesn't point at nothing.`);
        else if (dns[h] === true) add('target', 'pass', `\`${h}\` resolves`);
      }
    }
  }

  // ── What they already have ────────────────────────────────────
  const existing = R.namesOwnedBy(base, who);
  const after = R.namesOwnedBy(head, who);
  if (!findings.some((f) => f.check === 'limit')) {
    const list = existing.length ? ` (already: ${existing.map((x) => `\`${x}\``).join(', ')})` : '';
    add('limit', 'pass', isMaintainer ? `${after.length} (no limit for maintainers)` : `${after.length} of ${maxPerOwner}${list}`);
  }

  if (labels.includes('manual-hold')) add('consent', 'hold', 'A maintainer put this on hold.', { waitingFor: 'maintainer' });

  // Fill in passing rows for checks that found nothing.
  for (const check of Object.keys(CHECKS)) {
    if (findings.some((f) => f.check === check)) continue;
    const text = { format: 'Valid', ownership: 'Yours', name: 'OK', target: 'Nothing to check', consent: 'Nothing needed' }[check];
    if (text) add(check, 'pass', text);
  }

  // A maintainer's /approve clears every hold.
  if (overrideHolds) {
    for (const f of findings) if (f.level === 'hold') { f.level = 'pass'; f.text = `${f.text} (approved by a maintainer)`; delete f.label; }
  }

  // ── Verdict ───────────────────────────────────────────────────
  const has = (lvl) => findings.some((f) => f.level === lvl);
  let verdict = 'ready';
  if (has('reject')) verdict = 'rejected';
  else if (has('error')) verdict = 'needs-changes';
  else if (has('hold')) verdict = 'on-hold';

  const reasonLabels = [...new Set(findings.filter((f) => f.level === 'hold' && f.label).map((f) => f.label))];
  const autoMerge = verdict === 'ready' && !!config.autoMerge && !isMaintainer && !!sig && !sig.isBot &&
    sig.ageDays >= (config.autoMergeMinAccountAgeDays ?? 180) && sig.botScore === 0 && !has('hold');

  return { verdict, findings, labels: [verdict, ...reasonLabels], autoMerge, existing, profile: sig };
}

module.exports = { review, profileSignals, consentsFrom, VERDICTS, STATE_LABELS, REASON_LABELS, CHECKS, fmtAge, fmtDate };
