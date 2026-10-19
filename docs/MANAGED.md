# Managed accounts and hosted sites

People never join our hosted repos with their own GitHub account. The bot gives each person an account on **our GitHub server** and grants that account access. They sign in by proving who they are with their normal GitHub account, so there is no new password.

| | Where it lives |
|---|---|
| Public registry: names, DNS, request forms, website, the thin bot runner | [`So10-k/awesomeprojects.tech`](https://github.com/So10-k/awesomeprojects.tech) on github.com |
| People's accounts, **hosted site repos** (org `sites`) and the maintainer rooms (orgs `maintainers`, `on-duty`) | our GitHub Enterprise Server, **[github.samsprojects.xyz](https://github.samsprojects.xyz)** (`config.json → ghes`) |
| The private platform (bot, panel server, templates, deploy workflows) and a bot-only **build copy** of every site | org **`apjs-hosted-sites`** on [awesome-projects.ghe.com](https://awesome-projects.ghe.com) (`config.json → emu`) |
| Sign-in (SAML identity provider) and the panel API | `api.awesomeprojects.tech` (Cloudflare Worker, code in `platform/worker`) |
| Hosted sites | Cloudflare Pages, one project per site: `ap-<name>.pages.dev` + `<name>.awesomeprojects.tech` |

Why two GitHubs: the server is ours, so it can enforce our own push rules and branding. But a site's build runs the owner's code, and that must not run on our machine. So every build happens on GitHub's runners, in the site's build copy on ghe.com. Setting `ghes.live` to `false` puts everything back on ghe.com, where everyone still has an account. Server details (host, backups, admin access) are in the private `platform/docs/SERVER.md`.

## What people do

| Who | How |
|---|---|
| Someone who wants a hosted site | Picks **Host it for me** on the website. When it's approved, the bot creates their managed account, a private repo from the starter they chose, the Cloudflare Pages project and the DNS record. The first deploy is live about a minute later. |
| Site owner | Signs in at **[github.samsprojects.xyz](https://github.samsprojects.xyz/login)** (*Sign in with SAML*), edits the repo and pushes; each push redeploys, and the commit shows whether it went live. [My domains](https://awesomeprojects.tech/me/) shows the deploys and has Redeploy, collaborators and **Get my enterprise account**. |
| Collaborator | The owner adds them in My domains or with `/site-collab <name> @user add`. They get a managed account with write access. There is no invite to accept. |
| Maintainer | `/emu-create`, `/emu-suspend`, `/emu-restore @user`, or Console → People. `/suspend-user` also suspends the managed account. A suspended account is only ever brought back by `/emu-restore`: nothing else (a new request, being added to a site, a site sync) re-activates it. |
| Maintainer on duty | `/ops-account` makes a separate duty login (`ops-<name>`) that can open no repository. `/access <name> <permission> [hours]` elevates it on one repo for a limited time; `maintain` and `admin` wait for the owner's `/access-approve`. At the SSO page, pick **Everyday** or **Duty**. Details: [MAINTAINERS.md](MAINTAINERS.md#maintainer-rooms). |

## How sign-in works

1. Alice opens the server's sign-in page (or the enterprise SSO page on ghe.com). GitHub sends her browser to `api.awesomeprojects.tech/saml/sso` with a SAML request.
2. The Worker checks the request is from **our** enterprise and returns to **its** address, then sends her through GitHub OAuth on github.com. The SAML request rides inside the signed OAuth state, so there are no cookies.
3. Back from GitHub, it looks her up by her GitHub account **id** (renaming an account can't take over someone else's). If she's provisioned and active, it signs a SAML response whose NameID is her SCIM `userName`, and her browser posts it to the enterprise.

The SAML test in the enterprise settings is signed for the setup user (`2mv68l64_admin`) or the repo owner, because nobody is provisioned at that point.

## How a deploy works

1. The owner pushes to `main` of `sites/<name>` on the server.
2. The server's webhook tells the panel. The panel asks the bot to copy that commit to the build copy, `apjs-hosted-sites/<name>` on ghe.com. **The copy is refused** unless `.github/workflows` holds exactly the managed `deploy.yml`, so nobody can run their own workflow with our secrets.
3. The build copy's `deploy.yml` calls `apjs-hosted-sites/platform/.github/workflows/cf-pages-site.yml` and passes **only** the two Cloudflare secrets:
   - **build** runs the site's own code (`npm install`, the build) with **no secrets**. It gets the build scripts from the platform's `site-build` action, so it never clones anything.
   - **deploy** only uploads the built files, after stripping `_worker.js`, `functions/` and `_routes.json`, so a site can't run server code on our Cloudflare account.
4. The commit on the server gets a status: ✓ *Live on name.awesomeprojects.tech*, or ✗ with a comment showing the failed step and the end of its log.

People who point a name at **their own** GitHub repo use the public copy instead: `So10-k/awesomeprojects.tech/.github/workflows/pages-site.yml`, which publishes to their repo's GitHub Pages. It has to be public, because a personal repo can't call a private workflow in our enterprise.

## Secrets

| Where | Secret | What it is |
|---|---|---|
| Public registry | `GHES_BOT_TOKEN` | Classic token of `so10-k` **on the server**: `repo`, `workflow`, `admin:org`, `admin:org_hook`. Site repos, orgs, rooms, commit statuses. |
| Public registry | `GHES_SCIM_TOKEN` | Classic token of the server's `scim-admin` (a site admin), `scim:enterprise`, no expiry. SCIM only: creates, suspends and restores accounts. |
| Public registry | `BOT_PAT` | Classic token of `so10-k` **on ghe.com**: `repo`, `workflow`, `admin:org`. Build copies and checking out the platform. |
| Public registry | `EMU_ADMIN_TOKEN` | ghe.com's setup user (`2mv68l64_admin`), `scim:enterprise`. Only used while `ghes.live` is off. |
| Public registry | `CLOUDFLARE_PAGES_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Lets the bot create Pages projects and attach domains. |
| Public registry | `CLOUDFLARE_API_TOKEN` | DNS (DNSControl). |
| Public registry | `CLOUDFLARE_WORKERS_TOKEN`, `PANEL_*`, `ROOM_HOOK_SECRET` | The panel server and its sign-in key: [PANEL.md](PANEL.md). `ROOM_HOOK_SECRET` also signs the server's webhooks. |
| Org `apjs-hosted-sites` (ghe.com) | `CLOUDFLARE_PAGES_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Used by site deploys, which only see these two. |

`/bot-check` shows every token, its scopes, SCIM and the build org. Ask for no more scope than the table says.

## Keeping it running

- **Code changes** go to `apjs-hosted-sites/platform` (`npm test` there; Checks runs on every push). The public bot runs whatever is on platform `main` on its next event.
- **The panel server redeploys itself.** Every hour the bot compares the live version (`/health` → `version`) with platform's `worker/` plus the `emu` settings, and runs **Panel server** when they differ. To deploy right away: Actions → *Panel server* → *Run workflow*.
- **The website** takes its command list and hosting rules from the platform on every build, so it can't drift from the bot.
- **Site repos** pick up changes to the deploy workflow with `/site-sync <name>`, which also re-copies the site to its build copy and redeploys it.
- **Daily ops** (06:41 UTC, or `/ops`): deploy failures become an issue in the site repo, oversize and abandoned sites get locked, seats are counted.

## Seats

Every managed user is a seat, duty accounts too. The setup user isn't counted. `maxSeats` (now 50) caps it: when hosting is full, new hosted requests and collaborators wait for a maintainer. `/seats` lists them.

---

## Rebuilding it from scratch

Only needed for a new enterprise. The one above is set up.

1. **Enterprise.** Start an Enterprise Managed Users trial with data residency and pick the subdomain (`awesome-projects` → `awesome-projects.ghe.com`). GitHub mails the setup user `<shortcode>_admin`; set its password and 2FA, and keep the recovery codes.
2. **Signing key.** The private key goes straight into a secret, and only the certificate stays on disk:
   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=awesomeprojects.tech SAML" -keyout /tmp/ap-saml.key -out ap-saml.crt
   openssl pkcs8 -topk8 -nocrypt -in /tmp/ap-saml.key | gh secret set PANEL_SAML_PRIVATE_KEY -R So10-k/awesomeprojects.tech
   rm /tmp/ap-saml.key
   gh secret set PANEL_SAML_CERT -R So10-k/awesomeprojects.tech < ap-saml.crt
   ```
3. **`config.json`**: `"emu": { "enterprise": "<slug>", "org": "<sites org>", "shortcode": "<code>", "host": "<slug>.ghe.com" }`. Merge it. The hourly check deploys the panel with the new settings, or run *Panel server* yourself. <https://api.awesomeprojects.tech/saml/metadata> then shows the certificate.
4. **SAML**, as the setup user: Enterprise → Settings → Authentication security → *Require SAML authentication*. Sign on URL `https://api.awesomeprojects.tech/saml/sso`, issuer `https://api.awesomeprojects.tech/saml`, the certificate from `ap-saml.crt`, RSA-SHA256 / SHA256. **Test SAML configuration** and approve the awesomeprojects.tech app **as the setup user**, without switching accounts. Save, and keep the SSO recovery codes.
5. **Open SCIM**, same page: tick *Enable open SCIM configuration*. Without it every SCIM call fails with "must use Azure AD, Okta, or Ping".
6. **Setup-user token**: a classic token with `scim:enterprise` → `gh secret set EMU_ADMIN_TOKEN -R So10-k/awesomeprojects.tech`.
7. **Your managed account**: comment `/emu-create @So10-k` (it's made an enterprise owner), sign in at the SSO page as it, and create the sites org. Then make a classic token on that account with `repo`, `workflow` and `admin:org` → `gh secret set BOT_PAT -R So10-k/awesomeprojects.tech`.
8. **Cloudflare**: a token with *Account → Cloudflare Pages → Edit*, set on the public registry and as org secrets (run these logged in to the enterprise host: `gh auth login -h <slug>.ghe.com`):
   ```bash
   gh secret set CLOUDFLARE_PAGES_TOKEN -R So10-k/awesomeprojects.tech
   gh secret set CLOUDFLARE_ACCOUNT_ID -R So10-k/awesomeprojects.tech --body <account id>
   GH_HOST=<slug>.ghe.com gh secret set CLOUDFLARE_PAGES_TOKEN --org <sites org> --visibility all
   GH_HOST=<slug>.ghe.com gh secret set CLOUDFLARE_ACCOUNT_ID --org <sites org> --visibility all --body <account id>
   ```
9. **Platform**: create `<sites org>/platform` (private) and push this repo's platform code to it.
10. **Check**: `/bot-check` should be all ✅, then `/org-setup` applies org defaults, the Actions allow-list, custom properties, rulesets, custom roles and the maintainer rooms. `/site-sync <name>` re-applies each site.

## Turning it off

Set `"emu": {}`. New hosted requests then need a classic `sitesOrg`, or hosting is off. Existing managed sites keep running on Cloudflare Pages, but the bot stops managing them.
