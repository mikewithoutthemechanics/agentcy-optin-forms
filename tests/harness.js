/**
 * Shared test harness for api/optin.js. No framework and no network: the
 * handler is invoked directly with a fake req/res and a stubbed global fetch.
 */

const TABLE_FIELDS = [
  'Name', 'Business', 'Segment', 'Area', 'Preferred Channel', 'Pain Point',
  'Current Tools', 'POPIA Consent', 'Consent Basis', 'Source', 'Opt-In Date',
  'Status', 'Booked Call', 'Attended', 'Qualified', 'Proposal Sent',
  'Next Action', 'Next Follow-Up Date', 'Touch Count', 'Last Touch Date',
  'Lead Magnet', 'Email', 'Phone', 'LinkedIn',
];

const TABLE_ID = 'tblnhzmqneNswTvGd';

const calls = { airtableWrites: [], resendSends: [], schemas: 0, dupChecks: 0 };

// The rate limiter keeps module-level state, so every test needs its own IP
// unless it is specifically exercising the limiter.
let ipCounter = 0;
const nextIp = () => `203.0.113.${((ipCounter += 1) % 250) + 1}`;

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function schemaResponse() {
  return jsonResponse({ tables: [{ id: TABLE_ID, fields: TABLE_FIELDS.map((n) => ({ name: n })) }] });
}

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function resetCalls() {
  calls.airtableWrites.length = 0;
  calls.resendSends.length = 0;
  calls.schemas = 0;
  calls.dupChecks = 0;
}

/** Default happy-path fetch stub: schema read, no duplicate, Airtable write, Resend send. */
function defaultFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('/meta/bases/')) { calls.schemas++; return schemaResponse(); }
  if (u.includes('filterByFormula')) { calls.dupChecks++; return jsonResponse({ records: [] }); }
  if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') {
    calls.airtableWrites.push(JSON.parse(opts.body));
    return jsonResponse({ id: 'rec1' });
  }
  if (u.startsWith('https://api.resend.com/emails')) {
    calls.resendSends.push(JSON.parse(opts.body));
    return jsonResponse({ id: 'em1' });
  }
  throw new Error(`unexpected fetch: ${u}`);
}

async function invoke(handler, body, { ip = nextIp() } = {}) {
  const req = {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { host: 'forms.example.com', 'x-forwarded-for': ip },
    socket: {},
  };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const base = {
  name: 'Thabo Mthembu',
  segment: 'KZN Trades/Local SMBs',
  preferred_channel: 'Email',
  pain_point: 'Slow follow up',
  popia_consent: 'Yes',
};

function loadHandler() {
  process.env.AIRTABLE_API_KEY = 'test-airtable-token';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_FROM = 'Agentcy <optin@concierge.agentcy.co.za>';
  // Keep the limiter at its default so the limit tests are meaningful.
  return require('../api/optin.js');
}

module.exports = {
  TABLE_FIELDS, TABLE_ID, calls, base,
  nextIp, jsonResponse, schemaResponse, fakeRes, resetCalls,
  defaultFetch, invoke, loadHandler,
};
