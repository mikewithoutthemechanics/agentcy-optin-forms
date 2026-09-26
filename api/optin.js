const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcCMV';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd';
const TOKEN = process.env.AIRTABLE_API_KEY;

const RESEND_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Agentcy <onboarding@resend.dev>';
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '+27837915429').replace(/\D/g, '');

const STATUS_NEW = 'New Opt-In';
const CONSENT_BASIS = 'Form Opt-In';

// Which PDF each segment asked for. Anything unmapped still gets a record
// in Airtable, just no download link.
const MAGNETS = {
  'KZN Trades/Local SMBs': { file: 'lead-magnet-trades.pdf', title: 'Stop Losing Quotes' },
  'National Online SMBs': { file: 'lead-magnet-online-smb.pdf', title: 'Find 3 Automations' },
  'Professional Services': { file: 'lead-magnet-prof-services.pdf', title: 'AI Readiness Scorecard' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d\s\-+()]{10,}$/;

let cachedFields = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function trimmed(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/**
 * The Airtable table is edited by hand, so its columns drift from this file.
 * Read the live schema once per cold start and only submit columns that
 * actually exist, rather than 422-ing every lead over a renamed field.
 */
async function allowedFields() {
  if (cachedFields) return cachedFields;

  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Airtable schema fetch failed: ${res.status}`);

  const { tables } = await res.json();
  const table = tables.find((t) => t.id === TABLE_ID);
  if (!table) throw new Error(`Airtable table ${TABLE_ID} not found in base ${BASE_ID}`);

  cachedFields = new Set(table.fields.map((f) => f.name));
  return cachedFields;
}

function buildFields(body, allowed) {
  const contact = trimmed(body.contact || body.email, 200);
  const isEmail = contact.includes('@');

  const fields = {
    Name: trimmed(body.name, 120),
    Business: trimmed(body.business, 160),
    Segment: trimmed(body.segment || body.segment_choice, 80),
    Area: trimmed(body.area, 120),
    'Preferred Channel': trimmed(body.preferred_channel, 40),
    'Pain Point': trimmed(body.pain_point, 2000),
    'Current Tools': trimmed(body.current_tools, 2000),
    Email: isEmail ? contact : '',
    Phone: isEmail ? '' : contact,
    'POPIA Consent': trimmed(body.popia_consent, 10) || 'Yes',
    'Consent Basis': CONSENT_BASIS,
    Source: trimmed(body.source, 120) || 'website',
    'Opt-In Date': trimmed(body.optin_date, 10) || today(),
    Status: STATUS_NEW,
    'Booked Call': 'No',
    Attended: 'No',
    Qualified: 'No',
    'Proposal Sent': 'No',
    'Next Action': 'Send lead magnet + schedule follow-up',
    'Next Follow-Up Date': today(),
    'Touch Count': 0,
    'Last Touch Date': today(),
    'Lead Magnet': trimmed(body.lead_magnet, 120),
  };

  const dropped = [];
  const payload = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) {
      dropped.push(key);
      continue;
    }
    if (value === '' || value === null) continue;
    payload[key] = value;
  }

  if (dropped.length) {
    console.warn(
      `[optin] Airtable table is missing column(s): ${dropped.join(', ')}. ` +
        'Add them in Airtable or update the map in api/optin.js.'
    );
  }

  return payload;
}

function magnetFor(segment) {
  return MAGNETS[segment] || null;
}

/**
 * Resend call. Deliberately never throws: the lead is already safe in
 * Airtable by this point, and failing the request would leave the visitor
 * thinking they had not signed up. The success panel always carries a
 * working download link, so the promise holds even when email does not.
 */
async function sendLeadMagnet({ to, name, magnet, downloadUrl }) {
  if (!RESEND_KEY || !to) return { sent: false, reason: !RESEND_KEY ? 'no-key' : 'no-email' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: `Your free blueprint: ${magnet.title}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px">
          <h2 style="margin:0 0 16px">${magnet.title}</h2>
          <p>Hi ${escapeHtml(name) || 'there'},</p>
          <p>Thanks for requesting the Agentcy blueprint. Here it is:</p>
          <p><a href="${downloadUrl}"
                style="display:inline-block;background:#0891b2;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">
             Download the PDF
          </a></p>
          <p style="font-size:13px;color:#71717a">
            Prefer it on your phone? ${downloadUrl}
          </p>
          <hr style="border:0;border-top:1px solid #e4e4e7;margin:24px 0">
          <p style="font-size:12px;color:#71717a">
            Agentcy - Custom Automation for South African Businesses<br>
            <a href="https://agentcy.co.za">agentcy.co.za</a> &middot;
            <a href="mailto:hello@agentcy.co.za">hello@agentcy.co.za</a><br>
            You received this because you asked us to. Reply STOP to opt out.
          </p>
        </div>`,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error(`[optin] Resend rejected the email (${res.status}): ${detail}`);
    return { sent: false, reason: `resend-${res.status}` };
  }
  return { sent: true };
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function whatsappLink(name, magnet, downloadUrl) {
  const text =
    `Hi ${name || 'there'} - here's the ${magnet.title} you asked for: ${downloadUrl}`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    return res.status(400).json({ success: false, message: 'Malformed request body' });
  }

  // Honeypot: bots fill every field they find, humans never see this one.
  if (trimmed(body['bot-field'])) {
    return res.status(200).json({ success: true, message: 'Opt-in recorded. Lead magnet incoming.' });
  }

  const name = trimmed(body.name, 120);
  // The frictionless forms post one `contact` field that may hold either a
  // phone number or an email, so which field it came from decides how
  // strictly it can be validated.
  const fromContactField = Boolean(trimmed(body.contact, 200));
  const contact = trimmed(fromContactField ? body.contact : body.email, 200);

  if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
  if (!contact) return res.status(400).json({ success: false, message: 'Contact is required' });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^[\d\s\-+()]{10,}$/;

  if (fromContactField) {
    if (!EMAIL_RE.test(contact) && !PHONE_RE.test(contact)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email or phone number' });
    }
  } else if (!EMAIL_RE.test(contact)) {
    return res.status(400).json({ success: false, message: 'That email address looks invalid' });
  }

  // POPIA: an unconsented submission must never reach the CRM.
  if (trimmed(body.popia_consent) !== 'Yes') {
    return res.status(400).json({ success: false, message: 'Consent is required' });
  }

  try {
    if (!TOKEN) {
      console.error('[optin] AIRTABLE_API_KEY is not set.');
      return res.status(500).json({ success: false, message: 'Server not configured' });
    }

    const allowed = await allowedFields();
    const fields = buildFields(body, allowed);

    const airtable = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      // typecast lets Airtable create single-select options on first use
      // instead of rejecting leads over a label mismatch.
      body: JSON.stringify({ fields, typecast: true }),
    });

    if (!airtable.ok) {
      const detail = await airtable.text();
      console.error(`[optin] Airtable rejected the record (${airtable.status}): ${detail}`);
      return res.status(502).json({ success: false, message: 'Could not save your opt-in' });
    }

    // The lead is captured at this point, so delivery is best-effort and
    // never turns a successful signup into an error.
    const magnet = magnetFor(trimmed(body.segment, 80));
    const base = `https://${req.headers.host}`;
    const downloadUrl = magnet ? `${base}/${magnet.file}` : null;
    const emailTo = EMAIL_RE.test(contact) ? contact : fields.Email;

    let emailed = { sent: false, reason: 'no-magnet' };
    if (magnet) {
      emailed = await sendLeadMagnet({ to: emailTo, name, magnet, downloadUrl });
    }

    const channel = trimmed(body.preferred_channel, 40) || (EMAIL_RE.test(contact) ? 'Email' : 'WhatsApp');
    const waLink = magnet ? whatsappLink(name, magnet, downloadUrl) : null;

    return res.status(200).json({
      success: true,
      message: 'Opt-in recorded.',
      channel,
      magnetTitle: magnet ? magnet.title : null,
      downloadUrl,
      waLink,
      emailed: emailed.sent,
    });
  } catch (err) {
    console.error('[optin] Unhandled error:', err);
    return res.status(500).json({ success: false, message: 'Could not save your opt-in' });
  }
}
