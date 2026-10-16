#!/usr/bin/env node
// Runs inside someone's repo, from .github/workflows/pages-site.yml:
//   plan     detect the framework (scripts/frameworks.js) → step outputs + .awesomeprojects/plan.json
//   prepare  Next.js: wrap next.config so the build is a static export
//   finish   find the built site, add SPA fallback, copy it to a clean folder for upload
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const F = require('./frameworks');

const ws = process.env.GITHUB_WORKSPACE || process.cwd();
const planFile = path.join(ws, '.awesomeprojects', 'plan.json');
const SKIP = new Set(['.git', 'node_modules', '.awesomeprojects', '.next', '.output', 'dist', 'out', 'build']);

function output(key, value) {
  const line = `${key}=${String(value ?? '').replace(/\n/g, ' ')}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  console.log(md);
}
function fail(msg) {
  console.log(`::error::${msg}`);
  process.exit(1);
}

/** Paths under dir (relative), skipping dependencies and build output, max ~5000. */
function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length > 5000) return;
      if (SKIP.has(ent.name) && rel === '') continue;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function plan() {
  const rootCfgPath = path.join(ws, F.CONFIG_FILE);
  const { config, problems } = F.readConfig(fs.existsSync(rootCfgPath) ? fs.readFileSync(rootCfgPath, 'utf8') : null);
  if (problems.length) fail(problems.join('; '));
  const dirRel = (process.env.INPUT_DIRECTORY || config.directory || '.').replace(/^\.\/?/, '').replace(/\/$/, '') || '.';
  const dir = path.join(ws, dirRel);
  if (!fs.existsSync(dir)) fail(`The project folder "${dirRel}" doesn't exist.`);
  // A config inside the project folder also counts (for monorepos).
  let cfg = config;
  const innerCfg = path.join(dir, F.CONFIG_FILE);
  if (dirRel !== '.' && fs.existsSync(innerCfg)) {
    const inner = F.readConfig(fs.readFileSync(innerCfg, 'utf8'));
    if (inner.problems.length) fail(inner.problems.join('; '));
    cfg = { ...config, ...inner.config };
  }
  const files = new Set(listFiles(dir));
  let pkg = null;
  if (files.has('package.json')) {
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { fail(`package.json isn't valid JSON: ${e.message}`); }
  }
  const p = F.plan({ pkg, files, config: cfg });
  for (const w of p.warnings) console.log(`::warning::${w.replace(/\*\*/g, '').replace(/`/g, '')}`);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, JSON.stringify({ ...p, dir: dirRel }, null, 2));
  output('dir', dirRel);
  for (const k of ['framework', 'node', 'pm', 'install', 'build', 'output']) output(k, p[k] || '');
  summary(`### 🌐 awesomeprojects.tech build\n\n| | |\n|---|---|\n| Detected | **${p.label}** |\n| Folder | \`${dirRel}\` |\n| Install | ${p.install ? `\`${p.install}\`` : '—'} |\n| Build | ${p.build ? `\`${p.build}\`` : '—'} |\n| Output | \`${p.output}\` |\n${p.warnings.map((w) => `\n> ⚠️ ${w}`).join('\n')}`);
}

function prepare() {
  const p = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (!p.nextExport) return console.log('Nothing to prepare.');
  const dir = path.join(ws, p.dir);
  const ext = ['ts', 'mjs', 'js', 'cjs'].find((e) => fs.existsSync(path.join(dir, `next.config.${e}`))) || null;
  const w = F.nextExportConfig(ext);
  if (w.rename) fs.renameSync(path.join(dir, w.rename[0]), path.join(dir, w.rename[1]));
  fs.writeFileSync(path.join(dir, w.file), w.content);
  console.log(`Next.js: ${w.rename ? `wrapped ${w.rename[0]} → ` : 'created '}${w.file} with output: 'export'`);
}

function finish() {
  const p = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const dir = path.join(ws, p.dir);
  const found = p.outputGuesses.map((o) => path.join(dir, o)).find((o) => fs.existsSync(path.join(o, 'index.html')));
  if (!found) fail(`The build finished, but I can't find an index.html in ${p.outputGuesses.map((o) => `"${o}"`).join(', ')}. Set "output" in ${F.CONFIG_FILE} to the folder your build creates.`);
  const dest = path.join(process.env.RUNNER_TEMP || require('node:os').tmpdir(), 'awesomeprojects-site');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(found, dest, {
    recursive: true,
    filter: (src) => !['.git', 'node_modules', '.awesomeprojects', '.github'].includes(path.basename(src)),
  });
  if (p.spa && !fs.existsSync(path.join(dest, '404.html'))) fs.copyFileSync(path.join(dest, 'index.html'), path.join(dest, '404.html'));
  fs.writeFileSync(path.join(dest, '.nojekyll'), '');
  output('path', dest);
  summary(`Publishing \`${path.relative(ws, found) || '.'}\` (${fs.readdirSync(dest).length} items)${p.spa ? ' with single-page app fallback' : ''}.`);
}

const mode = process.argv[2];
({ plan, prepare, finish }[mode] || (() => fail(`unknown mode ${mode}`)))();
