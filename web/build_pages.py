"""Build the browser app.

1. web/app.html: the standalone page (no doctype, html, head or body tags). It starts with <title>,
   then the fonts stylesheet, then <style>, then the body markup and two scripts: the core
   (web/src/core/*.js in name order) and the interface (web/src/ui/*.js in name order).
2. docs/index.html: app.html wrapped as a full HTML document for GitHub Pages, with a
   Content-Security-Policy that allows only this page's own scripts and no connections at all, the
   PWA manifest, icons and a service worker that caches the app shell. The Pages build drops the
   web font link and uses the system fallbacks named in the font stacks, so it makes no requests.

Run: python web/build_pages.py
"""

import base64
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "src"
APP = ROOT / "web" / "app.html"
DOCS = ROOT / "docs"


def read(p):
    return p.read_text(encoding="utf-8")


ICONS = json.loads(read(SRC / "icons.json"))
PRODUCT = re.search(r'const PRODUCT_NAME = "([^"]+)";', read(SRC / "core" / "00_brand.js")).group(1)


def icon_svg(name):
    return ('<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>')


def joined(folder):
    return "\n".join(f"// ---- {p.parent.name}/{p.name}\n" + read(p) for p in sorted(folder.glob("*.js")))


def build_app():
    core = joined(SRC / "core")
    ui = joined(SRC / "ui").replace("/*ICONS*/", json.dumps(ICONS, sort_keys=True))
    for name, js in (("core", core), ("ui", ui)):
        if "</script" in js.lower():
            raise SystemExit(f"the {name} script contains '</script'; it would end the block early")
    body = re.sub(r"\{\{icon:([a-z0-9-]+)\}\}", lambda m: icon_svg(m.group(1)), read(SRC / "body.html"))
    t = read(SRC / "app.template.html")
    for key, val in (("/*TITLE*/", PRODUCT), ("/*STYLE*/", read(SRC / "style.css")), ("<!--BODY-->", body), ("/*CORE*/", core), ("/*UI*/", ui)):
        t = t.replace(key, val.rstrip("\n"))
    APP.write_text(t, encoding="utf-8")
    return t


CSP = ("default-src 'none'; script-src {SCRIPT_HASHES}; style-src 'unsafe-inline'; img-src 'self' data: blob:; "
       "connect-src 'none'; font-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'; "
       "object-src 'none'; frame-src 'none'")

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="referrer" content="no-referrer">
<meta name="description" content="Free, local-first critical path scheduler. Opens Primavera P6 XER and Microsoft Project XML files. Runs entirely in your browser.">
<meta name="theme-color" content="#14232b" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#080b0d" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-192.png">
"""

# Framing guard: a page that another site puts in a frame could be used to trick clicks (for example
# on Delete all data), and GitHub Pages cannot send a header that forbids framing. When framed, the
# page hides its markup, the interface does not start, and a short notice links to the app in its
# own tab. The script is covered by the Content-Security-Policy hash like the others.
FRAME_GUARD = """<script>
(function () {
  var framed = true;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed) return;
  document.documentElement.setAttribute("data-framed", "");
  document.addEventListener("DOMContentLoaded", function () {
    var box = document.createElement("div");
    box.id = "framed";
    var h = document.createElement("h1");
    h.textContent = "This page is shown inside another site.";
    var p = document.createElement("p");
    p.textContent = "For your safety the scheduler only runs in its own tab.";
    var a = document.createElement("a");
    a.href = location.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Open the scheduler in its own tab";
    box.appendChild(h); box.appendChild(p); box.appendChild(a);
    document.body.insertBefore(box, document.body.firstChild);
  });
})();
</script>
<style>html[data-framed] body > :not(#framed){display:none!important}#framed{padding:24px max(16px,env(safe-area-inset-left,0px));font:400 1rem/1.5 system-ui,sans-serif}#framed h1{font-size:1.25rem;margin:0 0 8px}</style>
"""

SW_REG = """<script>
if ("serviceWorker" in navigator && location.protocol === "https:") {
  try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {}
}
</script>
"""


FONT_FACES = "<style>" + "".join(
    f'@font-face{{font-family:"Fira Sans";src:url(fonts/fira-sans-latin-{w}-normal.woff2) format("woff2");font-weight:{w};font-display:swap}}'
    for w in (400, 500, 600, 700)) + "".join(
    f'@font-face{{font-family:"Fira Mono";src:url(fonts/fira-mono-latin-{w}-normal.woff2) format("woff2");font-weight:{w};font-display:swap}}'
    for w in (400, 500)) + ('@font-face{font-family:"Sofia Sans Condensed";src:url(fonts/sofia-sans-condensed-latin-wght-normal.woff2) '
                            'format("woff2");font-weight:1 1000;font-display:swap}</style>')


def build_docs(app):
    # the Pages build serves the three typefaces itself (SIL Open Font License, files in web/src/pwa/fonts)
    app = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>', lambda m: FONT_FACES, app, count=1)
    style_end = app.index("</style>") + len("</style>")
    doc = HEAD + FRAME_GUARD + app[:style_end] + "\n</head>\n<body>\n" + app[style_end:].lstrip("\n") + "\n" + SW_REG + "</body>\n</html>\n"
    hashes = []
    for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", doc, re.S):
        h = "'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode() + "'"
        if h not in hashes:
            hashes.append(h)
    doc = doc.replace("{CSP}", CSP.replace("{SCRIPT_HASHES}", " ".join(hashes)), 1)
    DOCS.mkdir(exist_ok=True)
    (DOCS / "index.html").write_text(doc, encoding="utf-8")
    shell = hashlib.sha256(doc.encode("utf-8"))
    for src in sorted(p for p in (SRC / "pwa").rglob("*") if p.is_file()):
        data = src.read_bytes()
        if src.suffix in (".webmanifest",):
            data = data.replace(b"/*TITLE*/", PRODUCT.encode("utf-8"))
        if src.name != "sw.js":
            shell.update(data)
        dst = DOCS / src.relative_to(SRC / "pwa")
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    sw = DOCS / "sw.js"
    sw.write_text(read(sw).replace('"cpm-shell-v1"', '"cpm-shell-' + shell.hexdigest()[:12] + '"'), encoding="utf-8")
    return DOCS / "index.html"


if __name__ == "__main__":
    app = build_app()
    out = build_docs(app)
    print(f"wrote {APP.relative_to(ROOT)} ({APP.stat().st_size:,} bytes) and {out.relative_to(ROOT)}")
