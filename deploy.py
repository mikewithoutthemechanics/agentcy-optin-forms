#!/usr/bin/env python3
"""
Deploy Agentcy opt-in forms to free hosting (Netlify, Vercel, or Cloudflare Pages).
Run this after you have an account on one of these platforms.
"""

import os
import subprocess
import sys
import json
from pathlib import Path

SOURCE_DIR = Path(__file__).parent
DIST_DIR = SOURCE_DIR / "dist"

def build():
    """Copy source files to dist directory for deployment."""
    import shutil
    
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True)
    
    # Copy all HTML, CSS, JS, PDF files
    for ext in ['*.html', '*.pdf', '*.json', '*.md', '*.txt']:
        for f in SOURCE_DIR.glob(ext):
            if f.name != 'deploy.py' and f.name != 'README.md':
                shutil.copy2(f, DIST_DIR / f.name)
    
    # Create _redirects for Netlify (SPA fallback)
    (DIST_DIR / "_redirects").write_text("/*    /index.html   200\n")
    
    # Create vercel.json for Vercel
    (DIST_DIR / "vercel.json").write_text(json.dumps({
        "buildCommand": "echo 'no build needed'",
        "outputDirectory": ".",
        "framework": None,
        "rewrites": [{"source": "/(.*)", "destination": "/index.html"}]
    }, indent=2))
    
    # Create _routes.json for Cloudflare Pages
    (DIST_DIR / "_routes.json").write_text(json.dumps({
        "version": 1,
        "include": ["/*"],
        "exclude": []
    }, indent=2))
    
    print(f"✅ Built to {DIST_DIR}")

def deploy_netlify():
    """Deploy to Netlify (requires netlify-cli: npm i -g netlify-cli)."""
    try:
        subprocess.run(["netlify", "deploy", "--prod", "--dir", str(DIST_DIR)], check=True)
        print("✅ Deployed to Netlify!")
    except FileNotFoundError:
        print("❌ netlify-cli not installed. Run: npm i -g netlify-cli")
    except subprocess.CalledProcessError as e:
        print(f"❌ Netlify deploy failed: {e}")

def deploy_vercel():
    """Deploy to Vercel (requires vercel CLI: npm i -g vercel)."""
    try:
        subprocess.run(["vercel", "--prod", "--cwd", str(DIST_DIR)], check=True)
        print("✅ Deployed to Vercel!")
    except FileNotFoundError:
        print("❌ vercel CLI not installed. Run: npm i -g vercel")
    except subprocess.CalledProcessError as e:
        print(f"❌ Vercel deploy failed: {e}")

def deploy_cloudflare():
    """Deploy to Cloudflare Pages (requires wrangler: npm i -g wrangler)."""
    try:
        # For Pages, you typically connect a Git repo in the dashboard
        # This is a manual step, but we can use wrangler for Workers
        print("ℹ️  Cloudflare Pages: Connect your Git repo at https://dash.cloudflare.com/pages")
        print("   Build command: (none)")
        print("   Output directory: /")
    except Exception as e:
        print(f"❌ Cloudflare deploy failed: {e}")

def test_forms():
    """Start a local server to test forms visually."""
    import http.server
    import socketserver
    import webbrowser
    import threading
    import time
    
    PORT = 8080
    os.chdir(DIST_DIR)
    
    handler = http.server.SimpleHTTPRequestHandler
    httpd = socketserver.TCPServer(("", PORT), handler)
    
    print(f"🌐 Starting test server at http://localhost:{PORT}")
    print("   Opening browser...")
    
    def open_browser():
        time.sleep(1)
        webbrowser.open(f"http://localhost:{PORT}")
    
    threading.Thread(target=open_browser, daemon=True).start()
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Server stopped")

def main():
    if len(sys.argv) < 2:
        print("Usage: python deploy.py [build|netlify|vercel|cloudflare|test]")
        return
    
    command = sys.argv[1]
    
    if command == "build":
        build()
    elif command == "netlify":
        build()
        deploy_netlify()
    elif command == "vercel":
        build()
        deploy_vercel()
    elif command == "cloudflare":
        build()
        deploy_cloudflare()
    elif command == "test":
        build()
        test_forms()
    else:
        print(f"Unknown command: {command}")

if __name__ == "__main__":
    main()