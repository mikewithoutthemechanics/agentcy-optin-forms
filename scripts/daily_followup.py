#!/usr/bin/env python3
"""
Agentcy Daily Follow-Up Automation — GitHub Actions Version
Runs daily via GitHub Actions cron (09:00 SAST)
Fetches due follow-ups from Airtable, sends via Email/WhatsApp/LinkedIn, updates Airtable.
"""

import os
import sys
import json
import logging
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

# ─── Config ──────────────────────────────────────────────────────
AIRTABLE_API_KEY = os.environ.get("AIRTABLE_API_KEY")
AIRTABLE_BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "app0CK3JUNYEGcCMV")
AIRTABLE_TABLE_ID = os.environ.get("AIRTABLE_TABLE_ID", "tblnhzmqneNswTvGd")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY")
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER")
LINKEDIN_ACCESS_TOKEN = os.environ.get("LINKEDIN_ACCESS_TOKEN")
FROM_EMAIL = os.environ.get("FROM_EMAIL", "michael@agentcy.co.za")

AIRTABLE_URL = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}"
AIRTABLE_HEADERS = {
    "Authorization": f"Bearer {AIRTABLE_API_KEY}",
    "Content-Type": "application/json"
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

# ─── Airtable Helpers ───────────────────────────────────────────
def fetch_due_followups() -> List[Dict]:
    """Get records where Touch Count < 3, Status = New Opt-In, Next Follow-Up Date <= today."""
    today = datetime.now().strftime("%Y-%m-%d")
    formula = (
        f"AND({{Touch Count}} < 3, {{Status}} = 'New Opt-In', "
        f"OR({{Next Follow-Up Date}} = '', {{Next Follow-Up Date}} <= '{today}'))"
    )
    
    all_records = []
    offset = None
    while True:
        params = {"pageSize": 100, "filterByFormula": formula}
        if offset:
            params["offset"] = offset
        
        resp = requests.get(AIRTABLE_URL, headers=AIRTABLE_HEADERS, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        all_records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
    
    logger.info(f"Found {len(all_records)} records due for follow-up")
    return all_records


def update_record(record_id: str, fields: Dict) -> bool:
    """Update a single Airtable record."""
    url = f"{AIRTABLE_URL}/{record_id}"
    resp = requests.patch(url, headers=AIRTABLE_HEADERS, json={"fields": fields}, timeout=30)
    if resp.status_code == 200:
        logger.info(f"Updated record {record_id}")
        return True
    else:
        logger.error(f"Failed to update {record_id}: {resp.text}")
        return False


# ─── Message Builders ───────────────────────────────────────────
def build_message(fields: Dict, touch_number: int) -> Dict[str, str]:
    """Build channel-agnostic message content based on segment and touch number."""
    name = (fields.get("Name") or "there").split()[0]
    business = fields.get("Business", "")
    segment = fields.get("Segment", "")
    pain_point = fields.get("Pain Point", "")
    lead_magnet = fields.get("Lead Magnet", "")
    
    if touch_number == 1:
        # Touch 1: Value delivery + soft CTA
        if segment == "KZN Trades/Local SMBs":
            subject = f"Quick question about {business}"
            body = f"""Hi {name},

Saw your note about "{pain_point}" — that's exactly why we built the "Stop Losing Quotes" blueprint.

One quick thing: the WhatsApp auto-reply + job logging setup takes 15 mins and starts catching after-hours leads tonight.

Want me to send the 3-step setup checklist? Just reply YES.

— Michael @ Agentcy"""
            whatsapp = f"""Hi {name}! Your "Stop Losing Quotes" blueprint is ready 📋

3 automations Punctual Plumbers uses to respond in minutes, not hours:
1. WhatsApp auto-reply + job log (15 min)
2. Quote follow-up sequence (30 min) 
3. After-hours capture (20 min)

PDF attached. Want the Make templates imported? Book a free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
        
        elif segment == "National Online SMBs":
            subject = f"Your 3-automation roadmap — one question"
            body = f"""Hi {name},

Your "Find 3 Automations" roadmap should've landed. The #1 pick for {business}: unified order → inventory → accounting sync (saves 5-8 hrs/week).

Quick question: which platform hurts most right now — Takealot sync, Shopify inventory, or Xero reconciliation?

Reply and I'll prioritize that one in the Make blueprint.

— Michael @ Agentcy"""
            whatsapp = f"""Hi {name}! Your 3-automation roadmap is ready 📊

Top picks for your stack:
1. Order→Inventory→Xero sync (5-8 hrs saved)
2. WhatsApp+Email+IG → one inbox (3-5 hrs)
3. Daily dashboard to WhatsApp (2-3 hrs)

PDF attached. Want the Make templates? Free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
        
        else:  # Professional Services
            subject = f"AI Readiness Scorecard — your top gap"
            body = f"""Hi {name},

Your scorecard highlighted {pain_point} as the biggest friction.

For professional services, the fastest win is usually Meeting-to-CRM automation (Fathom → Make → Clio/HubSpot). 2-hour setup, 100% capture rate.

Want the exact Make scenario JSON? Reply YES.

— Michael @ Agentcy"""
            whatsapp = f"""Hi {name}! Your AI Readiness Scorecard is ready 📈

5-dimension score + priority matrix + 3 quick-win Make blueprints + 90-day roadmap.

PDF attached. Want the blueprints implemented? Free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
    
    elif touch_number == 2:
        # Touch 2: Social proof + harder CTA
        if segment == "KZN Trades/Local SMBs":
            subject = "How Punctual Plumbers recovered R187K in lost quotes"
            body = f"""Hi {name},

Punctual Plumbers (Ballito) implemented the quote follow-up sequence from the blueprint.

Month 1 result: R187K in previously-lost quotes recovered. The "Day 3: quote expiring Friday" message was the killer.

If you want that exact Make scenario imported into your account, book a 15-min screen-share:
https://calendly.com/agentcy/30min-strategy

— Michael"""
            whatsapp = f"""Hi {name}, Punctual Plumbers recovered R187K in lost quotes using the blueprint's follow-up sequence.

Want the exact Make template? Book a free 15-min screen-share:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
        
        elif segment == "National Online SMBs":
            subject = "Sarah's Homewares: 11 hrs/week back in 3 days"
            body = f"""Hi {name},

Sarah (Cape Town, Shopify + Takealot) plugged in the order→inventory→Xero sync.

Day 1: 6.5 hrs saved. Day 3: zero oversells. Month 1: +R340K revenue from faster fulfillment → better reviews.

Same stack? Want the Make template?
https://calendly.com/agentcy/30min-strategy

— Michael"""
            whatsapp = f"""Hi {name}, Sarah's Homewares saved 11 hrs/week in 3 days with the order→inventory→Xero sync.

Want the Make template? Free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
        
        else:  # Professional Services
            subject = "Naidoo & Associates: 47 hrs/month recovered per partner"
            body = f"""Hi {name},

Naidoo & Associates (Commercial Law, Durban) scored 31/100 on readiness. 90 days later: 67/100.

Top win: Smart Intake Form (Tally → DocuSign → Clio → Slack). Onboarding 21 days → 4 days.

Want the blueprint for your practice?
https://calendly.com/agentcy/30min-strategy

— Michael"""
            whatsapp = f"""Hi {name}, Naidoo & Associates recovered 47 hrs/month/partner with Smart Intake Form automation.

Want the blueprint? Free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
    
    else:
        # Touch 3: Final nudge + opt-out
        subject = "Closing this thread — but the blueprint's yours"
        body = f"""Hi {name},

I'll stop following up after this. The {lead_magnet} blueprint is yours to keep — no strings.

If automation becomes a priority later, the 30-min strategy call is always free:
https://calendly.com/agentcy/30min-strategy

Just reply STOP if you want zero further contact (POPIA compliant).

All the best,
Michael @ Agentcy"""
        whatsapp = f"""Hi {name}, I'll stop following up after this. The {lead_magnet} blueprint is yours to keep.

If automation becomes a priority later, the free 30-min call is always open:
https://calendly.com/agentcy/30min-strategy

Reply STOP for zero further contact (POPIA compliant)."""
    
    linkedin = f"Hi {name}, {body.split(chr(10))[1] if chr(10) in body else body[:200]}... Free 30-min call: https://calendly.com/agentcy/30min-strategy"
    
    return {
        "subject": subject,
        "email_body": body,
        "whatsapp_body": whatsapp,
        "linkedin_body": linkedin
    }


# ─── Channel Senders ────────────────────────────────────────────
def send_email(to_email: str, subject: str, body: str) -> bool:
    if not SENDGRID_API_KEY or not to_email:
        return False
    try:
        resp = requests.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={"Authorization": f"Bearer {SENDGRID_API_KEY}", "Content-Type": "application/json"},
            json={
                "personalizations": [{"to": [{"email": to_email}], "subject": subject}],
                "from": {"email": FROM_EMAIL, "name": "Michael @ Agentcy"},
                "content": [{"type": "text/plain", "value": body}]
            },
            timeout=30
        )
        return resp.status_code == 202
    except Exception as e:
        logger.error(f"Email send failed: {e}")
        return False


def send_whatsapp(to_phone: str, body: str) -> bool:
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER and to_phone):
        return False
    try:
        resp = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
            auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
            data={"From": TWILIO_FROM_NUMBER, "To": to_phone, "Body": body},
            timeout=30
        )
        return resp.status_code == 201
    except Exception as e:
        logger.error(f"WhatsApp send failed: {e}")
        return False


