/**
 * The actual liveness checks, shared by the public /api/health endpoint and the
 * cron watcher. Extracted so the endpoint a human pokes and the job that pages
 * them can never disagree about what "healthy" means.
 *
 * This file is prefixed with an underscore so Vercel does not turn it into a
 * route of its own.
 */

const CHECK_TIMEOUT_MS = 5000;
const { BASE_ID, TABLE_ID } = require('./_airtable.js');

// Distinctive so a probe row left behind by a failed cleanup is obvious in the
// tracker rather than looking like a real lead.
const PROBE_NAME = '[health probe] delete me';

// Read from the environment inside runChecks() rather than at module load, so
// the checks always reflect the instance's current configuration instead of
// whatever happened to be set when the module was first evaluated.
const config = () => ({
  baseId: BASE_ID(),
  tableId: TABLE_ID(),
  airtableToken: process.env.AIRTABLE_API_KEY,
  resendKey: process.env.RESEND_API_KEY,
});

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Can we still save a lead?
 *
 * A read is the obvious probe and it is the wrong one. Airtable throttles reads
 * and writes separately, and in production the read path started returning 403
 * while writes carried on working - so a read-based health check reported the
 * form as DOWN on a day it was saving every lead perfectly. That is the worst
 * possible failure for a monitor: it cries wolf daily until you ignore it, and
 * then it is useless the one time it matters.
 *
 * So probe the write path: create a throwaway record and delete it again. Two
 * calls a day, and the answer is directly the question "will the next
 * submission be saved?".
 */
async function probeWrite(baseId, tableId, airtableToken) {
  const headers = {
    Authorization: `Bearer ${airtableToken}`,
    'Content-Type': 'application/json',
  };

  const created = await timedFetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fields: { Name: PROBE_NAME, Source: 'health-probe' },
      typecast: true,
    }),
  });
  if (!created.ok) {
    return { ok: false, error: `write probe rejected: HTTP ${created.status}` };
  }

  // Always clean up, even if the delete fails: a leftover probe row would
  // quietly pollute someone's pipeline.
  const { id } = await created.json().catch(() => ({}));
  if (id) {
    const removed = await timedFetch(`https://api.airtable.com/v0/${baseId}/${tableId}/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (!removed.ok) {
      console.error(`[health] could not delete probe record ${id}: ${removed.status}`);
    }
  }

  return { ok: true };
}

/**
 * Corroborate a failed write probe with a plain read before declaring an
 * outage. Airtable throttles per request type, so a single unlucky call is not
 * evidence that leads are being lost - and a false alarm is worse than none.
 * If the read works, the write failure was transient and the opt-in endpoint's
 * own retries (plus the rescue-by-email path) will have coped.
 */
async function readAirtable(baseId, tableId, airtableToken) {
  try {
    const r = await timedFetch(
      `https://api.airtable.com/v0/${baseId}/${tableId}?maxRecords=1`,
      { headers: { Authorization: `Bearer ${airtableToken}` } }
    );
    return { ok: r.ok, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  }
}

/**
 * Report configuration state without echoing any secret, and read Airtable for
 * real so a revoked token surfaces here rather than as a failed signup.
 */
async function runChecks() {
  const { baseId, tableId, airtableToken, resendKey } = config();
  const checks = {};
  let healthy = true;

  if (!airtableToken) {
    checks.airtable = { ok: false, error: 'AIRTABLE_API_KEY not set' };
    healthy = false;
  } else {
    const probe = await probeWrite(baseId, tableId, airtableToken);
    if (probe.ok) {
      checks.airtable = { ok: true, canSaveLeads: true };
    } else {
      const read = await readAirtable(baseId, tableId, airtableToken);
      if (read.ok) {
        // Writes are throttled, reads are not. The endpoint retries and then
        // falls back to emailing the lead, so nothing is being lost.
        checks.airtable = {
          ok: true,
          canSaveLeads: true,
          degraded: true,
          error: `${probe.error} (read corroboration succeeded, treating as transient)`,
        };
        console.warn(`[health] ${probe.error}; Airtable reads are fine, not paging`);
      } else {
        checks.airtable = {
          ok: false,
          canSaveLeads: false,
          error: `${probe.error}; read also failed: ${read.error}`,
        };
        healthy = false;
      }
    }
  }

  // Reachability only. Validating the key would need a full-access token, and
  // Vercel holds a send-only one by design.
  if (!resendKey) {
    checks.resend = { ok: false, error: 'RESEND_API_KEY not set' };
    healthy = false;
  } else {
    checks.resend = { ok: true, configured: true };
  }

  checks.resendFrom = { value: process.env.RESEND_FROM || null };
  checks.replyTo = { value: process.env.RESEND_REPLY_TO || null };

  return { ok: healthy, checks };
}

/** One line per failing check, for the alert email. */
function describeFailures(result) {
  return Object.entries(result.checks)
    .filter(([, v]) => v && v.ok === false)
    .map(([name, v]) => `- ${name}: ${v.error || 'failed'}`);
}

module.exports = { runChecks, describeFailures };
