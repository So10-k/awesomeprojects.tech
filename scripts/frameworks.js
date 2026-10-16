// Works out how to build a repo for GitHub Pages. Pure: give it package.json, the list of files
// and the optional awesomeprojects.json; get back install/build commands and the output folder.
// Used by the reusable workflow (scripts/site-build.js) and by the bot's request preview.
'use strict';

const CONFIG_FILE = 'awesomeprojects.json';
const CONFIG_KEYS = ['framework', 'node', 'install', 'build', 'output', 'directory', 'spa'];

// Checked in order: the first dependency that matches wins.
const FRAMEWORKS = [
  { id: 'next', label: 'Next.js', dep: 'next', build: 'npx next build', output: 'out', nextExport: true },
  { id: 'nuxt', label: 'Nuxt', dep: 'nuxt', build: 'npx nuxi generate', output: '.output/public' },
  { id: 'sveltekit', label: 'SvelteKit', dep: '@sveltejs/kit', build: 'run build', output: 'build' },
  { id: 'astro', label: 'Astro', dep: 'astro', build: 'run build', output: 'dist' },
  { id: 'gatsby', label: 'Gatsby', dep: 'gatsby', build: 'npx gatsby build', output: 'public' },
  { id: 'docusaurus', label: 'Docusaurus', dep: '@docusaurus/core', build: 'run build', output: 'build' },
  { id: 'vitepress', label: 'VitePress', dep: 'vitepress', build: 'run build', output: 'docs/.vitepress/dist' },
  { id: 'eleventy', label: 'Eleventy', dep: '@11ty/eleventy', build: 'npx @11ty/eleventy', output: '_site' },
  { id: 'cra', label: 'Create React App', dep: 'react-scripts', build: 'run build', output: 'build', spa: true },
  { id: 'vite', label: 'Vite', dep: 'vite', build: 'run build', output: 'dist', spa: true },
];
const OUTPUT_GUESSES = ['out', 'dist', 'build', 'public', '_site', '.output/public', 'site', 'docs'];

function packageManager(files) {
  if (files.has('pnpm-lock.yaml')) return { pm: 'pnpm', install: 'pnpm install --frozen-lockfile', run: 'pnpm run' };
  if (files.has('yarn.lock')) return { pm: 'yarn', install: 'yarn install --frozen-lockfile', run: 'yarn run' };
  if (files.has('bun.lockb') || files.has('bun.lock')) return { pm: 'bun', install: 'bun install --frozen-lockfile', run: 'bun run' };
  if (files.has('package-lock.json')) return { pm: 'npm', install: 'npm ci', run: 'npm run' };
  return { pm: 'npm', install: 'npm install', run: 'npm run' };
}

/** Validate an awesomeprojects.json; returns { config, problems }. */
function readConfig(raw) {
  if (raw === undefined || raw === null || raw === '') return { config: {}, problems: [] };
  let c;
  try { c = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return { config: {}, problems: [`${CONFIG_FILE} isn't valid JSON: ${e.message}`] }; }
  const problems = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { config: {}, problems: [`${CONFIG_FILE} must be an object`] };
  for (const k of Object.keys(c)) if (!CONFIG_KEYS.includes(k) && k !== '$schema') problems.push(`${CONFIG_FILE}: unknown setting "${k}"`);
  for (const k of ['framework', 'node', 'install', 'build', 'output', 'directory']) {
    if (c[k] !== undefined && typeof c[k] !== 'string') problems.push(`${CONFIG_FILE}: "${k}" must be text`);
  }
  if (c.spa !== undefined && typeof c.spa !== 'boolean') problems.push(`${CONFIG_FILE}: "spa" must be true or false`);
  if (c.directory && (c.directory.startsWith('/') || c.directory.split('/').includes('..'))) problems.push(`${CONFIG_FILE}: "directory" must be a folder inside the repo`);
  if (c.output && (c.output.startsWith('/') || c.output.split('/').includes('..'))) problems.push(`${CONFIG_FILE}: "output" must be a folder inside the repo`);
  return { config: c, problems };
}

/**
 * Plan a build.
 *   pkg     parsed package.json, or null for a plain HTML site
 *   files   Set of file paths relative to the project directory
 *   config  parsed awesomeprojects.json (optional)
 * returns { framework, label, pm, node, install, build, output, outputGuesses, spa, nextExport, warnings }
 */
