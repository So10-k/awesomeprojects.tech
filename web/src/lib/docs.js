// The repo's own docs, rendered at build time. One source: what's in docs/ and README.md is what's on the site.
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { D } from './data.js';

const ROOT = path.resolve(process.cwd(), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const noEmoji = (s) => s.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').trim();

/** Links that work on GitHub (relative to the repo) also work here. */
function fixLinks(html) {
  return html
    .replace(/href="(?:\.\.\/)*docs\/HOSTING\.md(#[^"]*)?"/g, (_, h = '') => `href="/docs/hosting/${h}"`)
    .replace(/href="(?:\.\.\/)*docs\/MAINTAINERS\.md(#[^"]*)?"/g, (_, h = '') => `href="/docs/maintaining/${h}"`)
    .replace(/href="(?:\.\.\/)*(HOSTING|MAINTAINERS)\.md(#[^"]*)?"/g, (_, f, h = '') => `href="/docs/${f === 'HOSTING' ? 'hosting' : 'maintaining'}/${h}"`)
    .replace(/href="(?:\.\.\/)+(issues|pulls)([^"]*)"/g, (_, a, b) => `href="https://github.com/${D.repo}/${a}${b}"`)
    .replace(/href="(?!https?:|#|\/|mailto:)([^"]+)"/g, (_, p) => `href="https://github.com/${D.repo}/blob/main/${p.replace(/^(\.\/|\.\.\/)+/, '')}"`)
    .replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
}

const slug = (s) => noEmoji(s).toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const plain = noEmoji(text.replace(/<[^>]+>/g, ''));
  return `<h${depth} id="${slug(plain)}">${noEmoji(text)}</h${depth}>\n`;
};
const md = (src) => fixLinks(marked.parse(src, { renderer, gfm: true }));

/** README split into its ## sections: { title, body } (the banner and badges above them are dropped). */
function readmeSections() {
  const parts = read('README.md').split(/^## /m).slice(1);
  return parts.map((p) => { const [first, ...rest] = p.split('\n'); return { title: noEmoji(first), body: rest.join('\n') }; });
}
const pick = (titles) => readmeSections().filter((s) => titles.some((t) => s.title.toLowerCase().startsWith(t))).map((s) => `## ${s.title}\n${s.body}`).join('\n');

export const DOCS = [
  { slug: 'get-a-name', title: 'Get a name', blurb: 'Request one, change it, transfer it, give it up. The rules.', html: () => md(pick(['get your subdomain', 'how a request flows', 'change, transfer', 'rules', 'faq'])) },
  { slug: 'hosting', title: 'Hosting', blurb: 'Point a name at your repo, or let us host the site for you.', html: () => md(read('docs/HOSTING.md').replace(/^# .*\n/, '')) },
  { slug: 'commands', title: 'Bot commands', blurb: 'Everything you can ask the bot in a comment.', html: () => null },
  { slug: 'maintaining', title: 'Maintaining', blurb: 'How the registry is run: ranks, duty, the queue, takedowns.', html: () => md(read('docs/MAINTAINERS.md').replace(/^# .*\n/, '')) },
];
export const docTitle = (s) => (DOCS.find((d) => d.slug === s) || {}).title;
