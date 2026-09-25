"""Render the lead-magnet markdown documents to the PDFs that get emailed out.

The PDFs are build artifacts: edit the .md source, then re-run this script.
It was added because the PDFs previously shipped a "+27 XX XXX XXXX"
placeholder that no one could regenerate or fix.

    python scripts/build-lead_magnets.py            # all documents
    python scripts/build-lead_magnets.py trades     # just one

Requires: markdown, playwright (plus `playwright install chromium`).
"""

import re
import sys
from pathlib import Path

import markdown
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

DOCUMENTS = {
    "trades": "lead-magnet-trades",
    "online-smb": "lead-magnet-online-smb",
    "prof-services": "lead-magnet-prof-services",
}

PHONE_DISPLAY = "+27 83 791 5429"
PHONE_LOCAL = "083 791 5429"

CSS = """
@page { size: A4; margin: 18mm 16mm; }

body {
  font-family: "Segoe UI", -apple-system, Helvetica, Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.55;
  color: #18181b;
  max-width: 178mm;
  margin: 0 auto;
}

h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 4mm; letter-spacing: -0.02em; }
h2 {
  font-size: 14pt; margin: 9mm 0 3mm; padding-bottom: 1.5mm;
  border-bottom: 2px solid #22d3ee;
}
h3 { font-size: 11.5pt; margin: 6mm 0 2mm; color: #0e7490; }
h4 { font-size: 10.5pt; margin: 4mm 0 1.5mm; }

p { margin: 0 0 3mm; }
ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
li { margin-bottom: 1.5mm; }

a { color: #0e7490; text-decoration: none; }

code {
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 9pt; background: #f4f4f5; padding: 0.4mm 1.2mm; border-radius: 2px;
}

pre {
  background: #18181b; color: #f4f4f5; padding: 3.5mm 4mm; border-radius: 2mm;
  font-size: 8.5pt; line-height: 1.4; overflow: visible; white-space: pre-wrap;
  word-break: break-word;
}
pre code { background: none; color: inherit; padding: 0; font-size: inherit; }

blockquote {
  margin: 0 0 3mm; padding: 2mm 4mm; border-left: 3px solid #22d3ee;
  background: #ecfeff; color: #155e75;
}

table { border-collapse: collapse; width: 100%; margin: 0 0 4mm; font-size: 9.5pt; }
th, td { border: 1px solid #d4d4d8; padding: 1.8mm 2.5mm; text-align: left; vertical-align: top; }
th { background: #f4f4f5; font-weight: 700; }

hr { border: 0; border-top: 1px solid #d4d4d8; margin: 6mm 0; }

strong { color: #0891b2; }

h1 + p { font-size: 11.5pt; color: #52525b; }
"""


def build_html(md_text: str) -> str:
    body = markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "sane_lists", "attr_list"],
    )
    # Drop the duplicated H1: the document title is already the first heading
    # and Chromium repeats it as a header when the margin box is enabled.
    body = re.sub(r"^\s*<h1[^>]*>.*?</h1>", "", body, count=1, flags=re.S)
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        f"<style>{CSS}</style></head><body>{body}</body></html>"
    )


def main() -> int:
    wanted = [a.lower() for a in sys.argv[1:]] or list(DOCUMENTS)
    unknown = [w for w in wanted if w not in DOCUMENTS]
    if unknown:
        print(f"Unknown document(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Available: {', '.join(DOCUMENTS)}", file=sys.stderr)
        return 1

    built = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        for key in wanted:
            stem = DOCUMENTS[key]
            src = ROOT / f"{stem}.md"
            out = ROOT / f"{stem}.pdf"
            if not src.exists():
                print(f"  missing source: {src.name}", file=sys.stderr)
                return 1

            html = build_html(src.read_text(encoding="utf-8"))
            tmp = ROOT / f".{stem}.build.html"
            tmp.write_text(html, encoding="utf-8")
            try:
                page.goto(tmp.resolve().as_uri(), wait_until="load")
                page.pdf(
                    path=str(out),
                    format="A4",
                    print_background=True,
                    display_header_footer=False,
                )
            finally:
                tmp.unlink(missing_ok=True)

            pages = out.stat().st_size
            print(f"  built {out.name}  ({pages:,} bytes)")
            built.append(out.name)

        browser.close()

    print(f"\n{len(built)} PDF(s) written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
