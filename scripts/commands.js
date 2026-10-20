// Slash commands: the catalog (for /help and the docs), parsing, and the read-only answers.
// Pure: the bot does the I/O.
'use strict';

const R = require('./rules');

const lc = (s) => String(s || '').trim().toLowerCase();

/**
 * where: 'any' = any issue, PR or discussion · 'request' = request issues & PRs ·
 *        'report' = takedown reports · 'transfer' = transfer issues
 */
const CATALOG = [
  // Everyone
  { cmd: '/help', who: 'everyone', where: 'any', usage: '/help', does: 'Show this list' },
  { cmd: '/available', who: 'everyone', where: 'any', usage: '/available <name>', does: 'Is a name free?' },
  { cmd: '/whois', who: 'everyone', where: 'any', usage: '/whois <name>', does: 'Who owns a name and where it points' },
  { cmd: '/mine', who: 'everyone', where: 'any', usage: '/mine', does: 'List your subdomains' },
  { cmd: '/verify', who: 'everyone', where: 'any', usage: '/verify <name>', does: 'Check DNS and HTTPS for a name, right now' },
  { cmd: '/stats', who: 'everyone', where: 'any', usage: '/stats', does: 'Numbers: names, owners, hosts' },
  { cmd: '/recheck', who: 'everyone', where: 'request', usage: '/recheck', does: 'Run the checks on this request again' },
  { cmd: '/cancel', who: 'requester', where: 'request', usage: '/cancel', does: 'Close your own request' },
  { cmd: '/txt', who: 'owner', where: 'issues', usage: '/txt <name> <label> <value>', does: 'Add a verification TXT under your name, e.g. `/txt alice _vercel vc-domain-verify=…`' },
  { cmd: '/remove', who: 'owner', where: 'issues', usage: '/remove <name>', does: 'Remove one of your names (and everything under it)' },
  { cmd: '/transfer', who: 'owner', where: 'any', usage: '/transfer <name> @user', does: 'Start handing a name to someone' },
  { cmd: '/approve', who: 'parent owner · current owner', where: 'request', usage: '/approve', does: 'Allow a name under yours, or approve handing yours over' },
  { cmd: '/accept', who: 'new owner', where: 'transfer', usage: '/accept', does: 'Accept a name someone is handing you' },
  // Maintainers
  { cmd: '/approve', who: 'maintainer', where: 'request', usage: '/approve', does: 'Approve and go live now (clears holds)', admin: true },
  { cmd: '/approve', who: 'maintainer', where: 'request', usage: '/approve force', does: 'Approve and override the automated blockers too (limits, reserved names, account checks, seats). Broken records and other people\'s names still can\'t pass.', admin: true },
  { cmd: '/create', who: 'maintainer', where: 'issues', usage: '/create <name> @user <host> [target|repo|template] [force]', does: 'Make a name for someone. Host: hosted, github, vercel, netlify, cloudflare, render, railway, fly, cname, server. Add "force" to skip the automated blockers.', admin: true },
  { cmd: '/make-repo', who: 'maintainer', where: 'issues', usage: '/make-repo <repo> @user [template]', does: 'Make a private repo in the sites org for someone (no domain), from a template', admin: true },
  { cmd: '/reject', who: 'maintainer', where: 'request', usage: '/reject <reason>', does: 'Close a request with a reason', admin: true },
  { cmd: '/hold', who: 'maintainer', where: 'request', usage: '/hold <reason>', does: 'Pause a request', admin: true },
  { cmd: '/unhold', who: 'maintainer', where: 'request', usage: '/unhold', does: 'Resume it', admin: true },
  { cmd: '/takedown', who: 'maintainer', where: 'issues', usage: '/takedown <name> <note>', does: 'Remove a name (and everything under it) right now. On a report the name is optional.', admin: true },
  { cmd: '/dismiss', who: 'maintainer', where: 'report', usage: '/dismiss <reason>', does: 'Close a report without changes', admin: true },
  { cmd: '/ban', who: 'maintainer', where: 'issues', usage: '/ban @user <reason>', does: 'Auto-reject everything from an account', admin: true },
  { cmd: '/unban', who: 'maintainer', where: 'issues', usage: '/unban @user', does: 'Lift a ban', admin: true },
  { cmd: '/limit', who: 'maintainer', where: 'issues', usage: '/limit @user <n>', does: 'Give an account a different limit', admin: true },
  { cmd: '/reserve', who: 'maintainer', where: 'issues', usage: '/reserve <name>', does: 'Make a name off-limits', admin: true },
  { cmd: '/unreserve', who: 'maintainer', where: 'issues', usage: '/unreserve <name>', does: 'Free a reserved name', admin: true },
  { cmd: '/lock', who: 'maintainer', where: 'issues', usage: '/lock <reason>', does: 'Pause all new requests (shown to requesters)', admin: true },
  { cmd: '/unlock', who: 'maintainer', where: 'issues', usage: '/unlock', does: 'Resume requests', admin: true },
  { cmd: '/deploy', who: 'maintainer', where: 'any', usage: '/deploy', does: 'Push DNS and rebuild the website now', admin: true },
  { cmd: '/site', who: 'maintainer', where: 'issues', usage: '/site <name> <active|locked|suspended|archived>', does: 'Change a hosted site\'s status: locked = owner read-only, suspended = also DNS off, archived = repo archived', admin: true },
  { cmd: '/site-sync', who: 'maintainer', where: 'issues', usage: '/site-sync <name>', does: 'Re-apply the standard repo setup (settings, workflow, Pages, access)', admin: true },
  { cmd: '/repo-access', who: 'maintainer', where: 'issues', usage: '/repo-access <name> @user <read|write|maintain|none>', does: 'Give someone access to a hosted site\'s repo (uses a seat). Prefer /access.', admin: true },
  { cmd: '/access', who: 'owner', where: 'issues', usage: '/access <name> <read|triage|write> @user', does: 'Grant one standing permission on your site to someone\'s everyday account' },
  { cmd: '/access', who: 'maintainer', where: 'issues', usage: '/access <name> <read|triage|write|security|maintain|admin> [hours]', does: 'Elevate your duty account on one repo, for the shortest time that covers the job', admin: true },
  { cmd: '/access-list', who: 'owner', where: 'any', usage: '/access-list [name]', does: 'Show standing grants and elevations, including who asked and when they expire' },
  { cmd: '/access-revoke', who: 'owner', where: 'issues', usage: '/access-revoke <id>', does: 'End a grant now. The owner, the person who asked, or a maintainer can do this.' },
  { cmd: '/ops-account', who: 'maintainer', where: 'issues', usage: '/ops-account', does: 'Create your separate duty account. It can see no repository until you elevate it.', admin: true },
  { cmd: '/access-approve', who: 'owner', where: 'issues', usage: '/access-approve <id>', does: 'Approve a pending elevation (admin, and maintain when a maintainer asked)', admin: true, owner: true },
  { cmd: '/access-deny', who: 'owner', where: 'issues', usage: '/access-deny <id>', does: 'Deny a pending elevation', admin: true, owner: true },
  { cmd: '/redeploy', who: 'owner', where: 'issues', usage: '/redeploy <name>', does: 'Rebuild and redeploy your hosted site now' },
  { cmd: '/site-collab', who: 'owner', where: 'issues', usage: '/site-collab <name> @user <add|remove>', does: 'Add or remove a collaborator on your hosted repo (limited per site)' },
  { cmd: '/suspend-user', who: 'maintainer', where: 'issues', usage: '/suspend-user @user <reason>', does: 'Ban an account and suspend every site it hosts', admin: true },
  { cmd: '/announce', who: 'maintainer', where: 'issues', usage: '/announce <text|off>', does: 'Show a banner on the website and dashboards', admin: true },
  { cmd: '/ops', who: 'maintainer', where: 'any', usage: '/ops', does: 'Run the daily site checks now (HTTPS, deploys, size, inactivity, seats)', admin: true },
  { cmd: '/seats', who: 'maintainer', where: 'any', usage: '/seats', does: 'How many enterprise seats hosted sites use', admin: true },
  { cmd: '/emu-create', who: 'maintainer', where: 'issues', usage: '/emu-create @user', does: 'Create a managed enterprise account for someone (they sign in with their GitHub)', admin: true },
  { cmd: '/emu-suspend', who: 'maintainer', where: 'issues', usage: '/emu-suspend @user', does: 'Suspend someone\'s managed enterprise account', admin: true },
  { cmd: '/emu-restore', who: 'maintainer', where: 'issues', usage: '/emu-restore @user', does: 'Re-activate a suspended managed account', admin: true },
  { cmd: '/config', who: 'owner', where: 'issues', usage: '/config <setting> <value>', does: 'Change a bot setting (limits, holds, auto-merge…) (owner only)', admin: true, owner: true },
  { cmd: '/org-setup', who: 'owner', where: 'issues', usage: '/org-setup', does: 'Apply the org\'s safe defaults, rulesets, Actions policy and maintainers team (owner only)', admin: true, owner: true },
  { cmd: '/bot-check', who: 'owner', where: 'issues', usage: '/bot-check', does: 'Check the bot account\'s token and org role (owner only)', admin: true, owner: true },
  { cmd: '/promote', who: 'owner', where: 'issues', usage: '/promote @user [@mentor]', does: 'Add someone as a trainee maintainer, on probation (owner only)', admin: true, owner: true },
  { cmd: '/demote', who: 'owner', where: 'issues', usage: '/demote @user', does: 'Remove a maintainer (owner only)', admin: true, owner: true },
  { cmd: '/health', who: 'maintainer', where: 'any', usage: '/health', does: 'Run the dangling-name check now', admin: true },
  { cmd: '/cosign', who: 'maintainer', where: 'any', usage: '/cosign <id>', does: 'Confirm a trainee\'s action (two-person rule). The bot posts the id.', admin: true },
  { cmd: '/duty', who: 'maintainer', where: 'any', usage: '/duty', does: 'Who is on duty now and next', admin: true },
  { cmd: '/duty-take', who: 'maintainer', where: 'any', usage: '/duty-take [hours]', does: 'Go on duty now (8 hours, at most 24). On duty you can elevate up to write by yourself, and new queue items come to you first.', admin: true },
  { cmd: '/duty-end', who: 'maintainer', where: 'any', usage: '/duty-end', does: 'End your duty shift now', admin: true },
  { cmd: '/duty-plan', who: 'lead', where: 'any', usage: '/duty-plan @a @b @c [weeks]', does: 'Plan a weekly rotation from next Monday (lead)', admin: true },
  { cmd: '/claim', who: 'maintainer', where: 'queue', usage: '/claim', does: 'Take this queue item', admin: true },
  { cmd: '/assign', who: 'maintainer', where: 'queue', usage: '/assign @user', does: 'Give this queue item to someone', admin: true },
  { cmd: '/unassign', who: 'maintainer', where: 'queue', usage: '/unassign', does: 'Hand this queue item back; it goes to someone else', admin: true },
  { cmd: '/triage', who: 'maintainer', where: 'queue', usage: '/triage <note>', does: 'Mark this queue item looked at, with a note', admin: true },
  { cmd: '/vote', who: 'maintainer', where: 'queue', usage: '/vote yes|no [note]', does: 'Vote on a maintainer application', admin: true },
  { cmd: '/rank', who: 'owner', where: 'issues', usage: '/rank @user <trainee|maintainer|lead>', does: 'Change a maintainer\'s rank (owner only)', admin: true, owner: true },
  { cmd: '/roleset', who: 'owner', where: 'issues', usage: '/roleset @user +abuse -docs', does: 'Change a maintainer\'s areas: reviewer, abuse, hosting, infra, docs (owner only)', admin: true, owner: true },
];

