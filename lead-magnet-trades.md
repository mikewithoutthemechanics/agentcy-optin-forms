# Stop Losing Quote Requests to Slow Follow-Up
## The Exact Automation Blueprint Punctual Plumbers Uses to Respond in Minutes, Not Hours

---

### The Problem You Know Too Well

It's 7:47 PM. A homeowner in Ballito messages your WhatsApp: *"Geyser burst. Need someone NOW."*

You're on a job site. Hands dirty. Phone in the bakkie.

By the time you see it at 8:15 PM, they've already called three other plumbers. **Job lost.**

**This happens 3-5 times a week for the average KZN trade business.**

---

### The Numbers Don't Lie

| Metric | Before Automation | After Automation |
|--------|-------------------|------------------|
| Avg. response time | 4.2 hours | **4 minutes** |
| Quote-to-job conversion | 23% | **41%** |
| After-hours jobs captured | 12% | **67%** |
| Admin hours/week | 8-12 hrs | **1.5 hrs** |

*Source: Punctual Plumbers internal data, 6-month comparison*

---

### The 3 Automations You Can Build This Week

#### 1. WhatsApp → Instant Quote Acknowledgment (15 min setup)
**Tools:** WhatsApp Business API (or Twilio) + Make (formerly Integromat)

**The Flow:**
```
Customer WhatsApps → Make webhook captures → Auto-reply: "Got it! [Name] will call within 15 min" → 
Creates job card in Google Sheet/Airtable → Sends you push notification with address & details
```

**Template Message:**
> "Thanks for reaching out, {{Name}}! 🛠️ We've logged your {{issue}} at {{address}}. [Owner Name] is on a job but will call you within 15 minutes. Reference: JOB-{{timestamp}}"

**Why it works:** Customer feels heard instantly. You get structured data. Zero manual typing.

---

#### 2. Quote Follow-Up Sequence That Runs While You Sleep (30 min setup)
**Tools:** Make + Gmail/Outlook + WhatsApp

**The Flow:**
```
Quote sent (via email/WhatsApp) → Make watches for "Sent" status →
Day 1, 10 AM: "Hi {{Name}}, just checking — any questions on the quote for {{job}}?"
Day 3, 2 PM: "Hey {{Name}}, quote for {{job}} expires Friday. Happy to adjust scope if needed."
Day 5, 9 AM: "Last call on {{job}} quote — locking in material prices today. Let me know?"
```

**Pro tip:** Include a "Book Site Visit" Calendly link in every follow-up.

**Result:** Punctual Plumbers recovered **R187K in otherwise-lost quotes** in month 1.

---

#### 3. After-Hours Lead Capture + Morning Handoff (20 min setup)
**Tools:** WhatsApp Business away message + Make + Google Sheets

**The Flow:**
```
After 6 PM / Before 7 AM: WhatsApp auto-reply triggers →
"Thanks for messaging! We're off-site but your request is logged. 
We'll call by 8 AM. For emergencies, call [emergency number]."
→ Make captures: name, number, message, timestamp →
Adds to "Morning Call List" Google Sheet →
You open sheet at 7 AM, tap-to-call each lead
```

**Bonus:** Add a "Urgency" dropdown in the sheet (Emergency / Today / This Week) so you prioritize.

---

### Your "Start This Week" Checklist

| Task | Time | Done? |
|------|------|-------|
| Set up WhatsApp Business auto-reply (after-hours) | 10 min | ☐ |
| Create Make account (free tier = 1,000 ops/mo) | 5 min | ☐ |
| Build Webhook → Auto-reply scenario | 15 min | ☐ |
| Build Quote Follow-Up scenario | 30 min | ☐ |
| Build Morning Handoff sheet + scenario | 20 min | ☐ |
| Test with 3 real leads | 30 min | ☐ |
| **Total** | **~1.5 hours** | |

---

### The "No-Code" Stack We Recommend (All Free to Start)

| Need | Tool | Free Tier |
|------|------|-----------|
| Automation engine | **Make** | 1,000 ops/mo |
| Database/Job board | **Airtable** | 1,000 records |
| WhatsApp messaging | **Twilio** / WhatsApp Business App | $0 (app) / pay-per-msg (API) |
| Scheduling | **Calendly** | Free |
| Forms/Quote builder | **Tally.so** | Unlimited free |

**Monthly cost at scale:** ~R500-800/mo (Twilio API + Make Pro)

---

### Want Us to Build It For You?

You've got a business to run. Pipes to fix. Geysers to replace.

**Book a free 30-minute AI Strategy Call** and we'll:
1. Audit your current lead flow (15 min)
2. Show you the exact Make scenarios pre-built for trades (10 min)
3. Give you a copy-paste deployment plan — or we build it turnkey (5 min)

**No pitch. No pressure. Just a clearer path to more jobs.**

→ **[Book Your Free Call Here](https://calendly.com/agentcy/30min-strategy)**

---

### One More Thing: The WhatsApp QR Card

Print this. Stick it on your bakkie. Put it on every invoice.

```
┌─────────────────────────────────┐
│   📱 WHATSAPP US FOR A QUOTE    │
│                                 │
│   [QR CODE → Your WhatsApp]     │
│                                 │
│   "Geyser burst? Blocked drain? │
│    Message us — we reply in     │
│    minutes, not hours."         │
│                                 │
│   Punctual Plumbers             │
│   082 XXX XXXX                  │
└─────────────────────────────────┘
```

**Generates 2-3 qualified leads/week per vehicle.** Cost: R150 for laminated cards.

---

*Agentcy — Custom Automation for South African Businesses*  
*hello@agentcy.co.za | agentcy.co.za | +27 XX XXX XXXX*