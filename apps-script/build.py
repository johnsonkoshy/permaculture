"""Build the Apps Script project in dist/ and the Netlify site in site/ from the Event Hub prototype.

The page is event-hub/src.html with photos inlined and the live bridge
(src/bridge.js) dropped in where the prototype leaves a marker."""
import base64
import pathlib
import shutil
import subprocess

here = pathlib.Path(__file__).parent
hub = here.parent / "event-hub"
dist = here / "dist"
dist.mkdir(exist_ok=True)

html = (hub / "src.html").read_text()
assert "/*__GAS_BRIDGE__*/" in html, "bridge marker missing from event-hub/src.html"
html = html.replace("/*__GAS_BRIDGE__*/", (here / "src" / "bridge.js").read_text())
for img in sorted((hub / "assets").iterdir()):
    mime = "image/png" if img.suffix == ".png" else "image/jpeg"
    data = base64.b64encode(img.read_bytes()).decode()
    token = "__IMG_" + img.stem.upper().replace("-", "_") + "__"
    html = html.replace(token, f"data:{mime};base64,{data}")
(dist / "index.html").write_text(html)
subprocess.run(["node", str(here / "gas-safe.js"), str(dist / "index.html")], check=True)
for f in ("Code.js", "appsscript.json"):
    shutil.copy(here / "src" / f, dist / f)
print("built dist/:", len(html) // 1024, "KB page")

# Netlify: the same page as a normal website that calls the Apps Script JSON API.
API_URL = "https://script.google.com/macros/s/AKfycbxy4le3b-fRgH9BjhSZrcPf3TDcSgzMZ0sDnZEeRiZsCnPoX5jPVy6GU5DPtyoUjERf/exec"
site = here / "site"
site.mkdir(exist_ok=True)
page = (dist / "index.html").read_text().replace("<title>EBPG Event Hub</title>\n", "", 1)
icon = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23264D3A'/%3E"
        "%3Cpath d='M16 25V14M16 17c-5 0-7-3-7-7 5 0 7 3 7 7zm0-2c0-4 3-7 8-7 0 4-3 7-8 7z' fill='%23A8C49A' stroke='%23A8C49A' stroke-width='1.5'/%3E%3C/svg%3E")
on_err = ("window.addEventListener('error',function(e){var d=document.createElement('div');d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;"
          "background:#9b2c2c;color:#fff;font:13px/1.4 monospace;padding:8px 12px';d.textContent='Something broke: '+e.message+' (line '+e.lineno+')';"
          "(document.body||document.documentElement).appendChild(d)});")
config = ("window.EBPG_GAS={api:" + '"' + API_URL + '"' + ",url:location.origin+location.pathname,"
          "ev:(new URLSearchParams(location.search).get('ev')||'').slice(0,40)};")
head = ('<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<title>East Bay Permaculture Guild</title>\n<meta name="description" content="Garden work days, monthly potlucks and volunteer sign-up for the East Bay Permaculture Guild in Oakland.">\n'
        f'<link rel="icon" href="{icon}">\n<script>{on_err}{config}</script>\n')
(site / "index.html").write_text(head + page)
(site / "_headers").write_text("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n")
print("built site/:", len(head + page) // 1024, "KB page")
