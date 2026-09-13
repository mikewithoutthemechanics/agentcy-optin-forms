# Agentcy 30-Day Outreach — Opt-In Forms & Tracker

## What's Built

| Asset | Path | Purpose |
|-------|------|---------|
| **Central CRM Tracker** | Airtable: `app0CK3JUNYEGcCMV` → `tblnhzmqneNswTvGd` | Single source of truth for all opt-ins, pipeline, follow-ups |
| **Trades Form** | `trades-form.html` | KZN trades/local SMBs — "Stop Losing Quotes" lead magnet |
| **Online SMB Form** | `online-smb-form.html` | National online SMBs — "Find 3 Automations" lead magnet |
| **Prof Services Form** | `prof-services-form.html` | Professional services — "AI Readiness Checklist" lead magnet |
| **Landing Page** | `index.html` | Hub linking to all 3 forms |
| **Lead Magnets** | `lead-magnet-*.md` | Content delivered after opt-in (PDF/Notion) |
| **n8n Workflow** | `n8n-workflow-agentcy-optin.json` | Receives form POSTs → writes to Airtable |

---

## Deploy Checklist

### 1. Import n8n Workflow
```bash
# In n8n UI: Workflows → Import → Select n8n-workflow-agentcy-optin.json
# Then configure credentials:
# - Airtable: "Agentcy Airtable" (Personal Access Token with data.records:write on app0CK3JUNYEGcCMV)
# Activate workflow
```

### 2. Verify Webhook Endpoints
After activating, test each:
```bash
curl -X POST https://n8n.agentcy.co.za/webhook/agentcy-trades-optin \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","business":"Test Plumbing","segment":"KZN Trades/Local SMBs","area":"Durban","preferred_channel":"WhatsApp","pain_point":"Slow follow-up","current_tools":"WhatsApp, paper","popia_consent":"Yes","lead_magnet":"Trades: Stop Losing Quotes","source":"test","optin_date":"2026-09-13"}'
```
Should return `{"success":true,"message":"Opt-in recorded. Lead magnet incoming."}` and create a record in Airtable.

### 3. Host Forms
Options (pick one):
- **Netlify/Vercel**: Drag `agentcy-optin-forms` folder → deploy (auto HTTPS, custom domain)
- **Cloudflare Pages**: Connect Git repo → build command: none, output: `/`
- **VPS (nginx)**: `cp -r agentcy-optin-forms/* /var/www/agentcy-optin/`

Update form `fetch()` URLs if webhook domain changes.

### 4. Configure Lead Magnet Delivery
In n8n, add a **Send Email / WhatsApp** node after "Create Airtable Record":
- **Email**: Use SendGrid/SMTP node with lead magnet PDF attached
- **WhatsApp**: Use Twilio WhatsApp node with link to Notion/PDF
- **Branch by segment** (use Switch node on `segment` field)

### 5. Set Up Follow-Up Automation (Week 1)
Create second n8n workflow: **Daily Follow-Up Check**
- Cron: Every day 09:00 SAST
- Airtable: List records where `Status = "New Opt-In"` AND `Touch Count < 3` AND `Next Follow-Up Date <= Today`
- For each: Send personalized follow-up (email/WhatsApp/LinkedIn per `Preferred Channel`)
- Update: `Touch Count += 1`, `Last Touch Date = Today`, `Next Follow-Up Date = Today + 2-4 days`

### 6. NCC Registration & sa-dm Cleansing
- Register as Direct Marketer with NCC (National Consumer Commission)
- Set up monthly cron to cleanse Airtable against NCC opt-out registry using `sa-dm` tooling
- Log: `cronjob_manage` skill has patterns for this

---

## Airtable Tracker Fields Reference

| Field | Type | Notes |
|-------|------|-------|
| Name | Single line text | Primary field |
| Business | Single line text | |
| Segment | Single select | KZN Trades / National Online / Prof Services |
| Area | Single line text | |
| Preferred Channel | Single select | WhatsApp, Email, LinkedIn, Phone, In-Person |
| Pain Point | Long text | |
| Current Tools | Long text | |
| POPIA Consent | Single select | Yes/No |
| Consent Basis | Single select | Form Opt-In, Partner Referral, Event Signup, Workshop Attendee, Lead Magnet Download |
| Source | Single line text | UTM/campaign source |
| Opt-In Date | Date | Auto-set on form submit |
| Status | Single select | New Opt-In → Contacted → Call Booked → Call Completed → Qualified → Proposal Sent → Won/Lost/Paused |
| Booked Call | Single select | Yes/No |
| Call Date | DateTime | |
| Attended | Single select | Yes/No |
| Qualified | Single select | Yes/No |
| Proposal Sent | Single select | Yes/No |
| Proposal Date | Date | |
| Outcome | Single select | Audit Started, Growth Retainer, Project Scoped, Not a Fit, Ghosted, Deferred |
| Next Action | Long text | |
| Next Follow-Up Date | Date | |
| Touch Count | Number | Max 3 per 14 days |
| Last Touch Date | Date | |
| Lead Magnet | Single select | Trades/Online SMB/Prof Services |

