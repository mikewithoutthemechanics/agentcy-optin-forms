#!/usr/bin/env python3
"""
Agentcy NCC Opt-Out Registry Cleansing Script
Runs monthly to cleanse Airtable outreach lists against the NCC opt-out registry.
Uses sa-dm tooling for compliance.
"""

import os
import sys
import json
import logging
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Set
import subprocess

# Configuration
AIRTABLE_API_KEY = os.environ.get("AIRTABLE_API_KEY")
AIRTABLE_BASE_ID = "app0CK3JUNYEGcCMV"
AIRTABLE_TABLE_ID = "tblnhzmqneNswTvGd"
NCC_API_URL = os.environ.get("NCC_API_URL", "https://api.ncc.gov.za/optout")  # Placeholder
SA_DM_CLI = os.environ.get("SA_DM_CLI", "sa-dm")  # sa-dm CLI command

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("/var/log/agentcy-ncc-cleanse.log"),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


def fetch_airtable_records() -> List[Dict]:
    """Fetch all active outreach records from Airtable."""
    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}"
    headers = {"Authorization": f"Bearer {AIRTABLE_API_KEY}"}
    
    all_records = []
    offset = None
    
    while True:
        params = {"pageSize": 100}
        if offset:
            params["offset"] = offset
        
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        data = response.json()
        
        all_records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
    
    logger.info(f"Fetched {len(all_records)} records from Airtable")
    return all_records


def extract_contact_info(records: List[Dict]) -> List[Dict]:
    """Extract contact identifiers for NCC checking."""
    contacts = []
    for record in records:
        fields = record.get("fields", {})
        if fields.get("POPIA Consent") == "Yes" and fields.get("Status") not in ["Won", "Lost", "Paused"]:
            contact = {
                "record_id": record["id"],
                "name": fields.get("Name", ""),
                "email": fields.get("Email", ""),
                "phone": fields.get("Phone", ""),
                "whatsapp": fields.get("Phone", ""),
                "preferred_channel": fields.get("Preferred Channel", ""),
            }
            contacts.append(contact)
    logger.info(f"Extracted {len(contacts)} active contacts for NCC check")
    return contacts


def check_ncc_registry_sa_dm(contacts: List[Dict]) -> Set[str]:
    """
    Use sa-dm CLI to check contacts against NCC opt-out registry.
    Returns set of record_ids that are opted out.
    """
    opted_out = set()
    
    # Prepare input for sa-dm (CSV format)
    import csv
    import io
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["record_id", "email", "phone", "name"])
    for c in contacts:
        writer.writerow([c["record_id"], c["email"], c["phone"], c["name"]])
    
    csv_input = output.getvalue()
    
    try:
        # Run sa-dm check command
        # Expected: sa-dm check --input - --output - --format csv
        result = subprocess.run(
            [SA_DM_CLI, "check", "--input", "-", "--output", "-", "--format", "csv"],
            input=csv_input,
            capture_output=True,
            text=True,
            timeout=120
        )
        
        if result.returncode != 0:
            logger.error(f"sa-dm failed: {result.stderr}")
            return opted_out
        
        # Parse output
        reader = csv.DictReader(io.StringIO(result.stdout))
        for row in reader:
            if row.get("opted_out", "").lower() in ("true", "yes", "1"):
                opted_out.add(row["record_id"])
        
        logger.info(f"sa-dm found {len(opted_out)} opted-out contacts")
        
    except FileNotFoundError:
        logger.error(f"sa-dm CLI not found at {SA_DM_CLI}. Install sa-dm or update SA_DM_CLI env var.")
    except subprocess.TimeoutExpired:
        logger.error("sa-dm command timed out")
    except Exception as e:
        logger.error(f"sa-dm check failed: {e}")
    
    return opted_out


