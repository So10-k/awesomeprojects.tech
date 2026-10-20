# Your own DNS: nameservers and DNSSEC

Most names only need a `CNAME` or an `A` record, and the [request form](../../issues/new?template=request.yml) handles those. If you'd rather run the whole zone yourself (on Cloudflare, deSEC, Hetzner, your own BIND), you can **delegate** your name to your own nameservers, and sign it with **DNSSEC**.

After that, every record under `yourname.awesomeprojects.tech` (`www.yourname`, `api.yourname`, mail, wildcards) lives on your nameservers, and you change them there without asking us.

## 1. Set the zone up on your nameservers first

Create the zone `yourname.awesomeprojects.tech` at your DNS host and note the nameservers it gives you. **Every one of them must already answer for the name** before you ask: the bot asks each of them for the zone's `SOA` and holds the request if any of them doesn't answer. That way there are no broken ("lame") delegations.

Check yourself:

```sh
dig +norec SOA yourname.awesomeprojects.tech @ns1.your-dns-host.example
```

You want an answer with the `aa` (authoritative) flag.

## 2. Ask for the delegation (a pull request)

[Create `domains/yourname.json`](../../new/main/domains?filename=yourname.json), or edit yours, with 2 to 6 nameservers:

```json
{
  "owner": { "github": "your-github-username" },
  "description": "My zone",
  "records": {
    "NS": ["ns1.your-dns-host.example", "ns2.your-dns-host.example"]
  }
}
```

A delegated name can't have any other records here (your nameservers answer for it), and it can't have names under it in this repo. The bot reviews the pull request like any other request.

## 3. Optional: DNSSEC

Turn DNSSEC on at your DNS host. It shows a **DS record**: a key tag, an algorithm, a digest type and a digest. Add it next to your nameservers:

```json
"records": {
  "NS": ["ns1.your-dns-host.example", "ns2.your-dns-host.example"],
  "DS": [{ "keyTag": 2371, "algorithm": 13, "digestType": 2, "digest": "50D858E0985ECC7F60418AAF0CC5AB587F42C2570A884095A9E8CCACD0F6545C" }]
}
```

| Field | Allowed |
|---|---|
| `keyTag` | 0 to 65535 |
| `algorithm` | 8, 10 (RSA), 13, 14 (ECDSA), 15, 16 (EdDSA). 13 is the usual one. |
| `digestType` | 2 (SHA-256, 64 hex characters) or 4 (SHA-384, 96) |
| `DS` | 1 to 4 records: keep the old one in while you roll keys |

Check the chain of trust once it's live:

```sh
dig +dnssec yourname.awesomeprojects.tech SOA
```

or paste the name into [DNSViz](https://dnsviz.net/). (The chain only validates end to end once `awesomeprojects.tech` itself is signed. Until then your DS is published, and validating resolvers treat the name as unsigned, so nothing breaks.)

**Turning DNSSEC off:** remove `DS` here first, wait a day for caches, and only then turn signing off at your host. Doing it the other way round makes your name fail for everyone who validates.

## Renewing

Delegated names renew like every other name: once a year, one click in [My domains](https://awesomeprojects.tech/me/), and any approved change renews it too. A name that isn't renewed goes on hold, and while it's on hold the delegation (and the DS) is taken out of our zone. See the [policy](POLICY.md#how-long-a-name-lasts).
