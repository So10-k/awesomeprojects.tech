import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildResponse, parseAuthnRequest } from '../worker/src/saml.js';
import worker, { sign, verify } from '../worker/src/index.js';

// A throwaway key + self-signed certificate (openssl is on macOS and CI runners).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=test'], { stdio: 'ignore' });
const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'k.pem'))).export({ type: 'pkcs8', format: 'pem' });
const cert = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
const ENT = 'ap-test';
const ACS = `https://github.com/enterprises/${ENT}/saml/consume`;
const base = { nameId: 'alice', acs: ACS, audience: `https://github.com/enterprises/${ENT}`, issuer: 'https://api.awesomeprojects.tech/saml', inResponseTo: '_req1', privateKey, cert };

test('the digest covers the exact canonical bytes and the RSA signature verifies', async () => {
  const { xml, id } = await buildResponse({ ...base, attributes: { full_name: ['Alice & <Co>'] } });
  const sigStart = xml.indexOf('<ds:Signature');
  const sigEnd = xml.indexOf('</ds:Signature>') + '</ds:Signature>'.length;
  const unsigned = xml.slice(0, sigStart) + xml.slice(sigEnd);
  const digest = (xml.match(/<ds:DigestValue>([^<]+)</) || [])[1];
  assert.equal(crypto.createHash('sha256').update(unsigned).digest('base64'), digest);
  const signedInfo = xml.match(/<ds:SignedInfo>.*?<\/ds:SignedInfo>/)[0].replace('<ds:SignedInfo>', '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">');
  const sigValue = xml.match(/<ds:SignatureValue>([^<]+)</)[1];
  assert.ok(crypto.verify('sha256', Buffer.from(signedInfo), crypto.createPublicKey(cert), Buffer.from(sigValue, 'base64')));
  assert.match(xml, new RegExp(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" Destination="${ACS}" ID="${id}"`));
  assert.match(xml, /<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">alice<\/saml:NameID>/);
  assert.match(xml, /Recipient="https:\/\/github.com\/enterprises\/ap-test\/saml\/consume"/);
  assert.match(xml, /<saml:Audience>https:\/\/github.com\/enterprises\/ap-test<\/saml:Audience>/);
  assert.match(xml, /Alice &amp; &lt;Co&gt;/, 'escaped');
  assert.ok(!/\/>/.test(xml), 'no self-closing tags (canonical form)');
});

let xmlsec = false;
try { execFileSync('xmlsec1', ['--version'], { stdio: 'ignore' }); xmlsec = true; } catch { /* not installed */ }
test('xmlsec1 verifies it, and rejects a tampered copy', { skip: !xmlsec && 'xmlsec1 not installed' }, async () => {
  const { xml } = await buildResponse(base);
  const ok = path.join(dir, 'r.xml');
  const bad = path.join(dir, 'b.xml');
  fs.writeFileSync(ok, xml);
  fs.writeFileSync(bad, xml.replace('>alice<', '>mallory<'));
  const args = (f) => ['--verify', '--trusted-pem', path.join(dir, 'c.pem'), '--id-attr:ID', 'urn:oasis:names:tc:SAML:2.0:protocol:Response', f];
  execFileSync('xmlsec1', args(ok), { stdio: 'ignore' });
  assert.throws(() => execFileSync('xmlsec1', args(bad), { stdio: 'ignore' }));
});

test('AuthnRequests: redirect (deflated) and POST', async () => {
  const req = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r9" Version="2.0" AssertionConsumerServiceURL="${ACS}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://github.com/enterprises/${ENT}</saml:Issuer></samlp:AuthnRequest>`;
  assert.deepEqual(await parseAuthnRequest(zlib.deflateRawSync(req).toString('base64'), { deflated: true }), { id: '_r9', acs: ACS, destination: undefined, issuer: `https://github.com/enterprises/${ENT}` });
  assert.equal((await parseAuthnRequest(Buffer.from(req).toString('base64'), { deflated: false })).id, '_r9');
  await assert.rejects(parseAuthnRequest(Buffer.from('<x/>').toString('base64'), { deflated: false }));
});

// ── The Worker flow ─────────────────────────────────────────────
function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_requests.sql', '0002_identities.sql']) db.exec(fs.readFileSync(new URL(`../worker/migrations/${f}`, import.meta.url), 'utf8'));
  return { prepare(sql) { const st = db.prepare(sql); let a = []; const api = { bind(...x) { a = x.map((v) => (v === undefined ? null : v)); return api; }, async run() { st.run(...a); return {}; }, async all() { return { results: st.all(...a) }; }, async first() { return st.get(...a) ?? null; } }; return api; } };
}
const kv = () => { const m = new Map(); return { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async list() { return { keys: [] }; } }; };
let ghUser = { login: 'Alice', id: 42, name: 'Alice A' };
globalThis.fetch = async (url) => {
  const u = String(url);
  const res = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
  if (u === 'https://github.com/login/oauth/access_token') return res({ access_token: 't' });
  if (u === 'https://api.github.com/user') return res(ghUser);
  if (u.includes('/contents/config.json')) return res({ content: Buffer.from('{"maintainers":[]}').toString('base64') });
  return new Response('{}', { status: 404 });
};
const env = () => ({ REPO: 'boss/x', SITE_ORIGIN: 'https://awesomeprojects.tech', SESSION_SECRET: 's', BOT_SECRET: 'b', GITHUB_CLIENT_ID: 'c', GITHUB_CLIENT_SECRET: 'cs', EMU_ENTERPRISE: ENT, EMU_SHORTCODE: 'apjs', SAML_ISSUER: 'https://api.awesomeprojects.tech/saml', SAML_PRIVATE_KEY: privateKey, SAML_CERT: cert, PANEL: kv(), DB: d1() });
const go = (e, p, init = {}) => worker.fetch(new Request(`https://api.awesomeprojects.tech${p}`, init), e);

async function ssoRoundTrip(e, requestXml) {
  const q = requestXml ? `?SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(requestXml).toString('base64'))}&RelayState=rs1` : '';
  const start = await go(e, `/saml/sso${q}`);
  if (start.status !== 302) return start;
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  return go(e, `/auth/callback?code=x&state=${encodeURIComponent(state)}`);
}
const gitHubRequest = (issuer = `https://github.com/enterprises/${ENT}`, acs = ACS) => `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_gh1" Version="2.0" AssertionConsumerServiceURL="${acs}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer></samlp:AuthnRequest>`;
const report = (e, body, token = 'b') => go(e, '/bot/identity', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('sign-in: only provisioned, active people get a signed response for our enterprise', async () => {
  const e = env();
  const none = await ssoRoundTrip(e, gitHubRequest());
  assert.equal(none.status, 403);
  assert.match(await none.text(), /have an enterprise account yet/);
  assert.equal((await report(e, {}, 'wrong')).status, 401, 'only the bot reports identities');
  await report(e, { personal_id: 42, personal_login: 'Alice', user_name: 'alice', managed_login: 'alice_ap', scim_id: 'sc1', status: 'active' });
  const ok = await ssoRoundTrip(e, gitHubRequest());
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, new RegExp(`action="${ACS}"`));
  assert.match(html, /name="RelayState" value="rs1"/);
  const xml = Buffer.from(html.match(/name="SAMLResponse" value="([^"]+)"/)[1], 'base64').toString('utf8');
  assert.match(xml, /InResponseTo="_gh1"/);
  assert.match(xml, />alice<\/saml:NameID>/, 'NameID = SCIM userName');
  await report(e, { personal_id: 42, personal_login: 'Alice', user_name: 'alice', status: 'suspended' });
  assert.equal((await ssoRoundTrip(e, gitHubRequest())).status, 403, 'suspended');
  await report(e, { personal_id: 42, personal_login: 'Alice', user_name: 'alice', status: 'active' });
  ghUser = { login: 'mallory', id: 666 };
  assert.equal((await ssoRoundTrip(e, gitHubRequest())).status, 403, 'someone else can\'t get Alice\'s account');
  ghUser = { login: 'Alice', id: 42, name: 'Alice A' };
});

test('sign-in: the repo owner can run GitHub\'s SAML test before anyone is provisioned', async () => {
  const e = env();
  ghUser = { login: 'Boss', id: 7 };
  const r = await ssoRoundTrip(e, gitHubRequest());
  assert.equal(r.status, 200);
  const xml = Buffer.from((await r.text()).match(/name="SAMLResponse" value="([^"]+)"/)[1], 'base64').toString('utf8');
  assert.match(xml, />boss<\/saml:NameID>/);
  ghUser = { login: 'apjs_admin', id: 8 };
  assert.equal((await ssoRoundTrip(e, gitHubRequest())).status, 200, 'the setup user, in the setup user\'s browser');
  ghUser = { login: 'other_admin', id: 9 };
  assert.equal((await ssoRoundTrip(e, gitHubRequest())).status, 403, 'another enterprise\'s setup user');
  ghUser = { login: 'Alice', id: 42, name: 'Alice A' };
});

test('sign-in: other services and return addresses are refused', async () => {
  const e = env();
  assert.equal((await ssoRoundTrip(e, gitHubRequest('https://github.com/enterprises/someone-else'))).status, 400);
  assert.equal((await ssoRoundTrip(e, gitHubRequest(undefined, 'https://evil.example.com/consume'))).status, 400);
  const off = env();
  delete off.EMU_ENTERPRISE;
  assert.equal((await go(off, '/saml/sso')).status, 503);
  assert.equal((await go(e, '/saml/metadata')).status, 200);
});

test('the SAML request rides inside the signed OAuth state (no cookies)', async () => {
  const e = env();
  const start = await go(e, `/saml/sso?SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(gitHubRequest()).toString('base64'))}`);
  const st = await verify(new URL(start.headers.get('Location')).searchParams.get('state'), 's');
  assert.equal(st.saml.id, '_gh1');
  const forged = await sign({ r: '/me/', exp: Date.now() + 1e5, saml: { id: '_x' } }, 'not-the-secret');
  assert.equal((await go(e, `/auth/callback?code=x&state=${encodeURIComponent(forged)}`)).status, 400);
});
