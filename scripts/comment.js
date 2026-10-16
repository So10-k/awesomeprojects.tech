// Markdown the bot posts. Pure functions; one sticky comment per PR/issue, found by its marker.
'use strict';

const { CHECKS } = require('./review');

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

const COMMANDS = `<details>
<summary>Commands</summary>

| Who | Comment | What it does |
|---|---|---|
| Anyone | \`/recheck\` | Run the checks again |
| Owner of the parent name | \`/approve\` | Allow a name under yours |
| New owner in a transfer | \`/accept\` | Take ownership |
| Maintainers | \`/approve\` | Merge it now, holds or not (it goes live in about a minute) |
| Maintainers | \`/reject <reason>\` | Close it with a reason |
| Maintainers | \`/hold <reason>\` · \`/unhold\` | Pause or resume |

</details>`;

function reviewComment(result, { autoMerging = false, merged = false } = {}) {
  const [title, blurb] = HEADLINE[result.verdict];
  const rows = Object.entries(CHECKS).map(([check, label]) => {
    const fs = result.findings.filter((f) => f.check === check);
    if (!fs.length) return null;
    const worst = fs.reduce((a, f) => (RANK[f.level] > RANK[a.level] ? f : a));
    const shown = worst.level === 'pass' ? fs : fs.filter((f) => f.level !== 'pass');
    return `| ${ICON[worst.level]} | **${label}** | ${shown.map((f) => cell(f.text)).join('<br>')} |`;
  }).filter(Boolean);

  const waiting = [...new Set(result.findings.filter((f) => f.level === 'hold').map((f) => f.waitingFor))];
  const waitLine = result.verdict === 'on-hold' && waiting.length
    ? `\n**Waiting for:** ${waiting.map((w) => (w === 'maintainer' ? 'a maintainer' : `@${w}`)).join(', ')}\n`
    : '';
  const status = merged
    ? '\n> 🚀 **Merged!** DNS is updating now. Give it a few minutes.\n'
    : autoMerging ? '\n> 🤖 Auto-approved: merging now.\n' : '';

  return `${MARK('review')}
## ${title}

${blurb}
${status}
| | Check | Result |
|:-:|---|---|
${rows.join('\n')}
${waitLine}
${COMMANDS}`;
}

function simpleComment(kind, title, body) {
  return `${MARK(kind)}\n## ${title}\n\n${body}`;
}

module.exports = { MARK, COMMANDS, reviewComment, simpleComment, ICON };
