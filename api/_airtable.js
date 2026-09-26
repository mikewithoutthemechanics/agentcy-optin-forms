/**
 * The single Airtable client, shared by the opt-in endpoint, the follow-up job
 * and the unsubscribe handler.
 *
 * Extracted so the retry policy lives in one place. It mattered enough to be
 * worth its own file: Airtable allows 5 requests/second per token and answers
 * an overrun with 403 or 429 - the *same* status it uses for a real
 * permissions failure. One burst of simultaneous submissions used to trip that
 * and lose the lead outright, because the write was a single un-retried call.
 *
 * That ambiguity is why 403 is retried: a throttled request recovers, and a
 * genuine auth failure simply fails again and falls through to the same error
 * it would have produced anyway.
 *
 * `_` prefix keeps Vercel from routing this file on its own.
 */

const ATTEMPTS = Number(process.env.AIRTABLE_RETRY_ATTEMPTS || 3);
const BACKOFF_MS = Number(process.env.AIRTABLE_RETRY_BACKOFF_MS || 250);
const TIMEOUT_MS = Number(process.env.AIRTABLE_TIMEOUT_MS || 4000);

const BASE = 'https://api.airtable.com/v0';
const TOKEN = () => process.env.AIRTABLE_API_KEY;

/**
 * One Airtable call with retries. Resolves to { ok, status, body } where body
 * is the raw text, so callers can both JSON.parse it and log it verbatim.
 */
async function airtableRequest(path, { method = 'GET', body = null, attempts = ATTEMPTS } = {}) {
  let status = 0;
  let lastBody = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      // Jitter, so simultaneous submissions do not re-collide in lockstep.
      const backoff = BACKOFF_MS * 2 ** (attempt - 2) * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${BASE}/${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${TOKEN()}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Timeout or connection reset: worth another attempt.
      status = 0;
      lastBody = err.message;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return { ok: true, status: res.status, body: await res.text().catch(() => '') };
    }

    status = res.status;
    lastBody = await res.text().catch(() => '');

    // 422 is a bad payload, 401/404 a bad config. Only a human can fix either,
    // and retrying just burns the caller's time.
    if (status === 422 || status === 401 || status === 404) {
      return { ok: false, status, body: lastBody };
    }

    if (attempt < attempts) {
      console.warn(`[airtable] ${res.status}, retrying (attempt ${attempt}/${attempts})`);
    }
  }

  return { ok: false, status, body: lastBody };
}

module.exports = { airtableRequest, ATTEMPTS };
