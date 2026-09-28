# Agentcy 30-Day Outreach — Opt-In Forms & Tracker

Static opt-in forms for three segments, deployed on Vercel, writing leads to Airtable
and emailing the lead magnet through Resend.

**Live:** https://optin.agentcy.co.za

Canonical domain, wildcard TLS via Vercel. The `*.vercel.app` alias still resolves and
still works, but links in emails, the WhatsApp deep link and the PDF download are built
from the request host, so they follow whatever domain the visitor arrived on.

There is no backend to run. `api/optin.js` is a Vercel serverless function: it validates,
writes one Airtable row, and sends the PDF. Nothing else needs to be hosted or scheduled.

---

## How a submission flows

```
visitor fills form
   -> POST /api/optin
      -> validate (name, contact, POPIA consent)   400 on failure
      -> honeypot check                            silent 200, nothing written
      -> rate limit (5 / 10 min / IP)              429 + Retry-After
      -> duplicate check (same contact, 30 days)   200, no second row
      -> Airtable record                           502 on failure
      -> Resend email (5s timeout, best effort)    never fails the request
   -> success panel: download button + wa.me link
```

Delivery is best-effort by design. The Airtable write happens first, so an email failure
logs and still returns 200 — a real lead is never told they had not signed up. The
download button is always rendered, so the promise holds even with no mail provider.

If **Airtable** fails after every retry, the lead is emailed to `ALERT_EMAIL` instead and
the visitor still succeeds. Airtable down means the lead exists only in that request, and
returning 502 loses it outright — the visitor walks away and nobody knows they came.
Resend is an independent service, so that path works during an Airtable outage. If both
are down, an honest 502 is returned, because at that point the lead really is lost and
saying otherwise would be a lie.

## Pages

| File | Segment | In funnel |
|---|---|---|
| `index.html` | landing hub, links to the 3 below | yes |
| `trades-form-frictionless.html` | KZN Trades / Local SMBs | yes |
| `online-smb-form-frictionless.html` | National Online SMBs | yes |
| `prof-services-form-frictionless.html` | Professional Services | yes |
| `trades-form.html` | KZN Trades (long form) | no — direct URL only |
| `online-smb-form.html` | National Online SMBs (long form) | no — direct URL only |
| `prof-services-form.html` | Professional Services (long form) | no — direct URL only |

Both variants of each form are live and working. The long forms are not linked from the
landing page; they are kept for anyone who wants the higher-detail version. Delete them
if you would rather maintain one form per segment.

## Contact handling

The frictionless forms collect one `contact` field that changes type with the toggle
(email / phone / LinkedIn). The server classifies it rather than trusting the field:

| Input | Stored in | Notes |
|---|---|---|
| `thabo@x.co.za` | `Email` | only these receive the email |
| `+27837915429` | `Phone` | gets download link + WhatsApp button instead |
| `linkedin.com/in/priyan` | `LinkedIn` | prof-services form only |

`Email`, `Phone` and `LinkedIn` are Airtable columns. The function reads the live column
list before writing and silently drops any field the table does not have, so renaming a
column degrades one field instead of failing every lead. Watch the Vercel logs for
`Airtable table is missing column(s)`.

**After adding a column, redeploy or wait 10 minutes.** The schema is cached per instance
for `AIRTABLE_SCHEMA_TTL_MS`, so a warm function will keep using the field list it read
before the column existed.

## Environment variables

Set in Vercel → Settings → Environment Variables. All three environments.

