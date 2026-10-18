# Managed accounts (Enterprise Managed Users)

When this is on, people don't join hosted site repos with their own GitHub account. The bot creates them a **managed account** in our enterprise (`alice_ap`, say) and gives that account access. To sign in, they open the enterprise's sign-in page and prove who they are with their normal GitHub account. There's no new password to remember.

- **Identity provider:** the panel server (`api.awesomeprojects.tech/saml`). It signs people in through GitHub OAuth and answers GitHub with a signed SAML response. It only signs for people the bot has provisioned, and it matches them by their GitHub account **id**, so renaming an account can't take over someone else's.
- **Provisioning:** the bot calls GitHub's SCIM API with the setup user's token. It creates, suspends, restores and finds accounts.
- **Hosting:** GitHub Pages sites are always private under managed users, so these sites deploy to **Cloudflare Pages** (`ap-<name>.pages.dev`, with `<name>.awesomeprojects.tech` attached). Leave `sitesOrg` empty to host only here; if you still have a classic sites org, those GitHub Pages sites keep working as before.

| Who | What they do |
|---|---|
| Site owner | **My domains → Enterprise account → Get my enterprise account.** Hosted requests create one automatically. |
| Maintainer | Console → People → *Create / Suspend / Restore account*, or `/emu-create @user`, `/emu-suspend @user`, `/emu-restore @user`. `/suspend-user` also suspends the managed account. |
| Collaborators | `/site-collab <name> @user add` gives them a managed account plus write access. There's no invite to accept. |

GitHub only supports partner identity providers. A custom one like ours is allowed (it implements SAML 2.0 and SCIM 2.0), but GitHub Support won't help debug it.

### Public registry vs private platform

| Repo | Visibility | Holds |
|---|---|---|
| `So10-k/awesomeprojects.tech` | **Public** | `domains/`, DNS, request forms, marketing site, thin bot/panel runners, domain `scripts/` for validate/site build |
| `apjs-hosted-sites/platform` (`config.platformRepo`) | **Private** (EMU) | Bot, panel Worker, templates, unit tests, `cf-pages-site.yml` / site-build |

Site repos call reusable workflows in **platform** (same org → `secrets: inherit` works). That private repo must allow Actions access from the rest of the org (`/org-setup` sets this; otherwise GitHub says the workflow was not found). The public bot/panel workflows check out platform with `BOT_PAT`. Platform is the source of truth for ops code — edit there, not in this registry.

After bootstrap: `/site-sync` existing hosted sites so their `deploy.yml` points at `apjs-hosted-sites/platform`.

---

## Setting it up (owner, once)

### 1. Create the managed enterprise

Managed users need a **new** enterprise; an existing enterprise can't be converted. Start an *Enterprise Managed Users* trial or purchase from <https://github.com/enterprise/trial> and choose **Enterprise with managed users**.

- Pick a **short code** of 3–8 letters or numbers (for example `ap`). It's permanent, and every managed username ends in `_<shortcode>`.
- GitHub emails a password-reset link for the **setup user**, `<shortcode>_admin`. Sign in with it in a private window, set a password and turn on 2FA. Save its recovery codes.

### 2. Make the SAML signing key

The private key goes straight into a GitHub secret, and only the public certificate stays on disk:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=awesomeprojects.tech SAML" -keyout /tmp/ap-saml.key -out ap-saml.crt
openssl pkcs8 -topk8 -nocrypt -in /tmp/ap-saml.key | gh secret set PANEL_SAML_PRIVATE_KEY -R So10-k/awesomeprojects.tech
rm /tmp/ap-saml.key
gh secret set PANEL_SAML_CERT -R So10-k/awesomeprojects.tech < ap-saml.crt
```

### 3. Turn it on in `config.json`

```json
"emu": { "enterprise": "<enterprise slug>", "org": "<managed org name>", "shortcode": "ap" }
```

The enterprise slug is the `…` in `github.com/enterprises/…`. Merge it, then run the **Panel server** workflow (Actions → *Panel server* → *Run workflow*). This deploys the sign-in with the key and the enterprise name. Check <https://api.awesomeprojects.tech/saml/metadata>: it should show your certificate.

### 4. Point the enterprise at our sign-in

As the setup user: **Enterprise → Settings → Authentication security → Require SAML authentication**.

| Field | Value |
|---|---|
| Sign on URL | `https://api.awesomeprojects.tech/saml/sso` |
| Issuer | `https://api.awesomeprojects.tech/saml` |
| Public certificate | the contents of `ap-saml.crt` |
| Signature / digest | RSA-SHA256 / SHA256 |

Click **Test SAML configuration** while signed in to github.com as the repo owner or the setup user, and approve the *awesomeprojects.tech* app. The response's NameID is always the setup user (`<shortcode>_admin`), which is the only account GitHub's test will accept. Then save, and store the SSO recovery codes somewhere safe.

