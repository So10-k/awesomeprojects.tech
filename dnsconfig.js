// DNSControl config: builds awesomeprojects.tech from domains/*.json.
// Docs: https://docs.dnscontrol.org  (ES5 only: no arrow functions, let/const)
//
// DNSControl makes Cloudflare match this file exactly. Anything it doesn't know
// about gets DELETED, except the names IGNOREd below. Those are yours to manage
// by hand in the Cloudflare dashboard (mail, reserved names, etc.).

var DOMAIN = "awesomeprojects.tech";
var reserved = require("./reserved.json");

// The website (this repo's GitHub Pages) lives at the root, and www redirects to it.
var GITHUB_PAGES_A = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];
var GITHUB_PAGES_AAAA = ["2606:50c0:8000::153", "2606:50c0:8001::153", "2606:50c0:8002::153", "2606:50c0:8003::153"];
var MANAGED_RESERVED = { www: true };

var records = [
  // Root: only the website's A/AAAA are managed here; mail, TXT etc. on the root stay hand-managed.
  IGNORE("@", "MX,TXT,CAA,SRV,NS"),
  CNAME("www", "so10-k.github.io.", CF_PROXY_OFF),
];
for (var g = 0; g < GITHUB_PAGES_A.length; g++) records.push(A("@", GITHUB_PAGES_A[g], CF_PROXY_OFF));
for (var h = 0; h < GITHUB_PAGES_AAAA.length; h++) records.push(AAAA("@", GITHUB_PAGES_AAAA[h], CF_PROXY_OFF));

// Hands off every other reserved name.
for (var i = 0; i < reserved.length; i++) {
  if (MANAGED_RESERVED[reserved[i]]) continue;
  records.push(IGNORE(reserved[i]));
  records.push(IGNORE("*." + reserved[i]));
}

var files = glob("./domains/", false, ".json");
for (var f = 0; f < files.length; f++) {
  var name = files[f].split("/").pop().replace(/\.json$/, "");
  var entry = require(files[f]);
  var r = entry.records;
  var t, k;
  // Hosted sites that are suspended or archived publish nothing (so nobody can take the name over).
  if (entry.site && entry.site.provider === "hosted" && (entry.site.status === "suspended" || entry.site.status === "archived")) continue;

  if (r.CNAME) records.push(CNAME(name, r.CNAME.replace(/\.$/, "") + ".", CF_PROXY_OFF));
  t = r.A || [];
  for (k = 0; k < t.length; k++) records.push(A(name, t[k], CF_PROXY_OFF));
  t = r.AAAA || [];
  for (k = 0; k < t.length; k++) records.push(AAAA(name, t[k], CF_PROXY_OFF));
  t = r.TXT === undefined ? [] : typeof r.TXT === "string" ? [r.TXT] : r.TXT;
  for (k = 0; k < t.length; k++) records.push(TXT(name, t[k]));
  t = r.MX || [];
  for (k = 0; k < t.length; k++) {
    var mx = typeof t[k] === "string" ? { host: t[k] } : t[k];
    records.push(MX(name, mx.priority === undefined ? 10 : mx.priority, mx.host.replace(/\.$/, "") + "."));
  }
}

D(DOMAIN, NewRegistrar("none"), DnsProvider(NewDnsProvider("cloudflare")), DefaultTTL(1), records);