const KNOWN = new Set(CATALOG.map((c) => c.cmd));
const ADMIN_ONLY = new Set(['/reject', '/hold', '/unhold', '/dismiss', '/ban', '/unban', '/limit', '/reserve', '/unreserve', '/lock', '/unlock', '/deploy', '/health', '/promote', '/demote', '/site', '/site-sync', '/repo-access', '/org-setup', '/bot-check', '/config', '/suspend-user', '/announce', '/ops', '/seats', '/create', '/make-repo', '/emu-create', '/emu-suspend', '/emu-restore', '/ops-account', '/access-approve', '/access-deny', '/cosign', '/rank', '/roleset']);
const OWNER_ONLY = new Set(['/promote', '/demote', '/rank', '/roleset', '/org-setup', '/bot-check', '/config', '/access-approve', '/access-deny']);

/** Settings /config may change, and how to read the value. */
const SETTINGS = {
  maxPerOwner: { type: 'int', min: 1, max: 50, help: 'names per person' },
  maxFilesPerRequest: { type: 'int', min: 1, max: 50, help: 'files per pull request' },
  rejectAccountsYoungerThanDays: { type: 'int', min: 0, max: 365, help: 'reject accounts younger than this' },
  holdAccountsYoungerThanDays: { type: 'int', min: 0, max: 730, help: 'hold accounts younger than this' },
  holdBotScoreAtLeast: { type: 'int', min: 1, max: 6, help: 'throwaway signals that trigger a hold (6 = never)' },
  autoMerge: { type: 'bool', help: 'merge ready requests without a maintainer' },
  autoMergeMinAccountAgeDays: { type: 'int', min: 0, max: 3650, help: 'minimum account age for auto-merge' },
  consentTimeoutDays: { type: 'int', min: 1, max: 365, help: 'days before a maintainer may stand in for an owner' },
  holdNamesContaining: { type: 'list', help: 'comma-separated words that put a name on hold' },
  maxSeats: { type: 'int', min: 0, max: 100000, help: 'hosted-site collaborators (enterprise seats) before new hosted approvals hold' },
  hostedPerOwner: { type: 'int', min: 0, max: 50, help: 'hosted sites per person' },
  hostedMinAccountAgeDays: { type: 'int', min: 0, max: 3650, help: 'minimum account age for a hosted site' },
  maxRepoSizeMB: { type: 'int', min: 1, max: 100000, help: 'a hosted repo bigger than this gets locked' },
  maxFileSizeMB: { type: 'int', min: 1, max: 100, help: 'largest file allowed in a push to a hosted repo' },
  blockedExtensions: { type: 'list', help: 'file types blocked in hosted repos (comma-separated, e.g. .exe, .zip)' },
  inactivityWarnDays: { type: 'int', min: 0, max: 3650, help: 'warn owners after this many days without a push (0 = never)' },
  inactivityLockDays: { type: 'int', min: 0, max: 3650, help: 'lock sites after this many days without a push (0 = never)' },
  maxCollaboratorsPerSite: { type: 'int', min: 0, max: 50, help: 'extra people an owner may add to their hosted repo' },
  staleRequestDays: { type: 'int', min: 1, max: 365, help: 'close private requests that need changes after this many quiet days' },
  termDays: { type: 'int', min: 0, max: 3650, help: 'how long a name lasts before it needs renewing (0 = names never expire); any change or push renews it' },
  holdDays: { type: 'int', min: 7, max: 365, help: 'how long an unrenewed name stays on hold (DNS off, nothing deleted) before it is released' },
  maintainerAwayDays: { type: 'int', min: 0, max: 3650, help: 'mark a maintainer away after this many days without activity (0 = never)' },
  maintainerEmeritusDays: { type: 'int', min: 0, max: 3650, help: 'mark an away maintainer emeritus after this many days (0 = never)' },
};
const READ_ONLY = new Set(['/help', '/available', '/whois', '/mine', '/verify', '/stats']);

