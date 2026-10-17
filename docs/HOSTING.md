# Hosting your repo at `<name>.awesomeprojects.tech`

Pick **"My GitHub repo"** when you [request a name](https://awesomeprojects.tech), and your site is built and hosted for free on GitHub Pages, straight from your repo, on every push.

- [Set it up](#set-it-up)
- [What gets built](#what-gets-built)
- [Next.js](#nextjs)
- [`awesomeprojects.json`](#awesomeprojectsjson)
- [Troubleshooting](#troubleshooting)

## Set it up

When your name goes live, the bot's comment has a **one-click link** that adds this file to your repo:

```yaml
# .github/workflows/awesomeprojects.yml
name: Deploy to awesomeprojects.tech
on:
  push:
    branches: [main, master]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  site:
    uses: So10-k/awesomeprojects.tech/.github/workflows/pages-site.yml@main
```

Then, in your repo:

1. **Settings → Pages → Source:** pick **GitHub Actions**.
2. **Settings → Pages → Custom domain:** enter `<name>.awesomeprojects.tech` and save.
3. Push anything, or run the workflow from the **Actions** tab. When it's green, tick **Enforce HTTPS** (it appears once GitHub has issued the certificate, usually within minutes).

Check it any time by commenting `/verify <name>` on any issue in this repo.

> The repo must be **public** (GitHub Pages is free for public repos), and it has to be **yours**, or an organization's where your membership is public.

## What gets built

The workflow looks at your repo and picks the first match:

| Framework | Detected by | Build | Publishes |
|---|---|---|---|
| **Next.js** | `next` | `next build` as a static export | `out/` |
| **Nuxt** | `nuxt` | `nuxi generate` | `.output/public/` |
| **SvelteKit** | `@sveltejs/kit` (needs `@sveltejs/adapter-static`) | `npm run build` | `build/` |
| **Astro** | `astro` | `npm run build` | `dist/` |
| **Gatsby** | `gatsby` | `gatsby build` | `public/` |
| **Docusaurus** | `@docusaurus/core` | `npm run build` | `build/` |
| **VitePress** | `vitepress` | `npm run build` | `docs/.vitepress/dist/` |
| **Eleventy** | `@11ty/eleventy` | `eleventy` | `_site/` |
| **Create React App** | `react-scripts` | `npm run build` | `build/` (SPA fallback on) |
| **Vite** (React, Vue, Svelte, Solid…) | `vite` | `npm run build` | `dist/` (SPA fallback on) |
| Anything with a `build` script | `scripts.build` | `npm run build` | the first of `dist/ build/ out/ public/ _site/` with an `index.html` |
| **Plain HTML** | no `package.json` | none | `public/`, `docs/`, `site/` or the repo root |

- **Package manager:** from your lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `package-lock.json`).
- **Node version:** `engines.node` in `package.json`, or 20.
- **SPA fallback:** copies `index.html` to `404.html` so client-side routes work on refresh.

## Next.js

GitHub Pages serves files, not a server, so Next.js is built as a [static export](https://nextjs.org/docs/app/guides/static-exports). The build wraps your `next.config` (any of `.js`, `.mjs`, `.cjs`, `.ts`) to:

- set `output: 'export'`, `images.unoptimized: true` and `trailingSlash: true`;
- remove `cacheComponents` / partial prerendering, which a static export can't do (Next 16 turns them on in new apps).

Your own config file isn't changed in your repo; this happens only inside the build.

**What doesn't work in a static export:** API routes (`app/api`, `pages/api`), middleware, server actions, `revalidate`/ISR, `cookies()`/`headers()`, and dynamic routes without `generateStaticParams`. The bot warns you if it sees any of these. If you need them, request your name with **Vercel** instead: it runs full Next.js for free on hobby projects.

## `awesomeprojects.json`

Put this at the top of your repo to override anything. Every field is optional:

```json
{
  "framework": "auto",
  "directory": "apps/web",
  "node": "22",
  "install": "pnpm install --frozen-lockfile",
  "build": "pnpm build",
  "output": "apps/web/dist",
  "spa": true
}
```

| Field | What it does |
|---|---|
| `framework` | `auto` (default), one of `next nuxt sveltekit astro gatsby docusaurus vitepress eleventy cra vite`, or `static` to skip building |
| `directory` | Where the project lives in a monorepo. Paths below are relative to it. |
| `node` | Node.js major version |
| `install` | Install command |
| `build` | Build command. Setting this for Next.js also turns off the automatic static-export wrapper. |
| `output` | The folder that ends up containing `index.html` |
| `spa` | `true` copies `index.html` to `404.html` for client-side routing |

The bot reads this file when you request a name and shows you the build plan in its comment.

## Troubleshooting

| You see | Do this |
|---|---|
| **404 "There isn't a GitHub Pages site here"** | Settings → Pages → *Custom domain* isn't set to your name, or the workflow hasn't run yet. |
| **Certificate / HTTPS error** | GitHub is still issuing the certificate. Wait a few minutes, then tick *Enforce HTTPS*. |
| **`Get Pages site failed` in the workflow** | Settings → Pages → *Source* must be **GitHub Actions**. |
| **"can't find an index.html"** | Set `output` in `awesomeprojects.json` to the folder your build creates. |
| **Styles or assets missing** | Make sure you visit the custom domain, not `you.github.io/repo/`; the build assumes it's served from the root. |
| **Next.js build fails on an API route** | Static exports can't have them: remove them, or move to Vercel. |

Still stuck? Ask in [Discussions → Q&A](https://github.com/So10-k/awesomeprojects.tech/discussions/categories/q-a).

## Sites we host for you

When managed accounts are on, sites we host live in our managed enterprise and deploy to Cloudflare Pages. You get an enterprise account (`yourname_ap`) and sign in with your GitHub account. See [MANAGED.md](MANAGED.md).
