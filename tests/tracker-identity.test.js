/**
 * Tracker identity, and the consent evidence attached to a record.
 *
 * Two failures are covered here that unit tests on the individual handlers
 * cannot catch, because both are about things that are true *of the file
 * rather than of a function*:
 *
 *  1. The Airtable base id was declared independently in four places, and three
 *     of them had the same typo. Each handler was tested against a stubbed
 *     fetch that never checked the URL, so all of them passed. The follow-up
 *     job and the unsubscribe endpoint were both pointed at a base that does
 *     not exist.
 *
 *  2. Consent was recorded as a date with no time and no record of the wording
 *     that was shown. s11(2)(a) puts the onus on us to prove consent was given,
 *     so the evidence has to exist at the moment the record is written.
 *
 * The client address is deliberately not recorded. It is personal information
 * with its own POPIA obligations and it is not needed to evidence consent, so
 * these tests also assert it is absent.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { BASE_ID, TABLE_ID } = require('../api/_airtable.js');

const API_DIR = path.join(__dirname, '..', 'api');
const KNOWN_BASE = 'app0CK3JUNYEGcCMV';
const KNOWN_TABLE = 'tblnhzmqneNswTvGd';

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

// ------------------------------------------------------------- base id --

test('the tracker base id is the real one', () => {
  delete process.env.AIRTABLE_BASE_ID;
  assert.equal(BASE_ID(), KNOWN_BASE);
  assert.equal(TABLE_ID(), KNOWN_TABLE);
});

test('the environment can still override both', () => {
  const { BASE_ID: b, TABLE_ID: t } = require('../api/_airtable.js');
  process.env.AIRTABLE_BASE_ID = 'appTestBase';
  process.env.AIRTABLE_TABLE_ID = 'tblTestTable';
  try {
    assert.equal(b(), 'appTestBase');
    assert.equal(t(), 'tblTestTable');
  } finally {
    delete process.env.AIRTABLE_BASE_ID;
    delete process.env.AIRTABLE_TABLE_ID;
  }
});

test('no handler hardcodes the base id any more', () => {
  // The actual regression guard. Four copies of a base id, three wrong, and
  // not one test noticed, because every test stubbed the transport and never
  // looked at the URL. So: the id may only appear in the module that owns it.
  const offenders = [];
  for (const file of jsFiles(API_DIR)) {
    if (path.basename(file) === '_airtable.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(KNOWN_BASE) || src.includes('app0CK3JUNYEGc')) {
      offenders.push(path.relative(API_DIR, file));
    }
  }
  assert.deepEqual(offenders, [],
    `these files hardcode the base id instead of importing it: ${offenders.join(', ')}`);
});

test('no handler hardcodes the table id any more', () => {
  const offenders = [];
  for (const file of jsFiles(API_DIR)) {
    if (path.basename(file) === '_airtable.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(KNOWN_TABLE) || src.includes('tblnhzmqneNsw')) {
      offenders.push(path.relative(API_DIR, file));
    }
  }
  assert.deepEqual(offenders, [],
    `these files hardcode the table id instead of importing it: ${offenders.join(', ')}`);
});

test('every Airtable caller takes its id from the shared module', () => {
  // Not just "no literal" - each caller must actually be using the accessor,
  // or the absence of a literal would just mean the id is missing entirely.
  const callers = ['optin.js', 'unsubscribe.js', 'cron/followup.js', '_health-checks.js'];
  for (const name of callers) {
    const src = fs.readFileSync(path.join(API_DIR, name), 'utf8');
    assert.match(src, /require\((['"])\.\.?\/.*_airtable(\.js)?\1\)/,
      `${name} must import from _airtable.js`);
    assert.match(src, /BASE_ID/, `${name} must use the shared BASE_ID`);
  }
});

// ------------------------------------------------- consent evidence --

const h = require('./harness.js');

test.beforeEach(() => {
  h.resetCalls();
  global.fetch = h.defaultFetch;
});

test('the opt-in writes evidence of what was agreed to and when', async () => {
  const { calls, invoke, loadHandler, base } = h;
  calls.airtableWrites.length = 0;
  const handler = loadHandler();

  const res = await invoke(handler, { ...base, contact: 'evidence@example.co.za' });
  assert.equal(res.statusCode, 200, 'the submission was accepted');
  const fields = calls.airtableWrites.at(-1).fields;

  // A full timestamp, not just a date: two opt-ins on the same day have to be
  // distinguishable when the question is asked.
  assert.match(fields['Consent Timestamp'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    'consent is timestamped to the second, not to the day');
  assert.ok(fields['Opt-In Date'], 'the existing date column is still written');

  // Which wording they agreed to.
  assert.ok(fields['Consent Text Version'],
    'a record points at the consent wording that was on screen');
  assert.equal(fields['Consent Basis'], 'Form Opt-In');
  assert.equal(fields['POPIA Consent'], 'Yes');
});

test('the evidence carries no client address', async () => {
  // The client IP is personal information in its own right, with its own
  // retention story. It is not needed to evidence consent, so it does not go in
  // the tracker - the logs deliberately carry no name, email or address either.
  const { calls, invoke, loadHandler, base } = h;
  calls.airtableWrites.length = 0;
  await invoke(loadHandler(), { ...base, contact: 'noip@example.co.za' },
    { ip: '198.51.100.7' });

  const fields = calls.airtableWrites.at(-1).fields;
  for (const [key, value] of Object.entries(fields)) {
    assert.ok(!String(value).includes('198.51.100.7'),
      `${key} must not contain the client address`);
  }
});

test('an absent consent value is never recorded as consent', async () => {
  // This reads the intake path rather than buildFields directly, because
  // buildFields used to default an empty value to 'Yes'. It was unreachable
  // only because the handler rejected everything else first - the safety came
  // from a comparison in a different function, which is not a thing to rely on.
  const { calls, invoke, loadHandler, base } = h;
  calls.airtableWrites.length = 0;

  const res = await invoke(loadHandler(),
    { ...base, popia_consent: '', contact: 'blank@example.co.za' });
  assert.equal(res.statusCode, 400, 'an empty consent field is refused outright');
  assert.equal(calls.airtableWrites.length, 0, 'and nothing is written to the tracker');
});
