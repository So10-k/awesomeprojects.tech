// A small SAML 2.0 identity provider for the managed-user enterprise (GitHub is the service provider).
//
// We build the Response ourselves, already in Exclusive XML Canonicalization (exc-c14n) form:
// attributes sorted, namespaces declared exactly where exc-c14n puts them, no self-closing tags,
// no whitespace between elements. So the bytes we digest and sign are exactly the bytes we send,
// and any standard verifier (GitHub, xmlsec1) computes the same digest. test/saml.test.mjs checks
// this with xmlsec1 when it's installed.

const NS = {
  samlp: 'urn:oasis:names:tc:SAML:2.0:protocol',
  saml: 'urn:oasis:names:tc:SAML:2.0:assertion',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
};
const enc = new TextEncoder();

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/** An element in canonical form. ns: [[prefix, uri]] declared here; attrs sorted (all unqualified). */
function el(name, { ns = [], attrs = {}, text } = {}, ...children) {
  const nsPart = [...ns].sort((a, b) => a[0].localeCompare(b[0])).map(([p, u]) => ` xmlns:${p}="${escAttr(u)}"`).join('');
  const attrPart = Object.keys(attrs).filter((k) => attrs[k] !== undefined && attrs[k] !== null).sort()
    .map((k) => ` ${k}="${escAttr(attrs[k])}"`).join('');
  const body = text !== undefined ? escText(text) : children.flat().filter(Boolean).join('');
  return `<${name}${nsPart}${attrPart}>${body}</${name}>`;
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(String(s).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const pemBody = (pem) => String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const randomId = () => `_${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

async function sha256b64(text) {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
async function rsaSign(privatePem, text) {
  const key = await crypto.subtle.importKey('pkcs8', fromB64(pemBody(privatePem)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(text)));
}

/** The SignedInfo for a reference to #id. Canonical standalone form adds xmlns:ds (exc-c14n). */
function signedInfo(refId, digest, { standalone }) {
  const ALG = {
    c14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    rsa: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    env: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
    sha: 'http://www.w3.org/2001/04/xmlenc#sha256',
  };
  return el('ds:SignedInfo', { ns: standalone ? [['ds', NS.ds]] : [] },
    el('ds:CanonicalizationMethod', { attrs: { Algorithm: ALG.c14n } }),
    el('ds:SignatureMethod', { attrs: { Algorithm: ALG.rsa } }),
    el('ds:Reference', { attrs: { URI: `#${refId}` } },
      el('ds:Transforms', {},
        el('ds:Transform', { attrs: { Algorithm: ALG.env } }),
        el('ds:Transform', { attrs: { Algorithm: ALG.c14n } })),
      el('ds:DigestMethod', { attrs: { Algorithm: ALG.sha } }),
      el('ds:DigestValue', { text: digest })));
}

/**
 * A signed SAML Response for GitHub.
 *   nameId        the SCIM userName of the managed user (GitHub matches NameID ↔ userName)
 *   acs           https://github.com/enterprises/<slug>/saml/consume
 *   audience      https://github.com/enterprises/<slug>
 *   issuer        our entity id
 *   inResponseTo  the AuthnRequest ID (omit for IdP-initiated)
 *   attributes    { name: [values] }
 */
