# Agentcy Opt-In Forms — Free Hosting Options

## Option 1: Netlify Forms (Recommended — Built into Netlify Hosting)

**Free tier:** 100 form submissions/month, spam filtering, email notifications, Zapier/Make integration

### Setup (5 minutes):
1. Push `agentcy-optin-forms` folder to GitHub
2. Go to netlify.com → "Add new site" → "Import from Git"
3. Connect your repo
4. Build command: *(leave empty)*
5. Publish directory: `.` (root)
6. Deploy → Netlify auto-detects `data-netlify="true"` forms

### Configure notifications:
- Site settings → Forms → Form notifications → Add notification
- Email to: `michael@agentcy.co.za`
- Trigger: New submission
- Format: Include all fields

### Webhook to Airtable (via Make/Zapier):
- Netlify Form settings → Outgoing webhook
- URL: Your Make webhook endpoint (or use the GitHub Actions workflow below)

---

## Option 2: Formspree (Simplest — No Hosting Needed)

**Free tier:** 50 submissions/month, email notifications, webhook support

### Setup (2 minutes):
1. Go to formspree.io → Create form
2. Copy your form endpoint: `https://formspree.io/f/YOUR_FORM_ID`
3. Update each form's `<form action="...">` to point to your Formspree endpoint
4. Done — submissions go to your email + webhook

### Update forms for Formspree:
```html
<form action="https://formspree.io/f/YOUR_TRADES_FORM_ID" method="POST" class="form-body" id="optinForm" novalidate>
```

---

## Option 3: GitHub Actions + Static Hosting (Zero Cost, Full Control)

**What you get:** Free hosting (GitHub Pages/Netlify/Vercel) + Form handling via GitHub Actions workflows

### Files already created:
- `.github/workflows/lead-magnet-delivery.yml` — Receives form submissions via `workflow_dispatch`
- `.github/workflows/daily-followup.yml` — Runs daily 09:00 SAST for follow-ups
- `scripts/deliver_lead_magnet.py` — Creates Airtable record + sends lead magnet
- `scripts/daily_followup.py` — Runs 3-touch follow-up sequence

### Required GitHub Secrets (Settings → Secrets → Actions):
| Secret | Value |
|--------|-------|
| `AIRTABLE_API_KEY` | Your Airtable PAT |
| `SENDGRID_API_KEY` | SendGrid API key (free 100/day) |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_FROM_NUMBER` | Your Twilio WhatsApp number (+27...) |
| `LINKEDIN_ACCESS_TOKEN` | LinkedIn OAuth token |

### How to trigger from forms:
Update form JS to call GitHub Actions API:
```javascript
// In form submit handler
const response = await fetch(
  'https://api.github.com/repos/YOUR_USERNAME/agentcy-optin-forms/actions/workflows/lead-magnet-delivery.yml/dispatches',
  {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer YOUR_GITHUB_PAT', // Needs repo scope
      'Accept': 'application/vnd.github+json'
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { payload: JSON.stringify(formData) }
    })
  }
);
```

**Note:** Requires a GitHub PAT with `repo` scope. For production, use a dedicated GitHub App.

---

## Option 4: Make (formerly Integromat) — Visual, 1000 ops/month free

**Already created:** `make-scenario-followup.json` (import → configure → activate)

### Setup:
1. Go to make.com → Create account
2. Scenarios → Import → Select `make-scenario-followup.json`
3. Configure connections:
   - Airtable (your base)
   - Email (SendGrid/Gmail/SMTP)
   - Twilio (WhatsApp)
   - HTTP (for LinkedIn)
4. Set up webhook trigger → Use Make's webhook URL in your forms
5. Activate scenario

### Form webhook URL format:
```
https://hook.eu1.make.com/abcdef123456
```

Update form JS:
```javascript
const response = await fetch('https://hook.eu1.make.com/YOUR_WEBHOOK_ID', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(formData)
});
```

---

## Recommendation

| Priority | Solution | Why |
|----------|----------|-----|
| **1** | **Netlify Forms + Make** | Free hosting + free forms + visual automation. Netlify detects forms automatically. Make handles Airtable + multi-channel delivery + follow-ups. |
| **2** | **Formspree + Make** | Simplest form backend. No hosting changes needed. Just update form `action` URLs. |
| **3** | **GitHub Actions + Netlify/Vercel** | Full control, zero cost, but requires GitHub PAT for form submission. |
| **4** | **n8n (self-hosted)** | If you get n8n access later, workflows are ready to import. |

---

## Quick Start (Netlify + Make — 15 minutes total):

### 1. Deploy forms to Netlify
```bash
cd agentcy-optin-forms
git init && git add . && git commit -m "Initial"
gh repo create agentcy-optin-forms --public --push
# Then import in Netlify dashboard
```

### 2. Import Make scenario
- make.com → Scenarios → Import → `make-scenario-followup.json`
- Connect Airtable, SendGrid, Twilio
- Copy webhook URL

### 3. Update forms with Make webhook
In each form's JS, replace the fetch URL:
```javascript
const response = await fetch('https://hook.eu1.make.com/YOUR_WEBHOOK_ID', {...});
```

### 4. Test
- Submit each form → Check Airtable → Check email/WhatsApp delivery → Check follow-up runs next day

---

## Lead Magnet PDF Hosting (Free)

Host PDFs on:
- **Netlify:** Put in `dist/lead-magnets/` → accessible at `https://yoursite.netlify.app/lead-magnets/lead-magnet-trades.pdf`
- **GitHub Pages:** Enable Pages → `https://username.github.io/repo/lead-magnet-trades.pdf`
- **Cloudflare R2 / AWS S3:** Free tier, public read

