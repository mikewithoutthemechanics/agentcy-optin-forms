const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcCMV';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd';
const TOKEN = process.env.AIRTABLE_API_KEY;

const STATUS_NEW = 'New Opt-In';
const CONSENT_BASIS = 'Form Opt-In';

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

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE = /^[\d\s\-+()]{10,}$/;

  if (fromContactField) {
    if (!EMAIL.test(contact) && !PHONE.test(contact)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email or phone number' });
    }
  } else if (!EMAIL.test(contact)) {
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

    return res.status(200).json({ success: true, message: 'Opt-in recorded. Lead magnet incoming.' });
  } catch (err) {
    console.error('[optin] Unhandled error:', err);
    return res.status(500).json({ success: false, message: 'Could not save your opt-in' });
  }
}
