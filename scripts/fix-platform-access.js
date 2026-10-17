#!/usr/bin/env node
// One-shot: private reusable workflows are invisible to other repos until the
// platform repo's Actions access is "organization". GitHub then says
// "workflow was not found". Also stamps that into platform's /org-setup.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const platformRepo = config.platformRepo;
const org = (config.emu && config.emu.org) || platformRepo.split('/')[0];
const token = String(process.env.BOT_PAT || '').trim();
if (!token) throw new Error('BOT_PAT required');

const problems = [];
const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => { problems.push(m); console.log(`❌ ${m}`); };

async function gh(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'awesomeprojects-platform-access',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${pathname}: ${res.status} ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function file(repo, p) {
  const data = await gh(`/repos/${repo}/contents/${p}?ref=main`);
  return { sha: data.sha, text: Buffer.from(data.content || '', 'base64').toString('utf8') };
}

(async () => {
  console.log(`platform=${platformRepo} org=${org}`);

  const workflows = await gh(`/repos/${platformRepo}/contents/.github/workflows?ref=main`);
  const names = workflows.map((f) => f.name);
  ok(`platform workflows: ${names.join(', ') || '(none)'}`);
  if (!names.includes('cf-pages-site.yml')) bad('cf-pages-site.yml missing on platform main');
  else {
    const wf = await file(platformRepo, '.github/workflows/cf-pages-site.yml');
    if (!wf.text.includes('workflow_call:')) bad('cf-pages-site.yml is not a reusable workflow');
    else ok('cf-pages-site.yml is workflow_call');
    if (!wf.text.includes('secrets.BOT_PAT') && !wf.text.includes('secrets.BOT_PAT'.replace('secrets.', ''))) {
      /* checked below */
    }
    if (wf.text.includes('${{ secrets.BOT_PAT }}')) ok('cf-pages-site.yml checks out scripts with BOT_PAT');
    else bad('cf-pages-site.yml does not use secrets.BOT_PAT to clone platform scripts');
  }

  let access;
  try { access = await gh(`/repos/${platformRepo}/actions/permissions/access`); } catch (e) { access = { error: e.message }; }
  console.log('access before:', JSON.stringify(access));
  await gh(`/repos/${platformRepo}/actions/permissions/access`, { method: 'PUT', body: { access_level: 'organization' } });
  access = await gh(`/repos/${platformRepo}/actions/permissions/access`);
  if (access.access_level === 'organization') ok('platform Actions access is organization (site repos can call it)');
  else bad(`platform Actions access is ${access.access_level}, expected organization`);

  const secrets = await gh(`/orgs/${org}/actions/secrets`);
  const secretNames = (secrets.secrets || []).map((s) => s.name);
  ok(`org secrets: ${secretNames.join(', ') || '(none)'}`);
  for (const name of ['BOT_PAT', 'CLOUDFLARE_PAGES_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (secretNames.includes(name)) ok(`org secret ${name}`);
    else bad(`org secret ${name} missing on ${org}`);
  }

  const need = `${platformRepo}/.github/workflows/*`;
  const before = await gh(`/orgs/${org}/actions/permissions/selected-actions`);
  const patterns = new Set(before.patterns_allowed || []);
  console.log('actions patterns before:', [...patterns].join(', ') || '(none)');
  patterns.add(need);
  patterns.add('oven-sh/setup-bun@*');
  await gh(`/orgs/${org}/actions/permissions`, { method: 'PUT', body: { enabled_repositories: 'all', allowed_actions: 'selected' } });
  await gh(`/orgs/${org}/actions/permissions/selected-actions`, {
    method: 'PUT',
    body: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [...patterns] },
  });
  const after = await gh(`/orgs/${org}/actions/permissions/selected-actions`);
  if ((after.patterns_allowed || []).includes(need)) ok(`Actions allow-list includes ${need}`);
  else bad(`Actions allow-list still missing ${need}`);

  const sites = ['justaquicktest'];
  for (const name of sites) {
    const repo = `${org}/${name}`;
    let deploy;
    try { deploy = await file(repo, '.github/workflows/deploy.yml'); }
    catch (e) { bad(`${repo} deploy.yml: ${e.message}`); continue; }
    if (deploy.text.includes(`${platformRepo}/.github/workflows/cf-pages-site.yml@main`) && deploy.text.includes('secrets: inherit')) {
      ok(`${repo} deploy.yml calls platform with secrets: inherit`);
    } else bad(`${repo} deploy.yml does not call platform with secrets: inherit:\n${deploy.text}`);
    try {
      await gh(`/repos/${repo}/actions/workflows/deploy.yml/dispatches`, { method: 'POST', body: { ref: 'main' } });
      ok(`dispatched deploy on ${repo}`);
    } catch (e) {
      bad(`dispatch deploy on ${repo}: ${e.message}`);
    }
  }

  const bot = await file(platformRepo, 'scripts/bot.js');
  const marker = "platform workflows callable by other repos in the org";
  if (bot.text.includes(marker)) ok('org-setup already sets platform Actions access');
  else {
    const start = bot.text.indexOf("await step(lines, 'Actions:");
    const end = start < 0 ? -1 : bot.text.indexOf('\n  });', start);
    if (start < 0 || end < 0) {
      bad('could not find org-setup Actions block to patch');
      const at = bot.text.indexOf('actionsPolicy');
      console.log(bot.text.slice(Math.max(0, at - 200), at + 400));
    } else {
      const addition = [
        '',
        `  await step(lines, '${marker}', async () => {`,
        "    if (!String(platformRepo).startsWith(org + '/')) return 'platform repo is outside this org, skipped';",
        '    await api.put(`/repos/${platformRepo}/actions/permissions/access`, { access_level: \'organization\' });',
        '    const share = S.actionsPolicy(platformRepo);',
        '    await api.put(`/orgs/${org}/actions/permissions/selected-actions`, share.selected);',
        "    return platformRepo + ' Actions access: organization';",
        '  });',
      ].join('\n');
      const next = bot.text.slice(0, end + '\n  });'.length) + addition + bot.text.slice(end + '\n  });'.length);
      await gh(`/repos/${platformRepo}/contents/scripts/bot.js`, {
        method: 'PUT',
        body: {
          message: 'org-setup: let site repos call private platform workflows',
          content: Buffer.from(next).toString('base64'),
          sha: bot.sha,
          branch: 'main',
        },
      });
      ok('patched platform scripts/bot.js so /org-setup keeps Actions access open');
    }
  }

  const since = Date.now() - 60_000;
  for (const name of sites) {
    const repo = `${org}/${name}`;
    let run;
    for (let i = 0; i < 18; i++) {
      const runs = await gh(`/repos/${repo}/actions/runs?per_page=5`);
      run = (runs.workflow_runs || []).find((r) => new Date(r.created_at).getTime() >= since && r.name === 'Deploy');
      if (run && run.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!run) { bad(`no Deploy run on ${repo}`); continue; }
    const jobs = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs`);
    const steps = (jobs.jobs || []).flatMap((j) => (j.steps || []).map((s) => `${j.name}/${s.name}: ${s.conclusion || s.status}`));
    console.log(`${repo} ${run.status} ${run.conclusion || ''} ${run.html_url}\n  ${steps.join('\n  ')}`);
    if (run.conclusion === 'success') ok(`${repo} deploy succeeded`);
    else bad(`${repo} deploy ${run.conclusion || run.status}: ${run.html_url}`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('\nAll checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
