const BASE_ID = process.env.AIRTABLE_BASE_ID || 'app0CK3JUNYEGcCMV';
const TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblnhzmqneNswTvGd';
const TOKEN = process.env.AIRTABLE_API_KEY;

const RESEND_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Agentcy <onboarding@resend.dev>';
// Replies must reach a monitored inbox. The sending subdomain is not one.
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || 'hello@agentcy.co.za';
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
// linkedin.com/in/someone, or a bare handle the visitor typed.
const LINKEDIN_RE = /^(https?:\/\/)?(www\.)?linkedin\.com\/(in|pub)\/[A-Za-z0-9_-]+\/?$/i;
const HANDLE_RE = /^[A-Za-z0-9._-]{3,}$/;

const SCHEMA_TTL_MS = Number(process.env.AIRTABLE_SCHEMA_TTL_MS || 10 * 60 * 1000);
const RESEND_TIMEOUT_MS = Number(process.env.RESEND_TIMEOUT_MS || 5000);
// A resubmission inside this window is treated as the same person, not a
// new lead. The rate limiter allows 5 per 10 min, so without this one
// person could create 5 rows and skew every pipeline KPI.
const DEDUPE_WINDOW_DAYS = Number(process.env.DEDUPE_WINDOW_DAYS || 30);

let cachedFields = null;
let cachedAt = 0;

/**
 * Classify what the visitor actually gave us. The forms use one `contact`
 * field for email, phone or LinkedIn depending on the toggle, and the long
 * forms use a dedicated `email` field.
 */