Still on that page (as the setup user): under **Open SCIM Configuration**, enable **Enable open SCIM configuration**. Without that checkbox, every SCIM call returns `403 … must use Azure AD, Okta, or Ping Federate` — GitHub's way of saying "partner IdP only", until you turn open SCIM on for a custom IdP like ours.

### 5. Two tokens (setup user ≠ org owner)

The **setup user can't join organizations**. SCIM and org admin are different accounts:

| Secret | Who | What for |
|---|---|---|
| `EMU_ADMIN_TOKEN` | setup user (`<shortcode>_admin`) | SCIM only (`scim:enterprise`) |
| `BOT_PAT` | your **provisioned** managed account (e.g. `so10-k_apjs`), Owner of the managed org | `/org-setup`, creating site repos, collaborators, org secrets |

As the setup user, create a classic PAT with `scim:enterprise` (no expiry), then:

```bash
gh secret set EMU_ADMIN_TOKEN -R So10-k/awesomeprojects.tech
```

### 6. Your managed account, the org, then `BOT_PAT`

After SAML is required, only a **provisioned** enterprise owner can create organizations. The bot makes the repo owner's managed account an enterprise owner automatically.

1. On any issue, comment `/emu-create @So10-k` (or **My domains → Get my enterprise account**). You should get something like `so10-k_apjs`.
2. Sign in at `https://github.com/enterprises/<slug>/sso` **as that managed account** (confirm with your normal GitHub account when our sign-in asks).
3. Create the org you named in `config.json` (**Enterprise → Organizations → New organization**). You (the managed owner) are the org owner; the setup user will never appear in the member list — that's normal.
4. As that managed owner, create a classic PAT with `repo`, `workflow`, `admin:org` (no expiry) and save it as `BOT_PAT` on the public registry **and** as an org secret (site deploys inherit it to clone private `platform`):

```bash
gh secret set BOT_PAT -R So10-k/awesomeprojects.tech
gh secret set BOT_PAT --org <managed org> --visibility all
```

5. Still as the managed owner (personal `So10-k` can't see the org), set the Cloudflare org secrets:

```bash
gh secret set CLOUDFLARE_PAGES_TOKEN --org <managed org> --visibility all
gh secret set CLOUDFLARE_ACCOUNT_ID --org <managed org> --visibility all --body 2f8365ea25e7fd8c95ba7da82046b81c
```

6. In this repo (as `So10-k` is fine):

```bash
gh secret set CLOUDFLARE_PAGES_TOKEN -R So10-k/awesomeprojects.tech
gh secret set CLOUDFLARE_ACCOUNT_ID -R So10-k/awesomeprojects.tech --body 2f8365ea25e7fd8c95ba7da82046b81c
```

Site owners can't read the org secrets. Each site's deploy workflow uses `secrets: inherit` into the reusable workflow in **`platform`** (same org). Set `CLOUDFLARE_PAGES_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **org** secrets on the managed org. The build job never sees them: it loads `site-build.js` as a composite action from platform (GitHub fetches that action; a PAT clone fails SAML SSO). Only the publish job gets the Cloudflare token. The deploy workflow is locked by the *managed workflows* ruleset, and the publish step strips `_worker.js`, `functions/` and `_routes.json`, so a site can only publish static files.

If a site was created before that workflow shape, comment `/site-sync <name>` so the bot rewrites `.github/workflows/deploy.yml`.

### 7. Check, then set up the org

On any issue in this repo, comment:

- `/bot-check`: **BOT_PAT** should be your managed owner of the org; **Managed accounts** should show the setup user + SCIM ✅. If SCIM says to enable Open SCIM, go back to step 4.
- `/org-setup`: applies defaults, Actions allow-list, custom properties, rulesets and custom roles via `BOT_PAT` (not the setup user).

From then on, new hosted requests go to the managed org on Cloudflare Pages. To stop using a classic sites org, set `"sitesOrg": ""` in `config.json`.

---

## How a sign-in works

1. Alice opens `github.com/enterprises/<slug>/sso`. GitHub sends her to our `/saml/sso` with a SAML request.
2. We check that the request is from *our* enterprise and returns to *its* address, then send her through GitHub OAuth. The SAML request rides inside the signed OAuth state, with no cookies.
3. Back from GitHub, we look up her account **id** in `identities`. If she's provisioned and active, we sign a SAML response with NameID = her SCIM `userName`, and her browser posts it to GitHub. Maintainers see a picker first: everyday account or duty account (`ops-…`).

## Seats

Every managed user is an enterprise seat, the same as an outside collaborator was. `maxSeats` counts both orgs together, leaving out the setup user. When hosting is full, new hosted requests and collaborators wait for a maintainer.

## Turning it off

Set `"emu": { "enterprise": "", "org": "", "shortcode": "" }`. New hosted requests need a classic `sitesOrg` again (or hosting is off). Sites already in the managed org keep running on Cloudflare Pages, but the bot stops managing them until you turn it back on.
