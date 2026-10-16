// Transfer and takedown requests (issue forms). Pure: works out what's needed and what to change.
'use strict';

const R = require('./rules');
const { profileSignals, fmtAge } = require('./review');

const lc = (s) => String(s || '').toLowerCase();

/** GitHub issue forms render as "### Label\n\nvalue" sections. */
function parseForm(body) {
  const out = {};
  const parts = String(body || '').split(/^### /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const key = p.slice(0, nl === -1 ? undefined : nl).trim();
    const val = nl === -1 ? '' : p.slice(nl + 1).trim();
    out[key] = val === '_No response_' ? '' : val;
  }
  return out;
}

/** "https://Alice.awesomeprojects.tech/" → "alice" */
function cleanName(s) {
  return lc(s).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
    .replace(new RegExp(`\\.?${R.DOMAIN.replace('.', '\\.')}$`), '').replace(/^`|`$/g, '');
}
const cleanUser = (s) => String(s || '').trim().replace(/^@/, '');

/** Files to rewrite so `name` (and everything under it the old owner has) belongs to `to`. */
function transferChanges(entries, name, to) {
  const from = R.ownerOf(entries[name]);
  return R.family(entries, name)
    .filter((n) => R.ownerOf(entries[n]) === from)
    .map((n) => {
      const data = { ...entries[n], owner: { github: to } };
      return { file: `domains/${n}.json`, content: JSON.stringify(data, null, 2) + '\n' };
    });
}

/** Files to delete to take `name` down (everything under it goes too). */
function takedownChanges(entries, name) {
  return R.family(entries, name).map((n) => ({ file: `domains/${n}.json`, content: null }));
}

/**
 * Where a transfer request stands.
 * returns { ok, problems: [], waiting: [{ who, cmd }], changes, from, to, name }
 */
function planTransfer({ form, author, entries, comments, maintainers, config = {}, profile, now = Date.now() }) {
  const name = cleanName(form['Subdomain']);
  const to = lc(cleanUser(form['New owner']) || author);
  const admins = maintainers.map(lc);
  const problems = [];
  const res = { name, to, from: null, problems, waiting: [], changes: [], ok: false };

  const data = entries[name];
  if (!name || !data) { problems.push(`\`${name || '(blank)'}\` isn't a registered subdomain.`); return res; }
  if (R.baseOf(name) !== name) { problems.push(`Transfer the top-level name \`${R.baseOf(name)}\`; everything under it moves along with it.`); return res; }
  const from = R.ownerOf(data);
  res.from = from;
  if (from === to) { problems.push(`@${to} already owns \`${name}\`.`); return res; }

  if (!profile) problems.push(`@${to} isn't a GitHub account I can find.`);
  else {
    const sig = profileSignals(profile, now);
    if (sig.isBot) problems.push(`@${to} is a bot account.`);
    if ((config.bannedUsers || []).map(lc).includes(to)) problems.push(`@${to} isn't allowed to own subdomains.`);
    if (sig.ageDays < (config.rejectAccountsYoungerThanDays ?? 7)) problems.push(`@${to}'s account is only ${fmtAge(sig.ageDays)} old.`);
  }
  const max = config.maxPerOwner ?? R.MAX_PER_OWNER;
  const has = R.namesOwnedBy(entries, to).length;
  if (has + 1 > max && !admins.includes(to)) problems.push(`@${to} already has ${has} subdomains (the limit is ${max}).`);

  const said = (who, cmd) => (comments || []).some((c) => lc(c.user && c.user.login) === who && lc((c.body || '').trim().split(/\s/)[0]) === cmd);
  const maintainerApproved = admins.some((m) => said(m, '/approve'));
  const fromOk = lc(author) === from || said(from, '/approve') || maintainerApproved;
  const toOk = lc(author) === to || said(to, '/accept');
  if (!fromOk) res.waiting.push({ who: from, cmd: '/approve', why: `to hand \`${name}\` over` });
  if (!toOk) res.waiting.push({ who: to, cmd: '/accept', why: `to take \`${name}\`` });

  res.changes = transferChanges(entries, name, to);
  res.ok = !problems.length && !res.waiting.length;
  return res;
}

const TAKEDOWN_REASONS = {
  owner: 'I own it and want it removed',
  phishing: 'Phishing or scam',
  malware: 'Malware',
  impersonation: 'Impersonation or trademark',
  dangling: 'Points at nothing (abandoned)',
  other: 'Something else',
};

/** Where a takedown request stands: { name, owner, reason, byOwner, problems, changes } */
function planTakedown({ form, author, entries }) {
  const name = cleanName(form['Subdomain']);
  const reasonText = form['Reason'] || '';
  const reason = Object.keys(TAKEDOWN_REASONS).find((k) => TAKEDOWN_REASONS[k] === reasonText) || 'other';
  const problems = [];
  const data = entries[name];
  if (!name || !data) problems.push(`\`${name || '(blank)'}\` isn't a registered subdomain (maybe it's already gone).`);
  const owner = data ? R.ownerOf(data) : null;
  // The parent's owner can also remove names under theirs.
  const parentOwner = name && R.baseOf(name) !== name ? R.ownerOf(entries[R.baseOf(name)]) : null;
  const byOwner = !!owner && (lc(author) === owner || lc(author) === parentOwner);
  return { name, owner, reason, byOwner, problems, changes: data ? takedownChanges(entries, name) : [], records: data ? data.records : null };
}

module.exports = { parseForm, cleanName, planTransfer, planTakedown, transferChanges, takedownChanges, TAKEDOWN_REASONS };
