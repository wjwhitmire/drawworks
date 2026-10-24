"""The Pages build in headless Chromium, served over http with its real Content-Security-Policy.

Walks through the main workflow: the example opens, a cell edit recalculates, undo and redo, insert
with an automatic link, delete with bridged logic, both sample files import with every stored date
agreeing, a hostile XML file is refused, exports download, Update progress moves the data
date, a suggested fix applies, the schedule survives a reload, the other views draw, nothing scrolls
sideways at 400 px, and the page makes no request outside its own origin. Skipped when Playwright
or Chromium is missing."""

import functools
import http.server
import re
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
pw = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def site():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs"))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_csp_is_strict():
    html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
    assert "connect-src 'none'" in csp and "'unsafe-eval'" not in csp
    assert "'unsafe-inline'" not in re.search(r"script-src ([^;]+)", csp).group(1)
    assert "fonts.googleapis" not in html and "<a download" not in html


def text(pg, sel):
    return pg.eval_on_selector(sel, "e => e.textContent")


def test_workflow(site, tmp_path):
    hostile = tmp_path / "evil.xml"
    hostile.write_text('<?xml version="1.0"?><!DOCTYPE p [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><Project><Name>&b;</Name></Project>')
    outside, problems = [], []
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # browser not installed
            pytest.skip(f"chromium not available: {e}")
        ctx = b.new_context(viewport={"width": 1400, "height": 950}, accept_downloads=True)
        pg = ctx.new_page()
        pg.on("request", lambda r: outside.append(r.url) if not r.url.startswith((site, "data:", "blob:")) else None)
        pg.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: problems.append(str(e)))
        pg.goto(site + "/index.html")
        pg.wait_for_selector("body[data-ready='1']", timeout=30000)
        pg.add_init_script("delete window.showSaveFilePicker")
        pg.evaluate("delete window.showSaveFilePicker")
        assert "Example Ranch 14-2H" in text(pg, "#projName")
        assert "A1620" in text(pg, "#trows") or pg.evaluate("document.querySelectorAll('#trows .tr').length") > 20
        finish0 = text(pg, "#st-finish")

        # edit a duration in the table: recalculates and goes on the undo stack
        row = pg.locator("#trows .tr[data-id='A1410']")
        row.scroll_into_view_if_needed()
        row.locator(".tc[data-c='2']").dblclick()
        pg.keyboard.press("Control+a")
        pg.keyboard.type("300h")
        pg.keyboard.press("Enter")
        pg.wait_for_function("() => document.getElementById('st-finish').textContent !== %r" % finish0)
        finish1 = text(pg, "#st-finish")
        assert finish1 != finish0
        pg.keyboard.press("Control+z")
        pg.wait_for_function("() => document.getElementById('st-finish').textContent === %r" % finish0)
        pg.keyboard.press("Control+y")
        pg.wait_for_function("() => document.getElementById('st-finish').textContent === %r" % finish1)
        pg.keyboard.press("Control+z")

        # insert after the selected activity links it; delete bridges the logic
        pg.click("#trows .tr[data-id='A1520'] .tc[data-c='1']")
        pg.keyboard.press("Escape")
        pg.click("#tb-add")
        pg.wait_for_selector("#trows input.cell")
        pg.keyboard.type("Pressure test casing")
        pg.keyboard.press("Enter")
        assert "Pressure test casing" in text(pg, "#trows")
        assert "finish-to-start link" in text(pg, "#toast")
        pg.click("#trows .tr[data-id='A1530'] .tc[data-c='1']")
        pg.click("#tb-del")
        pg.wait_for_function("() => document.getElementById('toast').textContent.includes('Deleted A1530')")
        assert "A1530" not in [x for x in pg.eval_on_selector_all("#trows .tr[data-id]", "els => els.map(e => e.dataset.id)")]
        pg.keyboard.press("Control+z")
        pg.keyboard.press("Control+z")
        pg.wait_for_function("() => !document.getElementById('trows').textContent.includes('Pressure test casing')"
                             " && !!document.querySelector(\"#trows .tr[data-id='A1530']\")")

        # import the hand-built P6 file: every stored date agrees
        pg.set_input_files("#fileIn", str(ROOT / "tests" / "files" / "sample_p6.xer"))
        pg.wait_for_selector("#dlg[open]")
        body = text(pg, "#dlgBody")
        assert "36 of 36" in body and "windows-1252" in body, body
        pg.click("#dlgAct button.primary")
        assert "CAFE-TI" in text(pg, "#projName")
        pg.set_input_files("#fileIn", str(ROOT / "tests" / "files" / "sample_msp.xml"))
        pg.wait_for_selector("#dlg[open]")
        assert "36 of 36" in text(pg, "#dlgBody")
        pg.click("#dlgAct button.primary")
        pg.set_input_files("#fileIn", str(hostile))
        pg.wait_for_function("() => document.getElementById('toast').textContent.includes('DOCTYPE')")
        assert "tenant improvement" in text(pg, "#projName")

        # exports download as files
        for label, ext in (("XER", ".xer"), ("Project XML", ".xml"), ("CSV activity", ".csv"), ("backup", ".json")):
            pg.click("#tb-export")
            with pg.expect_download() as dl:
                pg.click(f"#menu button:has-text('{label}')")
            assert dl.value.suggested_filename.endswith(ext)
        pg.click("#tb-export")
        pg.click("#menu button:has-text('Gantt chart PDF')")
        with pg.expect_download() as dl:
            pg.click("#dlgAct button.primary")
        pdf_path = tmp_path / "out.pdf"
        dl.value.save_as(pdf_path)
        assert pdf_path.read_bytes().startswith(b"%PDF-1.4")

        # Update progress moves the data date
        dd0 = text(pg, "#st-dd")
        pg.click("#tb-update")
        pg.wait_for_selector("#dlg[open]")
        pg.fill("#up-dd", "2026-11-26T17:00")
        pg.dispatch_event("#up-dd", "change")
        assert "planned" in text(pg, "#dlgBody").lower()
        pg.click("#dlgAct button.primary")
        pg.wait_for_function("() => document.getElementById('st-dd').textContent.includes('26-Nov-26')")
        assert text(pg, "#st-dd") != dd0

        # History lists the update with its reason and undoes back to any entry
        pg.click("#st-hist")
        pg.wait_for_selector("#dlg[open].side")
        hist = text(pg, "#dlgBody")
        assert "Progress update to 26-Nov-26" in hist and "You approved" in hist and "Opened sample_msp.xml" in hist, hist
        assert pg.locator("#dlgBody button:has-text('Undo')").count() >= 1
        pg.click("#dlgX")

        # check view applies a suggested fix
        pg.click("#v-check")
        before = pg.evaluate("document.querySelectorAll('#checkwrap tbody tr').length")
        fixes = pg.locator("#checkwrap button:has-text('Link to'), #checkwrap button:has-text('Change to'), #checkwrap button:has-text('Make it')")
        if fixes.count():
            fixes.first.click()
            pg.wait_for_function(f"() => document.querySelectorAll('#checkwrap tbody tr').length < {before}")
        for v in ("net", "res", "acts"):
            pg.click(f"#v-{v}")
            pg.wait_for_timeout(200)
        assert pg.evaluate("document.querySelectorAll('#gsvg rect').length") > 5

        # density: Dense rows are 24 px on a desktop pointer; double-clicking a column edge fits it
        pg.click("#m-view")
        pg.click("#menu button:has-text('Dense rows')")
        assert pg.evaluate("document.querySelector('#trows .tr[data-id]').offsetHeight") == 24
        pg.click("#m-view")
        pg.click("#menu button:has-text('Comfortable rows')")
        assert pg.evaluate("document.querySelector('#trows .tr[data-id]').offsetHeight") == 44
        w0 = pg.evaluate("document.querySelector('#thead .hc[data-k=name]').offsetWidth")
        pg.dblclick("#thead .hc[data-k=name] .grip")
        assert pg.evaluate("document.querySelector('#thead .hc[data-k=name]').offsetWidth") != w0

        # the schedule survives a reload (IndexedDB autosave)
        pg.wait_for_timeout(600)
        pg.reload()
        pg.wait_for_selector("body[data-ready='1']", timeout=30000)
        assert "tenant improvement" in text(pg, "#projName") and "26-Nov-26" in text(pg, "#st-dd")

        # back to the example; every view at phone width without sideways scroll
        pg.click("#m-file")
        pg.click("#menu button:has-text('Schedules on this device')")
        pg.click("#dlgBody button:has-text('Example: commercial building')")
        pg.wait_for_function("() => document.getElementById('projName').textContent.includes('office building')")
        pg.click("#v-res")
        pg.wait_for_selector("#levelbox .lev-prev")
        assert "Apply" in text(pg, "#lv-apply")
        pg.set_viewport_size({"width": 400, "height": 860})
        for v in ("acts", "net", "res", "check"):
            pg.click(f"#v-{v}")
            pg.wait_for_timeout(250)
            assert pg.evaluate("document.documentElement.scrollWidth") <= 400, v
        pg.click("#v-acts")
        pg.click("#ps-gantt")
        assert pg.evaluate("document.getElementById('tpane').offsetWidth") == 0

        # delete all data: every stored schedule goes, including the one that was open; only the
        # example that opens afterwards is stored again
        pg.set_viewport_size({"width": 1400, "height": 950})
        pg.set_input_files("#fileIn", str(ROOT / "tests" / "files" / "sample_p6.xer"))
        pg.wait_for_selector("#dlg[open]")
        pg.click("#dlgAct button.primary")
        pg.wait_for_timeout(500)
        pg.click("#m-file")
        pg.click("#menu button:has-text('Delete all data')")
        pg.click("#dlgAct button:has-text('Delete everything')")
        pg.wait_for_function("() => document.getElementById('toast').textContent.includes('were deleted')")
        pg.wait_for_timeout(800)
        names = pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('cpm-scheduler'); r.onsuccess = () => {
            const tx = r.result.transaction('projects'); const q = tx.objectStore('projects').getAll();
            tx.oncomplete = () => res(q.result.map((x) => x.name)); }; })""")
        assert names == ["Example Ranch 14-2H well program"], names
        b.close()
    assert outside == [], outside
    assert problems == [], problems


def test_framed_page_does_not_start(site):
    # another site framing the page sees only a notice with a link to open the app in its own tab
    errors = []
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # browser not installed
            pytest.skip(f"chromium not available: {e}")
        pg = b.new_page(viewport={"width": 900, "height": 700})
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.set_content(f'<iframe id="f" src="{site}/index.html" width="800" height="600"></iframe>')
        fr = pg.frame_locator("#f")
        fr.locator("#framed a").wait_for(timeout=30000)
        frame = next(f for f in pg.frames if f.url.startswith(site))
        assert frame.locator("#framed a").get_attribute("target") == "_blank"
        assert frame.locator("#framed a").get_attribute("href") == f"{site}/index.html"
        assert "own tab" in frame.locator("#framed").text_content()
        pg.wait_for_timeout(500)
        assert frame.evaluate("document.body.dataset.ready") is None
        assert frame.evaluate("document.getElementById('trows').children.length") == 0
        assert not frame.locator("#tb-add").is_visible()
        # nothing was stored: the app never opened its database
        assert frame.evaluate("indexedDB.databases().then((d) => d.map((x) => x.name))") == []
        b.close()
    assert errors == [], errors
