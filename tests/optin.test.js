/**
 * Tests for api/optin.js. No framework and no network: the handler is
 * invoked directly with a fake req/res and a stubbed global fetch.
 *
 *   node --test tests/
 *
 * These cover the paths that actually broke in production - contact
 * classification, POPIA consent, honeypot, dedupe, and rate-limit ordering.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('./harness.js');
const handler = h.loadHandler();
const { base, calls, invoke, jsonResponse, schemaResponse } = h;

test.beforeEach(() => {
  h.resetCalls();
  global.fetch = h.defaultFetch;
});

test('rejects a submission with no name', async () => {
  const res = await invoke(handler, { ...base, name: '', contact: 'a@b.co' });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.airtableWrites.length, 0);
});

test('rejects a submission without POPIA consent', async () => {
  const res = await invoke(handler, { ...base, contact: 'a@b.co', popia_consent: 'No' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Consent/);
  assert.equal(calls.airtableWrites.length, 0, 'must not reach Airtable without consent');
});

test('honeypot is silently accepted and writes nothing', async () => {
  const res = await invoke(handler, { ...base, contact: 'bot@spam.co', 'bot-field': 'gotcha' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.airtableWrites.length, 0);
});

test('classifies an email into Email, not Phone', async () => {
  const res = await invoke(handler, { ...base, contact: 'thabo@example.co.za' });
  assert.equal(res.statusCode, 200);
  const f = calls.airtableWrites[0].fields;
  assert.equal(f.Email, 'thabo@example.co.za');
  assert.equal(f.Phone, undefined);
  assert.equal(f.LinkedIn, undefined);
});

test('classifies a phone number into Phone, not Email', async () => {
  const res = await invoke(handler, { ...base, contact: '+27837915429' });
  assert.equal(res.statusCode, 200);
  const f = calls.airtableWrites[0].fields;
  assert.equal(f.Phone, '+27837915429');
  assert.equal(f.Email, undefined);
});

// The bug that shipped: the prof-services form offers LinkedIn, the old
// validator rejected it, and anything that got through landed in Phone.
test('accepts a LinkedIn URL and routes it to LinkedIn', async () => {
  const res = await invoke(handler, { ...base, segment: 'Professional Services', preferred_channel: 'LinkedIn', contact: 'linkedin.com/in/priyan' });
  assert.equal(res.statusCode, 200);
  const f = calls.airtableWrites[0].fields;
  assert.equal(f.LinkedIn, 'linkedin.com/in/priyan');
  assert.equal(f.Phone, undefined, 'a LinkedIn URL must never land in Phone');
});

test('accepts a full https LinkedIn URL', async () => {
  const res = await invoke(handler, { ...base, segment: 'Professional Services', preferred_channel: 'LinkedIn', contact: 'https://www.linkedin.com/in/priyan/' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.airtableWrites[0].fields.LinkedIn, 'https://www.linkedin.com/in/priyan/');
});

test('rejects genuine nonsense', async () => {
  const res = await invoke(handler, { ...base, contact: '??? !!' });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.airtableWrites.length, 0);
});

test('long-form email field must be a real email', async () => {
  const res = await invoke(handler, { ...base, email: 'not-an-email' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /email/i);
});

test('returns the right PDF per segment', async () => {
  const cases = [
    ['KZN Trades/Local SMBs', 'lead-magnet-trades.pdf'],
    ['National Online SMBs', 'lead-magnet-online-smb.pdf'],
    ['Professional Services', 'lead-magnet-prof-services.pdf'],
  ];
  for (const [segment, file] of cases) {
    const res = await invoke(handler, { ...base, segment, contact: `x${segment.length}@e.co` });
    assert.equal(res.statusCode, 200, `${segment} should be accepted`);
    assert.equal(res.body.downloadUrl, `https://forms.example.com/${file}`);
    assert.equal(res.body.magnetTitle.length > 0, true);
  }
});

test('builds a wa.me deep link carrying the number and the PDF', async () => {
  const res = await invoke(handler, { ...base, contact: '+27837915429', preferred_channel: 'WhatsApp' });
  assert.match(res.body.waLink, /^https:\/\/wa\.me\/27837915429\?text=/);
  assert.match(decodeURIComponent(res.body.waLink), /lead-magnet-trades\.pdf/);
});

test('emails only when there is an email address to send to', async () => {
  await invoke(handler, { ...base, contact: 'thabo@example.co.za' });
  assert.equal(calls.resendSends.length, 1);
  assert.equal(calls.resendSends[0].to[0], 'thabo@example.co.za');
  assert.equal(calls.resendSends[0].reply_to, 'hello@agentcy.co.za');

  calls.resendSends.length = 0;
  const res = await invoke(handler, { ...base, contact: '+27837915429', preferred_channel: 'WhatsApp' });
  assert.equal(calls.resendSends.length, 0, 'a phone number is not an email recipient');
  assert.equal(res.body.emailed, false);
  assert.ok(res.body.downloadUrl, 'but they still get the download link');
});

test('still reports success when Resend fails, lead is already in Airtable', async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return schemaResponse();
    if (u.includes('filterByFormula')) return jsonResponse({ records: [] });
    if (u.startsWith('https://api.resend.com/emails')) return jsonResponse({ message: 'nope' }, 422);
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') { calls.airtableWrites.push(JSON.parse(opts.body)); return jsonResponse({ id: 'rec1' }); }
    return jsonResponse({ id: 'rec1' });
  };
  const res = await invoke(handler, { ...base, contact: 'thabo@example.co.za' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, false);
  assert.equal(calls.airtableWrites.length, 1, 'the lead is still captured');
  assert.ok(res.body.downloadUrl);
});

test('rate limits per IP, after validation', async () => {
  const results = [];
  for (let i = 0; i < 7; i++) {
    results.push(await invoke(handler, { ...base, contact: `rl${i}@e.co` }, { ip: '198.51.100.7' }));
  }
  assert.equal(results.filter((r) => r.statusCode === 200).length, 5);
  assert.equal(results.filter((r) => r.statusCode === 429).length, 2);
  assert.ok(results[5].headers['Retry-After']);

  const other = await invoke(handler, { ...base, contact: 'other@e.co' }, { ip: '198.51.100.8' });
  assert.equal(other.statusCode, 200, 'a different IP is unaffected');
});

test('an invalid payload does not consume rate-limit quota', async () => {
  for (let i = 0; i < 8; i++) {
    await invoke(handler, { ...base, name: '', contact: 'x@e.co' }, { ip: '198.51.100.20' });
  }
  const res = await invoke(handler, { ...base, contact: 'valid@e.co' }, { ip: '198.51.100.20' });
  assert.equal(res.statusCode, 200, 'typo attempts must not lock a real person out');
});

test('rejects a non-POST method', async () => {
  const res = h.fakeRes();
  await handler({ method: 'GET', headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 405);
});
