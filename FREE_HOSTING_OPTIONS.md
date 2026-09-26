# Hosting & Backend — Current State

Superseded by the rewrite of `README.md`. Kept only for the parts that are still useful:
running the PDF build, and the NCC compliance steps.

## Where it is hosted

Vercel, connected to the GitHub repo. Production deploys happen automatically on push to
`master`. There is no separate backend to configure.

**Do not follow the old advice in this file's history** — it recommended Netlify, Formspree
and n8n. All three are wrong now:

| Old advice | Reality |
|---|---|
| Host on Netlify, forms via `data-netlify` | Vercel; forms POST to `/api/optin` |
| Formspree or Make webhook as the form backend | Vercel serverless function |
| Import `n8n-workflow-agentcy-optin.json` | Deleted — `/api/optin` does this |
| `scripts/deliver_lead_magnet.py` | Deleted — `/api/optin` sends via Resend |

The remaining `*-followup` scenarios and `scripts/daily_followup.py` are still valid
blueprints, because the follow-up sequence is not implemented yet.

## If you need to deploy manually

```bash
vercel link --project=agentcy-optin-forms --team=<your-team-slug>
vercel --prod
```

Or just push to `master` — the GitHub integration handles it.

## Regenerating the lead magnet PDFs

```bash
python -m pip install markdown playwright
playwright install chromium
python scripts/build_lead_magnets.py
```

Commit both the `.md` change and the regenerated `.pdf`.

## NCC / POPIA compliance

Manual steps, unchanged:

1. Register as a Direct Marketer with the National Consumer Commission.
2. Install `sa-dm` on a server.
3. Deploy the monthly cleanse:

```bash
sudo mkdir -p /opt/agentcy
sudo cp ncc-cleanse.py /opt/agentcy/
sudo cp agentcy-ncc-cleanse.service agentcy-ncc-cleanse.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentcy-ncc-cleanse.timer
```

4. Configure `/etc/agentcy/ncc-cleanse.env`:

```
AIRTABLE_API_KEY=pat_xxx
SA_DM_CLI=/usr/local/bin/sa-dm
NCC_API_URL=https://api.ncc.gov.za/optout
```

## Suppression list

The lead magnet email asks recipients to reply STOP, but nothing is automated — add the
address to Resend's suppression list and to the Airtable `POPIA Consent` = "No" view
manually until an unsubscribe endpoint exists.