function plan({ pkg = null, files = new Set(), config = {} } = {}) {
  const warnings = [];
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const forced = config.framework && config.framework !== 'auto' ? config.framework : null;

  let fw = null;
  if (forced) {
    fw = FRAMEWORKS.find((f) => f.id === forced) || (forced === 'static' ? null : { id: forced, label: forced, build: 'run build' });
  } else if (pkg) {
    fw = FRAMEWORKS.find((f) => deps[f.dep]);
    if (!fw && pkg.scripts && pkg.scripts.build) fw = { id: 'node', label: 'Node project (npm run build)', build: 'run build' };
  }

  // Plain HTML: no package.json (or "framework": "static").
  if (!fw) {
    const output = config.output
      || (files.has('public/index.html') ? 'public' : files.has('docs/index.html') ? 'docs' : files.has('site/index.html') ? 'site' : '.');
    if (output === '.' && !files.has('index.html')) warnings.push('No index.html found at the top of the repo. Add one, or set "output" in awesomeprojects.json.');
    return {
      framework: 'static', label: 'Static HTML', pm: null, node: null, install: '', build: config.build || '',
      output, outputGuesses: [output], spa: !!config.spa, nextExport: false, warnings,
    };
  }

  const pmInfo = packageManager(files);
  const build = config.build || (fw.build.startsWith('run ') ? `${pmInfo.run} ${fw.build.slice(4)}` : fw.build);

  if (fw.id === 'next') {
    const server = [...files].filter((f) => /^(src\/)?(pages|app)\/api\//.test(f) || /^(src\/)?middleware\.(js|ts|mjs)$/.test(f));
    if (server.length) {
      warnings.push(`This Next.js app uses server features (${server.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${server.length > 3 ? '…' : ''}). GitHub Pages only serves static files, so the build will fail. Pick **Vercel** instead (free for hobby projects), or remove those parts.`);
    }
  }
  if (fw.id === 'sveltekit' && !deps['@sveltejs/adapter-static']) {
    warnings.push('SvelteKit needs `@sveltejs/adapter-static` for GitHub Pages: `npm i -D @sveltejs/adapter-static` and use it in svelte.config.js.');
  }
  if (fw.id === 'nuxt' && pkg.scripts && pkg.scripts.generate) {
    // Respect their own generate script.
  }

  const output = config.output || fw.output;
  return {
    framework: fw.id,
    label: fw.label,
    pm: pmInfo.pm,
    node: config.node || (pkg.engines && typeof pkg.engines.node === 'string' && (pkg.engines.node.match(/\d+/) || [])[0]) || '20',
    install: config.install || pmInfo.install,
    build,
    output,
    outputGuesses: [...new Set([output, ...OUTPUT_GUESSES])],
    spa: config.spa !== undefined ? !!config.spa : !!fw.spa,
    nextExport: !!fw.nextExport && !config.build,
    warnings,
  };
}

/**
 * Next.js static export: a next.config wrapper around the user's own config. It also turns off what
 * an export can't do (cacheComponents / partial prerendering, on by default in Next 16).
 * ext = the user's config extension ("js" | "mjs" | "cjs" | "ts"), or null if they have none.
 * returns { rename: [from, to] | null, file, content }
 */
function nextExportConfig(ext) {
  const header = '// Added by the awesomeprojects.tech build for a static export (GitHub Pages).\n';
  // Removes what an export can't do instead of adding keys: Next rejects keys it doesn't know
  // (experimental.dynamicIO in 16), and partialPrefetching requires cacheComponents.
  const body = (t) => `const merge = (c${t ? ': any' : ''}) => {
  const o${t ? ': any' : ''} = { ...c, output: 'export', images: { ...(c && c.images), unoptimized: true }, trailingSlash: c && c.trailingSlash !== undefined ? c.trailingSlash : true };
  for (const k of ['cacheComponents', 'partialPrefetching']) delete o[k];
  if (o.experimental) {
    o.experimental = { ...o.experimental };
    for (const k of ['ppr', 'dynamicIO', 'cacheComponents', 'partialPrefetching']) delete o.experimental[k];
  }
  return o;
};
export default typeof user === 'function' ? async (...a${t ? ': any[]' : ''}) => merge(await (user${t ? ' as any' : ''})(...a)) : merge(user);
`;
  if (!ext) {
    return { rename: null, file: 'next.config.mjs', content: `${header}export default { output: 'export', images: { unoptimized: true }, trailingSlash: true };\n` };
  }
  const user = `next.config.user.${ext}`;
  const rename = [`next.config.${ext}`, user];
  if (ext === 'ts') return { rename, file: 'next.config.ts', content: `${header}import user from './next.config.user';\n${body(true)}` };
  // .mjs can import both CommonJS and ESM configs.
  return { rename, file: 'next.config.mjs', content: `${header}import user from './${user}';\n${body(false)}` };
}

module.exports = { CONFIG_FILE, CONFIG_KEYS, FRAMEWORKS, plan, readConfig, packageManager, nextExportConfig };
