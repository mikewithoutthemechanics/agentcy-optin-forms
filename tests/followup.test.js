/**
 * The follow-up sequence and its opt-out.
 *
 * The opt-out is the part that matters most: it is a POPIA obligation and the
 * only thing standing between a lead and unwanted email. It is therefore a
 * public, unauthenticated, GET endpoint that writes to the lead database, so
 * the tests below are mostly about making sure it cannot be abused.
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.FOLLOWUP_SECRET = 'test-followup-secret';
process.env.AIRTABLE_API_KEY = 'test-airtable-token';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.CRON_SECRET = 'test-cron-secret';

const followup = require('../api/_followup.js');
const cron = require('../api/cron/followup.js');
const unsubscribe = require('../api/unsubscribe.js');

const UNSUB = 'https://optin.agentcy.co.za/api/unsubscribe?r=rec123&s=abc';

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
}

async function run(handler, { query = {}, auth = null } = {}) {
  const req = { method: 'GET', query, headers: auth ? { authorization: auth } : {} };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const lead = (over = {}) => ({
  Name: 'Thabo Mthembu',
  Business: 'Mthembu Plumbing',
  Email: 'thabo@mthembuplumbing.co.za',
  Segment: 'KZN Trades/Local SMBs',
  'Pain Point': 'Losing quotes after hours',
  'Lead Magnet': 'Stop Losing Quotes',
  'Touch Count': 0,
  ...over,
});

// ---------------------------------------------------------------- sequence --

test('picks a different message for each touch', () => {
  const first = followup.buildFollowUp(lead({ 'Touch Count': 0 }), UNSUB);
  const second = followup.buildFollowUp(lead({ 'Touch Count': 1 }), UNSUB);
  const third = followup.buildFollowUp(lead({ 'Touch Count': 2 }), UNSUB);

  const bodies = [first, second, third].map((m) => m.body);
  assert.equal(new Set(bodies).size, 3, 'three touches, three different emails');
  assert.equal(new Set([first, second, third].map((m) => m.subject)).size, 3);
});

test('every touch carries the unsubscribe link', () => {
  for (const touch of [0, 1, 2]) {
    const msg = followup.buildFollowUp(lead({ 'Touch Count': touch }), UNSUB);
    assert.ok(msg.body.includes(UNSUB), `touch ${touch + 1} has no opt-out link`);
  }
});

test('the final touch says the thread is closed', () => {
  const last = followup.buildFollowUp(lead({ 'Touch Count': 2 }), UNSUB);
  assert.match(last.subject, /Closing this thread/i);
  assert.match(last.body, /stop following up/i);
});

test('segment copy is specific, not generic', () => {
  const trades = followup.buildFollowUp(lead({ Segment: 'KZN Trades/Local SMBs' }), UNSUB);
  const online = followup.buildFollowUp(lead({ Segment: 'National Online SMBs' }), UNSUB);
  const pro = followup.buildFollowUp(lead({ Segment: 'Professional Services' }), UNSUB);

  assert.match(trades.body, /quote/i);
  assert.match(online.body, /inventory/i);
  assert.match(pro.body, /CRM/i);

  // A subject naming their actual business beats a generic one.
  assert.match(trades.subject, /Mthembu Plumbing/);
});

test('a long business name cannot blow up the subject line', () => {
  const msg = followup.buildFollowUp(lead({ Business: 'x'.repeat(160) }), UNSUB);
  assert.ok(msg.subject.length <= 90, `subject was ${msg.subject.length} chars`);
});

test('a missing business name still produces a sensible subject', () => {
  const msg = followup.buildFollowUp(lead({ Business: '' }), UNSUB);
  assert.ok(msg.subject.length > 0);
  assert.doesNotMatch(msg.subject, /about\s*$/, 'no dangling "about"');
});

test('handles a missing name with a fallback greeting', () => {
  const msg = followup.buildFollowUp(lead({ Name: '' }), UNSUB);
  assert.match(msg.body, /Hi there,/);
});

test('gaps back off after the final touch', () => {
  const inThree = followup.nextFollowUpDate(1);
  const inThirty = followup.nextFollowUpDate(3);
  const diff = (Date.parse(inThirty) - Date.parse(inThree)) / 86400000;
  assert.ok(diff >= 27 && diff <= 30, `expected ~27 days further out, got ${diff}`);
});

// ------------------------------------------------------------------ filter --

test('the due filter excludes opted-out and finished leads', () => {
  const f = followup.DUE_FILTER('2026-09-26');
  assert.match(f, /\{Touch Count\} < 3/, 'stops after three touches');
  assert.match(f, /\{Status\} = 'New Opt-In'/, 'and only the opening status');
  assert.match(f, /2026-09-26/, 'and only what is actually due today');
  assert.match(f, /\{Email\} != ''/, 'and never a lead we cannot email');
});

test('an unsubscribed lead stops matching the filter', () => {
  // The opt-out works by moving Status off 'New Opt-In', so there is no
  // second suppression list that could drift out of sync with this one.
  assert.ok(!followup.DUE_FILTER('2026-09-26').includes('Unsubscribed'));
  assert.match(followup.DUE_FILTER('2026-09-26'), /Status\} = 'New Opt-In'/);
});

// ---------------------------------------------------------------- signature --

test('a signature is accepted only for the record it was made for', () => {
  const sig = followup.signRecordId('rec123');
  assert.equal(followup.verifySignature('rec123', sig), true);
  assert.equal(followup.verifySignature('rec124', sig), false, 'cannot be reused on another record');
});

test('garbage signatures are rejected without throwing', () => {
  for (const bad of ['', 'nope', 'zz', 'a'.repeat(64), undefined, null]) {
    assert.equal(followup.verifySignature('rec123', bad), false, `accepted ${bad}`);
  }
});

test('a wrong-length signature cannot crash the comparison', () => {
  // timingSafeEqual throws on mismatched lengths, which would turn a junk
  // link into a 500 for the recipient.
  assert.equal(followup.verifySignature('rec123', 'abcd'), false);
});

// -------------------------------------------------------------- unsubscribe --

test('a valid unsubscribe link opts the lead out', async () => {
  let patched = null;
  global.fetch = async (url, opts = {}) => {
    patched = { url: String(url), body: JSON.parse(opts.body), method: opts.method };
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{"ok":true}' };
  };

  const sig = followup.signRecordId('rec123');
  const res = await run(unsubscribe, { query: { r: 'rec123', s: sig } });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /unsubscribed/i);
  assert.equal(patched.method, 'PATCH');
  assert.equal(patched.body.fields.Status, 'Unsubscribed');
  assert.equal(patched.body.fields['Next Action'], 'Unsubscribed - do not contact');
  assert.equal(patched.body.typecast, true, 'creates the select option without a schema change');
});

test('a forged unsubscribe link is refused and writes nothing', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };

  const res = await run(unsubscribe, { query: { r: 'rec999', s: followup.signRecordId('rec123') } });

  assert.equal(res.statusCode, 403);
  assert.equal(called, false, 'a forged link must not reach Airtable at all');
  assert.match(res.body, /not valid/i);
});

test('an incomplete link is refused', async () => {
  global.fetch = async () => {
    throw new Error('must not be called');
  };
  for (const q of [{}, { r: 'rec123' }, { s: 'abc' }]) {
    const res = await run(unsubscribe, { query: q });
    assert.equal(res.statusCode, 400);
  }
});

test('a failed write tells them how to reach a human', async () => {
  global.fetch = async () => ({
    ok: false, status: 403, json: async () => ({}), text: async () => 'denied',
  });
  const res = await run(unsubscribe, {
    query: { r: 'rec123', s: followup.signRecordId('rec123') },
  });
  assert.equal(res.statusCode, 500);
  assert.match(res.body, /hello@agentcy\.co\.za/, 'an opt-out that fails must still offer a way out');
});

test('the opt-out page does not confirm which records exist', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
  const res = await run(unsubscribe, { query: { r: 'rec999', s: followup.signRecordId('rec123') } });
  assert.doesNotMatch(res.body, /not found|no such record/i);
});

// --------------------------------------------------------------------- cron --

/** Stub Airtable: `due` records go out, and every PATCH is recorded. */
function stubCron(dueRecords, { resendStatus = 200 } = {}) {
  const state = { patches: [], sent: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.airtable.com')) {
      if (opts.method === 'PATCH') {
        state.patches.push({ url: u, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
      }
      if (u.includes('filterByFormula')) {
        return {
          ok: true, status: 200,
          json: async () => ({ records: dueRecords }),
          text: async () => JSON.stringify({ records: dueRecords }),
        };
      }
      throw new Error(`unexpected airtable call: ${u}`);
    }
    if (u.includes('api.resend.com')) {
      state.sent.push(JSON.parse(opts.body));
      return { ok: resendStatus < 400, status: resendStatus, json: async () => ({}), text: async () => '{}' };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return state;
}

test('the job emails each due lead and books the next touch', async () => {
  const state = stubCron([
    { id: 'rec1', fields: lead() },
    { id: 'rec2', fields: lead({ Name: 'Nomsa Dlamini', Segment: 'Professional Services' }) },
  ]);

  const res = await run(cron, { auth: 'Bearer test-cron-secret' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sent, 2);
  assert.equal(state.sent.length, 2);
  assert.equal(state.patches.length, 2);

  const patch = state.patches[0].body.fields;
  assert.equal(patch['Touch Count'], 1);
  assert.equal(patch.Status, 'Contacted');
  assert.match(patch['Next Follow-Up Date'], /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(patch['Next Follow-Up Date'] > new Date().toISOString().slice(0, 10),
    'the next touch is scheduled in the future, not today');
});

test('replies go to a monitored inbox, not the sending subdomain', async () => {
  process.env.RESEND_REPLY_TO = 'michaelgraemek@gmail.com';
  const state = stubCron([{ id: 'rec1', fields: lead() }]);
  await run(cron, { auth: 'Bearer test-cron-secret' });
  assert.equal(state.sent[0].reply_to, 'michaelgraemek@gmail.com');
});

test('the job needs the cron secret', async () => {
  stubCron([]);
  assert.equal((await run(cron)).statusCode, 401);
  assert.equal((await run(cron, { auth: 'Bearer wrong' })).statusCode, 401);
  assert.equal((await run(cron, { auth: 'Bearer test-cron-secret' })).statusCode, 200);
});

test('a lead that fails to send stays due instead of vanishing', async () => {
  const state = stubCron([{ id: 'rec1', fields: lead() }], { resendStatus: 500 });
  const res = await run(cron, { auth: 'Bearer test-cron-secret' });

  assert.equal(res.body.sent, 0);
  assert.equal(res.body.failed, 1);
  assert.equal(state.patches.length, 0, 'no bookkeeping written, so tomorrow it retries');
});

test('one bad lead does not stop the rest of the batch', async () => {
  let sendCount = 0;
  const patches = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.airtable.com')) {
      if (opts.method === 'PATCH') {
        patches.push(u);
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
      }
      const records = [
        { id: 'rec1', fields: lead({ 'Touch Count': 0 }) },
        { id: 'rec2', fields: lead({ Name: 'Second', 'Touch Count': 0 }) },
        { id: 'rec3', fields: lead({ Name: 'Third', 'Touch Count': 0 }) },
      ];
      return {
        ok: true, status: 200, json: async () => ({ records }),
        text: async () => JSON.stringify({ records }),
      };
    }
    sendCount += 1;
    // The first send fails; the batch must carry on.
    return { ok: sendCount > 1, status: sendCount > 1 ? 200 : 500, json: async () => ({}), text: async () => '{}' };
  };

  const res = await run(cron, { auth: 'Bearer test-cron-secret' });
  assert.equal(res.body.sent, 2, 'the two healthy leads still got their email');
  assert.equal(res.body.failed, 1);
  assert.equal(patches.length, 2);
});

test('the last touch parks the lead instead of looping forever', async () => {
  const state = stubCron([{ id: 'rec1', fields: lead({ 'Touch Count': 2 }) }]);
  await run(cron, { auth: 'Bearer test-cron-secret' });

  const patch = state.patches[0].body.fields;
  assert.equal(patch['Touch Count'], 3);
  assert.equal(patch.Status, 'Paused', 'Paused is excluded by the due filter');
  assert.match(patch['Next Action'], /awaiting/i);
});

test('a runaway batch is capped', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `rec${i}`, fields: lead({ Name: `Lead ${i}` }),
  }));
  const state = stubCron(many);

  const res = await run(cron, { auth: 'Bearer test-cron-secret' });
  assert.equal(res.body.sent, 25, 'capped at FOLLOWUP_MAX_PER_RUN');
  assert.equal(res.body.due, 40);
  assert.equal(state.sent.length, 25);
  assert.ok(res.body.skipped.length, 'and it says how many were deferred');
});

test('no due leads means no emails and no errors', async () => {
  const state = stubCron([]);
  const res = await run(cron, { auth: 'Bearer test-cron-secret' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(state.sent.length, 0);
  assert.equal(state.patches.length, 0);
});

test('an Airtable read failure is reported, not silently ignored', async () => {
  global.fetch = async () => ({
    ok: false, status: 403, json: async () => ({}), text: async () => 'denied',
  });
  const res = await run(cron, { auth: 'Bearer test-cron-secret' });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'airtable read failed');
});
