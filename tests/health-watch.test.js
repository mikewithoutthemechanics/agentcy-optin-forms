/**
 * The watcher is the thing you find out about when everything else has already
 * failed, so its failure modes are the tests that matter most here:
 *
 *  - it must be silent while healthy (an email every healthy run would train
 *    you to ignore it, which defeats the entire purpose)
 *  - it must alert, naming the actual failure, when something breaks
 *  - it must not leak to anyone who guesses the URL
 *  - it must answer 200 even when unhealthy, or Vercel retries a cron job that
 *    has already done its job
 */

const { test } = require('node:test');
const assert = require('node:assert');

function load({ cronSecret, resendKey = 'test-resend-key' } = {}) {
  for (const k of ['CRON_SECRET', 'RESEND_API_KEY', 'ALERT_EMAIL', 'RESEND_REPLY_TO', 'RESEND_FROM']) {
    delete process.env[k];
  }
  process.env.AIRTABLE_API_KEY = 'test-airtable-token';
  if (cronSecret) process.env.CRON_SECRET = cronSecret;
  if (resendKey !== undefined) process.env.RESEND_API_KEY = resendKey;
  process.env.ALERT_EMAIL = 'ops@example.co.za';
  process.env.RESEND_FROM = 'Agentcy <optin@concierge.agentcy.co.za>';

  delete require.cache[require.resolve('../api/cron/health-watch.js')];
  return require('../api/cron/health-watch.js');
}

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function run(handler, { auth = null } = {}) {
  const req = { method: 'GET', headers: auth ? { authorization: auth } : {} };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/** Stub the Airtable read that runChecks() performs. */
function stubAirtable(status) {
  global.fetch = async (url) => {
    if (String(url).includes('api.airtable.com')) {
      return {
        ok: status < 400,
        status,
        json: async () => ({ records: [] }),
        text: async () => 'error',
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function captureResend() {
  const sent = [];
  const inner = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.airtable.com')) return inner(url, opts);
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ id: 'em1' }), text: async () => '{}' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return sent;
}

test('stays silent while healthy - no email, so alerts are never noise', async () => {
  stubAirtable(200);
  const sent = captureResend();
  const res = await run(load({ resendKey: 'k' }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.notified, false);
  assert.equal(sent.length, 0, 'a healthy run must not email anyone');
});

test('alerts with the specific failure when Airtable is down', async () => {
  stubAirtable(403);
  const sent = captureResend();
  const res = await run(load({ resendKey: 'k' }));

  assert.equal(res.statusCode, 200, 'still 200: the alert is the report, not the status');
  assert.equal(res.body.ok, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /DOWN/);
  assert.match(sent[0].text, /airtable: HTTP 403/);
  assert.deepEqual(sent[0].to, ['ops@example.co.za']);
});

test('alerts when Airtable is missing entirely, not just erroring', async () => {
  const handler = load({ resendKey: 'k' });
  // runChecks() reads the environment per call, so unsetting the key here is
  // enough to exercise the misconfigured path.
  const saved = process.env.AIRTABLE_API_KEY;
  delete process.env.AIRTABLE_API_KEY;
  const sent = captureResend();
  const res = await run(handler);
  process.env.AIRTABLE_API_KEY = saved;

  assert.equal(res.body.ok, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /AIRTABLE_API_KEY not set/);
});

test('rejects a caller with the wrong secret', async () => {
  stubAirtable(200);
  const handler = load({ cronSecret: 'right-secret', resendKey: 'k' });

  const bad = await run(handler, { auth: 'Bearer wrong-secret' });
  assert.equal(bad.statusCode, 401);

  const none = await run(handler);
  assert.equal(none.statusCode, 401);
});

test('accepts the cron with the right secret', async () => {
  stubAirtable(200);
  const handler = load({ cronSecret: 'right-secret', resendKey: 'k' });
  const res = await run(handler, { auth: 'Bearer right-secret' });
  assert.equal(res.statusCode, 200);
});

test('reports rather than emails when Resend itself is the broken part', async () => {
  stubAirtable(403);
  const handler = load({ cronSecret: undefined, resendKey: undefined });

  global.fetch = async (url) => {
    if (String(url).includes('api.airtable.com')) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => 'nope' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const res = await run(handler);

  assert.equal(res.statusCode, 200, 'a monitor with no email still reports');
  assert.equal(res.body.notified, false, 'and says honestly that nobody was told');
});

test('the public health endpoint and the watcher agree on health', async () => {
  stubAirtable(200);
  const sent = captureResend();

  delete require.cache[require.resolve('../api/health.js')];
  const health = require('../api/health.js');
  const endpointRes = fakeRes();
  await health({ method: 'GET', headers: {} }, endpointRes);

  const watcherRes = await run(load({ resendKey: 'k' }));

  assert.equal(endpointRes.statusCode, 200);
  assert.equal(watcherRes.body.ok, true);
  assert.equal(sent.length, 0);
});
