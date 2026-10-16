# Maintainer guide

The bot does the checking. You make the calls it can't: approve, hold, reject, take down.
Everything is a comment, so it all works from the GitHub mobile app.

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
| `/help` | anywhere | Everything, including the user commands |

**A good place to run admin commands:** open one issue titled "Admin console", pin it, and run `/ban`, `/reserve`, `/lock`… there. Its history is your audit trail.

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
5. **Discussions** on, and **Pages** for this repo: *Source* = GitHub Actions, custom domain `awesomeprojects.tech`.
6. **Later: the [Public Suffix List](https://github.com/publicsuffix/list).** Once established, apply so browsers isolate cookies between subdomains. Until then, nothing with logins should live on the root domain.