---

## Views to Create in Airtable

1. **Pipeline Kanban** — Group by Status
2. **Today's Follow-Ups** — Filter: `Next Follow-Up Date = Today` AND `Touch Count < 3`
3. **By Segment** — Group by Segment
4. **Weekly Review** — Filter: `Opt-In Date >= 7 days ago`, sort by Status
5. **Consent Audit** — Filter: `POPIA Consent = "No"` (should be zero)

---

## Daily KPI Dashboard (Airtable Interface or Notion)

| KPI | Target | Source |
|-----|--------|--------|
| New Opt-Ins (24h) | 5-7/day | Count records where `Opt-In Date = Today` |
| Booked Calls (24h) | 1-2/day | Count where `Booked Call = Yes` AND `Call Date = Today` |
| Call Show Rate | >80% | `Attended = Yes` / `Booked Call = Yes` |
| Qualified Rate | >50% | `Qualified = Yes` / `Call Completed = Yes` |
| Proposals Sent (week) | 3-4/week | Count where `Proposal Date = This Week` |

---

## Week 1 Launch Checklist

- [ ] n8n workflow imported & activated
- [ ] Forms hosted & HTTPS working
- [ ] Lead magnet delivery tested (all 3 segments)
- [ ] Follow-up automation workflow created
- [ ] NCC registration submitted
- [ ] sa-dm cleansing cron scheduled (monthly)
- [ ] Airtable views created
- [ ] Team added to Airtable base (Editor access)
- [ ] Calendly link updated in all lead magnets (`https://calendly.com/agentcy/30min-strategy`)
- [ ] Test end-to-end: form → Airtable → lead magnet delivery → follow-up trigger

---

## File Structure

```
agentcy-optin-forms/
├── index.html                    # Landing hub
├── trades-form.html              # KZN Trades opt-in form
├── online-smb-form.html          # National Online SMB opt-in form
├── prof-services-form.html       # Professional Services opt-in form
├── lead-magnet-trades.md         # Trades lead magnet content
├── lead-magnet-online-smb.md     # Online SMB lead magnet content
├── lead-magnet-prof-services.md  # Prof Services lead magnet content
├── n8n-workflow-agentcy-optin.json  # n8n workflow (import this)
└── README.md                     # This file
```

---

## Customization Notes

### Colors (CSS Variables)
All forms use the same cool silverish neutral palette:
```css
--bg: #0a0a0b;           /* Near black */
--bg-elevated: #141416;  /* Card background */
--fg: #f4f4f5;           /* Near white */
--muted: #71717a;        /* Zinc 500 */
--accent: #22d3ee;       /* Cyan 400 — primary CTA */
--accent-dim: #0891b2;   /* Cyan 600 — hover */
--border: #27272a;       /* Zinc 800 */
--card: #18181b;         /* Zinc 900 */
```
**No warm tints. No glassmorphism. Sharp, high-contrast, accessible.**

### Adding a 4th Segment
1. Duplicate one form HTML → rename fields
2. Add segment to Airtable `Segment` single select options
3. Add lead magnet to `Lead Magnet` single select options
4. Add webhook path in n8n (new Webhook node → connect to existing Map node)
5. Update `index.html` with 4th card

### POPIA Compliance Checklist
- [x] Explicit opt-in checkbox on every form (required)
- [x] Clear consent language with STOP/withdrawal instructions
- [x] Privacy Policy & Terms links
- [x] Consent basis tracked in Airtable
- [x] Separate unconsented master list (not in this base)
- [ ] NCC registration complete
- [ ] Monthly sa-dm cleansing cron active
- [ ] Audit trail: every touch logged with date/channel/content

---

## Support

- **Forms not submitting?** Check browser Network tab → webhook URL → CORS/404/500
- **Airtable not creating records?** Check n8n execution log → Airtable node error
- **Lead magnets not delivering?** Check n8n Send Email/WhatsApp node logs
- **Need to bulk import legacy leads?** Use Airtable CSV import → map fields → set `Consent Basis = "Partner Referral"` or similar

---

*Built for Agentcy — Custom Automation for South African Businesses*  
*hello@agentcy.co.za | agentcy.co.za*