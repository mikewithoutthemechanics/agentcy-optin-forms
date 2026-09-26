/**
 * One-click unsubscribe, linked from every follow-up email.
 *
 * The blueprint this replaced told people to "reply STOP if you want zero
 * further contact". That is not an opt-out, it is a hope - and under POPIA a
 * marketing email needs a real way out that does not depend on the recipient
 * getting around to replying.
 *
 * The record id is signed, so the link cannot be used to opt somebody else out
 * by guessing ids or walking the table. A bad or missing signature is refused
 * rather than guessed at.
 *
 * Unsubscribing sets Status to a value the follow-up filter excludes, so the
 * sequence stops on the next run - there is no second list to keep in sync.
 */

const { verifySignature } = require('./_followup.js');
const { airtableRequest } = require('./_airtable.js');

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcMTV';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:34rem;background:#1e293b;border-radius:14px;padding:2.5rem;border:1px solid #334155}
  h1{font-size:1.4rem;margin:0 0 .75rem}
  p{margin:0 0 1rem;color:#cbd5e1}
  a{color:#7dd3fc}
</style></head>
<body><div class="card">`;

const page = (title, body) =>
  `${PAGE}<h1>${title}</h1>${body}</div></body></html>`;

module.exports = async function handler(req, res) {
  const recordId = String(req.query?.r || '');
  const signature = String(req.query?.s || '');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!recordId || !signature) {
    return res.status(400).send(
      page(
        'Link incomplete',
        '<p>This unsubscribe link is missing part of its code. Use the link in the email, or email <a href="mailto:hello@agentcy.co.za">hello@agentcy.co.za</a> and we will remove you.</p>'
      )
    );
  }

  if (!verifySignature(recordId, signature)) {
    // Deliberately does not distinguish "bad signature" from "no such record",
    // so this endpoint cannot be used to probe which ids exist.
    return res.status(403).send(
      page(
        'Link not recognised',
        '<p>This unsubscribe link is not valid. If you want to stop hearing from us, email <a href="mailto:hello@agentcy.co.za">hello@agentcy.co.za</a> with any message and we will remove you straight away.</p>'
      )
    );
  }

  const result = await airtableRequest(`${BASE_ID}/${TABLE_ID}/${recordId}`, {
    method: 'PATCH',
    // typecast creates the single-select option on first use, so this works
    // without a schema change.
    body: {
      fields: {
        Status: 'Unsubscribed',
        'Next Action': 'Unsubscribed - do not contact',
        'Next Follow-Up Date': '',
      },
      typecast: true,
    },
  });

  if (!result.ok) {
    console.error(`[unsubscribe] ${recordId} failed: ${result.status} ${result.body}`);
    return res.status(500).send(
      page(
        'That did not work',
        '<p>Something went wrong on our side. Please email <a href="mailto:hello@agentcy.co.za">hello@agentcy.co.za</a> and we will stop the follow-ups manually.</p>'
      )
    );
  }

  console.log(`[unsubscribe] ${recordId} opted out`);
  return res.status(200).send(
    page(
      'You are unsubscribed',
      `<p>You will not get any more follow-up emails from Agentcy. Your blueprint is still yours to keep - no need to do anything else.</p>
       <p>If this was a mistake, email <a href="mailto:hello@agentcy.co.za">hello@agentcy.co.za</a>.</p>`
    )
  );
};
