"""The page exactly as GitHub Pages serves it: the tracked docs/ folder with the publish step's links
filled in, served under /drawworks/ (a subpath, as on Pages) with its real Content-Security-Policy.

Walks the main workflows a person uses and checks the regressions found in the full function test:
a predecessor typed with a lag ("A1400SS+2h"), a cell editor that survives the table redrawing under
it, the toolbar Undo naming what it undid, the complete shortcut sheet, deleting the open schedule,
a multi-project XER opening its exported project, adding a first resource from the empty histogram,
every export parsed, offline start from the service worker, and the phone layout. Fails on any page
error, Content-Security-Policy violation or request outside the site. Skipped when Playwright or
Chromium is missing."""

import csv
import functools
import http.server
import io
import re
import shutil
import subprocess
import threading
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NAME = "drawworks"
FILL = {"https://wjwhitmire.github.io/drawworks/": f"https://wjwhitmire.github.io/{NAME}/", "wjwhitmire": "wjwhitmire",
        "https://github.com/wjwhitmire/drawworks": f"https://github.com/wjwhitmire/{NAME}"}
pw = pytest.importorskip("playwright.sync_api")

TWO_PROJECTS = ("ERMHDR\t8.0\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\texport_flag\n"
                "%R\t1\tOther\t2026-01-05 08:00\tN\n%R\t2\tMine\t2026-01-05 08:00\tY\n"
                "%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttarget_drtn_hr_cnt\n"
                "%R\t10\t2\tA\t8\n%R\t12\t1\tC\t8\n%R\t13\t1\tD\t16\n")


def published_folder(dst):
    """The tracked files of docs/ copied with the publish step's placeholder fill applied."""
    files = subprocess.run(["git", "-C", str(ROOT), "ls-files", "docs"], capture_output=True, text=True, check=True).stdout.split()
    if not files:  # not a git checkout: take the folder as it is
        files = [str(p.relative_to(ROOT)) for p in (ROOT / "docs").rglob("*") if p.is_file()]
    for f in files:
        src, out = ROOT / f, dst / NAME / Path(f).relative_to("docs")
        out.parent.mkdir(parents=True, exist_ok=True)
        data = src.read_bytes()
        for k, v in FILL.items():
            data = data.replace(k.encode(), v.encode())
        out.write_bytes(data)
    return dst


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    root = published_folder(tmp_path_factory.mktemp("pages"))

    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{".webmanifest": "application/manifest+json"})

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/{NAME}/"
    srv.shutdown()


@pytest.fixture(scope="module")
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # browser not installed
            pytest.skip(f"chromium not available: {e}")
        yield b
        b.close()


def open_page(browser, site, problems, **kw):
    ctx = browser.new_context(accept_downloads=True, **kw)
    pg = ctx.new_page()
    origin = site.split(f"/{NAME}/")[0]
    pg.on("console", lambda m: problems.append(m.text) if m.type == "error" or "Content Security Policy" in m.text else None)
    pg.on("pageerror", lambda e: problems.append(str(e)))
    pg.on("request", lambda r: problems.append("outside request " + r.url) if not r.url.startswith((origin, "data:", "blob:")) else None)
    pg.add_init_script("delete window.showSaveFilePicker")
    pg.goto(site)
    pg.wait_for_selector("body[data-ready='1']", timeout=30000)
    return ctx, pg


def txt(pg, sel):
    return pg.eval_on_selector(sel, "e => e.textContent")


def menu(pg, mid, label):
    pg.click("#" + mid)
    pg.locator("#menu button", has_text=label).first.click()


def cell(pg, act, col_header):
    ci = pg.evaluate(f"Array.from(document.querySelectorAll('#thead .hc[data-k]')).findIndex(h => h.textContent === {col_header!r})")
    row = pg.locator(f"#trows .tr[data-id='{act}']")
    row.scroll_into_view_if_needed()
    return row.locator(f".tc[data-c='{ci}']")


