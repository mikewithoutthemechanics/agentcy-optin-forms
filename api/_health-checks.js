/**
 * The actual liveness checks, shared by the public /api/health endpoint and the
 * cron watcher. Extracted so the endpoint a human pokes and the job that pages
 * them can never disagree about what "healthy" means.
 *
 * This file is prefixed with an underscore so Vercel does not turn it into a
 * route of its own.
 */

const CHECK_TIMEOUT_MS = 5000;

// Read the environment inside runChecks() rather than at module load, so the
// checks always reflect the instance's current configuration instead of
// whatever happened to be set when the module was first evaluated.
const config = () => ({
  baseId: process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcMTV',
  tableId: process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd',
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
    try {
      const r = await timedFetch(
        `https://api.airtable.com/v0/${baseId}/${tableId}?maxRecords=1`,
        { headers: { Authorization: `Bearer ${airtableToken}` } }
      );
      checks.airtable = r.ok
        ? { ok: true }
        : { ok: false, error: `HTTP ${r.status}` };
      if (!r.ok) healthy = false;
    } catch (err) {
      checks.airtable = {
        ok: false,
        error: err.name === 'AbortError' ? `timed out after ${CHECK_TIMEOUT_MS}ms` : err.message,
      };
      healthy = false;
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
