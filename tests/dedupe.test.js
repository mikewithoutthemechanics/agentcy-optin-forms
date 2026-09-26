/**
 * Dedupe behaviour. Airtable has no LAST_N_DAYS function; using it made every
 * duplicate check 422, which the "never block a lead" fallback turned into a
 * silent no-op - the guard looked present and did nothing. These assert the
 * formula we actually send is well-formed, and that a failure is logged.
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

test('a repeat submission is not written twice', async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return schemaResponse();
    if (u.includes('filterByFormula')) return jsonResponse({ records: [{ id: 'recExisting' }] });
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') { calls.airtableWrites.push(JSON.parse(opts.body)); return jsonResponse({ id: 'rec2' }); }
    return jsonResponse({ id: 'em1' });
  };
  const res = await invoke(handler, { ...base, contact: 'repeat@example.co.za' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(calls.airtableWrites.length, 0, 'no second pipeline row');
  assert.ok(res.body.downloadUrl, 'but they still get the blueprint');
});

test('sends a valid Airtable formula, not LAST_N_DAYS', async () => {
  const seen = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return schemaResponse();
    if (u.includes('filterByFormula')) {
      seen.push(decodeURIComponent(u.split('filterByFormula=')[1]));
      return jsonResponse({ records: [] });
    }
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') { calls.airtableWrites.push(JSON.parse(opts.body)); return jsonResponse({ id: 'rec1' }); }
    return jsonResponse({ id: 'em1' });
  };

  await invoke(handler, { ...base, contact: 'formula@example.co.za' });
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /LAST_N_DAYS/, 'LAST_N_DAYS is not an Airtable function');
  assert.match(
    seen[0],
    /AND\(\{Email\} = "formula@example\.co\.za", IS_AFTER\(\{Opt-In Date\}, "\d{4}-\d{2}-\d{2}"\)\)/,
    'cutoff must be a concrete date computed in JS'
  );
});

test('checks the column matching the contact kind', async () => {
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return schemaResponse();
    if (u.includes('filterByFormula')) {
      seen.push(decodeURIComponent(u.split('filterByFormula=')[1]));
      return jsonResponse({ records: [] });
    }
    return jsonResponse({ id: 'rec1' });
  };

  await invoke(handler, { ...base, contact: '+27837915429', preferred_channel: 'WhatsApp' });
  await invoke(handler, { ...base, segment: 'Professional Services', preferred_channel: 'LinkedIn', contact: 'linkedin.com/in/priyan' });

  assert.match(seen[0], /\{Phone\}/);
  assert.match(seen[1], /\{LinkedIn\}/);
});

test('a broken duplicate check is logged, not silently swallowed', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/meta/bases/')) return schemaResponse();
    if (u.includes('filterByFormula')) return { ok: false, status: 422, json: async () => ({}), text: async () => 'INVALID_FILTER_BY_FORMULA' };
    if (u.startsWith('https://api.airtable.com/v0/') && opts.method === 'POST') { calls.airtableWrites.push(JSON.parse(opts.body)); return jsonResponse({ id: 'rec1' }); }
    return jsonResponse({ id: 'em1' });
  };

  const res = await invoke(handler, { ...base, contact: 'brokendupe@example.co.za' });
  console.error = realError;

  assert.equal(res.statusCode, 200, 'a broken dup check must not block the lead');
  assert.equal(calls.airtableWrites.length, 1, 'the lead is still captured');
  assert.ok(
    errors.some((e) => /DUPLICATE CHECK FAILED/.test(e)),
    'the failure must be logged loudly, not swallowed'
  );
});