/** First line of a comment → { cmd, args, rest } or null. Quotes group words: /txt a _x "b c". */
function parseCommand(body) {
  const line = String(body || '').trim().split('\n')[0].trim();
  const m = line.match(/^(\/[a-z-]+)(?:\s+(.*))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  if (!KNOWN.has(cmd)) return null;
  const rest = (m[2] || '').trim().slice(0, 500);
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let a;
  while ((a = re.exec(rest))) args.push(a[1] ?? a[2] ?? a[3]);
  return { cmd, args, rest };
}

const user = (s) => String(s || '').trim().replace(/^@/, '');

function helpTable({ admin = true } = {}) {
  const rows = (list) => list.map((c) => `| \`${c.usage}\` | ${c.does} |`).join('\n');
  const everyone = CATALOG.filter((c) => !c.admin);
  const admins = CATALOG.filter((c) => c.admin);
  return `#### Everyone\n\n| Command | What it does |\n|---|---|\n${rows(everyone)}\n` +
    (admin ? `\n#### Maintainers\n\n| Command | What it does |\n|---|---|\n${rows(admins)}\n` : '') +
    (admin ? '\nMaintainers can also do all of this from the [console](https://awesomeprojects.tech/admin/).\n' : '') +
    `\nCommands go at the start of a comment, in any issue or pull request here (and \`/help\`, \`/available\`, \`/whois\`, \`/mine\`, \`/verify\`, \`/stats\` in Discussions too).`;
}

const fmtRecords = (r = {}) => Object.entries(r).map(([t, v]) => {
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => `\`${t} ${typeof x !== 'object' ? x : t === 'DS' ? `${x.keyTag} ${x.algorithm} ${x.digestType} ${String(x.digest).slice(0, 12)}…` : `${x.priority ?? 10} ${x.host}`}\``).join(' ');
}).join(' ');