| Variable | Required | Purpose |
|---|---|---|
| `AIRTABLE_API_KEY` | yes | PAT with `data.records:write` + `schema.bases:read` on `app0CK3JUNYEGcCMV` |
| `AIRTABLE_BASE_ID` | no | defaults to the base above; set it explicitly if you ever fork the tracker |
| `AIRTABLE_TABLE_ID` | no | defaults to `tblnhzmqneNswTvGd` ("Agentcy Outreach Tracker") |
| `RESEND_API_KEY` | for email | send-only key scoped to the sending domain |
| `RESEND_FROM` | for email | e.g. `Agentcy <optin@concierge.agentcy.co.za>` |
| `RESEND_REPLY_TO` | recommended | a **monitored** inbox; defaults to `hello@agentcy.co.za` |
| `WHATSAPP_NUMBER` | no | defaults to `+27837915429` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | no | defaults `5` / `600000` |
| `DEDUPE_WINDOW_DAYS` | no | defaults `30` |
| `RESEND_TIMEOUT_MS` | no | defaults `5000` |
| `AIRTABLE_SCHEMA_TTL_MS` | no | defaults `600000` |
| `REDIS_URL` + `REDIS_TOKEN` | no | see Rate limiting |
| `CRON_SECRET` | for crons | Vercel sends it as `Authorization: Bearer …`; both jobs refuse without it |
| `ALERT_EMAIL` | no | where health alerts go; defaults to `RESEND_REPLY_TO` |
| `FOLLOWUP_SECRET` | for follow-up | signs unsubscribe links; falls back to `CRON_SECRET` |
| `BASE_URL` | recommended | canonical origin used in unsubscribe links |
| `CALENDLY_URL` | no | booking link in touches 2 and 3 |
| `FOLLOWUP_MAX_PER_RUN` | no | defaults `25`, a runaway-batch guard |
| `AIRTABLE_RETRY_ATTEMPTS` | no | defaults `3`; see Airtable tracker |

## Deploying

Push to `master`; the GitHub integration deploys automatically.

```bash
node --test tests/*.test.js    # 74 tests, no network needed
```

## Health check

`GET /api/health` returns 200 or 503, and answers the only question that matters: **can
the next submission be saved?** It writes a throwaway record and deletes it again, rather
than reading. A read is the obvious probe and it is the wrong one — Airtable throttles
reads and writes separately, and in production reads started returning 403 while every
write carried on working. A read-based check called the form DOWN on a day it was saving
every lead perfectly.

If the write probe fails, a plain read corroborates before anyone is paged: if reads work,
the failure was transient, and the opt-in endpoint's own retries plus the rescue-by-email
path will have coped. Two calls a day.

Point an uptime monitor or the cron at it.

## Rate limiting

Per-IP sliding window, evaluated before the Airtable write so junk never reaches the
tracker, and after validation so a human who mistypes their email is not locked out.

The client address comes from `x-vercel-forwarded-for`, falling back to the **last** entry
of `x-forwarded-for`. This matters: `x-forwarded-for` is client-controlled, and a proxy
appends the real address to whatever the caller sent, so the first entry is the caller's
own claim. Trusting it meant anyone could bypass the limiter with a forged header and a
fresh IP per submission.

The counter is an in-memory `Map` with a hard cap, swept a slice at a time so a request
does not cost O(distinct IPs seen). Vercel does not guarantee a warm instance, so this
absorbs bursts and casual abuse but is **not** a hard guarantee against a determined
attacker. Setting `REDIS_URL` and `REDIS_TOKEN` (Upstash free tier is ample) switches the
same check to a shared counter with no code change.

## Lead magnets

`lead-magnet-*.pdf` are build artifacts generated from the `.md` sources:

```bash
python -m pip install markdown playwright && playwright install chromium
python scripts/build_lead_magnets.py            # all three
python scripts/build_lead_magnets.py trades     # just one
```

Edit the markdown, re-run the script, commit both. The PDFs are served from the site root
and are therefore ungated — anyone who guesses the URL can download them. The opt-in form
buys contact details, not content protection. That is a deliberate choice; gate them behind
the form only if you want the content itself to be the thing you are selling.

## Airtable tracker

Base `app0CK3JUNYEGcCMV`, table `tblnhzmqneNswTvGd` ("Agentcy Outreach Tracker").

The function reads the live column list before writing and silently drops any field the
table does not have, so renaming a column degrades one field instead of failing every
lead. Watch the Vercel logs for `Airtable table is missing column(s)`.

Pipeline columns (`Status`, `Touch Count`, `Next Follow-Up Date`, …) are set on create and
are read by the follow-up job below.

**`Status` is the sequence position's _opposite_.** It is the opt-out switch, and
`Touch Count` is the position. They were briefly conflated, which quietly reduced the
sequence to a single email: the job set `Status = "Contacted"` after touch 1 while the
due filter selected `{Status} = "New Opt-In"`, so no lead ever matched again. Nothing
caught it because each half was tested separately and both passed. The job now leaves
`Status` alone until the end of the sequence.

**Add the new columns before redeploying.** `Consent Timestamp` and
`Consent Text Version` are written on every opt-in; until they exist the fields are
dropped with a warning and no evidence is recorded.

Views worth creating:

1. **Pipeline Kanban** — group by `Status`
2. **Today's Follow-Ups** — `Next Follow-Up Date` is today AND `Touch Count` < 3
3. **By Segment** — group by `Segment`
4. **Consent Audit** — `POPIA Consent` ≠ "Yes" (should be zero; both the API and the
   follow-up filter now refuse these)
5. **Unsubscribed** — `Status` = "Unsubscribed"

## Scheduled jobs

Two Vercel crons, both in `vercel.json` and both requiring `CRON_SECRET`:

| Job | Schedule | What it does |
| --- | --- | --- |
| `/api/cron/health-watch` | 06:00 UTC daily | Silent while healthy. Emails `ALERT_EMAIL` when a check fails. |
| `/api/cron/followup` | 07:00 UTC daily | Sends the follow-up sequence to whoever is due. |

`health-watch` is deliberately stateless. The obvious design — remember "I am already
alerting" in Airtable — would make the monitor depend on the service it exists to watch,
so an Airtable outage would silence the alarm. It is a dead-man's switch instead, which
means **there is no "recovered" email**: silence after an alert is the signal. The check
itself retries, because Airtable throttling during a burst would otherwise report a
perfectly working form as down — and a false alarm is worse than none, because it teaches
you to ignore the alert you actually need.

## Follow-up sequence

Three touches, on days 2, 5 and 8, then the lead is parked as `Paused`. Copy is
segment-specific (`api/_followup.js`). A lead whose send fails keeps its scheduled date, so
it is retried tomorrow instead of silently disappearing.

