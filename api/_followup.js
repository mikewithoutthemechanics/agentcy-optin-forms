/**
 * The follow-up sequence: what to send a lead on their 2nd, 5th and 8th day,
 * and the bookkeeping that decides who is due.
 *
 * Ported from the n8n blueprint, with two deliberate omissions:
 *
 *  - WhatsApp. The blueprint sent it through Twilio, which is not connected.
 *    A phone-only lead is left alone rather than silently skipped later.
 *  - LinkedIn DMs. Automating those breaks LinkedIn's terms and gets the
 *    account restricted. A LinkedIn lead is left for a human to contact.
 *
 * So this is email-only, and says so out loud rather than pretending to cover
 * every channel the forms accept.
 *
 * `_` prefix keeps Vercel from routing this file on its own.
 */

const crypto = require('crypto');

const CALENDLY = process.env.CALENDLY_URL || 'https://calendly.com/agentcy/30min-strategy';
const MAX_TOUCHES = 3;
// Blueprint cadence: touch 1 on day 2, then every third day, then a long tail.
const GAPS_DAYS = { 1: 3, 2: 3, 3: 30 };

const TRADES = 'KZN Trades/Local SMBs';
const ONLINE = 'National Online SMBs';
const PRO = 'Professional Services';

const BOOKING = 'Book a free 30-minute strategy call';

/**
 * Touch 1 asks a question, touch 2 makes the case, touch 3 closes the thread
 * and hands the blueprint over with no strings. Each segment gets its own
 * subject and body because a generic version of this is how a warm lead goes
 * cold.
 */
function buildFollowUp(fields, unsubscribeUrl) {
  const name = String(fields.Name || '').trim().split(/\s+/)[0] || 'there';
  // Business is capped at 160 characters on the way in, which is far too long
  // for a subject line. Trim it here or the whole thing reads as spam.
  const business = String(fields.Business || '').trim().slice(0, 60);
  const painPoint = String(fields['Pain Point'] || '').trim().slice(0, 200);
  const segment = fields.Segment;
  const touch = (Number(fields['Touch Count']) || 0) + 1;

  const closing = [
    '',
    '— Michael @ Agentcy',
    '',
    `Not these? Unsubscribe: ${unsubscribeUrl}`,
  ].join('\n');

  if (touch === 1) {
    if (segment === TRADES) {
      return {
        subject: business ? `Quick question about ${business}` : 'Quick question about your quotes',
        body:
`Hi ${name},

You mentioned "${painPoint || 'losing quotes'}" - that is exactly the problem the "Stop Losing Quotes" blueprint is built around.

One thing worth knowing: the WhatsApp auto-reply plus job logging setup takes about 15 minutes, and it starts catching after-hours leads the same night.

Want me to send over the 3-step setup checklist? Just reply YES.
${closing}`,
      };
    }
    if (segment === ONLINE) {
      return {
        subject: 'Your 3-automation roadmap - one question',
        body:
`Hi ${name},

Your "Find 3 Automations" roadmap should have landed by now. The highest-leverage pick for ${business || 'an online store'} is usually:

  unified orders -> inventory -> accounting sync

That alone tends to save 5-8 hours a week and stops the oversells.

Quick question: which hurts most right now - Takealot sync, Shopify inventory, or Xero reconciliation? Reply and I will prioritise that one in the Make blueprint.
${closing}`,
      };
    }
    return {
      subject: 'AI Readiness Scorecard - your top gap',
      body:
`Hi ${name},

Your scorecard flagged ${painPoint || 'a few manual handoffs'} as the biggest friction point.

For professional services the fastest win is almost always meeting-to-CRM automation (Fathom -> Make -> Clio or HubSpot). Roughly a 2-hour setup, and it captures close to 100% of enquiries instead of the ones somebody remembered to type in.

Want the exact Make scenario JSON? Reply YES.
${closing}`,
    };
  }

  if (touch === 2) {
    if (segment === TRADES) {
      return {
        subject: 'How Punctual Plumbers recovered R187K in lost quotes',
        body:
`Hi ${name},

Punctual Plumbers in Ballito implemented the quote follow-up sequence from the blueprint.

Month one: R187,000 in previously-lost quotes recovered. The "day 3, your quote expires Friday" message was the one that did it.

If you want that exact Make scenario imported into your own account, we can do it on a screen-share:

${CALENDLY}
${closing}`,
      };
    }
    if (segment === ONLINE) {
      return {
        subject: "Sarah's Homewares: 11 hrs/week back in 3 days",
        body:
`Hi ${name},

Sarah in Cape Town, running Shopify plus Takealot, plugged in the orders -> inventory -> Xero sync.

Day 1: 6.5 hours saved. Day 3: oversells down to zero. Month 1: roughly R340,000 more revenue from faster fulfilment and better reviews.

Same stack, and want the Make template imported for you?

${CALENDLY}
${closing}`,
      };
    }
    return {
      subject: 'Naidoo & Associates: 47 hrs/month recovered per partner',
      body:
`Hi ${name},

Naidoo & Associates, a commercial law practice in Durban, scored 31 out of 100 on the readiness scorecard. Ninety days later: 67.

Biggest win was a smart intake form (Tally -> DocuSign -> Clio -> Slack). Onboarding went from 21 days to 4.

Want the blueprint set up for your practice?

${CALENDLY}
${closing}`,
    };
  }

  return {
    subject: 'Closing this thread - but the blueprint is yours',
    body:
`Hi ${name},

I will stop following up after this one. The ${fields['Lead Magnet'] || 'blueprint'} is yours to keep either way, no strings attached.

If automation becomes a priority later, the 30-minute strategy call is free and I will only send useful stuff:

${CALENDLY}

And if you would rather I never email again, the unsubscribe link below does it instantly - no reply needed.
${closing}`,
  };
}

/** Days until the next touch, and the date it lands on. */
function nextFollowUpDate(touch) {
  const gap = GAPS_DAYS[touch] ?? 30;
  return new Date(Date.now() + gap * 86400000).toISOString().slice(0, 10);
}

/**
 * Leads that are due: under the touch cap, still in the opening status, and
 * past their scheduled date. Everything else is deliberately excluded rather
 * than filtered later, so an opted-out or already-worked lead is never even
 * loaded.
 */
const DUE_FILTER = (today) =>
  `AND({Touch Count} < ${MAX_TOUCHES}, {Status} = 'New Opt-In', ` +
  `OR({Next Follow-Up Date} = '', {Next Follow-Up Date} <= "${today}"), ` +
  `{Email} != '')`;

function secret() {
  return process.env.FOLLOWUP_SECRET || process.env.CRON_SECRET || '';
}

/**
 * Sign a record id so the unsubscribe link cannot be used to opt somebody else
 * out by guessing ids. Without this, anyone could walk the table.
 */
function signRecordId(recordId) {
  return crypto.createHmac('sha256', secret()).update(String(recordId)).digest('hex');
}

function verifySignature(recordId, signature) {
  const expected = Buffer.from(signRecordId(recordId), 'hex');
  let given;
  try {
    given = Buffer.from(String(signature || ''), 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = {
  MAX_TOUCHES,
  CALENDLY,
  buildFollowUp,
  nextFollowUpDate,
  DUE_FILTER,
  signRecordId,
  verifySignature,
};