export async function buildResponse({ nameId, acs, audience, issuer, inResponseTo, attributes = {}, privateKey, cert, now = Date.now(), sessionHours = 12 }) {
  const rid = randomId();
  const aid = randomId();
  const t = iso(now);
  const notBefore = iso(now - 60e3);
  const notAfter = iso(now + 5 * 60e3);
  const sessionEnd = iso(now + sessionHours * 3600e3);
  const attrs = Object.entries(attributes).filter(([, v]) => v !== undefined && v !== null && [].concat(v).length);
  const assertion = el('saml:Assertion', { ns: [['saml', NS.saml]], attrs: { ID: aid, IssueInstant: t, Version: '2.0' } },
    el('saml:Issuer', { text: issuer }),
    el('saml:Subject', {},
      el('saml:NameID', { attrs: { Format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' }, text: nameId }),
      el('saml:SubjectConfirmation', { attrs: { Method: 'urn:oasis:names:tc:SAML:2.0:cm:bearer' } },
        el('saml:SubjectConfirmationData', { attrs: { InResponseTo: inResponseTo, NotOnOrAfter: notAfter, Recipient: acs } }))),
    el('saml:Conditions', { attrs: { NotBefore: notBefore, NotOnOrAfter: notAfter } },
      el('saml:AudienceRestriction', {}, el('saml:Audience', { text: audience }))),
    el('saml:AuthnStatement', { attrs: { AuthnInstant: t, SessionIndex: aid, SessionNotOnOrAfter: sessionEnd } },
      el('saml:AuthnContext', {}, el('saml:AuthnContextClassRef', { text: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport' }))),
    attrs.length ? el('saml:AttributeStatement', {},
      ...attrs.map(([n, vals]) => el('saml:Attribute', { attrs: { Name: n, NameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic' } },
        ...[].concat(vals).map((v) => el('saml:AttributeValue', { text: v }))))) : '');
  const issuerEl = el('saml:Issuer', { ns: [['saml', NS.saml]], text: issuer });
  const status = el('samlp:Status', {}, el('samlp:StatusCode', { attrs: { Value: 'urn:oasis:names:tc:SAML:2.0:status:Success' } }));
  const respAttrs = { Destination: acs, ID: rid, InResponseTo: inResponseTo, IssueInstant: t, Version: '2.0' };
  const open = el('samlp:Response', { ns: [['samlp', NS.samlp]], attrs: respAttrs }).replace(/<\/samlp:Response>$/, '');
  // Digest the Response without its Signature (the enveloped-signature transform removes it).
  const unsigned = `${open}${issuerEl}${status}${assertion}</samlp:Response>`;
  const digest = await sha256b64(unsigned);
  const sigValue = await rsaSign(privateKey, signedInfo(rid, digest, { standalone: true }));
  const signature = el('ds:Signature', { ns: [['ds', NS.ds]] },
    signedInfo(rid, digest, { standalone: false }),
    el('ds:SignatureValue', { text: sigValue }),
    el('ds:KeyInfo', {}, el('ds:X509Data', {}, el('ds:X509Certificate', { text: pemBody(cert) }))));
  return { xml: `${open}${issuerEl}${signature}${status}${assertion}</samlp:Response>`, id: rid };
}

/** Decode a SAMLRequest (HTTP-Redirect = deflated; HTTP-POST = plain) and read what we need. */
export async function parseAuthnRequest(samlRequest, { deflated }) {
  let bytes = fromB64(samlRequest);
  if (deflated) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
    bytes = new Uint8Array(await out.arrayBuffer());
  }
  const xml = new TextDecoder().decode(bytes);
  if (!/<(\w+:)?AuthnRequest[\s>]/.test(xml)) throw new Error('not an AuthnRequest');
  const attr = (n) => (xml.match(new RegExp(`<(?:\\w+:)?AuthnRequest[^>]*\\s${n}="([^"]*)"`)) || [])[1];
  const issuer = (xml.match(/<(?:\w+:)?Issuer[^>]*>([^<]*)<\/(?:\w+:)?Issuer>/) || [])[1];
  return { id: attr('ID'), acs: attr('AssertionConsumerServiceURL'), destination: attr('Destination'), issuer: issuer && issuer.trim() };
}

/** IdP metadata (handy for checking the enterprise's SAML settings). */
export function metadata({ issuer, ssoUrl, cert }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${el('md:EntityDescriptor', { ns: [['md', 'urn:oasis:names:tc:SAML:2.0:metadata']], attrs: { entityID: issuer } },
    el('md:IDPSSODescriptor', { attrs: { WantAuthnRequestsSigned: 'false', protocolSupportEnumeration: 'urn:oasis:names:tc:SAML:2.0:protocol' } },
      el('md:KeyDescriptor', { attrs: { use: 'signing' } },
        el('ds:KeyInfo', { ns: [['ds', NS.ds]] }, el('ds:X509Data', {}, el('ds:X509Certificate', { text: pemBody(cert) })))),
      el('md:NameIDFormat', { text: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' }),
      el('md:SingleSignOnService', { attrs: { Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: ssoUrl } }),
      el('md:SingleSignOnService', { attrs: { Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: ssoUrl } })))}`;
}

/** The page that POSTs the Response to GitHub (HTTP-POST binding). */
export function postForm({ acs, samlResponse, relayState }) {
  const e = (s) => escAttr(s || '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing you in…</title><meta name="robots" content="noindex"></head>
<body style="font-family:system-ui;background:#0b1020;color:#e6ebff;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" action="${e(acs)}"><input type="hidden" name="SAMLResponse" value="${e(samlResponse)}">${relayState ? `<input type="hidden" name="RelayState" value="${e(relayState)}">` : ''}
<noscript><button type="submit">Continue to GitHub</button></noscript></form>
<p>Signing you in to GitHub…</p><script>document.forms[0].submit()</script></body></html>`;
}

export const _test = { el, escAttr, escText, iso };
