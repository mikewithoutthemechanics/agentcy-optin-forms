/**
 * The lead must be saved even when the helper calls around it fail.
 *
 * Found in production, twice, and the second time it was my own doing:
 *
 *  1. The Airtable *schema read* timed out, threw, and turned every opt-in into
 *     a 500. That read exists only to avoid 422-ing a lead over a renamed
 *     column - losing every submission because we could not ask a question is
 *     precisely the failure it was meant to prevent.
 *
 *  2. The retry wrapper could outrun Vercel's function limit, so the request was
 *     killed and answered with an HTML error page the browser could not parse.
 *
 * Both showed the visitor a bare failure and lost the lead. Neither is
 * recoverable by the visitor, so neither is allowed to happen.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./harness.js');

const handler = h.loadHandler();

const lead = { ...h.base, contact: 'schema.fallback@example.co.za' };

/** Fresh module, so the schema cache starts cold like a cold start does. */
function freshHandler() {
  delete require.cache[require.resolve('../api/optin.js')];
  return h.loadHandler();
}

test('a schema read that times out still saves the lead', async () => {
  h.resetCalls();
  const target = freshHandler();

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) {
      // Hang until aborted, exactly like Airtable refusing to answer.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 30000);
        opts.signal?.addEventListener?.('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (u.includes('filterByFormula')) return h.jsonResponse({ records: [] });
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') {
      h.calls.airtableWrites.push(JSON.parse(opts.body));
      return h.jsonResponse({ id: 'rec1' });
    }
    if (u.includes('api.resend.com')) {
      h.calls.resendSends.push(JSON.parse(opts.body));
      return h.jsonResponse({ id: 'em1' });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const res = await h.invoke(target, lead);

  assert.equal(res.statusCode, 200, 'the lead is saved despite the schema read');
  assert.equal(res.body.success, true);
  assert.equal(h.calls.airtableWrites.length, 1);
  assert.ok(res.body.downloadUrl, 'and they still get the blueprint');
});

test('a 403 on the schema read still saves the lead', async () => {
  h.resetCalls();
  const target = freshHandler();

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => 'denied' };
    }
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(target, lead);
  assert.equal(res.statusCode, 200);
  assert.equal(h.calls.airtableWrites.length, 1);
});

test('the built-in column list matches what buildFields actually writes', async () => {
  // These drift independently, and if they diverge a cold start with no cached
  // schema would silently drop columns from every lead.
  const source = require('fs').readFileSync(require.resolve('../api/optin.js'), 'utf8');

  // The keys buildFields() sets, read out of the source.
  const buildStart = source.indexOf('function buildFields(');
  const buildEnd = source.indexOf('const dropped', buildStart);
  const body = source.slice(buildStart, buildEnd);
  const written = new Set(
    [...body.matchAll(/^\s{4}(?:'([^']+)'|([A-Za-z]+)):/gm)].map((m) => m[1] || m[2])
  );

  assert.ok(written.size >= 20, `parsed ${written.size} field names out of buildFields`);

  const fallbackBlock = source.slice(
    source.indexOf('const FALLBACK_FIELDS'),
    source.indexOf(']);', source.indexOf('const FALLBACK_FIELDS'))
  );
  for (const field of written) {
    assert.ok(
      fallbackBlock.includes(`'${field}'`),
      `FALLBACK_FIELDS is missing "${field}", which buildFields writes`
    );
  }
});

test('a lead is still saved when every optional call misbehaves at once', async () => {
  h.resetCalls();
  const target = freshHandler();

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => 'nope' };
    }
    if (u.includes('filterByFormula')) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => 'nope' };
    }
    return h.defaultFetch(url, opts);
  };

  const res = await h.invoke(target, { ...lead, contact: 'everything.breaks@example.co.za' });

  // The duplicate check failing means duplicates are not prevented, which is
  // logged - but it must never cost the lead itself.
  assert.equal(res.statusCode, 200);
  assert.equal(h.calls.airtableWrites.length, 1, 'the write is the one that must happen');
});

test('a totally broken Airtable never returns a 500', async () => {
  h.resetCalls();
  const target = freshHandler();

  global.fetch = async () => {
    throw new Error('network down');
  };

  const res = await h.invoke(target, { ...lead, contact: 'total.outage@example.co.za' });

  // The worst case is a 502 with a real message the form can display, or the
  // rescue email succeeding. What must never happen is a 500, because that is
  // the shape that showed the visitor an unparseable error.
  assert.notEqual(res.statusCode, 500, 'no unhandled 500');
  assert.ok(res.body && res.body.message, 'always a JSON body with a message');
  assert.ok([200, 502].includes(res.statusCode), `unexpected status ${res.statusCode}`);
});