def send_linkedin(linkedin_id: str, subject: str, body: str) -> bool:
    if not (LINKEDIN_ACCESS_TOKEN and linkedin_id):
        return False
    try:
        resp = requests.post(
            "https://api.linkedin.com/v2/messages",
            headers={"Authorization": f"Bearer {LINKEDIN_ACCESS_TOKEN}", "Content-Type": "application/json"},
            json={
                "recipients": [{"person": f"urn:li:person:{linkedin_id}"}],
                "subject": subject,
                "body": body
            },
            timeout=30
        )
        return resp.status_code == 201
    except Exception as e:
        logger.error(f"LinkedIn send failed: {e}")
        return False


# ─── Main ────────────────────────────────────────────────────────
def main():
    if not AIRTABLE_API_KEY:
        logger.error("AIRTABLE_API_KEY not set")
        sys.exit(1)
    
    records = fetch_due_followups()
    if not records:
        logger.info("No follow-ups due today")
        return
    
    processed = 0
    for record in records:
        fields = record.get("fields", {})
        record_id = record["id"]
        touch_count = fields.get("Touch Count", 0)
        next_touch = touch_count + 1
        channel = fields.get("Preferred Channel", "Email")
        
        # Build messages
        msg = build_message(fields, next_touch)
        
        # Send via preferred channel
        sent = False
        if channel == "Email" and fields.get("Email"):
            sent = send_email(fields["Email"], msg["subject"], msg["email_body"])
        elif channel == "WhatsApp" and fields.get("Phone"):
            sent = send_whatsapp(fields["Phone"], msg["whatsapp_body"])
        elif channel == "LinkedIn" and fields.get("LinkedIn ID"):
            sent = send_linkedin(fields["LinkedIn ID"], msg["subject"], msg["linkedin_body"])
        else:
            # Fallback to email if available
            if fields.get("Email"):
                sent = send_email(fields["Email"], msg["subject"], msg["email_body"])
        
        # Update Airtable
        new_status = "Paused" if next_touch >= 3 else "Contacted"
        next_date = (datetime.now() + timedelta(days=30 if next_touch >= 3 else 3)).strftime("%Y-%m-%d")
        
        update_record(record_id, {
            "Touch Count": next_touch,
            "Last Touch Date": datetime.now().strftime("%Y-%m-%d"),
            "Next Follow-Up Date": next_date,
            "Status": new_status
        })
        
        if sent:
            processed += 1
            logger.info(f"Follow-up {next_touch} sent to {fields.get('Name')} via {channel}")
        else:
            logger.warning(f"Follow-up {next_touch} NOT sent to {fields.get('Name')} (channel: {channel})")
    
    logger.info(f"Completed: {processed}/{len(records)} follow-ups sent")


if __name__ == "__main__":
    main()