/**
 * Watches the opt-in pipeline and emails you when it breaks.
 *
 * Deliberately stateless. The obvious design - remember "I am already
 * alerting" in Airtable - would make the monitor depend on the very service it
 * exists to watch, so an Airtable outage would silence the alarm. Instead this
 * is a dead-man's-switch: it stays completely silent while things are healthy
 * and speaks only when something is wrong. At worst you get one email per
 * check, which is why the schedule is daily rather than hourly.
 *
 * The trade-off, stated plainly: there is no "recovered" email. Silence after an
 * alert is the recovery signal, which is a little more ambiguous than a
 * recovery notice but can never page you at 3am for having fixed something.
 */

const { runChecks, describeFailures } = require('../_health-checks.js');

const RESEND_KEY = process.env.RESEND_API_KEY;
const ALERT_TO = process.env.ALERT_EMAIL || process.env.RESEND_REPLY_TO || 'hello@agentcy.co.za';
const ALERT_FROM =
  process.env.RESEND_FROM || 'Agentcy <onboarding@resend.dev>';
const CRON_SECRET = process.env.CRON_SECRET;

const ALERT_TIMEOUT_MS = 5000;

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without the secret set
 * we still allow the run, because a watcher that silently stops working is
 * worse than one reachable by URL - but it is logged, because an unauthenticated
 * endpoint here can be used to burn your Resend quota.
 */
function authorised(req) {
  if (!CRON_SECRET) return true;
  const header = req.headers?.authorization || '';
  return header === `Bearer ${CRON_SECRET}`;
}

async function sendAlert(subject, lines) {
  if (!RESEND_KEY) {
    console.error('[health-watch] RESEND_API_KEY not set; cannot alert.');
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: [ALERT_TO],
        subject,
        text: lines.join('\n'),
      }),
    });
    if (!r.ok) {
      console.error(`[health-watch] alert email failed: ${r.status} ${await r.text().catch(() => '')}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[health-watch] alert email errored: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (!authorised(req)) {
    return res.status(401).json({ ok: false, message: 'Unauthorised' });
  }

  const result = await runChecks();
  let notified = false;

  if (!result.ok) {
    const failures = describeFailures(result);
    console.error(`[health-watch] UNHEALTHY: ${failures.join('; ')}`);

    // Resend being down is itself a failure, so the alert goes over the same
    // broken path it is reporting. It will fail too, which is unavoidable -
    // but the log line is what you read when no email arrives.
    notified = await sendAlert(
      'Agentcy: the opt-in form is DOWN',
      [
        'The opt-in form failed its health check.',
        '',
        'Failing:',
        ...failures,
        '',
        `Checked at: ${new Date().toISOString()}`,
        '',
        'Until this clears, new submissions are being rejected and no leads',
        'are being recorded. Check the Vercel logs for [optin] errors.',
        '',
        'This message repeats once per scheduled check while the fault lasts,',
        'and stops on its own once the checks pass again.',
      ]
    );
  }

  // Always 200: a non-2xx here would make Vercel mark the cron job as failed and
  // retry it, and a failing check is reported by email, not by status code.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: result.ok,
    notified,
    at: new Date().toISOString(),
  });
};