function classifyContact(value) {
  const v = trimmed(value, 200);
  if (!v) return { kind: 'missing' };
  if (EMAIL_RE.test(v)) return { kind: 'email', value: v };
  if (PHONE_RE.test(v)) return { kind: 'phone', value: v };
  if (LINKEDIN_RE.test(v)) return { kind: 'linkedin', value: v };
  if (HANDLE_RE.test(v)) return { kind: 'linkedin', value: v, assumed: true };
  return { kind: 'invalid' };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function trimmed(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

const AIRTABLE_ATTEMPTS = Number(process.env.AIRTABLE_RETRY_ATTEMPTS || 3);
const AIRTABLE_BACKOFF_MS = Number(process.env.AIRTABLE_RETRY_BACKOFF_MS || 250);
const AIRTABLE_TIMEOUT_MS = Number(process.env.AIRTABLE_TIMEOUT_MS || 4000);

/**
 * Airtable allows 5 requests/second per token and answers an overrun with
 * 403 or 429 - the *same* status it uses for a genuine permissions failure.
 * That ambiguity is why this retries 403 as well as 429: a throttled request
 * recovers, and a real auth failure simply fails again and falls through to
 * the identical error it would have produced without this wrapper.
 *
 * Without it, one burst of simultaneous submissions hits the limit, Airtable
 * 403s the write, and the visitor gets "could not save your opt-in" - a lead
 * lost to infrastructure, not to anything they did.
 *
 * 422 and 401/404 are never retried: they mean the payload or the
 * configuration is wrong, and only a human can fix either.
 */
async function airtableFetch(url, init = {}) {
  let status = 0;
  let body = '';

  for (let attempt = 1; attempt <= AIRTABLE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // Jitter, so a burst of simultaneous submissions does not re-collide
      // in lockstep on the next attempt.
      const backoff =
        AIRTABLE_BACKOFF_MS * 2 ** (attempt - 2) * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AIRTABLE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // Timeout or connection reset. Worth another attempt.
      status = 0;
      body = err.message;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return { ok: true, status: res.status, body: await res.text().catch(() => '') };
    }

    status = res.status;
    body = await res.text().catch(() => '');

    if (res.status === 422 || res.status === 401 || res.status === 404) {
      return { ok: false, status, body };
    }

    if (attempt < AIRTABLE_ATTEMPTS) {
      console.warn(
        `[optin] Airtable ${res.status}, retrying (attempt ${attempt}/${AIRTABLE_ATTEMPTS})`
      );
    }
  }

  return { ok: false, status, body };
}

/**
 * The Airtable table is edited by hand, so its columns drift from this file.
 * Read the live schema and only submit columns that actually exist, rather
 * than 422-ing every lead over a renamed field. Cached with a TTL so a
 * rename is picked up on a warm instance instead of only after a recycle.
 */
async function allowedFields() {
  if (cachedFields && Date.now() - cachedAt < SCHEMA_TTL_MS) return cachedFields;

  const { ok, status, body } = await airtableFetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  if (!ok) throw new Error(`Airtable schema fetch failed: ${status} ${body}`);

  const { tables } = JSON.parse(body);
  const table = tables.find((t) => t.id === TABLE_ID);
  if (!table) throw new Error(`Airtable table ${TABLE_ID} not found in base ${BASE_ID}`);

  cachedFields = new Set(table.fields.map((f) => f.name));
  cachedAt = Date.now();
  return cachedFields;
}

/**
 * True when this contact already opted in inside the dedupe window. Airtable
 * has no unique-constraint equivalent, so this is a filtered read.
 *
 * The cutoff is computed here rather than with a relative Airtable date
 * function: there is no LAST_N_DAYS, and a bad formula returns 422 which -
 * because this check must never block a lead - would be swallowed into a
 * silent "not a duplicate". That bug shipped once, so the formula lives here
 * in one place and is covered by a test asserting its shape.
 */
async function findRecentDuplicate(contact) {
  if (!contact?.value || contact.kind === 'invalid') return null;

  const column = { email: 'Email', phone: 'Phone', linkedin: 'LinkedIn' }[contact.kind];
  if (!column) return null;

  const cutoff = new Date(Date.now() - DEDUPE_WINDOW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  const formula =
    `AND({${column}} = "${contact.value.replace(/"/g, '\\"')}", ` +
    `IS_AFTER({Opt-In Date}, "${cutoff}"))`;
  const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;

  const { ok, status, body } = await airtableFetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!ok) {
    // Never block a real lead because the duplicate check is unavailable,
    // but make it loud: a silent failure here means duplicate rows.
    console.error(
      `[optin] DUPLICATE CHECK FAILED (${status}) after ${AIRTABLE_ATTEMPTS} attempts - duplicates are not being prevented. ${body}`
    );
    return null;
  }
  const { records } = JSON.parse(body);
  return records.length ? records[0] : null;
}

function buildFields(body, allowed, contact) {
  const fields = {
    Name: trimmed(body.name, 120),
    Business: trimmed(body.business, 160),
    Segment: trimmed(body.segment || body.segment_choice, 80),
    Area: trimmed(body.area, 120),
    'Preferred Channel': trimmed(body.preferred_channel, 40),
    'Pain Point': trimmed(body.pain_point, 2000),
    'Current Tools': trimmed(body.current_tools, 2000),
    // Routed by classification, not by "contains @" - otherwise a LinkedIn
    // URL lands in the Phone column.
    Email: contact.kind === 'email' ? contact.value : '',
    Phone: contact.kind === 'phone' ? contact.value : '',
    LinkedIn: contact.kind === 'linkedin' ? contact.value : '',
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
 *
 * Bounded by an AbortController because this runs inside the request and
 * Vercel kills the function at ~10s on Hobby - an unbounded Resend hang
 * would leave the visitor on a spinner instead of a download link.
 */
async function sendLeadMagnet({ to, name, magnet, downloadUrl }) {
  if (!RESEND_KEY || !to) return { sent: false, reason: !RESEND_KEY ? 'no-key' : 'no-email' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        reply_to: RESEND_REPLY_TO,
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
  } catch (err) {
    console.error(`[optin] Resend call failed: ${err.name === 'AbortError' ? `timed out after ${RESEND_TIMEOUT_MS}ms` : err.message}`);
    return { sent: false, reason: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }

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

/**
 * One structured line per outcome so conversions can be counted from Vercel
 * Logs without adding an analytics dependency. Deliberately carries no name,
 * email, phone or IP - those stay in Airtable where they belong under POPIA.
 */
function logSubmission({ event, segment, channel, contactKind, emailed }) {
  console.log(JSON.stringify({
    event: 'optin',
    outcome: event,
    segment: segment || null,
    channel: channel || null,
    contact_kind: contactKind || null,
    emailed: emailed === undefined ? null : emailed,
  }));
}

/**
 * Per-IP submission throttle, evaluated before the Airtable write so junk
 * traffic never reaches the tracker.
 *
 * Caveat worth knowing: Vercel does not guarantee a warm instance, so this
 * Map is per-instance. It reliably absorbs bursts and casual abuse, but a
 * determined attacker spread across cold starts can exceed it. For a hard
 * guarantee, set REDIS_URL + REDIS_TOKEN and the same check runs against
 * Upstash instead - see `checkRateLimit` below.
 */
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT_MAX || 5);
const MAX_TRACKED_IPS = Number(process.env.RATE_LIMIT_MAX_IPS || 10000);
const SWEEP_EVERY = 256;
const hits = new Map();
let sinceSweep = 0;

/**
 * Identify the caller well enough to rate limit them.
 *
 * `x-forwarded-for` is client-influenced: a caller may send its own value and
 * the proxy appends the real address, so the FIRST entry is whatever the caller
 * claimed. Trusting it - as this used to - means anyone bypasses the limiter by
 * sending a forged header, one fresh IP per submission. Prefer the header Vercel
 * sets itself, then take the LAST forwarded entry, which the proxy controls.
 */
function clientIp(req) {
  const vercel = req.headers['x-vercel-forwarded-for'];
  if (typeof vercel === 'string' && vercel.trim()) return vercel.split(',')[0].trim();

  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) {
    const chain = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }

  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Drop expired windows, but only sweep a slice of the map per call. Sweeping
 * everything every time makes each request cost O(distinct IPs seen), which is
 * a denial-of-service lever: an attacker who rotates source addresses makes
 * every legitimate request slower, forever.
 */
function sweep(now) {
  for (const [key, stamps] of hits) {
    const live = stamps.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(key, live);
    else hits.delete(key);
  }

  // Still over cap after dropping expired entries: a flood is in progress.
  // Forget the oldest half rather than growing without bound. Evicting is
  // safe here - it can only let a flooder through, never lock out a real
  // visitor whose entry is still live and recent.
  if (hits.size > MAX_TRACKED_IPS) {
    const excess = hits.size - MAX_TRACKED_IPS;
    for (const key of [...hits.keys()].slice(0, excess)) hits.delete(key);
    console.warn(`[optin] rate limiter over cap, evicted ${excess} entries`);
  }
}

function localRateLimit(ip) {
  const now = Date.now();

  if (++sinceSweep >= SWEEP_EVERY || hits.size > MAX_TRACKED_IPS) {
    sweep(now);
    sinceSweep = 0;
  }

  const seen = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (seen.length >= MAX_PER_WINDOW) {
    return { limited: true, retryAfter: Math.ceil((WINDOW_MS - (now - seen[0])) / 1000) };
  }
  seen.push(now);
  hits.set(ip, seen);
  return { limited: false };
}

async function checkRateLimit(ip) {
  const url = process.env.REDIS_URL;
  const token = process.env.REDIS_TOKEN;
  if (!url || !token) return localRateLimit(ip);

  try {
    // Fixed-window counter, so a burst cannot slip through by straddling a boundary.
    const bucket = Math.floor(Date.now() / WINDOW_MS);
    const key = `rl:${bucket}:${ip}`;
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, Math.ceil(WINDOW_MS / 1000) + 60]]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Upstash returns a JSON array of results, one per command.
    const results = await res.json();
    const count = Number(results?.[0]?.result || 0);
    if (count > MAX_PER_WINDOW) {
      const retryAfter = Math.ceil((WINDOW_MS - (Date.now() % WINDOW_MS)) / 1000);
      return { limited: true, retryAfter };
    }
    return { limited: false };
  } catch (err) {
    // Never let the limiter itself take the form down.
    console.error('[optin] Redis rate limit failed, falling back to in-memory:', err.message);
    return localRateLimit(ip);
  }
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
  // The frictionless forms post one `contact` field that may hold an email,
  // a phone number or a LinkedIn URL depending on the toggle; the long forms
  // use a dedicated `email` field that must be an email.
  const fromContactField = Boolean(trimmed(body.contact, 200));
  const contact = classifyContact(fromContactField ? body.contact : body.email);

  if (!name) return res.status(400).json({ success: false, message: 'Name is required' });
  if (contact.kind === 'missing') {
    return res.status(400).json({ success: false, message: 'Contact is required' });
  }

  if (contact.kind === 'invalid') {
    return res.status(400).json({
      success: false,
      message: fromContactField
        ? 'Enter a valid email, phone number or LinkedIn profile'
        : 'That email address looks invalid',
    });
  }

  if (!fromContactField && contact.kind !== 'email') {
    return res.status(400).json({ success: false, message: 'That email address looks invalid' });
  }

  // POPIA: an unconsented submission must never reach the CRM.
  if (trimmed(body.popia_consent) !== 'Yes') {
    return res.status(400).json({ success: false, message: 'Consent is required' });
  }

  // Throttled after validation so a fat-fingered human who mistypes their
  // email does not burn their own quota, but before the Airtable write so
  // junk never lands in the tracker.
  const limit = await checkRateLimit(clientIp(req));
  if (limit.limited) {
    const mins = Math.max(1, Math.ceil(limit.retryAfter / 60));
    console.warn(`[optin] rate limited ${clientIp(req)}`);
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({
      success: false,
      message: `Too many submissions from this connection. Try again in ${mins} minute${mins > 1 ? 's' : ''}, or email hello@agentcy.co.za.`,
    });
  }

  try {
    if (!TOKEN) {
      console.error('[optin] AIRTABLE_API_KEY is not set.');
      return res.status(500).json({ success: false, message: "Something went wrong on our side. Please try again or email hello@agentcy.co.za." });
    }

    const allowed = await allowedFields();
    const segment = trimmed(body.segment, 80);
    const channel = trimmed(body.preferred_channel, 40) ||
      ({ email: 'Email', phone: 'WhatsApp', linkedin: 'LinkedIn' }[contact.kind] || 'Email');

    // Same person, same window: still show them the blueprint, but do not
    // create a second pipeline row. Their first record stays the source of
    // truth so call/qualified counts are not inflated.
    const existing = await findRecentDuplicate(contact);
    if (existing) {
      const magnet = magnetFor(segment);
      const base = `https://${req.headers.host}`;
      const downloadUrl = magnet ? `${base}/${magnet.file}` : null;
      logSubmission({ event: 'duplicate', segment, channel, contactKind: contact.kind });
      return res.status(200).json({
        success: true,
        message: 'Opt-in recorded.',
        duplicate: true,
        channel,
        magnetTitle: magnet ? magnet.title : null,
        downloadUrl,
        waLink: magnet ? whatsappLink(name, magnet, downloadUrl) : null,
        emailed: false,
      });
    }

    const fields = buildFields(body, allowed, contact);

    const airtable = await airtableFetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`, {
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
      console.error(
        `[optin] Airtable rejected the record (${airtable.status}) after ${AIRTABLE_ATTEMPTS} attempts: ${airtable.body}`
      );
      return res.status(502).json({ success: false, message: 'Could not save your opt-in just now. Please try again in a moment.' });
    }

    // The lead is captured at this point, so delivery is best-effort and
    // never turns a successful signup into an error.
    const magnet = magnetFor(segment);
    const base = `https://${req.headers.host}`;
    const downloadUrl = magnet ? `${base}/${magnet.file}` : null;
    // Only an actual email address can receive the email; a phone or
    // LinkedIn contact still gets the download link and the WhatsApp button.
    const emailTo = contact.kind === 'email' ? contact.value : null;

    let emailed = { sent: false, reason: 'no-magnet' };
    if (magnet) {
      emailed = await sendLeadMagnet({ to: emailTo, name, magnet, downloadUrl });
    }

    const waLink = magnet ? whatsappLink(name, magnet, downloadUrl) : null;
    logSubmission({ event: 'new', segment, channel, contactKind: contact.kind, emailed: emailed.sent });

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
    return res.status(500).json({ success: false, message: 'Something went wrong on our side. Please try again or email hello@agentcy.co.za.' });
  }
}
