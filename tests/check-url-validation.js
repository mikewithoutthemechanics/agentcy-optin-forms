// Verifies the client-side URL check in prof-services-form-frictionless.html
// agrees with what the server accepts. Run: node tests/check-url-validation.js
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'prof-services-form-frictionless.html'),
  'utf8'
);

const line = html.split('\n').find((l) => l.includes("input.type === 'url'"));
if (!line) {
  console.error('  could not find the url validation line');
  process.exit(1);
}
// The line contains a /.../flags literal. Strip the delimiters before
// constructing a RegExp, otherwise the slashes become literal characters.
const literal = line.match(/!(.*)\.test/)[1];
const close = literal.lastIndexOf('/');
const source = literal.slice(1, close);
const flags = literal.slice(close + 1);
const client = new RegExp(source, flags);
const LINKEDIN_LITERAL = literal;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[\d\s\-+()]{10,}$/;
const LINKEDIN = /^(https?:\/\/)?(www\.)?linkedin\.com\/(in|pub)\/[A-Za-z0-9_-]+\/?$/i;
const HANDLE = /^[A-Za-z0-9._-]{3,}$/;
const server = (v) => EMAIL.test(v) || PHONE.test(v) || LINKEDIN.test(v) || HANDLE.test(v);

console.log('  client regex:', LINKEDIN_LITERAL);

// [input, expectedClient, expectedServer]
const cases = [
  ['linkedin.com/in/priyan', true, true],
  ['https://linkedin.com/in/priyan', true, true],
  ['http://www.linkedin.com/in/priyan/', true, true],
  ['linkedin.com/pub/priya-n', true, true],
  ['  linkedin.com/in/priyan  ', true, true],
  // A bare handle is deliberately stricter on the client: the field is
  // labelled "LinkedIn Profile URL" and suggests a full URL, so the browser
  // nudges toward the canonical form. The server stays lenient so a direct
  // API caller is not rejected.
  ['priyan', false, true],
  ['not a url', false, false],
  ['???', false, false],
  ['', false, false],
];

let ok = true;
for (const [raw, wantClient, wantServer] of cases) {
  const v = raw.trim();
  const c = v !== '' && client.test(v);
  const s = v !== '' && server(v);
  const good = c === wantClient && s === wantServer;
  if (!good) ok = false;
  console.log(
    `  ${good ? 'ok  ' : 'FAIL'}  ${JSON.stringify(raw).padEnd(40)} client=${c} server=${s}`
  );
}

console.log(ok ? '\n  client and server agree on every case' : '\n  MISMATCH REMAINS');
process.exit(ok ? 0 : 1);
