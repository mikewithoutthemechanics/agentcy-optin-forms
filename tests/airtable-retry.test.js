/**
 * Airtable answers a request that exceeds its 5/second per-token limit with
 * 403 or 429 - the same status it uses for a real permissions failure. Before
 * this was handled, a burst of simultaneous submissions hit the limit, the
 * write 403'd, and the visitor saw "could not save your opt-in": a lead lost to
 * infrastructure rather than to anything they did.
 *
 * These tests pin the behaviour that fixes it, and equally the behaviour that
 * must NOT change: a malformed payload is still rejected immediately, because
 * retrying a 422 just burns the visitor's time.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./harness.js');

const handler = h.loadHandler();

/** Counts Airtable write attempts, failing the first `failures` of them. */
function flakyWriteStub({ failures, status = 403 }) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    fetch: async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/meta/bases/')) return h.schemaResponse();
      if (u.includes('filterByFormula')) return h.jsonResponse({ records: [] });
      if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') {
        attempts += 1;
        if (attempts <= failures) {
          return h.jsonResponse(
            { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' } },
            status
          );
        }
        h.calls.airtableWrites.push(JSON.parse(opts.body));
        return h.jsonResponse({ id: 'rec1' });
      }
      if (u.startsWith('https://api.resend.com/emails')) {
        h.calls.resendSends.push(JSON.parse(opts.body));
        return h.jsonResponse({ id: 'em1' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
  };
}

test('recovers the lead when Airtable throttles the write with 403', async () => {
  h.resetCalls();
  const stub = flakyWriteStub({ failures: 1 });
  global.fetch = stub.fetch;

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.403@example.co.za' });

  assert.equal(res.statusCode, 200, 'the visitor sees success, not an error');
  assert.equal(res.body.success, true);
  assert.equal(stub.attempts, 2, 'the write was retried exactly once');
  assert.equal(h.calls.airtableWrites.length, 1, 'and the lead landed in Airtable');
  assert.ok(res.body.downloadUrl, 'they still get the blueprint');
});

test('recovers when Airtable answers 429 instead', async () => {
  h.resetCalls();
  const stub = flakyWriteStub({ failures: 2, status: 429 });
  global.fetch = stub.fetch;

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.429@example.co.za' });

  assert.equal(res.statusCode, 200);
  assert.equal(stub.attempts, 3, 'two retries, then success');
  assert.equal(h.calls.airtableWrites.length, 1);
});

test('gives up after a bounded number of attempts rather than spinning', async () => {
  h.resetCalls();
  const stub = flakyWriteStub({ failures: 99 });
  global.fetch = stub.fetch;

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.giveup@example.co.za' });

  assert.equal(res.statusCode, 502, 'a persistently failing write still surfaces');
  assert.equal(res.body.success, false);
  assert.equal(stub.attempts, 3, 'and it stopped at the attempt ceiling');
  assert.equal(h.calls.airtableWrites.length, 0, 'no phantom lead was written');
});

test('does not retry a 422, because only a human can fix a bad payload', async () => {
  h.resetCalls();
  const stub = flakyWriteStub({ failures: 99, status: 422 });
  global.fetch = stub.fetch;

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.422@example.co.za' });

  assert.equal(res.statusCode, 502);
  assert.equal(stub.attempts, 1, 'exactly one attempt - no pointless retries');
});

test('does not retry a 401', async () => {
  h.resetCalls();
  const stub = flakyWriteStub({ failures: 99, status: 401 });
  global.fetch = stub.fetch;

  await h.invoke(handler, { ...h.base, contact: 'retry.401@example.co.za' });
  assert.equal(stub.attempts, 1);
});

test('retries the schema read too, so a cold start under load still works', async () => {
  h.resetCalls();
  // allowedFields() memoises the schema per module instance, and an earlier
  // test in this process has already populated it. A fresh module is the only
  // way to exercise the cold-start path.
  delete require.cache[require.resolve('../api/optin.js')];
  const fresh = h.loadHandler();

  let schemaCalls = 0;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) {
      schemaCalls += 1;
      if (schemaCalls <= 1) return h.jsonResponse({ error: 'throttled' }, 403);
      return h.schemaResponse();
    }
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(fresh, { ...h.base, contact: 'retry.schema@example.co.za' });
  assert.equal(res.statusCode, 200);
  assert.equal(schemaCalls, 2, 'the schema read was retried');
  assert.equal(h.calls.airtableWrites.length, 1);
});

test('a failed duplicate check is retried, so throttling does not allow duplicate rows', async () => {
  h.resetCalls();
  let dupCalls = 0;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return h.schemaResponse();
    if (u.includes('filterByFormula')) {
      dupCalls += 1;
      if (dupCalls <= 1) return h.jsonResponse({ error: 'throttled' }, 429);
      h.calls.dupChecks += 1;
      return h.jsonResponse({ records: [] });
    }
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.dedupe@example.co.za' });
  assert.equal(res.statusCode, 200);
  assert.equal(dupCalls, 2, 'the duplicate check was retried rather than silently skipped');
});

test('still lets a duplicate through once the check succeeds on retry', async () => {
  h.resetCalls();
  let dupCalls = 0;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return h.schemaResponse();
    if (u.includes('filterByFormula')) {
      dupCalls += 1;
      if (dupCalls <= 1) return h.jsonResponse({ error: 'throttled' }, 403);
      return h.jsonResponse({ records: [{ id: 'recExisting' }] });
    }
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.dedupe.hit@example.co.za' });
  assert.equal(res.body.duplicate, true, 'the retried check still prevents the duplicate row');
  assert.equal(h.calls.airtableWrites.length, 0);
});

test('a network timeout on the write is retried', async () => {
  h.resetCalls();
  let attempts = 0;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return h.schemaResponse();
    if (u.includes('filterByFormula')) return h.jsonResponse({ records: [] });
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') {
      attempts += 1;
      if (attempts <= 1) throw new Error('socket hang up');
      h.calls.airtableWrites.push(JSON.parse(opts.body));
      return h.jsonResponse({ id: 'rec1' });
    }
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.timeout@example.co.za' });
  assert.equal(res.statusCode, 200, 'a dropped connection does not lose the lead');
  assert.equal(attempts, 2);
  assert.equal(h.calls.airtableWrites.length, 1);
});

test('a healthy write is not slowed down by the retry wrapper', async () => {
  h.resetCalls();
  let attempts = 0;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') attempts += 1;
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(handler, { ...h.base, contact: 'retry.clean@example.co.za' });
  assert.equal(res.statusCode, 200);
  assert.equal(attempts, 1, 'the common case still costs exactly one request');
});
