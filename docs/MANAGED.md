# Managed accounts (Enterprise Managed Users)

When this is on, people don't join hosted site repos with their own GitHub account. The bot creates them a **managed account** in our enterprise (`alice_ap`, say) and gives that account access. To sign in, they open the enterprise's sign-in page and prove who they are with their normal GitHub account. There's no new password to remember.

- **Identity provider:** the panel server (`api.awesomeprojects.tech/saml`). It signs people in through GitHub OAuth and answers GitHub with a signed SAML response. It only signs for people the bot has provisioned, and it matches them by their GitHub account **id**, so renaming an account can't take over someone else's.
- **Provisioning:** the bot calls GitHub's SCIM API with the setup user's token. It creates, suspends, restores and finds accounts.
- **Hosting:** GitHub Pages sites are always private under managed users, so these sites deploy to **Cloudflare Pages** (`ap-<name>.pages.dev`, with `<name>.awesomeprojects.tech` attached). Sites in the classic sites org keep using GitHub Pages and work exactly as before.

| Who | What they do |
|---|---|
| Site owner | **My domains → Enterprise account → Get my enterprise account.** Hosted requests create one automatically. |
| Maintainer | Console → People → *Create / Suspend / Restore account*, or `/emu-create @user`, `/emu-suspend @user`, `/emu-restore @user`. `/suspend-user` also suspends the managed account. |
| Collaborators | `/site-collab <name> @user add` gives them a managed account plus write access. There's no invite to accept. |

GitHub only supports partner identity providers. A custom one like ours is allowed (it implements SAML 2.0 and SCIM 2.0), but GitHub Support won't help debug it.

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

Click **Test SAML configuration** and sign in with **your own** GitHub account (the repo owner). It's the only account the sign-in will sign for before anyone is provisioned, and the test account matches no managed user. Then save, and store the SSO recovery codes somewhere safe.

### 5. The setup user's token

Still as the setup user, create a **classic** personal access token with `scim:enterprise`, `admin:org`, `repo` and `workflow`, and no expiry, or put a reminder in your calendar. Then:

```bash
gh secret set EMU_ADMIN_TOKEN -R So10-k/awesomeprojects.tech
```

The `gh` command asks for the value, so it never lands in your shell history.

### 6. The managed org and Cloudflare Pages

1. As the setup user, create the org you named in `config.json` (**Enterprise → Organizations → New organization**).
2. In Cloudflare, create an API token with **Account → Cloudflare Pages → Edit** only.
3. The bot needs it, and so does every site repo's deploy (the reusable workflow runs in the managed org):

```bash
gh secret set CLOUDFLARE_PAGES_TOKEN -R So10-k/awesomeprojects.tech
gh secret set CLOUDFLARE_ACCOUNT_ID -R So10-k/awesomeprojects.tech --body 2f8365ea25e7fd8c95ba7da82046b81c
gh secret set CLOUDFLARE_PAGES_TOKEN --org <managed org> --visibility all
gh secret set CLOUDFLARE_ACCOUNT_ID --org <managed org> --visibility all --body 2f8365ea25e7fd8c95ba7da82046b81c
```

Site owners can't read the org secrets. The build job has no secrets, the deploy workflow is locked by the *managed workflows* ruleset, and the publish step strips `_worker.js`, `functions/` and `_routes.json`, so a site can only publish static files.

### 7. Check, then set up the org

On any issue in this repo, comment:

- `/bot-check`: the **Managed accounts** table should be all ✅ (setup user, scopes, SCIM, Cloudflare).
- `/org-setup`: applies the same defaults, Actions allow-list, custom properties, rulesets and custom roles to the managed org. The maintainers team stays in the classic org, because maintainers use their own accounts.

From then on, new hosted requests go to the managed org on Cloudflare Pages. Existing GitHub Pages sites stay where they are.

---

## How a sign-in works

1. Alice opens `github.com/enterprises/<slug>/sso`. GitHub sends her to our `/saml/sso` with a SAML request.
2. We check that the request is from *our* enterprise and returns to *its* address, then send her through GitHub OAuth. The SAML request rides inside the signed OAuth state, with no cookies.
3. Back from GitHub, we look up her account **id** in `identities`. If she's provisioned and active, we sign a SAML response with NameID = her SCIM `userName`, and her browser posts it to GitHub.

## Seats

Every managed user is an enterprise seat, the same as an outside collaborator was. `maxSeats` counts both orgs together, leaving out the setup user. When hosting is full, new hosted requests and collaborators wait for a maintainer.

## Turning it off

Set `"emu": { "enterprise": "", "org": "", "shortcode": "" }`. New hosted requests go back to the classic sites org. Sites already in the managed org keep running on Cloudflare Pages, but the bot stops managing them until you turn it back on.