def test_published_folder_is_filled_and_strict(site):
    html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    assert "{{" not in html.replace("{{icon", "")
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
    assert "connect-src 'none'" in csp and "'unsafe-eval'" not in csp


def test_main_workflows_on_the_published_page(site, browser, tmp_path):
    problems = []
    ctx, pg = open_page(browser, site, problems, viewport={"width": 1280, "height": 900})
    assert "Example Ranch" in txt(pg, "#projName")

    # a predecessor typed with a positive lag, as the README shows
    pg.select_option("#tb-layout", "logic")
    cell(pg, "A1410", "Predecessors").dblclick()
    pg.keyboard.press("Control+a")
    pg.keyboard.type("A1400SS+2h, A1340 FF-4h")
    pg.keyboard.press("Enter")
    pred = txt(pg, "#trows .tr[data-id='A1410']")
    assert "A1400SS+2h" in pred and "A1340FF-4h" in pred, txt(pg, "#toastMsg")

    # the editor survives the table being redrawn under it (scrolling, a phone keyboard resizing the page)
    pg.select_option("#tb-layout", "classic")
    cell(pg, "A1300", "Activity Name").dblclick()
    pg.keyboard.press("Control+a")
    pg.keyboard.type("Drill intermediate")
    pg.evaluate("document.getElementById('tscroll').scrollTop += 60; window.dispatchEvent(new Event('resize'))")
    pg.wait_for_timeout(150)
    pg.keyboard.type(" hole")
    pg.keyboard.press("Enter")
    assert "Drill intermediate hole" in txt(pg, "#trows .tr[data-id='A1300']")

    # toolbar Undo says what it undid, like Ctrl+Z
    pg.click("#tb-undo")
    assert "Undid" in txt(pg, "#st-count")
    pg.click("#tb-redo")

    # the shortcut sheet lists every key the page answers
    menu(pg, "m-help", "Keyboard shortcuts")
    sheet = txt(pg, "#dlgBody")
    for k in ["F9", "Insert", "Delete", "F2", "Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+O", "Ctrl+F", "Ctrl+P", "Page Up"]:
        assert k in sheet, k
    pg.click("#dlgX")

    # Update progress: proposals, apply, one undo
    dd0 = txt(pg, "#st-dd")
    pg.click("#tb-update")
    assert pg.locator(".t-prog tbody tr").count() > 0 and txt(pg, "#up-why")
    pg.click("#up-apply")
    assert txt(pg, "#st-dd") != dd0
    pg.keyboard.press("Control+z")
    assert txt(pg, "#st-dd") == dd0

    # every export downloads and parses
    def export(label):
        with pg.expect_download() as d:
            pg.click("#tb-export")
            pg.locator("#menu button", has_text=label).click()
        path = tmp_path / d.value.suggested_filename
        d.value.save_as(path)
        return path.read_bytes()

    xer = export("P6 XER")
    assert xer.startswith(b"ERMHDR") and b"%T\tTASK\r\n" in xer
    xml = export("Project XML")
    assert ET.fromstring(xml).tag.endswith("Project")
    rows = list(csv.reader(io.StringIO(export("CSV activity table").decode("utf-8-sig"))))
    assert rows[0][0] == "Activity ID" and len(rows) > 30
    assert b'"format": "cpm-schedule"' in export("JSON backup")
    pg.click("#tb-export")
    pg.locator("#menu button", has_text="Gantt chart PDF").click()
    with pg.expect_download() as d:
        pg.locator("#dlgAct button", has_text="Write PDF").click()
    pdf = (tmp_path / "g.pdf")
    d.value.save_as(pdf)
    data = pdf.read_bytes()
    assert data.startswith(b"%PDF-") and data.rstrip().endswith(b"%%EOF") and len(re.findall(rb"/Type\s*/Page\b", data)) >= 1

    # a multi-project XER opens the project the file marks as exported, and offers the others
    two = tmp_path / "two.xer"
    two.write_text(TWO_PROJECTS)
    pg.set_input_files("#fileIn", str(two))
    pg.wait_for_selector("#dlg[open]")
    assert txt(pg, "#projName") == "Mine" and "holds 2 projects" in txt(pg, "#dlgBody")
    pg.locator("#dlgBody button", has_text="Open this one instead").click()
    pg.wait_for_function("() => document.getElementById('projName').textContent === 'Other'")
    pg.click("#dlgX")

    # the empty histogram adds the first resource right there
    menu(pg, "m-file", "New schedule")
    pg.locator("#dlgAct button", has_text="Create").click()
    pg.wait_for_function("() => document.getElementById('projName').textContent === 'New project'")
    pg.click("#v-res")
    pg.click("#r-add-first")
    assert txt(pg, "#dlgTitle") == "Resources" and pg.locator("#dlgBody tbody tr").count() == 1
    pg.click("#dlgX")
    pg.click("#v-acts")

    # deleting the open schedule removes it for good
    menu(pg, "m-file", "Schedules on this device")
    n = pg.locator("#dlgBody tbody tr").count()
    open_row = pg.locator("#dlgBody tbody tr", has=pg.locator(".chip", has_text="Open"))
    open_name = open_row.locator("td").first.inner_text()
    open_row.locator("button", has_text="Delete").click()
    pg.wait_for_timeout(500)
    assert pg.locator("#dlgBody tbody tr").count() == n - 1
    pg.click("#dlgX")
    pg.reload()
    pg.wait_for_selector("body[data-ready='1']")
    menu(pg, "m-file", "Schedules on this device")
    assert pg.locator("#dlgBody tbody tr").count() == n - 1
    assert open_name.split("\n")[0] == "New project"
    assert "New project" not in [t.split("\n")[0] for t in pg.locator("#dlgBody tbody tr td:first-child").all_inner_texts()]
    pg.click("#dlgX")
    ctx.close()
    assert not problems, problems


