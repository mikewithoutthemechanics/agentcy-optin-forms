# Agentcy 30-Day Outreach — Opt-In Forms & Tracker

Static opt-in forms for three segments, deployed on Vercel, writing leads to Airtable
and emailing the lead magnet through Resend.

**Live:** https://agentcy-optin-forms.vercel.app

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
| `RESEND_API_KEY` | for email | send-only key scoped to the sending domain |
| `RESEND_FROM` | for email | e.g. `Agentcy <optin@concierge.agentcy.co.za>` |
| `RESEND_REPLY_TO` | recommended | a **monitored** inbox; defaults to `hello@agentcy.co.za` |
| `WHATSAPP_NUMBER` | no | defaults to `+27837915429` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | no | defaults `5` / `600000` |
| `DEDUPE_WINDOW_DAYS` | no | defaults `30` |
| `RESEND_TIMEOUT_MS` | no | defaults `5000` |
| `AIRTABLE_SCHEMA_TTL_MS` | no | defaults `600000` |
| `REDIS_URL` + `REDIS_TOKEN` | no | see Rate limiting |

## Deploying

Push to `master`; the GitHub integration deploys automatically.

```bash
node --test tests/optin.test.js     # 17 tests, no network needed
```

## Health check

`GET /api/health` returns 200 or 503 and pings Airtable with a real read, so a revoked
token or an outage shows up without waiting for a failed signup. Point an uptime monitor
or Vercel cron at it.

## Rate limiting

Per-IP sliding window, evaluated before the Airtable write so junk never reaches the
tracker, and after validation so a human who mistypes their email is not locked out.

The counter is an in-memory `Map`, and Vercel does not guarantee a warm instance — so it
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
are yours to work from. **The follow-up sequence is not implemented** — the `*-followup`
JSON scenarios and `scripts/daily_followup.py` in this repo are blueprints for it, not
running code. Nothing reads those columns yet.

Views worth creating:

1. **Pipeline Kanban** — group by `Status`
2. **Today's Follow-Ups** — `Next Follow-Up Date` is today AND `Touch Count` < 3
3. **By Segment** — group by `Segment`
4. **Consent Audit** — `POPIA Consent` = "No" (should be zero; the API rejects these)

## POPIA

- Consent is enforced **server-side**; the client-side checkbox is convenience only.
- An unconsented submission never reaches Airtable.
- Duplicate suppression keeps one person to one record inside 30 days, so a follow-up
  sequence cannot message the same lead three times.
- The lead magnet email carries a `reply-to` at a monitored address and asks for STOP.
  **There is no automatic suppression list** — handle STOP manually, or add the address
  to Resend suppressions.
- Register as a direct marketer with the NCC and run the monthly cleanse:

```bash
sudo cp ncc-cleanse.py /opt/agentcy/
sudo cp agentcy-ncc-cleanse.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentcy-ncc-cleanse.timer
```

## Still to do

- [ ] **Rotate the Airtable PAT** — the one in use was shared in a chat and in shell history
- [ ] Point a monitor at `/api/health`
- [ ] Add `REDIS_URL` / `REDIS_TOKEN` for durable rate limiting
- [ ] Serve from a `agentcy.co.za` subdomain rather than `*.vercel.app`
- [ ] Implement the follow-up sequence
- [ ] Decide whether to keep the three long forms
- [ ] Fix the `michaelgrazemek@gmail.com` (stray "z") reply-to in the Agentcy Pipeline
      automation — it is **not** in this repo, it lives in whatever sends that mail