def check_ncc_registry_api(contacts: List[Dict]) -> Set[str]:
    """
    Fallback: Check NCC registry via API (if sa-dm not available).
    """
    opted_out = set()
    
    for contact in contacts:
        # Check email and phone
        identifiers = []
        if contact["email"]:
            identifiers.append(("email", contact["email"]))
        if contact["phone"]:
            identifiers.append(("phone", contact["phone"]))
        
        for id_type, identifier in identifiers:
            try:
                response = requests.post(
                    f"{NCC_API_URL}/check",
                    json={id_type: identifier},
                    timeout=10
                )
                if response.status_code == 200:
                    data = response.json()
                    if data.get("opted_out"):
                        opted_out.add(contact["record_id"])
                        break
            except Exception as e:
                logger.warning(f"NCC API check failed for {identifier}: {e}")
    
    logger.info(f"NCC API found {len(opted_out)} opted-out contacts")
    return opted_out


def update_airtable_opted_out(record_ids: Set[str]) -> int:
    """Mark opted-out records in Airtable."""
    if not record_ids:
        return 0
    
    url = f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{AIRTABLE_TABLE_ID}"
    headers = {
        "Authorization": f"Bearer {AIRTABLE_API_KEY}",
        "Content-Type": "application/json"
    }
    
    updated = 0
    # Batch update in chunks of 10
    record_list = list(record_ids)
    for i in range(0, len(record_list), 10):
        batch = record_list[i:i+10]
        records_payload = {
            "records": [
                {
                    "id": rid,
                    "fields": {
                        "POPIA Consent": "No",
                        "Status": "Paused",
                        "Next Action": "NCC opt-out detected - marketing paused",
                        "Consent Basis": "NCC Registry Opt-Out"
                    }
                }
                for rid in batch
            ]
        }
        
        try:
            response = requests.patch(url, headers=headers, json=records_payload)
            response.raise_for_status()
            updated += len(batch)
            logger.info(f"Updated {len(batch)} records as opted-out")
        except Exception as e:
            logger.error(f"Failed to update batch: {e}")
    
    return updated


def generate_audit_log(contacts: List[Dict], opted_out: Set[str]) -> str:
    """Generate audit log entry for compliance."""
    audit_entry = {
        "timestamp": datetime.now().isoformat(),
        "total_checked": len(contacts),
        "opted_out_count": len(opted_out),
        "opted_out_record_ids": list(opted_out),
        "script_version": "1.0",
        "compliance": "POPIA Section 69 - Direct Marketing Opt-Out"
    }
    return json.dumps(audit_entry, indent=2)


def main():
    logger.info("=" * 60)
    logger.info("Agentcy NCC Opt-Out Registry Cleansing - Started")
    logger.info("=" * 60)
    
    if not AIRTABLE_API_KEY:
        logger.error("AIRTABLE_API_KEY environment variable not set")
        sys.exit(1)
    
    try:
        # 1. Fetch active records
        records = fetch_airtable_records()
        
        # 2. Extract contact info
        contacts = extract_contact_info(records)
        
        if not contacts:
            logger.info("No active contacts to check")
            return
        
        # 3. Check against NCC registry (prefer sa-dm)
        opted_out = set()
        if os.path.exists(SA_DM_CLI) or subprocess.run(["which", SA_DM_CLI], capture_output=True).returncode == 0:
            opted_out = check_ncc_registry_sa_dm(contacts)
        else:
            logger.warning("sa-dm CLI not found, falling back to NCC API")
            opted_out = check_ncc_registry_api(contacts)
        
        # 4. Update Airtable
        updated = update_airtable_opted_out(opted_out)
        
        # 5. Generate audit log
        audit_log = generate_audit_log(contacts, opted_out)
        log_path = f"/var/log/agentcy-ncc-audit-{datetime.now().strftime('%Y%m')}.json"
        with open(log_path, "a") as f:
            f.write(audit_log + "\n")
        logger.info(f"Audit log written to {log_path}")
        
        logger.info("=" * 60)
        logger.info(f"Cleansing complete: {updated} records updated, {len(opted_out)} opted-out")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.exception(f"Cleansing failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()