const PROVIDER_NAMES = {
  'github-pages': 'GitHub Pages', vercel: 'Vercel', netlify: 'Netlify', 'cloudflare-pages': 'Cloudflare Pages',
  render: 'Render', railway: 'Railway', fly: 'Fly.io', cname: 'CNAME', server: 'Own server', hosted: 'Hosted by us',
};
const hostOf = (d) => (d && d.site && PROVIDER_NAMES[d.site.provider]) || (d && d.records && d.records.NS ? (d.records.DS ? 'Own nameservers (DNSSEC)' : 'Own nameservers') : null) || (d && d.records && Object.keys(d.records)[0]) || '?';

/** /available */
function availability(rawName, entries, reserved, { repoUrl } = {}) {
  const { cleanName } = require('./requests');
  const name = cleanName(rawName);
  if (!name) return 'Usage: `/available <name>`';
  if (name.includes('.')) return `\`${name}\` is a name *under* \`${R.baseOf(name)}\`. Only its owner can add it (with \`/txt\`, or by asking them).`;
  const problems = R.checkName(name, reserved);
  if (problems.length) return `❌ \`${name}.${R.DOMAIN}\` can't be used: ${problems.join('; ')}.`;
  if (entries[name]) return `🔒 \`${name}.${R.DOMAIN}\` is taken by @${R.ownerOf(entries[name])}. Try \`/whois ${name}\`.`;
  const link = repoUrl ? ` [**Request it →**](${repoUrl}/issues/new?template=request.yml&title=${encodeURIComponent(`Request: ${name}`)}&subdomain=${encodeURIComponent(name)})` : '';
  return `✅ \`${name}.${R.DOMAIN}\` is available!${link}`;
}

