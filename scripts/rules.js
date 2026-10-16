// Rules for subdomain requests. Pure functions, no I/O, so they're easy to test.
'use strict';

const net = require('node:net');

const DOMAIN = 'awesomeprojects.tech';
const MAX_PER_OWNER = 3; // top-level names per GitHub account (maintainers exempt)
const MAX_DEPTH = 4; // labels in a name, e.g. selector._domainkey.alice = 3
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX'];
const TOP_KEYS = ['$schema', 'owner', 'description', 'repo', 'records'];
const OWNER_KEYS = ['github', 'email', 'discord'];

const BASE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUB_LABEL = /^_?[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GITHUB_USER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

const lc = (s) => String(s).toLowerCase();

/** "alice.json" → "alice"; "_vercel.alice.json" → "_vercel.alice"; anything else → null */
function nameFromFile(file) {
  const base = file.split('/').pop();
  return base.endsWith('.json') ? base.slice(0, -5) : null;
}

/** The top-level label a name lives under: "_vercel.alice" → "alice". */
function baseOf(name) {
  return name.split('.').pop();
}

function checkName(name, reserved) {
  const errors = [];
  if (name !== lc(name)) errors.push('file name must be lowercase');
  const labels = name.split('.');
  const base = labels[labels.length - 1];
  if (labels.length > MAX_DEPTH) errors.push(`at most ${MAX_DEPTH} labels`);
  if (!BASE_LABEL.test(base)) {
    errors.push(`"${base}" must be 1-63 characters of a-z, 0-9 and "-", not starting or ending with "-"`);
  }
  if (base.startsWith('xn--')) errors.push('punycode (xn--) names are not allowed');
  if (reserved.includes(base)) errors.push(`"${base}" is reserved`);
  for (const l of labels.slice(0, -1)) {
    if (!SUB_LABEL.test(l)) errors.push(`label "${l}" is not valid`);
  }
  return errors;
}

function ipv4Parts(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

function isPublicIPv4(ip) {
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

/** Expand an IPv6 address to 8 16-bit numbers, or null. */
function ipv6Groups(ip) {
  if (!net.isIPv6(ip) || ip.includes('%')) return null;
  let s = ip;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = ipv4Parts(v4[1]);
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = s.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

function isPublicIPv6(ip) {
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return false; // IPv4-mapped
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

/** A hostname another record can point at (CNAME/MX target). */
function checkTarget(host, name) {
  if (typeof host !== 'string' || !host) return ['target must be a hostname'];
  const h = host.replace(/\.$/, '');
  if (h !== lc(h)) return [`"${host}" must be lowercase`];
  if (net.isIP(h)) return [`"${host}" is an IP address; use an A/AAAA record instead`];
  const labels = h.split('.');
  if (h.length > 253 || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) {
    return [`"${host}" is not a valid hostname`];
  }
  if (h === DOMAIN || h.endsWith('.' + DOMAIN)) {
    return [`"${host}" points back into ${DOMAIN}; point at your real host instead`];
  }
  if (name && h === `${name}.${DOMAIN}`) return ['a record cannot point at itself'];
  return [];
}

function checkRecords(records, name) {
  const errors = [];
  if (!records || typeof records !== 'object' || Array.isArray(records)) return ['"records" must be an object'];
  const types = Object.keys(records);
  if (!types.length) errors.push('"records" is empty');
  for (const t of types) if (!RECORD_TYPES.includes(t)) errors.push(`record type "${t}" is not allowed (allowed: ${RECORD_TYPES.join(', ')})`);
  if (records.CNAME !== undefined && types.length > 1) errors.push('a CNAME cannot be combined with other records');

  const ips = (t, ok, label) => {
    const v = records[t];
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.length || v.length > 8) return errors.push(`${t} must be a list of 1-8 addresses`);
    if (new Set(v).size !== v.length) errors.push(`${t} has duplicates`);
    for (const ip of v) if (typeof ip !== 'string' || !ok(ip)) errors.push(`${t} "${ip}" is not a public ${label} address`);
  };
  ips('A', isPublicIPv4, 'IPv4');
  ips('AAAA', isPublicIPv6, 'IPv6');

  if (records.CNAME !== undefined) errors.push(...checkTarget(records.CNAME, name).map((e) => `CNAME ${e}`));

  if (records.TXT !== undefined) {
    const list = Array.isArray(records.TXT) ? records.TXT : [records.TXT];
    if (!list.length || list.length > 10) errors.push('TXT must be a string or a list of 1-10 strings');
    for (const s of list) {
      if (typeof s !== 'string' || !s.length || s.length > 255 || !/^[\x20-\x7e]+$/.test(s)) {
        errors.push('each TXT value must be 1-255 printable ASCII characters');
      }
    }
  }

  if (records.MX !== undefined) {
    if (!Array.isArray(records.MX) || !records.MX.length || records.MX.length > 5) {
      errors.push('MX must be a list of 1-5 entries');
    } else {
      for (const mx of records.MX) {
        const host = typeof mx === 'string' ? mx : mx && mx.host;
        const prio = typeof mx === 'string' ? 10 : mx && mx.priority === undefined ? 10 : mx && mx.priority;
        if (!Number.isInteger(prio) || prio < 0 || prio > 65535) errors.push('MX priority must be 0-65535');
        errors.push(...checkTarget(host, name).map((e) => `MX ${e}`));
      }
    }
  }
  return errors;
}

/** Check one entry's contents (not its relationship to other files). */
function checkEntry(name, data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['file must contain a JSON object'];
  for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) errors.push(`unknown field "${k}"`);
  const o = data.owner;
  if (!o || typeof o !== 'object') {
    errors.push('"owner" is required');
  } else {
    for (const k of Object.keys(o)) if (!OWNER_KEYS.includes(k)) errors.push(`unknown owner field "${k}"`);
    if (typeof o.github !== 'string' || !GITHUB_USER.test(o.github)) errors.push('"owner.github" must be your GitHub username');
    if (o.email !== undefined && (typeof o.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email))) {
      errors.push('"owner.email" is not a valid email');
    }
  }
  if (data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 200)) {
    errors.push('"description" must be text, at most 200 characters');
  }
  if (data.repo !== undefined && (typeof data.repo !== 'string' || !/^https:\/\//.test(data.repo))) {
    errors.push('"repo" must be an https:// URL');
  }
  errors.push(...checkRecords(data.records, name));
  return errors;
}

const ownerOf = (data) => (data && data.owner && typeof data.owner.github === 'string' ? lc(data.owner.github) : null);

/**
 * Check the whole domains/ folder.
 * entries: { [name]: data }. Returns { [name]: string[] } with only the names that have errors.
 * Names under someone else's subdomain are fine here: consent is checked when they're requested.
 */
function checkTree(entries, { reserved = [], maintainers = [], maxPerOwner = MAX_PER_OWNER } = {}) {
  const out = {};
  const add = (n, errs) => { if (errs.length) out[n] = (out[n] || []).concat(errs); };
  const admins = maintainers.map(lc);
  const perOwner = {};

  for (const [name, data] of Object.entries(entries)) {
    add(name, checkName(name, reserved));
    add(name, checkEntry(name, data));
    const base = baseOf(name);
    if (base !== name) {
      if (!entries[base]) add(name, [`"${name}" needs "${base}.json" to exist`]);
    } else if (ownerOf(data)) {
      (perOwner[ownerOf(data)] ||= []).push(name);
    }
  }
  for (const [owner, names] of Object.entries(perOwner)) {
    if (names.length > maxPerOwner && !admins.includes(owner)) {
      for (const n of names) add(n, [`@${owner} would own ${names.length} subdomains; the limit is ${maxPerOwner}`]);
    }
  }
  return out;
}

/** Every top-level name an owner has, sorted. */
function namesOwnedBy(entries, owner) {
  const who = lc(owner);
  return Object.keys(entries).filter((n) => baseOf(n) === n && ownerOf(entries[n]) === who).sort();
}

/** A name and everything under it: "alice" → ["alice", "_vercel.alice", "blog.alice"]. */
function family(entries, name) {
  return Object.keys(entries).filter((n) => n === name || n.endsWith('.' + name)).sort();
}

module.exports = {
  DOMAIN, MAX_PER_OWNER, RECORD_TYPES,
  nameFromFile, baseOf, ownerOf, namesOwnedBy, family,
  checkName, checkEntry, checkRecords, checkTarget, checkTree,
  isPublicIPv4, isPublicIPv6,
};