def test_offline_after_first_visit(site, browser):
    problems = []
    ctx, pg = open_page(browser, site, problems)
    # Pages registers the worker over https; localhost is also a secure context, so register it the same way
    assert pg.evaluate("navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => 'ok')") == "ok"
    pg.reload()
    pg.wait_for_selector("body[data-ready='1']")
    ctx.set_offline(True)
    pg.reload()
    pg.wait_for_selector("body[data-ready='1']", timeout=15000)
    ctx.close()
    assert not problems, problems


def test_phone_layout(site, browser):
    problems = []
    ctx, pg = open_page(browser, site, problems, viewport={"width": 400, "height": 860}, has_touch=True, is_mobile=True)
    for v in ["v-acts", "v-net", "v-res", "v-check"]:
        pg.tap("#" + v)
        assert pg.evaluate("document.documentElement.scrollWidth <= innerWidth"), v
    pg.tap("#menuBtn")
    assert pg.locator("#menu button").count() > 30
    pg.locator("#menu button", has_text="Update progress").tap()
    assert pg.evaluate("document.documentElement.scrollWidth <= innerWidth")
    pg.tap("#dlgX")
    ctx.close()
    assert not problems, problems


def test_starts_when_storage_never_answers(site, browser):
    # some browsers never answer IndexedDB for a page opened from a file; the page must still start
    problems = []
    ctx = browser.new_context()
    ctx.add_init_script("IDBFactory.prototype.open = function () { return {}; };")
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: problems.append(str(e)))
    pg.goto(site)
    pg.wait_for_selector("body[data-ready='1']", timeout=15000)
    assert "Example Ranch" in txt(pg, "#projName")
    pg.wait_for_function("() => document.getElementById('st-save').textContent.includes('storage unavailable')", timeout=5000)
    ctx.close()
    assert not problems, problems
