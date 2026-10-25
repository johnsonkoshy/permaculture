"""Build the Apps Script project in dist/ and the Netlify site in site/ from the Event Hub prototype.

The page is event-hub/src.html with photos inlined, the prototype-only blocks removed, and the
live bridge (src/bridge.js) dropped in where the prototype leaves a marker.

Prototype-only blocks in src.html: HTML between <!--PROTO--> and <!--/PROTO-->, and CSS or JS
between /*PROTO*/ and /*/PROTO*/, each marker on its own line. event-hub/build.py keeps them."""
import base64
import pathlib
import re
import shutil
import subprocess

here = pathlib.Path(__file__).parent
hub = here.parent / "event-hub"
dist = here / "dist"
dist.mkdir(exist_ok=True)


def strip_proto(html):
    """Remove the prototype-only blocks. Markers must come in open/close pairs of the same kind, never nested."""
    marker = re.compile(r"<!--(/?)PROTO-->|/\*(/?)PROTO\*/")
    want = None
    for m in marker.finditer(html):
        kind = "html" if m.group(0).startswith("<!--") else "js"
        closing = bool(m.group(1) or m.group(2))
        line = html.count("\n", 0, m.start()) + 1
        own = html[html.rfind("\n", 0, m.start()) + 1:m.start()].strip() == "" and html[m.end():].split("\n", 1)[0].strip() == ""
        assert own, f"src.html line {line}: put {m.group(0)} on a line of its own"
        if not closing:
            assert want is None, f"src.html line {line}: PROTO block opened inside another one"
            want = kind
        else:
            assert want == kind, f"src.html line {line}: {m.group(0)} has no matching opening marker"
            want = None
    assert want is None, "src.html: a PROTO block is never closed"
    html = re.sub(r"[ \t]*<!--PROTO-->.*?<!--/PROTO-->[ \t]*\n?", "", html, flags=re.S)
    html = re.sub(r"[ \t]*/\*PROTO\*/.*?/\*/PROTO\*/[ \t]*\n?", "", html, flags=re.S)
    assert not re.search(r"PROTO(-->|\*/)", html), "a PROTO marker was left in the live page"
    return html


html = strip_proto((hub / "src.html").read_text())
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
# A friendly bar for script errors; the details go to the console. Same script as ON_ERROR in src/Code.js
# (a test checks they match). No "//" anywhere in it: Apps Script's HtmlService would cut the line there.
on_err = ("(function(){var shown=0;window.addEventListener('error',function(e){"
          "var m=String((e&&e.message)||''),f=String((e&&e.filename)||'');"
          "if(m==='Script error.'||/ResizeObserver loop/.test(m)||/^(chrome|moz|safari)-extension:/.test(f))return;"
          "console.error('Event Hub error: '+m+' ('+f+' '+(e.lineno||0)+':'+(e.colno||0)+')',e.error||'');"
          "if(shown)return;shown=1;"
          "var d=document.createElement('div');d.id='err-bar';d.setAttribute('role','alert');"
          "d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;"
          "padding:12px max(16px,env(safe-area-inset-right,0px)) calc(12px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));"
          "background:var(--raised,#fff);color:var(--ink,#1B2A21);border-top:3px solid var(--flag,#C24A22);box-shadow:0 -6px 20px rgba(0,0,0,.18);"
          "font:15px/1.45 var(--body,system-ui,sans-serif)';"
          "var t=document.createElement('span');t.style.flex='1 1 220px';"
          "t.textContent='Something went wrong. Please refresh the page. If it keeps happening, email the Guild.';"
          "var b=document.createElement('button');b.type='button';b.textContent='Dismiss';"
          "b.style.cssText='border:1px solid var(--line-2,#C5CCB9);background:transparent;color:inherit;border-radius:999px;padding:7px 14px;font:inherit;font-weight:700;cursor:pointer';"
          "b.addEventListener('click',function(){d.remove()});"
          "d.appendChild(t);d.appendChild(b);(document.body||document.documentElement).appendChild(d)})})();")
assert "//" not in on_err
config = ("window.EBPG_GAS={api:" + '"' + API_URL + '"' + ",url:location.origin+location.pathname,"
          "ev:(new URLSearchParams(location.search).get('ev')||'').slice(0,40)};")
# Share previews: what a link to the site (or to an event's ?ev= page) shows in WhatsApp, iMessage, Slack and social posts.
# The page is static, so every link previews as the Guild; og.jpg is the trellis photo.
SITE_URL = "https://ebpg-event-hub.netlify.app/"
desc = "Garden work days, monthly potlucks and volunteer sign-up for the East Bay Permaculture Guild in Oakland."
share = (f'<link rel="canonical" href="{SITE_URL}">\n'
         '<meta property="og:type" content="website">\n<meta property="og:site_name" content="East Bay Permaculture Guild">\n'
         f'<meta property="og:title" content="East Bay Permaculture Guild">\n<meta property="og:description" content="{desc}">\n'
         f'<meta property="og:url" content="{SITE_URL}">\n<meta property="og:image" content="{SITE_URL}og.jpg">\n'
         '<meta property="og:image:width" content="560">\n<meta property="og:image:height" content="421">\n'
         '<meta property="og:image:alt" content="A volunteer ties a wire trellis in a garden bed">\n'
         '<meta name="twitter:card" content="summary_large_image">\n')
head = ('<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<title>East Bay Permaculture Guild</title>\n<meta name="description" content="{desc}">\n{share}'
        f'<link rel="icon" href="{icon}">\n<script>{on_err}{config}</script>\n')
(site / "index.html").write_text(head + page)
shutil.copy(hub / "assets" / "trellis.jpg", site / "og.jpg")
(site / "_headers").write_text("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n")
print("built site/:", len(head + page) // 1024, "KB page")

# The Posting Helper (chrome-extension/), served as /ebpg-posting-helper.zip for the install steps in the Outreach list
# and on the Help page. Its zip script needs only Node and gives the same zip for the same files, so it runs each time
# to keep the zip current; if it can't, the zip already built is used. The site still builds without it, with a warning.
ext = here.parent / "chrome-extension"
zip_src, zip_out = ext / "dist" / "ebpg-posting-helper.zip", site / "ebpg-posting-helper.zip"
try:
    subprocess.run(["node", str(ext / "tools" / "build-zip.js")], check=True, capture_output=True, timeout=120)
except (OSError, subprocess.SubprocessError) as e:
    print("warning: could not build the Posting Helper zip (" + str(e).splitlines()[0] + ")" + ("; using the one already built" if zip_src.exists() else ""))
if zip_src.exists():
    shutil.copy(zip_src, zip_out)
    print("copied site/ebpg-posting-helper.zip:", zip_out.stat().st_size // 1024, "KB")
else:
    zip_out.unlink(missing_ok=True)
    print("warning: site/ebpg-posting-helper.zip is missing, so the Posting Helper's Download link won't work on the site. Build it with: cd chrome-extension && node tools/build-zip.js")