**Email only.** Phone and LinkedIn leads are skipped and left for a human. The original
blueprint dialled Twilio for WhatsApp (never connected) and sent automated LinkedIn DMs,
which breaks LinkedIn's terms and gets the account restricted. That blueprint has been
removed - see [One stack](#one-stack) below.

<a id="one-stack"></a>
## One stack

There is exactly one follow-up runner. Everything else that touched these leads has been
deleted, because a second runner does not halve the emails - it doubles them:

| Concern | Owner | Why |
|---|---|---|
| Consent + delivery | **Resend** (send-only key, `concierge.agentcy.co.za` verified) | The only sender in the stack |
| Lead store | **Airtable**, one base, one table | `Status` is the opt-out switch, so a second list cannot drift |
| Sequence | **Vercel cron** `/api/cron/followup`, 07:00 UTC | Always on, and it owns `Touch Count` |
| Liveness | **Vercel cron** `/api/cron/health-watch`, 06:00 UTC | Stateless, so an Airtable outage cannot silence it |
| WhatsApp / LinkedIn | **A human** | The forms accept these as contact channels; nothing automates them |

### Removed

`SENDGRID_API_KEY`, `TWILIO_*` and `LINKEDIN_ACCESS_TOKEN` are gone from the repo, along
with everything that used them:

- `.github/workflows/daily-followup.yml` — ran `scripts/daily_followup.py` on `0 7 * * *`,
  **the same minute as the Vercel cron**, and sent via SendGrid, Twilio and LinkedIn. It
  failed on 14 of 14 runs, every day since 2026-09-14, so it was not double-sending. It
  was also one working secret away from doing so.
- `.github/workflows/lead-magnet-delivery.yml` — called `scripts/deliver_lead_magnet.py`,
  which does not exist. It could never have succeeded.
- `scripts/daily_followup.py` — the blueprint, 23 references to the dead stack.
- `make-scenario-followup.json`, `n8n-workflow-daily-followup.json`,
  `pipedream-workflow-daily-followup.json` — exports for the same blueprint.

### You must switch these off yourself

**Deleting a workflow file from this repo does not stop an automation running in someone
else's account.** If any of these are live, they are still sending:

- **n8n** — an "Agentcy Daily Follow-Up" workflow, sending from `michael@agentcy.co.za` via
  SendGrid, plus Twilio WhatsApp and automated LinkedIn DMs. This is the dangerous one: the
  LinkedIn DMs are exactly what breaks LinkedIn's terms. Check it first.
- **Make** — the "Agentcy Pipeline" scenario. Also the likely home of the stray-z
  `michaelgrazemek@gmail.com` reply-to.
- **Pipedream** — a daily follow-up workflow.

If one of them is still on and the others are off, it is the only sender left — which is
the same as none of them being on, minus the compliance problem.

## POPIA

- Consent is enforced **server-side**; the client-side checkbox is convenience only.
- The hidden `popia_consent` field **ships empty** and is filled from the checkbox. It
  previously shipped as `value="Yes"`, which meant the default — a visitor who never
  ticked anything — recorded consent they never gave. A web form cannot prove a human
  clicked a box, so a deliberate forgery is always possible; what matters is that the
  default is *not* consent.
- An unconsented submission never reaches Airtable, and an unconsented record is never
  emailed: the follow-up filter requires `POPIA Consent = "Yes"` as well. The two are not
  redundant — the Make/n8n automations and manual edits do not go through the intake check,
  and the filter is the last thing before a send.
- **s11(2)(a) evidence is recorded with the consent.** A web form cannot prove a human
  clicked a box, and it does not pretend to. What it can do is record *what was agreed to*
  and *when*: `Consent Timestamp` is a full ISO timestamp, so two opt-ins on the same day
  are distinguishable, and `Consent Text Version` ties the record to the exact wording that
  was on screen. Bump `CONSENT_TEXT_VERSION` in `api/optin.js` whenever that wording
  changes, or a later edit will silently rewrite what past signups agreed to.
- The client address is **not** recorded. It is personal information in its own right, it
  is not needed to evidence consent, and the structured logs deliberately carry no name,
  email, phone or IP either.
- Duplicate suppression keeps one person to one record inside 30 days, so a follow-up
  sequence cannot message the same lead three times.
- Every follow-up email carries a one-click unsubscribe link, HMAC-signed per record so it
  cannot be used to opt somebody else out by guessing ids. Unsubscribing sets `Status` to
  `Unsubscribed`, which the due filter already excludes — so there is no second suppression
  list to drift out of sync.
- If the unsubscribe write fails, the page offers a direct email address rather than
  pretending it worked.
- Register as a direct marketer with the NCC and run the monthly cleanse:

```bash
sudo cp ncc-cleanse.py /opt/agentcy/
sudo cp agentcy-ncc-cleanse.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentcy-ncc-cleanse.timer
```

## Free-tier budget

Everything here is designed to stay inside the free tiers. What each limit costs
you, and how much room is left:

| Service | Free limit | Our worst realistic day | Notes |
|---|---|---|---|
| **Resend** | 100 emails/day, 3,000/month | ~22 | 1 blueprint per lead, up to 25 follow-ups, 1 health alert, plus 1 rescue per lead *only while Airtable is broken* |
| **Vercel** | 10s per function | ~9s | `AIRTABLE_REQUEST_BUDGET_MS` (4s) + two 2.5s email sends. The deadline is what keeps it under; without it a retry chain ran 38s and Vercel killed the request |
| **Vercel crons** | daily frequency only | 2 jobs | Both schedules are daily, which is all Hobby allows. Hobby caps crons per project, so do not add a third without checking |
| **Airtable** | 5 requests/second | ~3 per submission | Schema read is cached 10 minutes and makes a *single* attempt, because it is optional |
| **Airtable rows** | 5,000 per table on Free | ~7/day | Years of runway |

Two things that will silently eat a budget if changed: `FOLLOWUP_MAX_PER_RUN`
(25 emails in one run) and the health alert, which repeats every day for as long
as a fault lasts. Both are deliberate caps, not oversights.

## Still to do

- [ ] **Switch off the old automations in n8n, Make and Pipedream.** See
      [One stack](#one-stack). They are not in this repo and deleting the files
      here did nothing to them. n8n first: it sends automated LinkedIn DMs.
- [ ] **Delete the repo secrets** `SENDGRID_API_KEY`, `TWILIO_ACCOUNT_SID`,
      `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `LINKEDIN_ACCESS_TOKEN` under
      Settings → Secrets. Nothing reads them any more.
- [ ] **Confirm `RESEND_REPLY_TO` in production** is a monitored inbox and not
      the stray-z `michaelgrazemek@gmail.com`. Vercel will not return the value
      of a sensitive variable, so this cannot be checked from the API.
- [ ] **Clear the leftover test records** — `Outage Probe`, `Panel Probe 2`,
      `RateLimit Impact`, `Prod Impact`, `Block Check` are still in the tracker
- [ ] Add `REDIS_URL` / `REDIS_TOKEN` for durable rate limiting
- [ ] Decide whether to keep the three long forms
- [ ] Register with the NCC and run the monthly cleanse (see below)
- [ ] `tests/check-url-validation.js` has no `.test.` suffix, so
      `node --test tests/*.test.js` never runs it. Either rename it or delete it.