Update `LEAD_MAGNETS` URLs in `scripts/deliver_lead_magnet.py` and n8n/Make workflows.

---

## NCC Compliance (Manual Steps)

1. **Register as Direct Marketer** with NCC (National Consumer Commission)
2. **Install sa-dm** on your server/VPS:
   ```bash
   # Follow sa-dm installation docs
   ```
3. **Deploy cleansing script:**
   - Copy `ncc-cleanse.py` to `/opt/agentcy/`
   - Copy `agentcy-ncc-cleanse.service` + `.timer` to `/etc/systemd/system/`
   - `sudo systemctl daemon-reload && sudo systemctl enable --now agentcy-ncc-cleanse.timer`
4. **Set env vars** in `/etc/agentcy/ncc-cleanse.env`:
   ```
   AIRTABLE_API_KEY=pat_xxx
   SA_DM_CLI=/usr/local/bin/sa-dm
   NCC_API_URL=https://api.ncc.gov.za/optout
   ```

---

## File Structure (Complete)

```
agentcy-optin-forms/
├── index.html                          # Landing hub
├── trades-form.html                    # KZN Trades form (Netlify Forms ready)
├── online-smb-form.html                # Online SMB form (Netlify Forms ready)
├── prof-services-form.html             # Prof Services form (Netlify Forms ready)
├── lead-magnet-trades.pdf              # Trades lead magnet
├── lead-magnet-online-smb.pdf          # Online SMB lead magnet
├── lead-magnet-prof-services.pdf       # Prof Services lead magnet
├── README.md                           # This documentation
├── deploy.py                           # Deploy helper
├── ncc-cleanse.py                      # NCC cleansing script
├── cron-ncc-cleanse                    # Crontab entry
├── agentcy-ncc-cleanse.service         # systemd service
├── agentcy-ncc-cleanse.timer           # systemd timer
├── make-scenario-followup.json         # Make scenario (import this)
├── n8n-workflow-lead-magnet-delivery.json  # n8n (if you get access)
├── n8n-workflow-daily-followup.json    # n8n follow-up
├── scripts/
│   ├── daily_followup.py               # GitHub Actions follow-up
│   └── deliver_lead_magnet.py          # GitHub Actions delivery
└── .github/workflows/
    ├── daily-followup.yml              # Daily cron (09:00 SAST)
    └── lead-magnet-delivery.yml        # Form submission handler
```

---

## Next Steps

1. **Pick your stack** (Netlify+Make recommended)
2. **Deploy forms** (5 min)
3. **Import Make scenario** (5 min)
4. **Connect webhooks** (2 min)
5. **Test all 3 segments** (5 min)
6. **Set up NCC cleansing** (when you have server access)

All code is in `/c/Users/micha/agentcy-optin-forms/` — ready to push and deploy.