# Maintainer guide

The bot does the checking. You make the calls it can't: approve, hold, reject, take down.
Everything is a comment, so it all works from the GitHub mobile app.

- [The console](#the-console)
- [Hosted sites](#hosted-sites)
- [Your daily routine](#your-daily-routine)
- [Command reference](#command-reference)
- [Request issues](#request-issues)
- [The activity log & Discussions](#the-activity-log--discussions)
- [The website](#the-website)
- [Approving](#approving)
- [Verifying a request](#verifying-a-request)
- [Holds](#holds)
- [Rejecting](#rejecting)
- [Transfers](#transfers)
- [Takedowns & abuse](#takedowns--abuse)
- [Weekly health check](#weekly-health-check)
- [Tuning the bot](#tuning-the-bot-configjson)
- [Emergencies](#emergencies)
- [How it's built](#how-its-built)
- [One-time setup](#one-time-setup)

---

## The console

**[awesomeprojects.tech/admin](https://awesomeprojects.tech/admin/)** is a dashboard for all of this:

| Tab | What's there |
|---|---|
| **Queue** | Requests and PRs in three lanes (ready · waiting on someone · needs changes), each with the bot's review one click away, and buttons for approve / hold / unhold / reject / recheck |
| **Reports** | Takedown reports: take down or dismiss |
| **Names** | Every name with *Verify* and *Take down* |
| **People** | Ban / unban, per-person limits |
| **Maintenance** | Pause / resume requests, deploy, health check, reserved names |
| **Owner** *(owner only)* | Promote / demote maintainers, links to the settings the console can't change |
| **Activity** | The bot activity log |

**Two ways to sign in:**

- **Sign in with GitHub** (*private mode*, the default): actions go privately to the bot through the [panel server](PANEL.md). There are no comments and no slash commands, and every action is in the private audit log (*Activity* tab) under your name. Setup: [docs/PANEL.md](PANEL.md).
- **A token** (*comment mode*, the fallback when the server is down): the page posts the slash command as a comment from your account, as described below.

**Comment mode.** You sign in with a **fine-grained token** (the page links to GitHub with the permissions pre-filled: this repo only, *Issues* and *Pull requests* read & write, *Discussions* read). It stays in your browser. Every button shows the exact command first (`➜ /ban @x phishing · on #31 as @you`) and posts it **as you** when you press *Post*: on the request itself, or on the pinned **🛠️ Admin console** issue for global actions. The bot does the work, replies, and logs it; the console shows the reply.

**Security.** The page only hides what you can't use; the bot enforces it. Maintainer commands from non-maintainers are ignored, and `/promote` and `/demote` only work for the owner. Treat the token like a password: give it a short expiry, and revoke it in GitHub → Settings → Developer settings if it's ever exposed.

---

## Hosted sites

"**Host it for me**" names get a private repo in the **`sites` org on our GitHub server** (github.samsprojects.xyz, `config.json → ghes`), served on **Cloudflare Pages**. Each site also has a bot-only *build copy* on ghe.com (`apjs-hosted-sites/<name>`): every push to the server is copied there and deployed on GitHub's runners, and the result comes back as a status on the commit (with the log, if it failed). The copy is refused if `.github/workflows` was changed. How it all fits: [MANAGED.md](MANAGED.md). Leave `sitesOrg` empty unless you still want a classic GitHub Pages hosting org.

- **On approval** the bot creates `sites/<name>` on the server with a starter page, the Cloudflare deploy workflow and an `awesomeprojects.json`. It provisions a managed account for the owner, gives them write access (no invite to accept), and attaches `<name>.awesomeprojects.tech` to the Pages project.
- **Status** lives in `domains/<name>.json → site.status` and is applied to the repo:

  | Status | Owner | Site / DNS | Use it when |
  |---|---|---|---|
  | `active` | write | live | normal |
  | `locked` | read | live | a dispute, or "please stop changing it" |
  | `suspended` | read | **DNS off** | abuse under review (DNS off so nobody can take the name over) |
  | `archived` | removed | DNS off, repo archived | done with it |

  Change it from the console's **Sites** tab or with `/site`. Only the owner can bring back an archived site.
- **Templates:** Plain HTML, Next.js, Vite + React, Astro or Docs (VitePress), from `templates/` in **`apjs-hosted-sites/platform`**, created in one commit. Each one is test-built through the real deploy pipeline.
- **Custom properties** on every site repo (`ap_status`, `ap_owner`, `ap_name`, `ap_template`), and org rulesets that target them:
  - **frozen sites:** `ap_status` locked or suspended means GitHub refuses every push, branch creation and deletion
  - **managed workflows:** no edits to `.github/workflows/**`, a maximum file size (`maxFileSizeMB`), and blocked file types (`blockedExtensions`)
  - **protect main:** no force pushes or deletion
- **Custom roles** (Enterprise): `ap-site-owner` (write + read security alerts), `ap-site-collaborator` (write), `ap-site-locked` (triage: they can answer our issues but not push), and an `ap-maintainer` org role (audit log, Actions usage, read-only) for the maintainers team. Only the permissions GitHub offers are used; `/org-setup` reads the live list.
- **Security:** on the server, push rules (`awesome-projects/push-rules`) refuse private keys, common tokens and files over 25 MiB at push time. On ghe.com repos, Dependabot alerts and secret scanning are switched on where the plan allows.
- **Cost guards:** `maxSeats` (managed accounts + any classic outside collaborators; new hosted approvals hold at the cap), `hostedPerOwner`, `hostedMinAccountAgeDays`, `maxRepoSizeMB` and `maxCollaboratorsPerSite`. All are in the console's *Settings* tab.
- **Daily ops** (06:41 UTC, or `/ops` / *Run checks now*):
  - turns on HTTPS when the certificate is ready
  - opens a "deploy failed" issue in the site repo, assigned to the owner, and closes it once a deploy succeeds
  - locks repos over the size limit
  - warns, then optionally locks, sites with no recent push (`inactivityWarnDays` / `inactivityLockDays`)
  - counts seats, sends the console a snapshot, and posts a digest to the activity log (and Discord, if set)
- **Owners manage their own site** in My domains: Redeploy, and collaborators (`/site-collab`), capped per site.
- **Locked down:** org rulesets block every change to `.github/workflows/**` except by org admins (the bot), and the Actions allow-list only permits GitHub's own actions and our build workflow. Site owners edit content; they can't run arbitrary Actions on the org's minutes. To give a site a different build, edit its workflow as an admin, or `/site-sync` to reset it.
- **Removing** a hosted name (takedown or `/remove`) archives the repo and removes the owner; nothing is deleted.
- **Tokens:** `GHES_BOT_TOKEN` = `so10-k` on the server (orgs and repos). `GHES_SCIM_TOKEN` = the server's `scim-admin`, **SCIM only**. `BOT_PAT` = `so10-k` on ghe.com (build copies and the platform). `/bot-check` shows all three.

---

## Your daily routine

1. **Takedown reports first**, especially ones labelled `abuse`: [open reports](../../../issues?q=is%3Aopen+label%3Atakedown).
2. **Requests that are ready**: [issues](../../../issues?q=is%3Aopen+label%3Arequest+label%3Aready) and [PRs](../../../pulls?q=is%3Aopen+label%3Aready) labelled `ready`. Glance at each, comment `/approve`.
3. **Holds waiting on you**: [`label:on-hold`](../../../issues?q=is%3Aopen+label%3Aon-hold). The bot's comment says who it's waiting for. Ignore the ones waiting for an owner.

You never need to look at `needs-changes`: that's the requester's move, and the tidy-up job closes them after 14 quiet days.

---

## Command reference

Commands go at the **start** of a comment. A maintainer command from anyone else gets a 😕 reaction and a short note. Everything the bot changes is committed through a PR it opens and merges itself, so `git log` and the [activity log](#the-activity-log--discussions) both show who asked for what.

| Command | Where | What it does |
|---|---|---|
| `/approve` | request issue, PR | Re-checks, clears holds, writes the record, merges, deploys, posts next steps |
| `/approve force` | request issue, PR | Also overrides the **automated blockers**: limits, reserved names, account age, bot signals, bans, seat cap, hosted-site limits, dead targets. **Never** overrides broken records (bad IPs or hostnames, invalid JSON) or someone else's name (use a transfer). Overridden checks are struck through on the review and logged as forced. Console: *Force approve*. |
| `/create <name> @user <host> [target\|repo\|template] [force]` | any issue | Make a name for someone: `hosted` (with a template), `github`, `vercel`, `netlify`, `cloudflare`, `render`, `railway`, `fly`, `cname`, `server`. Same checks, and `force` works as above. Console: *Create*. Forcing a **reserved** name hands it to DNSControl, so any hand-made Cloudflare record at that name is replaced. |
| `/make-repo <repo> @user [template]` | any issue | A private repo in the sites org with no domain, from a template, with the person invited (a seat). The maintainers team is not added. |
| `/reject <reason>` | request issue, PR | Closes it with your reason quoted |
| `/hold <reason>` · `/unhold` | request issue, PR | Pause / resume (label `manual-hold`) |
| `/takedown <name> <note>` | any issue | Removes a name and everything under it, right now. On a report, the name is optional. |
| `/dismiss <reason>` | report | Closes a report without changes |
| `/ban @user <reason>` · `/unban @user` | any issue | Edits `config.json → bannedUsers`: their requests are rejected automatically |
| `/limit @user <n>` | any issue | Per-person limit (`config.json → limits`); `n` = the default removes the override |
| `/reserve <name>` · `/unreserve <name>` | any issue | Edits `reserved.json`. Reserving doesn't remove an existing name: `/takedown` does. |
| `/lock <reason>` · `/unlock` | any issue | Pauses new requests (requesters see your reason; nothing is lost, they're re-checked after `/unlock` + `/recheck`) |
| `/deploy` | anywhere | Re-runs the DNS deploy and rebuilds the website |
| `/health` | anywhere | Runs the dangling-name check now |
| `/promote @user` · `/demote @user` | any issue | **Owner only.** Edits `config.json → maintainers`. Promoting creates that person's duty account and adds it to `site-maintainers`. Demoting suspends the duty account. |
| `/ops-account` | any issue, console, maintainer rooms | Creates your duty account (a separate enterprise login, `ops-…`). It can see no repository until you elevate it. |
| `/access <name> <read\|triage\|write> @user` | any issue | Site owner: standing access for someone's everyday account, only the permission you name. |
| `/access <name> <read\|triage\|write\|security\|maintain\|admin> [hours]` | any issue, console, maintainer rooms | Maintainer: elevate your duty account on that one repo. Caps are 14 days, 7 days, 12h, 8h, 4h, and 2h. `maintain` and `admin` wait for the owner. The console's **Elevate** tab sends the same command. |
| `/access-list [name]` · `/access-revoke <id>` | any issue | See grants, or end one now. The hourly job expires elevations that have run out. |
| `/access-approve <id>` · `/access-deny <id>` | any issue | **Owner only.** Approve or deny a pending elevation. Nothing is granted until it's approved. |
| `/site <name> <active\|locked\|suspended\|archived>` | any issue | A hosted site's status: locked = owner read-only · suspended = also DNS off · archived = repo archived, access removed |
| `/site-sync <name>` | any issue | Re-apply a hosted repo's standard setup (settings, workflow, Pages, owner access) |
| `/repo-access <name> @user <read\|write\|maintain\|none>` | any issue | Same ledger as `/access`. `maintain` tells you to elevate a duty account instead. |
| `/config <setting> <value>` | any issue | **Owner only.** Change a bot setting (also in the console's *Settings* tab) |
| `/suspend-user @user <reason>` | any issue | Ban an account and suspend every site it hosts |
| `/announce <text\|off>` | any issue | A banner on the website, My domains and the console |
| `/ops` · `/seats` | anywhere | Run the daily site checks now · show enterprise seat use |
| `/redeploy <name>` · `/site-collab <name> @user <add\|remove>` | any issue | Owners (and maintainers): redeploy a hosted site · manage its collaborators |
| `/org-setup` · `/bot-check` | any issue | **Owner only.** Re-apply the sites org's defaults · check the bot token and its org role |
| `/help` | anywhere | Everything, including the user commands |

**A good place to run admin commands:** the console's **Elevate** tab, an issue in the maintainer queue, or the lounge. The public "Admin console" issue still works. Every command is logged.

## Ranks and rolesets

The roster is [`maintainers.json`](../maintainers.json). Each change is a bot PR, like the config, so `git log` shows who changed whom and when.

**Ranks** decide how much you can do on your own:

| Rank | On their own | Needs a second maintainer (`/cosign`) | Never |
|---|---|---|---|
| **Trainee** | hold requests, site sync, DNS deploy, checks, duty account, read/triage/write elevations | approve, reject, create, reserve, limits, takedowns, dismissals, site status, standing access, announcements | force-approve, bans, account changes, registry lock, security elevations, cosigning |
| **Maintainer** | everything in their rolesets | elevations while off duty (once there's a rotation) | owner-only things |
| **Lead** | everything in every area, and off-duty elevations | — | owner-only things |
| **Owner** | everything | — | — |

Owner-only: the roster (`/promote`, `/demote`, `/rank`, `/roleset`), `/config`, `/org-setup`, `/bot-check`, and approving `maintain`/`admin` elevations.

**Rolesets** decide where you work. Leads and the owner cover all of them:

| Roleset | Area |
|---|---|
| `reviewer` | requests: approve, reject, hold, limits, reserved names, making names |
| `abuse` | reports and takedowns, bans, suspensions |
| `hosting` | hosted sites: status, sync, repos, accounts, access |
| `infra` | DNS deploys, the registry lock, security elevations |
| `docs` | announcements and the handbook |

**The two-person rule.** When a trainee runs something that needs a second pair of eyes, the bot doesn't run it. It answers with an id, and any maintainer who could do it themselves confirms with **`/cosign <id>`**. Then it runs, as the trainee, with both names in the activity log. A cosign stays open for 24 hours and runs only once. You can't cosign your own action, and trainees can't cosign.

**Changing people** (owner):
- `/promote @user [@mentor]` adds a **trainee** (`reviewer`), on probation for 60 days.
- `/rank @user maintainer` (or `trainee`, `lead`) promotes, and ends probation.
- `/roleset @user +abuse -docs` adds or removes areas.
- `/demote @user` takes them off the roster, which also removes them from the rooms and ends their duty grants.
- Setting `"status": "away"` or `"emeritus"` in the file pauses someone's powers without removing them.

If `maintainers.json` is ever invalid, the bot and the panel give maintainer powers to **the owner only** until it's fixed. They never fall back to more.

## The console

**[admin.awesomeprojects.tech](https://admin.awesomeprojects.tech/)** is where maintainers work. Sign in with GitHub.

- **Overview:** what's assigned to you, what's overdue, cosigns waiting for you, who's on duty, and recent activity.
- **Queue:** claim, assign, hand back, and vote on applications.
- **Requests:** approve, hold or reject public and private requests, and take down or dismiss reports.
- **Names:** redeploy, change a hosted site's status, or take a name down.
- **People:** ranks, rolesets, adding and removing people (owner).
- **Duty:** a two-week view, going on duty, and planning a rotation (leads).
- **Access & cosigns:** confirm cosigns, elevate your duty account, and see or end grants.
- **Audit:** every event.
- **Settings:** bot settings (owner), plus one-click runs.

Every button follows your rank and rolesets. If you can't do something, it isn't there. If it needs a second maintainer, it says **cosign**. The panel and the bot check everything again anyway. Keyboard: **⌘K** for anything, `g` then a letter to switch views (`g q` is the queue), and `/` to filter.

The old console at [awesomeprojects.tech/admin](https://awesomeprojects.tech/admin/) stays for now, for creating names, bans, limits and request notes.

## Joining

1. Someone opens a **[🙋 Become a maintainer](../../../issues/new?template=maintainer-application.yml)** issue.
2. The bot answers it and copies it to the queue for the owner.
3. Maintainers vote there with `/vote yes|no [note]`.
4. The owner says yes with `/promote @them [@mentor]` on the application.
5. Then the bot:
   - adds them to the roster as a **trainee** (`reviewer`), on 60-day probation
   - emails a welcome, if they've turned email on
   - opens an onboarding checklist in the queue for their mentor
   - closes the application
6. When probation ends, the owner and the mentor get a reminder: `/rank @them maintainer` when they're ready. Nothing changes on its own.

**Going quiet.** No maintainer activity for 46 days brings a warning email. At 60 days the person is set to `away` (powers paused, duty grants ended, out of the rooms), and at 180 days to `emeritus`. Each change is a roster PR. Change the timers with `/config maintainerAwayDays <n>` and `/config maintainerEmeritusDays <n>` (0 turns them off). Set `"status": "active"` to bring someone back.

## Duty

| Command | |
|---|---|
| `/duty` | Who's on duty now, and next |
| `/duty-take [hours]` | Go on duty now (8 hours by default, at most 24) |
| `/duty-end` | End your shift |
| `/duty-plan @a @b @c [weeks]` | **Leads:** weekly turns from next Monday 00:00 UTC. It replaces shifts that haven't started. |

- **On duty**, you can elevate your duty account up to `write` by yourself, and new queue items come to you first.
- **Off duty**, an elevation becomes a cosign that only a lead can confirm.
- **With no rotation planned**, everyone counts as on duty (how it worked before).
- **Emails:** each person gets one when their shift starts and one when it ends, with who's next.

## The queue

Every request, report, private request and application has a copy in `maintainers/queue` on our server, and each copy is a tracked item:

- **Deadlines:** reports 12 hours, requests 48 hours, applications 7 days, failing deploys 3 days.
- **Who gets it:** the bot assigns it right away, choosing whoever is on duty first, then someone with the right roleset (reviewer for requests, abuse for reports), then whoever has the fewest open items. Applications go to the owner.
- **On the copy:** `/claim`, `/assign @user`, `/unassign` (hands it to the next person), `/triage <note>`. Any other command still runs against the original.
- **Every hour:**
  - Decided items close their copy.
  - Overdue items get the `overdue` label and one email a day to whoever has them (or to whoever is on duty).

## Email

Email is opt-in. In [My domains](https://awesomeprojects.tech/me/), **Email me** signs you in to GitHub once more with permission to read your email addresses. We keep only your primary verified address, and GitHub's token is dropped. Turn it off there at any time.

Maintainers get duty handoffs, assignments, overdue nudges, probation and onboarding mail. Messages wait in an outbox until there's an address to send to, and anything nobody can receive is dropped after two weeks.

The bot sends through our mail server: secrets `SMTP_USER` and `SMTP_PASS`, plus optional repo variables `SMTP_HOST` (default `mail.ottens.org`) and `SMTP_FROM`. It refuses to log in unless the server offers STARTTLS.

## Maintainer rooms

Two private organizations on our server, `maintainers` and `on-duty` (`config.json → ghes`). `/org-setup` (or any `/promote` / `/demote`) builds and re-checks them, and its last lines are an audit: owners, members, default access and whether Actions is off.

- **maintainers** is for your everyday account. `handbook` is the instructions (read only). `lounge` is the discussion board. `queue` gets a copy of every request and report; a command on a copy runs against the original, and the reply is posted in both places. Members can comment and triage; nobody can push, create repositories or change settings.
- **on-duty** is the runbook. Owners can always see it. A duty account is a member only while it holds an active elevation; the bot adds it on approval and removes it when the last one ends. Anyone else found there is removed on the next sync.
- **Actions is switched off** in both, so nothing in them can run a workflow.
- **Links.** Only awesomeprojects.tech, github.com and our server (`github.samsprojects.xyz`). Anything else counts as outside, including other `*.ghe.com` enterprises. An outside link in a lounge thread hides the comment and locks the thread; in the queue the comment is hidden, and an issue opened with one is closed and locked. Edited comments are checked too.
- **Who can run commands there.** The bot maps the enterprise login back to the maintainer's github.com login, and only runs commands for current maintainers and the owner. A duty account can only run `/access-list`, `/access-revoke` and `/help` (from the runbook); everything else comes from the everyday account.

## Duty accounts

- **Names.** `ops-` + your enterprise username. That prefix is reserved: nobody can get an everyday account named `ops-…`, the sign-in refuses one, and the bot never adopts an existing account unless its SCIM `externalId` is that person's (`gh-<id>` for everyday, `ops-gh-<id>` for duty). Without that check, a github.com user named `ops-<maintainer>` could have been handed that maintainer's duty account.
- **Elevations** (`/access <name> <permission> [hours]`) are per repo, per permission and timed. `maintain` and `admin` wait for the owner; a request that isn't approved within 24 hours lapses, and the owner is pinged on Discord when one arrives (once `DISCORD_WEBHOOK` is set; it isn't yet). Expiry runs every hour.
- **Demotion** removes the everyday account from `maintainers`, suspends the duty account, ends every grant it held and takes it out of `on-duty`.
- **Suspensions stick.** Nothing re-activates a suspended account as a side effect (a hosted request, a collaborator add, a site sync). Only `/emu-restore`.

**One setting to change by hand** (GitHub has no API for it): Enterprise → **Policies → Repositories → Repository deletion and transfer → Disabled**. Then even an `admin` elevation can't delete or move a site's repository.

## Signing in as the duty account

1. Open the enterprise SSO page (or **Sign in as ops-…** on the console's Elevate tab).
2. Confirm it's you with your normal GitHub account.
3. Choose **Everyday** or **Duty**. Only current maintainers and the owner see the choice.

Use a separate browser profile or a private window for the duty account, so you never push as the wrong one. Elevations apply to the duty account even if you never open a browser session as it.

---

## Request issues

The main way people ask now: the [website](https://awesomeprojects.tech) or the [request form](../../../issues/new?template=request.yml) opens an issue labelled `request`. The bot:

1. Turns the form into a `domains/<name>.json` entry (`scripts/providers.js`): GitHub repo → `CNAME <owner>.github.io` + `site.repo`; Vercel → `cname.vercel-dns.com`; Netlify/Cloudflare Pages/Render/Railway/Fly → their hostnames; own server → A/AAAA.
2. For GitHub repos, checks that the repo exists, is public and not archived, and belongs to the requester (or an org where their membership is public; otherwise ⏸️ for you), then reads its files and shows the **build plan** (`scripts/frameworks.js`).
3. Runs the same review as PRs, and posts it with a preview of the exact file.
4. On `/approve` (or auto-merge), opens + merges a PR with the file, deploys, comments **🎉 live + next steps**, labels it `live`, and closes the issue.

**Edits re-trigger the review**, so requesters fix typos by editing the issue. A request for a name they already own is an **update**. A name someone else owns comes back as ✏️ "taken" with a transfer link.

---

## The activity log & Discussions

- **📜 Bot activity log**, a discussion in *Announcements* that the bot creates on first use: one line per change (approved, rejected, removed, transferred, TXT added, banned, reserved, locked, deployed), with who did it and the PR. Subscribe to it to get everything in one feed.
- **Q&A / Show and tell**: people help each other and show off their sites. `/help`, `/available`, `/whois`, `/mine`, `/verify` and `/stats` work in discussion comments; the bot replies in the thread.

---

## The website

`site/` (plain HTML/CSS/JS) is built by `scripts/build-site.js` into `_site/` with a `data.json` generated from the repo (names, reserved words, providers, frameworks, commands), so it can't drift from the bot. `.github/workflows/site.yml` publishes it to GitHub Pages at the root domain on every change; the bot also rebuilds it after each merge.

Preview locally: `node scripts/build-site.js && npx http-server _site`.

The root's `A`/`AAAA` and `www` are managed in `dnsconfig.js` (GitHub Pages). Other record types on the root (MX, TXT…) are still ignored, so set up email by hand in Cloudflare.

---

## Approving

Comment **`/approve`** on the request issue or PR. The bot:

1. Re-runs every check against the latest `main`.
2. If nothing is ✏️ or ⛔, it squash-merges (holds don't block a maintainer's `/approve`).
3. Starts a DNS deploy, which takes about a minute, and edits its comment to 🚀 **Merged**.

If it says it can't merge, the checks found a real problem. Ask the requester to fix it.

**Auto-merge** (off by default): with `"autoMerge": true` in `config.json`, the bot merges ✅ requests by itself, but only from accounts at least `autoMergeMinAccountAgeDays` old (180) with zero throwaway signals. Turn it on once you've watched the bot for a while and trust it.

---

## Verifying a request

The bot already checked the format, ownership, account, limit, name and DNS. Before you `/approve`, spend 20 seconds on what it can't judge:

- **Does the target look legit?** Open the target hostname (not the subdomain). A real portfolio, app or docs site is fine. A login form for some other brand, a crypto giveaway, or a "verify your account" page means `/reject`.
- **Does the name fit the project?** `alice` → Alice's portfolio is fine. `steam-support` → a random Vercel app is not.
- **A records:** an IP with nothing on it today is fine for a self-hosted server, but use your judgement.
- **Profile sanity**, for held accounts: real repos, real activity? A profile created yesterday with no repos asking for `wallet-login` is the textbook case.

---

## Holds

⏸️ means "a person needs to decide". The status stays *pending*, so it can't be merged by accident.

| Label | Why it's held | Who clears it |
|---|---|---|
| `nested` | A name under someone else's subdomain (`docs.alice` by bob) | **The parent owner** comments `/approve` (or you do) |
| `transfer` | A PR hands a name to another account | **The new owner** comments `/accept` |
| `new-account` | The account is 7–30 days old | You: verify it, then `/approve` |
| `maybe-bot` | 3+ throwaway signals (no repos, no followers, empty profile, under 90 days, username ends in a long number) | You |
| `sensitive-name` | The name contains a phishing-bait word (`login`, `paypal`, `wallet`…) | You |
| `pages-mismatch` | CNAME to `someone-else.github.io` (often an org, which is fine) | You: check they're a member of that org |
| `manual-hold` | You put it on hold | You: `/unhold` |

**Your commands:** `/hold <reason>` pauses anything (the reason is posted). `/unhold` resumes. `/approve` clears every hold at once and merges.

Owners and new owners don't need to understand any of this: the bot @mentions them with the exact word to reply.

---

## Rejecting

**Automatic ⛔ (closed by the bot):**
- bot accounts (`type: Bot`)
- accounts younger than `rejectAccountsYoungerThanDays` (7). The bot tells them the date they can come back.
- anyone in `bannedUsers`
- editing or deleting a name that belongs to someone else (it points them to transfers)

**By you:** `/reject <reason>` closes the PR with your reason quoted. Keep it short and kind; it's public. For example:

> `/reject This points at a login page for another company.`

**Repeat abusers:** add their username to `bannedUsers` in `config.json` (via a PR). Their future requests are rejected automatically.

**Fixable problems** (✏️) are never rejected: the requester pushes a fix and the bot re-checks automatically.

---

## Transfers

Someone opens a [transfer issue](../../../issues/new?template=transfer.yml). The bot works out who still needs to agree:

| Opened by | Waits for |
|---|---|
| the current owner (giving it away) | the new owner to comment `/accept` |
| the person who wants it | the current owner to comment `/approve` |

Once both have agreed, and the new owner passes the account checks and has room under the limit, the bot opens a PR moving the name (plus everything under it the old owner has) and merges it. The old owner's email is dropped and DNS records stay the same.

**Owner vanished?** If the current owner hasn't answered in `consentTimeoutDays` (30), check whether the site is dead or abandoned. If handing it over is fair, comment `/approve` yourself on the issue. Your approval stands in for theirs.

A transfer can also arrive as a PR (the owner edits `owner.github`). The bot holds it with `transfer` until the new owner comments `/accept`.

---

## Takedowns & abuse

Someone opens a [takedown issue](../../../issues/new?template=takedown.yml).

- **By the owner** (or the owner of the parent name): removed **automatically, right away**. You don't have to do anything.
- **A report** from anyone else: the bot posts a summary (owner, target, whether the target resolves, reason), @mentions the owner, and labels it `abuse` (phishing, malware, impersonation) or `dangling`.

Then you decide:

| Command | Effect |
|---|---|
| `/takedown <note>` | Removes the name **and everything under it**, merges, deploys, closes the issue. |
| `/dismiss <reason>` | Closes the report without changes. |

**Phishing or malware: act first, discuss later.** `/takedown` is easy to undo: the owner can re-request if it was a mistake. A phishing page staying up is the thing that gets the whole domain blocklisted.

---

## Weekly health check

Every Monday the bot resolves every CNAME target. Names pointing at hostnames that don't exist end up in one pinned issue (label `health`) that @mentions their owners. The issue closes itself when everything resolves again.

A dangling CNAME is how subdomains get hijacked: someone claims the abandoned `x.herokuapp.com` and now serves content on your domain. Give owners `consentTimeoutDays` to react, then remove the leftovers with a takedown issue + `/takedown`.

Run it any time from **Actions → Subdomain bot → Run workflow → `health`**.

---

## Tuning the bot (`config.json`)

| Key | Default | What it does |
|---|---|---|
| `maintainers` | `[]` | Extra maintainer usernames (the repo owner always is one) |
| `bannedUsers` | `[]` | Auto-reject these accounts |
| `maxPerOwner` | `3` | Top-level names per account |
| `maxFilesPerRequest` | `10` | Files per PR |
| `rejectAccountsYoungerThanDays` | `7` | ⛔ below this age |
| `holdAccountsYoungerThanDays` | `30` | ⏸️ below this age |
| `holdBotScoreAtLeast` | `3` | Throwaway signals (0–5) that trigger a hold |
| `holdNamesContaining` | phishing words | ⏸️ names containing any of these |
| `autoMerge` | `false` | Merge ✅ requests without you |
| `autoMergeMinAccountAgeDays` | `180` | Minimum account age for auto-merge |
| `consentTimeoutDays` | `30` | How long owners get before a maintainer may step in |

`reserved.json` lists names nobody can request. Those names (and the root) are also never touched by deploys, so manage them by hand in Cloudflare.

Config changes go through a PR like everything else. The bot always runs `main`'s config.

---

## Emergencies

- **Kill a record right now:** Cloudflare dashboard → DNS → delete it. Then open a takedown + `/takedown` so the repo agrees (otherwise the next deploy puts it back).
- **Re-run anything:** Actions → Subdomain bot → Run workflow → `pr 12`, `issue 34` or `health`.
- **The bot is misbehaving:** Settings → Actions → disable the *Subdomain bot* workflow. Requests then wait for you to merge by hand (you can bypass the rules as an admin).
- **A deploy wants to delete a lot:** it refuses beyond 10 deletions. Read the preview in the run log; if it's intended, run *Deploy DNS* by hand with `allow_mass_delete`.

---

## How it's built

```
domains/*.json            source of truth: one file per name
config.json               bot knobs · reserved.json: off-limits names
scripts/rules.js          what makes a file and the whole tree valid (pure, tested)
scripts/review.js         the review engine: verdict + checks for a PR (pure, tested)
scripts/requests.js       transfer & takedown logic (pure, tested)
scripts/comment.js        the bot's comments
scripts/providers.js      request form → records, per-host setup steps (pure, tested)
scripts/frameworks.js     how to build a repo for GitHub Pages (pure, tested)
scripts/commands.js       the command catalog, /available /whois /mine /stats, admin config edits (pure, tested)
scripts/bot.js            event router: GitHub API, git, DNS, activity log
scripts/lib.js            GitHub REST + GraphQL client, reading domains/ from git, DNS lookups, /verify
scripts/site-build.js     runs in people's repos: plan → prepare (Next.js export) → finish
scripts/build-site.js     builds the website into _site/
site/                     the website
dnsconfig.js              DNSControl: domains/ → Cloudflare records
.github/workflows/
  bot.yml                 issues / pull_request_target / comments / discussions / weekly → scripts/bot.js
  pages-site.yml          REUSABLE: people's repos call it to build + publish their site
  site.yml                the website → GitHub Pages
  deploy.yml              push to main (or the bot) → dnscontrol preview + push
  checks.yml              unit tests on PRs (read-only)
  stale.yml               closes needs-changes after 14 quiet days
```

**Security model.** `bot.yml` runs on `pull_request_target` with a write token, so it **only runs `main`'s code** and reads PR files as git objects + `JSON.parse`. It never checks out a PR, runs `npm install`, or puts PR text into a shell command. Keep it that way. `checks.yml` runs PR code but with a read-only token and no secrets. The Cloudflare token lives only in `deploy.yml`, which only runs from `main`.

**Status check.** The bot posts a commit status called `subdomain-review` (success = ready, pending = held, failure = needs changes or rejected). The `protect-main` ruleset requires it on every PR, so nothing merges without the bot's OK, and only people with write access can merge at all. `/approve` works because the bot merges with its own token once the status is green. (There's no "required approvals" rule: on a personal repo GitHub Actions can't bypass one, and you can't approve your own PRs anyway. If the repo moves to an organization, you can add approvals back and put GitHub Actions on the bypass list.)

**Locally:**

```bash
npm test                                   # all unit tests
node scripts/validate.js                   # validate domains/
dnscontrol check                           # validate dnsconfig.js
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=So10-k/awesomeprojects.tech DRY_RUN=1 node scripts/bot.js pr 12
```

`DRY_RUN=1` reads from GitHub but only prints what it would write.

---

## One-time setup

Already done for this repo; here for reference.

1. **Cloudflare:** the zone on Cloudflare's nameservers; an API token from the *Edit zone DNS* template, scoped to this zone only, saved as the `CLOUDFLARE_API_TOKEN` Actions secret.
2. **Ruleset `protect-main`:** PRs only, required status `subdomain-review`, no force pushes or deletion. Bypass: repo admins, PR only (to merge changes to the bot itself, which it can't review before they exist).
3. **Actions:** require approval for workflows from outside contributors (this covers `checks.yml`; the bot always runs); default token read-only (each workflow asks for what it needs).
4. **Labels:** `request`, `live`, `ready`, `needs-changes`, `on-hold`, `rejected`, `nested`, `transfer`, `new-account`, `maybe-bot`, `sensitive-name`, `pages-mismatch`, `manual-hold`, `takedown`, `abuse`, `dangling`, `health`, `stale`.
5. **Optional Discord:** `gh secret set DISCORD_WEBHOOK -R So10-k/awesomeprojects.tech` (a channel webhook URL) gets new requests, reports and ops problems.
6. **Discussions** on, and **Pages** for this repo: *Source* = GitHub Actions, custom domain `awesomeprojects.tech`.
7. **Later: the [Public Suffix List](https://github.com/publicsuffix/list).** Once established, apply so browsers isolate cookies between subdomains. Until then, nothing with logins should live on the root domain.

## Managed accounts

`/emu-create @user`, `/emu-suspend @user` and `/emu-restore @user` (or Console → People) manage people's enterprise accounts. Setup and how sign-in works: [MANAGED.md](MANAGED.md).
