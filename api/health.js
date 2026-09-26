/**
 * Liveness check for the opt-in pipeline. Point a Vercel cron or an uptime
 * monitor at this and alert on a non-200, otherwise a 500ing function is
 * only discovered when a lead complains.
 *
 * Deliberately reports configuration state without echoing any secret, and
 * pings Airtable with a real read so a revoked token shows up here rather
 * than as a failed signup.
 */

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcCMV';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd';
const AIRTABLE_TOKEN = process.env.AIRTABLE_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

const CHECK_TIMEOUT_MS = 5000;

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  const checks = {};
  let healthy = true;

  if (!AIRTABLE_TOKEN) {
    checks.airtable = { ok: false, error: 'AIRTABLE_API_KEY not set' };
    healthy = false;
  } else {
    try {
      const r = await timedFetch(
        `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?maxRecords=1`,
        { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
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

  // Reachability only. Validating the key would need a full-access token,
  // and Vercel holds a send-only one by design.
  if (!RESEND_KEY) {
    checks.resend = { ok: false, error: 'RESEND_API_KEY not set' };
    healthy = false;
  } else {
    checks.resend = { ok: true, configured: true };
  }

  checks.resendFrom = { value: process.env.RESEND_FROM || null };
  checks.replyTo = { value: process.env.RESEND_REPLY_TO || null };

  res.setHeader('Cache-Control', 'no-store');
  return res.status(healthy ? 200 : 503).json({
    ok: healthy,
    checks,
    at: new Date().toISOString(),
  });
};
