/**
 * The rate limiter is the only thing standing between a bot and unlimited junk
 * rows in the lead tracker plus a burned email quota, so its failure modes are
 * security-relevant, not cosmetic.
 *
 * The one that matters most is in here: `x-forwarded-for` is client-controlled.
 * A proxy appends the real address to whatever the caller sent, so the first
 * entry is the caller's own claim. Trusting it means a forged header defeats the
 * limiter completely - one fresh IP per submission, unlimited leads created.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./harness.js');

const handler = h.loadHandler();

/** Invoke with arbitrary headers, not just x-forwarded-for. */
async function invokeWithHeaders(body, headers, target = handler) {
  const req = {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { host: 'forms.example.com', ...headers },
    socket: {},
  };
  const res = h.fakeRes();
  await target(req, res);
  return res;
}

/** Load a handler with its own rate-limit state, for eviction tests. */
function freshHandler(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('../api/optin.js')];
  return h.loadHandler();
}

function happyFetch() {
  global.fetch = h.defaultFetch;
}

test('a forged x-forwarded-for cannot buy unlimited submissions', async () => {
  happyFetch();

  // The real client address is the LAST entry, appended by the proxy. Each
  // request claims a different innocent-looking IP in front of it.
  const results = [];
  for (let i = 0; i < 8; i++) {
    const res = await invokeWithHeaders(
      { ...h.base, contact: `spoof${i}@example.co.za` },
      { 'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.99` }
    );
    results.push(res.statusCode);
  }

  const limited = results.filter((c) => c === 429).length;
  assert.ok(limited > 0, 'the limiter engaged despite rotating forged IPs');
  assert.equal(
    results.filter((c) => c === 200).length,
    h.__maxPerWindow ?? 5,
    'and it allowed exactly the configured quota, not one per forged header'
  );
});

test('prefers the header Vercel sets over anything the caller sent', async () => {
  happyFetch();
  // x-vercel-forwarded-for is set by the platform and cannot be overridden.
  const res = await invokeWithHeaders(
    { ...h.base, contact: 'vercel.header@example.co.za' },
    { 'x-vercel-forwarded-for': '203.0.113.77', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }
  );
  assert.equal(res.statusCode, 200);
});

test('still rate limits when the trusted address repeats', async () => {
  happyFetch();
  const results = [];
  for (let i = 0; i < 7; i++) {
    const res = await invokeWithHeaders(
      { ...h.base, contact: `repeat.${i}@example.co.za` },
      { 'x-vercel-forwarded-for': '203.0.113.200' }
    );
    results.push(res.statusCode);
  }
  assert.equal(results.filter((c) => c === 429).length, 2, '6th and 7th were refused');
});

test('falls back to the socket address when the proxy sends nothing', async () => {
  happyFetch();
  const res = await invokeWithHeaders({ ...h.base, contact: 'socket@example.co.za' }, {});
  assert.equal(res.statusCode, 200, 'it does not collapse every proxy-less caller into one shared bucket');
});

test('a single spoofed header cannot lock out an unrelated visitor', async () => {
  happyFetch();
  // Exhaust the shared real address.
  for (let i = 0; i < 6; i++) {
    await invokeWithHeaders(
      { ...h.base, contact: `burn.${i}@example.co.za` },
      { 'x-forwarded-for': `10.0.0.1, 203.0.113.55` }
    );
  }
  // A different real client is unaffected.
  const other = await invokeWithHeaders(
    { ...h.base, contact: 'bystander@example.co.za' },
    { 'x-forwarded-for': '10.0.0.2, 203.0.113.56' }
  );
  assert.equal(other.statusCode, 200, 'one client exhausting their quota must not throttle anyone else');
});

test('bounded memory: the limiter forgets IPs instead of growing forever', async () => {
  // A tiny cap so the eviction path is exercised without 10k requests. This
  // needs its own handler, because the limiter's state lives in the module.
  const capped = freshHandler({ RATE_LIMIT_MAX_IPS: '50' });

  global.fetch = h.defaultFetch;
  for (let i = 0; i < 300; i++) {
    await invokeWithHeaders(
      { ...h.base, contact: `flood${i}@example.co.za` },
      { 'x-vercel-forwarded-for': `198.18.${Math.floor(i / 256)}.${i % 256}` },
      capped
    );
  }

  delete process.env.RATE_LIMIT_MAX_IPS;

  // Two halves of the same trade-off, and both matter. Bounding memory means
  // forgetting the oldest entries, so a flooder gets a clean slate - but the
  // most recent entries must survive, or the limiter has stopped working and
  // the cap has simply disabled it.
  const recent = '198.18.1.43'; // last IP of the flood
  let last;
  for (let i = 0; i < 6; i++) {
    const res = await invokeWithHeaders(
      { ...h.base, contact: `recent${i}@example.co.za` },
      { 'x-vercel-forwarded-for': recent },
      capped
    );
    last = res.statusCode;
  }
  assert.equal(last, 429, 'the newest entries are still being counted and enforced');

  const evicted = await invokeWithHeaders(
    { ...h.base, contact: 'evicted@example.co.za' },
    { 'x-vercel-forwarded-for': '198.18.0.5' }, // first IPs of the flood
    capped
  );
  assert.equal(evicted.statusCode, 200, 'the oldest were dropped, which is the memory bound doing its job');
});

test('the honest path still works on a fresh instance', async () => {
  const clean = freshHandler();
  happyFetch();
  const res = await invokeWithHeaders(
    { ...h.base, contact: 'legit@example.co.za' },
    { 'x-vercel-forwarded-for': '203.0.113.99' },
    clean
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});
