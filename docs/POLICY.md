# Registry policy

awesomeprojects.tech gives free names under `awesomeprojects.tech` to people who build things. It's run by volunteers in public: every name is a pull request, every review and every decision is on GitHub, and the zone is rebuilt from this repository.

## Who can have a name

- Anyone with a GitHub account that's at least 30 days old. Newer accounts are held for a maintainer to look at.
- Up to 3 names each. Names under your own name (`blog.alice`) don't count toward that.
- A name must be used for something real: a project, a portfolio, docs, an API, a demo. Parking names to resell or hoard them isn't allowed.
- Names that impersonate a person, a company or a product, or that are made to confuse (`paypal-login`), are refused or taken down.

## What a name can do

- Point somewhere: `CNAME`, `A`, `AAAA`, `MX` and `TXT` records.
- **Be delegated** to your own nameservers (`NS`, 2 to 6), optionally signed with **DNSSEC** (`DS`). The bot checks that every nameserver already answers for the name before it goes live, so there are no broken (lame) delegations. A delegated name can't have other records here, because your nameservers answer for it.
- Be hosted by us, on a private repo on our GitHub server.

## How long a name lasts

| | |
|---|---|
| **Term** | One year, free. |
| **Renewing** | One click in [My domains](https://awesomeprojects.tech/me/). **Any approved change to the name, or a push to a site we host, renews it too**, so a name in use never runs out. |
| **Reminders** | 30 days and 7 days before the end. By email if you turned email on in My domains, otherwise one GitHub issue that mentions you. |
| **Hold** | If a term ends without a renewal, the name goes on hold for 30 days. Its DNS is off, and nothing is deleted. Renewing during the hold brings it straight back. |
| **Release** | After the hold, the name is removed and anyone can request it, including you. |

Maintainers can renew a name for its owner, and can change the term (`termDays`, `holdDays`) for everyone.

## Abuse

We take down phishing, malware, scams, impersonation, and anything illegal where we or the owner are. Phishing and malware come first, and a maintainer acts on them as soon as they see them.

- **Report a name:** [open a takedown report](https://github.com/So10-k/awesomeprojects.tech/issues/new?template=takedown.yml). You don't need to explain who you are.
- **Monitoring:** we watch Certificate Transparency logs for every certificate issued under `awesomeprojects.tech`. A phishing-style hostname, or a certificate for a name that isn't in the zone, goes to the maintainers right away.
- **Speed:** reports are due within 12 hours, and someone is assigned to each one automatically. Urgent ones are usually handled much faster.
- **What happens:** a takedown removes the name and everything under it at once, in a public commit. Repeat or serious abuse also bans the GitHub account from requesting names.

## Privacy

- Public: your GitHub username, your records, the description you give, and when the name was registered and renews.
- Never public: email addresses. RDAP and WHOIS show owners by GitHub account only. If you turn on email, we keep only your primary verified address, used for your names and nothing else.
- We don't run ads or trackers, and we don't sell or share anything.

## Looking a name up

- **RDAP**, the modern WHOIS: `https://rdap.awesomeprojects.tech/domain/<name>.awesomeprojects.tech`
- **WHOIS**: `whois -h whois.awesomeprojects.tech <name>`
- On the site: `https://awesomeprojects.tech/n/<name>/`
- From the bot: comment `/whois <name>` on any issue.

## Changes to this policy

This page is in the repository like everything else. A change is a pull request, reviewed in public.
