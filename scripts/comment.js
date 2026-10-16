// Markdown the bot posts. Pure functions; one sticky comment per PR/issue, found by its marker.
'use strict';

const { CHECKS } = require('./review');
const { helpTable } = require('./commands');

const MARK = (kind) => `<!-- subdomain-bot:${kind} -->`;
const ICON = { pass: '✅', info: 'ℹ️', hold: '⏸️', error: '✏️', reject: '⛔' };
const RANK = { pass: 0, info: 1, hold: 2, error: 3, reject: 4 };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const HEADLINE = {
  ready: ['✅ Ready to go live', 'Everything checks out. A maintainer will give it a final look, usually within a day.'],
  'needs-changes': ['✏️ Needs a few changes', 'Push a fix to this branch and I will check again automatically.'],
  'on-hold': ['⏸️ On hold', 'Nothing for you to fix right now. This is waiting on someone (see below).'],
  rejected: ['⛔ Not accepted', 'This request can\'t be accepted, so I\'m closing it. If you think that\'s a mistake, comment here and a maintainer will take a look.'],
};
const REQUEST_BLURB = {
  'needs-changes': '**Edit this issue** (⋯ → Edit) to fix it, and I\'ll check again automatically.',
};

const COMMANDS = `<details>
<summary>🤖 Commands</summary>

${helpTable()}

</details>`;

function table(findings) {
  return Object.entries(CHECKS).map(([check, label]) => {
    const fs = findings.filter((f) => f.check === check);
    if (!fs.length) return null;
    const worst = fs.reduce((a, f) => (RANK[f.level] > RANK[a.level] ? f : a));
    // Problems hide the ✅ lines; an ℹ️ note sits alongside them.
    const shown = worst.level === 'pass' || worst.level === 'info' ? fs : fs.filter((f) => f.level !== 'pass');
    return `| ${ICON[worst.level]} | **${label}** | ${shown.map((f) => cell(f.text)).join('<br>')} |`;
  }).filter(Boolean).join('\n');
}

function waitingLine(result) {
  const waiting = [...new Set(result.findings.filter((f) => f.level === 'hold').map((f) => f.waitingFor))];
  return result.verdict === 'on-hold' && waiting.length
    ? `\n**Waiting for:** ${waiting.map((w) => (w === 'maintainer' ? 'a maintainer' : `@${w}`)).join(', ')}\n`
    : '';
}

function reviewComment(result, { autoMerging = false, merged = false } = {}) {
  const [title, blurb] = HEADLINE[result.verdict];
  const status = merged
    ? '\n> 🚀 **Merged!** DNS is updating now. Give it a few minutes.\n'
    : autoMerging ? '\n> 🤖 Auto-approved: merging now.\n' : '';
  return `${MARK('review')}
## ${title}

${blurb}
${status}
| | Check | Result |
|:-:|---|---|
${table(result.findings)}
${waitingLine(result)}
${COMMANDS}`;
}

/**
 * The sticky comment on a request issue.
 * opts: { name, domain, entry, plan (frameworks.plan result), problems (form problems), locked, live, guide, prUrl }
 */
function requestComment(result, opts) {
  const { name, domain, entry, plan, problems = [], locked, live, guide, prUrl } = opts;
  const host = name ? `\`${name}.${domain}\`` : 'this name';
  let body;
  if (locked) {
    body = `## 🔒 Requests are paused\n\n${typeof locked === 'string' ? `> ${locked}\n\n` : ''}Your request is saved. I'll pick it up as soon as requests open again.`;
  } else if (problems.length) {
    body = `## ✏️ Almost there\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\n${REQUEST_BLURB['needs-changes']}`;
  } else if (live) {
    body = `## 🎉 ${host} is live!\n\nDNS is updating now${prUrl ? ` ([the change](${prUrl}))` : ''}: give it a few minutes.\n\n### Next steps\n\n${guide}`;
  } else {
    const [title, blurb] = HEADLINE[result.verdict];
    const why = result.verdict === 'needs-changes' ? REQUEST_BLURB['needs-changes'] : blurb.replace('Push a fix to this branch', 'Edit this issue');
    body = `## ${title}: ${host}\n\n${why}\n\n| | Check | Result |\n|:-:|---|---|\n${table(result.findings)}\n${waitingLine(result)}`;
    if (plan) {
      const cmds = [plan.install && `\`${plan.install}\``, plan.build && `\`${plan.build}\``].filter(Boolean).join(' → ');
      body += `\n<details open>\n<summary>🛠️ How I'll build your repo</summary>\n\n| | |\n|---|---|\n| **Detected** | ${plan.label}${plan.pm ? ` (${plan.pm})` : ''} |\n| **Commands** | ${cmds || 'none (served as-is)'} |\n| **Publishes** | \`${plan.output}/\`${plan.nextExport ? ' as a static export' : ''}${plan.spa ? ' (single-page app routing on)' : ''} |\n\n` +
        `${plan.warnings.map((w) => `> ⚠️ ${w}`).join('\n\n')}${plan.warnings.length ? '\n\n' : ''}Change any of this with an \`awesomeprojects.json\` in your repo.\n</details>\n`;
    }
    if (entry) body += `\n<details>\n<summary>📄 The file I'll add: <code>domains/${name}.json</code></summary>\n\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\`\n</details>\n`;
  }
  return `${MARK('request')}\n${body}\n\n${COMMANDS}`;
}

function simpleComment(kind, title, body) {
  return `${MARK(kind)}\n## ${title}\n\n${body}`;
}

module.exports = { MARK, COMMANDS, reviewComment, requestComment, simpleComment, ICON };
