#!/usr/bin/env python3
"""
Agentcy Lead Magnet Delivery — GitHub Actions Version
Triggered via workflow_dispatch with JSON payload from form submission.
"""

import os
import sys
import json
import logging
import requests
from datetime import datetime
from typing import Dict, Any

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

# Lead magnet files (hosted publicly or attached)
LEAD_MAGNETS = {
    "Trades: Stop Losing Quotes": {
        "file": "lead-magnet-trades.pdf",
        "url": "https://agentcy.co.za/lead-magnets/lead-magnet-trades.pdf"
    },
    "Online SMB: Find 3 Automations": {
        "file": "lead-magnet-online-smb.pdf",
        "url": "https://agentcy.co.za/lead-magnets/lead-magnet-online-smb.pdf"
    },
    "Prof Services: AI Readiness Checklist": {
        "file": "lead-magnet-prof-services.pdf",
        "url": "https://agentcy.co.za/lead-magnets/lead-magnet-prof-services.pdf"
    }
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def create_airtable_record(data: Dict) -> bool:
    """Create record in Airtable."""
    fields = {
        "Name": data.get("name"),
        "Business": data.get("business"),
        "Segment": data.get("segment"),
        "Area": data.get("area", ""),
        "Preferred Channel": data.get("preferred_channel"),
        "Pain Point": data.get("pain_point"),
        "Current Tools": data.get("current_tools", ""),
        "POPIA Consent": "Yes",
        "Consent Basis": data.get("consent_basis", "Form Opt-In"),
        "Source": data.get("source", "website"),
        "Opt-In Date": data.get("optin_date", datetime.now().strftime("%Y-%m-%d")),
        "Status": "New Opt-In",
        "Booked Call": "No",
        "Attended": "No",
        "Qualified": "No",
        "Proposal Sent": "No",
        "Outcome": "",
        "Next Action": "Send lead magnet + schedule follow-up",
        "Next Follow-Up Date": (datetime.now()).strftime("%Y-%m-%d"),  # +2 days
        "Touch Count": 0,
        "Last Touch Date": datetime.now().strftime("%Y-%m-%d"),
        "Lead Magnet": data.get("lead_magnet")
    }
    
    resp = requests.post(AIRTABLE_URL, headers=AIRTABLE_HEADERS, json={"fields": fields}, timeout=30)
    if resp.status_code in (200, 201):
        logger.info(f"Created Airtable record for {data.get('name')}")
        return True
    else:
        logger.error(f"Airtable create failed: {resp.text}")
        return False


def build_delivery_content(data: Dict) -> Dict[str, str]:
    """Build delivery content for all channels."""
    name = (data.get("name") or "there").split()[0]
    segment = data.get("segment", "")
    lead_magnet_key = data.get("lead_magnet", "")
    magnet = LEAD_MAGNETS.get(lead_magnet_key, {})
    magnet_url = magnet.get("url", "")
    
    if segment == "KZN Trades/Local SMBs":
        subject = f'Your "Stop Losing Quotes" Blueprint is Ready, {name}!'
        email_body = f"""Hi {name},

Your personalized automation blueprint is ready: {magnet_url}

It includes:
1. WhatsApp Instant Auto-Reply + Job Logging (15 min setup)
2. Quote Follow-Up Sequence That Runs 24/7 (30 min setup)
3. After-Hours Lead Capture + Morning Handoff (20 min setup)

Plus: Print-ready WhatsApp QR cards for your vehicles.

Total setup time: ~1.5 hours. All free tools (Make, Airtable, WhatsApp Business).

---
Next step: I'll follow up in 2 days to see which automation you want to implement first.

Want us to build it for you? Book a free 30-min strategy call:
https://calendly.com/agentcy/30min-strategy

---
Michael @ Agentcy
hello@agentcy.co.za
+27 XX XXX XXXX

P.S. Reply STOP anytime to opt out (POPIA compliant)."""
        whatsapp = f"""Hi {name}! Your "Stop Losing Quotes" blueprint is ready 📋
{magnet_url}

3 automations Punctual Plumbers uses:
1. WhatsApp auto-reply + job log (15 min)
2. Quote follow-up sequence (30 min) 
3. After-hours capture (20 min)

Want the Make templates imported? Book a free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
    
    elif segment == "National Online SMBs":
        subject = f'Your 3-Automation Roadmap is Ready, {name}!'
        email_body = f"""Hi {name},

Your personalized "Find 3 Automations" roadmap is ready: {magnet_url}

Based on your stack, the highest-impact picks:
1. Unified Order → Inventory → Accounting Sync (saves 5-8 hrs/week)
2. Customer Comms Unification: WhatsApp + Email + Instagram → One Inbox (saves 3-5 hrs/week)
3. Automated Daily Dashboard to WhatsApp/Email (saves 2-3 hrs/week + better decisions)

Plus: Time Tax Audit spreadsheet to prioritize your own backlog.

---
Next step: I'll follow up in 2 days — which automation felt highest leverage?

Ready to build? Book a free 30-min strategy call:
https://calendly.com/agentcy/30min-strategy

---
Michael @ Agentcy
hello@agentcy.co.za
+27 XX XXX XXXX

P.S. Reply STOP anytime to opt out (POPIA compliant)."""
        whatsapp = f"""Hi {name}! Your 3-automation roadmap is ready 📊
{magnet_url}

Top picks:
1. Order→Inventory→Xero sync (5-8 hrs saved)
2. WhatsApp+Email+IG → one inbox (3-5 hrs)
3. Daily dashboard to WhatsApp (2-3 hrs)

Want the Make templates? Free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
    
    else:  # Professional Services
        subject = f'Your AI Readiness Scorecard is Ready, {name}!'
        email_body = f"""Hi {name},

Your AI Readiness & Workflow Scorecard is ready: {magnet_url}

It scores your practice across 5 dimensions:
1. Client Onboarding & Intake (25% weight)
2. Knowledge Management & Institutional Memory (20%)
3. Reporting & Client Communication (20%)
4. Meeting-to-CRM & Action Tracking (20%)
5. AI & Automation Maturity (15%)

Plus: Priority Matrix (Effort vs. Impact), 3 Quick-Win Make Blueprints, 90-Day Roadmap, and Tool Budget.

---
Next step: I'll follow up in 3 days — which dimension scored lowest?

Want the blueprints implemented? Book a free 30-min strategy call:
https://calendly.com/agentcy/30min-strategy

---
Michael @ Agentcy
hello@agentcy.co.za
+27 XX XXX XXXX

P.S. Reply STOP anytime to opt out (POPIA compliant)."""
        whatsapp = f"""Hi {name}! Your AI Readiness Scorecard is ready 📈
{magnet_url}

5-dimension score + priority matrix + 3 quick-win Make blueprints + 90-day roadmap.

Want the blueprints implemented? Free 30-min call:
https://calendly.com/agentcy/30min-strategy

Reply STOP to opt out."""
    
    linkedin = f"Hi {name}, your {lead_magnet_key} is ready: {magnet_url}. Free 30-min strategy call: https://calendly.com/agentcy/30min-strategy"
    
    return {
        "subject": subject,
        "email_body": email_body,
        "whatsapp_body": whatsapp,
        "linkedin_body": linkedin,
        "magnet_url": magnet_url
    }


def send_email(to_email: str, subject: str, body: str) -> bool:
    if not SENDGRID_API_KEY or not to_email:
        logger.warning("SendGrid not configured or no email")
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
        logger.warning("Twilio not configured or no phone")
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


def send_linkedin(linkedin_id: str, body: str) -> bool:
    if not (LINKEDIN_ACCESS_TOKEN and linkedin_id):
        logger.warning("LinkedIn not configured or no ID")
        return False
    try:
        resp = requests.post(
            "https://api.linkedin.com/v2/messages",
            headers={"Authorization": f"Bearer {LINKEDIN_ACCESS_TOKEN}", "Content-Type": "application/json"},
            json={
                "recipients": [{"person": f"urn:li:person:{linkedin_id}"}],
                "subject": "Your Agentcy Lead Magnet",
                "body": body
            },
            timeout=30
        )
        return resp.status_code == 201
    except Exception as e:
        logger.error(f"LinkedIn send failed: {e}")
        return False


def main():
    if len(sys.argv) < 2:
        logger.error("Usage: python deliver_lead_magnet.py '<json_payload>'")
        sys.exit(1)
    
    try:
        data = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON payload: {e}")
        sys.exit(1)
    
    if not AIRTABLE_API_KEY:
        logger.error("AIRTABLE_API_KEY not set")
        sys.exit(1)
    
    # 1. Create Airtable record
    if not create_airtable_record(data):
        sys.exit(1)
    
    # 2. Build delivery content
    content = build_delivery_content(data)
    
    # 3. Send via preferred channel
    channel = data.get("preferred_channel", "Email")
    sent = False
    
    if channel == "Email" and data.get("email"):
        sent = send_email(data["email"], content["subject"], content["email_body"])
    elif channel == "WhatsApp" and data.get("phone"):
        sent = send_whatsapp(data["phone"], content["whatsapp_body"])
    elif channel == "LinkedIn" and data.get("linkedin_id"):
        sent = send_linkedin(data["linkedin_id"], content["linkedin_body"])
    else:
        # Fallback
        if data.get("email"):
            sent = send_email(data["email"], content["subject"], content["email_body"])
    
    if sent:
        logger.info(f"Lead magnet delivered to {data.get('name')} via {channel}")
    else:
        logger.warning(f"Lead magnet NOT delivered to {data.get('name')} (channel: {channel})")
    
    # Output for GitHub Actions
    print(json.dumps({"success": sent, "channel": channel, "magnet_url": content["magnet_url"]}))


if __name__ == "__main__":
    main()