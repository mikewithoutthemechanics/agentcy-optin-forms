/**
 * Daily follow-up run. Finds the leads that are due, sends one email each, and
 * moves their next-touch date forward so tomorrow's run does not pick them up
 * again.
 *
 * One lead failing must not stop the batch, so each is sent and updated
 * independently and the summary reports what happened per lead.
 */

const {
  MAX_TOUCHES,
  buildFollowUp,
  nextFollowUpDate,
  DUE_FILTER,
  signRecordId,
} = require('../_followup.js');
const { airtableRequest } = require('../_airtable.js');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcMTV';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd';
const MAX_PER_RUN = Number(process.env.FOLLOWUP_MAX_PER_RUN || 25);
const SEND_TIMEOUT_MS = 8000;

// Read per invocation rather than at module load, so the job always reflects
// the instance's current configuration.
const config = () => ({
  resendKey: process.env.RESEND_API_KEY,
  resendFrom: process.env.RESEND_FROM || 'Agentcy <onboarding@resend.dev>',
  replyTo: process.env.RESEND_REPLY_TO || 'hello@agentcy.co.za',
  cronSecret: process.env.CRON_SECRET,
});

function authorised(secret) {
  if (!secret) return true;
  return (req) => req.headers?.authorization === `Bearer ${secret}`;
}

async function sendEmail({ to, subject, text, from, replyTo, key }) {
  if (!key) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text }),
    });
    if (!r.ok) return { sent: false, reason: `HTTP ${r.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  const { resendKey, resendFrom, replyTo, cronSecret } = config();

  if (!authorised(cronSecret)(req)) {
    return res.status(401).json({ ok: false, message: 'Unauthorised' });
  }

  const today = new Date().toISOString().slice(0, 10);
  // Named BASE_URL, not PUBLIC_BASE_URL: Vercel refuses to store a PUBLIC_
  // secret, and this should not be inlined into client bundles anyway.
  const base =
    (process.env.BASE_URL || '').replace(/\/$/, '') ||
    `https://${req.headers?.host || 'optin.agentcy.co.za'}`;

  const due = await airtableRequest(
    `${BASE_ID}/${TABLE_ID}?pageSize=100&filterByFormula=${encodeURIComponent(DUE_FILTER(today))}`
  );
  if (!due.ok) {
    console.error(`[followup] could not read due leads: ${due.status} ${due.body}`);
    return res.status(200).json({ ok: false, error: 'airtable read failed', at: today });
  }

  const records = JSON.parse(due.body).records || [];
  const skipped = [];
  const batch = records.slice(0, MAX_PER_RUN);

  if (records.length > batch.length) {
    skipped.push(`${records.length - batch.length} left for the next run (cap ${MAX_PER_RUN})`);
  }

  const results = [];
  for (const record of batch) {
    const f = record.fields || {};
    const touch = (Number(f['Touch Count']) || 0) + 1;
    const copy = buildFollowUp(
      f,
      `${base}/api/unsubscribe?r=${encodeURIComponent(record.id)}&s=${signRecordId(record.id)}`
    );

    const sent = await sendEmail({
      to: f.Email, subject: copy.subject, text: copy.body,
      from: resendFrom, replyTo, key: resendKey,
    });

    if (!sent.sent) {
      // Leave the date alone. A failed send must stay due, otherwise the lead
      // is silently dropped and nobody ever finds out.
      results.push({ id: record.id, touch, sent: false, reason: sent.reason });
      console.error(`[followup] touch ${touch} to ${f.Email} failed: ${sent.reason}`);
      continue;
    }

    const done = touch >= MAX_TOUCHES;
    const updated = await airtableRequest(`${BASE_ID}/${TABLE_ID}/${record.id}`, {
      method: 'PATCH',
      // An object, not a pre-stringified one: the shared client serialises it.
      body: {
        fields: {
          'Touch Count': touch,
          'Last Touch Date': today,
          'Next Follow-Up Date': nextFollowUpDate(touch),
          // Past the last touch, park it so no later run picks it up again.
          Status: done ? 'Paused' : 'Contacted',
          'Next Action': done
            ? 'Sequence complete - awaiting their reply'
            : `Follow-up touch ${touch + 1} scheduled`,
        },
        typecast: true,
      },
    });

    results.push({ id: record.id, touch, sent: true, recorded: updated.ok });
    if (!updated.ok) {
      console.error(
        `[followup] emailed ${f.Email} but could not update the record: ${updated.status}`
      );
    }
  }

  const sentCount = results.filter((r) => r.sent).length;
  const failed = results.filter((r) => !r.sent).length;
  console.log(
    `[followup] ${today}: due=${records.length} sent=${sentCount} failed=${failed}` +
      (skipped.length ? ` (${skipped.join('; ')})` : '')
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: failed === 0, due: records.length, sent: sentCount, failed, results, skipped, at: today });
};
