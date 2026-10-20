# Public Suffix List

Being on the [Public Suffix List](https://publicsuffix.org) makes browsers treat every `*.awesomeprojects.tech` name as its own site: one name can't set cookies for another, and each one is isolated like a separate domain. That matters here, because every name belongs to a different person.

This page is the maintainers' checklist and the draft of the pull request. Only the owner files it.

## Ready?

| | Requirement | Where we are |
|---|---|---|
| ✅ | A public policy: who can have a name, how long, abuse, privacy | [POLICY.md](POLICY.md) |
| ✅ | An abuse contact that answers | [Takedown reports](../../issues/new?template=takedown.yml), private advisories, `/.well-known/security.txt`, due in 12 h |
| ✅ | Names that lapse are cleaned up | Yearly terms, then a 30-day hold, then release |
| ✅ | Public registration data | RDAP at `rdap.awesomeprojects.tech`, `/whois`, the per-name pages |
| ✅ | Abuse monitoring | Certificate Transparency watch, every 6 hours |
| ⬜ | **The domain is registered for at least 2 more years** | It expires **2027-08-25**: extend it at the registrar to 2029 or later before filing |
| ⬜ | **DNSSEC on the domain itself** (not required, strongly expected) | Turn it on in Cloudflare (DNS → Settings → DNSSEC), then add the DS it shows at the registrar |
| ✅ | The `_psl` TXT record | Points at [publicsuffix/list#3439](https://github.com/publicsuffix/list/pull/3439). Keep it for as long as we're on the list |

Check the record once it's live:

```sh
dig +short TXT _psl.awesomeprojects.tech
```

## Filing it

1. Fork [publicsuffix/list](https://github.com/publicsuffix/list) and add this to the end of the **PRIVATE DOMAINS** section, sorted by the comment line's domain:

   ```
   // awesomeprojects.tech : https://awesomeprojects.tech
   // Submitted by <your name> <<a mailbox that will be read for years>>
   awesomeprojects.tech
   ```

   Only `awesomeprojects.tech` itself: its direct children are the separate parties. Names under names (`blog.alice`) belong to the same owner, so they don't need their own line.

2. Run `make test` in the fork, and paste its output into the PR.
3. Open the pull request with the text below, then put its URL in `dnsconfig.js` (`PSL_PULL_REQUEST`) and merge, so their check finds `_psl`.
4. Don't let the record or the domain lapse while it's open, or afterwards. The PSL removes entries whose `_psl` record disappears.

## The pull request text

> **Description of Organization**
>
> awesomeprojects.tech is a free, volunteer-run subdomain registry for people who build things, in the spirit of is-a.dev and eu.org. Anyone with a GitHub account can register `name.awesomeprojects.tech` for a project, portfolio or API. Everything is public: each name is a JSON file in [So10-k/awesomeprojects.tech](https://github.com/So10-k/awesomeprojects.tech), each request is a pull request or issue reviewed in public, and the zone is rebuilt from the repository with DNSControl. The registry also offers delegation to the registrant's own nameservers (with DNSSEC) and hosts static sites for some registrants.
>
> I maintain it, with a small group of maintainers ([roster](https://awesomeprojects.tech/maintainers/)).
>
> **Reason for PSL Inclusion**
>
> Each direct child of `awesomeprojects.tech` is owned and controlled by a different, unrelated person. Without a PSL entry, a page on `alice.awesomeprojects.tech` can set cookies for `.awesomeprojects.tech` that are sent to `bob.awesomeprojects.tech`, and browsers group all of them as one site for storage, permissions and site isolation. We want the same boundary between registrants that separate registrable domains have.
>
> This request isn't made to work around rate limits or any other third-party limits (Let's Encrypt or otherwise).
>
> Registry details: [policy](https://awesomeprojects.tech/docs/policy/) (eligibility, yearly terms, holds and release, abuse, privacy), abuse reports through [the takedown form](https://github.com/So10-k/awesomeprojects.tech/issues/new?template=takedown.yml) and `security.txt`, RDAP at `https://rdap.awesomeprojects.tech/`. Number of registrations at the time of writing: see [stats](https://awesomeprojects.tech/stats/).
>
> **DNS Verification**
>
> ```
> dig +short TXT _psl.awesomeprojects.tech
> "https://github.com/publicsuffix/list/pull/<number>"
> ```
>
> **Results of Syntax Checker** (`make test`)
>
> ```
> <paste the output>
> ```
>
> - [ ] The domain's registration runs for at least two more years. *(Tick this only once it does.)*
> - [ ] We understand the entry is removed if `_psl` disappears, and we keep the section maintained.