/** /whois */
function whois(rawName, entries, { repoUrl } = {}) {
  const { cleanName } = require('./requests');
  const name = cleanName(rawName);
  if (!name) return 'Usage: `/whois <name>`';
  const d = entries[name];
  if (!d) return `\`${name}.${R.DOMAIN}\` isn't registered. \`/available ${name}\``;
  const under = R.family(entries, name).filter((n) => n !== name);
  return [
    `### \`${name}.${R.DOMAIN}\``,
    '',
    '| | |',
    '|---|---|',
    `| **Owner** | @${R.ownerOf(d)} |`,
    `| **Hosted on** | ${hostOf(d)}${d.site && d.site.repo ? ` ([${d.site.repo}](https://github.com/${d.site.repo}))` : ''} |`,
    `| **Records** | ${fmtRecords(d.records)} |`,
    d.description ? `| **About** | ${String(d.description).replace(/\|/g, '\\|')} |` : null,
    under.length ? `| **Under it** | ${under.map((n) => `\`${n}\``).join(', ')} |` : null,
    repoUrl ? `| **File** | [domains/${name}.json](${repoUrl}/blob/main/domains/${name}.json) |` : null,
  ].filter((l) => l !== null).join('\n');
}

/** /mine */
function mine(login, entries, config = {}) {
  const names = R.namesOwnedBy(entries, login);
  const limit = R.limitFor(login, { maxPerOwner: config.maxPerOwner, limits: config.limits });
  if (!names.length) return `@${login}, you don't have any subdomains yet (you can have ${limit}). \`/available <name>\` to find one.`;
  const rows = names.map((n) => `| \`${n}.${R.DOMAIN}\` | ${hostOf(entries[n])} | ${fmtRecords(entries[n].records)} |`).join('\n');
  return `@${login}, you have **${names.length} of ${limit}**:\n\n| Name | Host | Records |\n|---|---|---|\n${rows}`;
}

/** /stats */
function stats(entries, { openRequests } = {}) {
  const top = Object.keys(entries).filter((n) => R.baseOf(n) === n);
  const owners = new Set(top.map((n) => R.ownerOf(entries[n])));
  const hosts = {};
  for (const n of top) hosts[hostOf(entries[n])] = (hosts[hostOf(entries[n])] || 0) + 1;
  const hostRows = Object.entries(hosts).sort((a, b) => b[1] - a[1]).map(([h, c]) => `| ${h} | ${c} |`).join('\n');
  return `### 📊 ${R.DOMAIN}\n\n| | |\n|---|---|\n| **Subdomains** | ${top.length} |\n| **People** | ${owners.size} |\n| **Records under them** | ${Object.keys(entries).length - top.length} |` +
    (openRequests !== undefined ? `\n| **Open requests** | ${openRequests} |` : '') +
    (hostRows ? `\n\n| Hosted on | Names |\n|---|---|\n${hostRows}` : '');
}

/** Config edits for admin commands → { config?, reserved?, message } or { error }. */
function adminEdit(cmd, args, { config, reserved, entries, owner }) {
  const c = JSON.parse(JSON.stringify(config));
  const res = [...reserved];
  const who = lc(user(args[0]));
  const valid = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
  switch (cmd) {
    case '/ban':
      if (!who || !valid.test(who)) return { error: 'Usage: `/ban @user <reason>`' };
      if ((c.bannedUsers || []).map(lc).includes(who)) return { error: `@${who} is already banned.` };
      c.bannedUsers = [...(c.bannedUsers || []), who];
      return { config: c, message: `🔨 Banned @${who}${args.length > 1 ? `: ${args.slice(1).join(' ')}` : ''}` };
    case '/unban':
      if (!who) return { error: 'Usage: `/unban @user`' };
      if (!(c.bannedUsers || []).map(lc).includes(who)) return { error: `@${who} isn't banned.` };
      c.bannedUsers = c.bannedUsers.filter((u) => lc(u) !== who);
      return { config: c, message: `🕊️ Unbanned @${who}` };
    case '/limit': {
      const n = Number(args[1]);
      if (!who || !valid.test(who) || !Number.isInteger(n) || n < 0 || n > 100) return { error: 'Usage: `/limit @user <0-100>`' };
      c.limits = { ...(c.limits || {}) };
      for (const k of Object.keys(c.limits)) if (lc(k) === who) delete c.limits[k];
      if (n !== c.maxPerOwner) c.limits[who] = n;
      return { config: c, message: `📏 @${who} can now have ${n} subdomain${n === 1 ? '' : 's'}` };
    }
    case '/reserve': {
      const { cleanName } = require('./requests');
      const name = cleanName(args[0]);
      if (!name || name.includes('.')) return { error: 'Usage: `/reserve <name>`' };
      if (res.includes(name)) return { error: `\`${name}\` is already reserved.` };
      res.push(name);
      const note = entries && entries[name] ? ` (it's registered to @${R.ownerOf(entries[name])}; reserving doesn't remove it, use \`/takedown ${name}\` for that)` : '';
      return { reserved: res, message: `🚧 Reserved \`${name}\`${note}` };
    }
    case '/unreserve': {
      const { cleanName } = require('./requests');
      const name = cleanName(args[0]);
      if (!res.includes(name)) return { error: `\`${name}\` isn't reserved.` };
      return { reserved: res.filter((r) => r !== name), message: `✅ \`${name}\` is no longer reserved` };
    }
    case '/promote':
      if (!who || !valid.test(who)) return { error: 'Usage: `/promote @user`' };
      if ((c.maintainers || []).map(lc).includes(who)) return { error: `@${who} is already a maintainer.` };
      c.maintainers = [...(c.maintainers || []), who];
      return { config: c, message: `⭐ @${who} is now a maintainer` };
    case '/demote':
      if (!who) return { error: 'Usage: `/demote @user`' };
      if (who === lc(owner)) return { error: `@${who} is the owner, and always a maintainer.` };
      if (!(c.maintainers || []).map(lc).includes(who)) return { error: `@${who} isn't a maintainer.` };
      c.maintainers = c.maintainers.filter((u) => lc(u) !== who);
      return { config: c, message: `↩️ @${who} is no longer a maintainer` };
    case '/config': {
      const key = String(args[0] || '');
      const spec = SETTINGS[key];
      if (!spec) return { error: `Settings you can change: ${Object.keys(SETTINGS).map((k) => `\`${k}\``).join(', ')}.` };
      const raw = args.slice(1).join(' ').trim();
      let value;
      if (spec.type === 'int') {
        value = Number(raw);
        if (!Number.isInteger(value) || value < spec.min || value > spec.max) return { error: `\`${key}\` must be a whole number from ${spec.min} to ${spec.max}.` };
      } else if (spec.type === 'bool') {
        if (!['true', 'false', 'on', 'off', 'yes', 'no'].includes(lc(raw))) return { error: `\`${key}\` must be true or false.` };
        value = ['true', 'on', 'yes'].includes(lc(raw));
      } else {
        value = raw.split(',').map((w) => lc(w).trim()).filter(Boolean).slice(0, 200);
        if (!value.length) return { error: `Give \`${key}\` a comma-separated list.` };
      }
      c[key] = value;
      return { config: c, message: `⚙️ \`${key}\` = \`${Array.isArray(value) ? value.join(', ') : value}\`` };
    }
    case '/announce': {
      const text = args.join(' ').trim();
      c.announcement = ['off', 'none', 'clear', ''].includes(lc(text)) ? '' : text.slice(0, 280);
      return { config: c, message: c.announcement ? `📣 Announcement: ${c.announcement}` : '📣 Announcement cleared' };
    }
    case '/lock':
      c.locked = args.join(' ') || true;
      return { config: c, message: `🔒 Requests paused${typeof c.locked === 'string' ? `: ${c.locked}` : ''}` };
    case '/unlock':
      if (!c.locked) return { error: 'Requests aren\'t paused.' };
      c.locked = false;
      return { config: c, message: '🔓 Requests are open again' };
    default:
      return { error: `Unknown command ${cmd}` };
  }
}

module.exports = { CATALOG, ADMIN_ONLY, OWNER_ONLY, READ_ONLY, SETTINGS, parseCommand, helpTable, availability, whois, mine, stats, adminEdit, fmtRecords, hostOf, PROVIDER_NAMES };
