"""Opening any supported file, comparing stored dates with ours, CSV export, the native format."""

from __future__ import annotations

import json
import re

from .cpm import Ctx, schedule
from .errors import SchedError
from .model import validate_project
from .mspdi import read_mspdi
from .textio import decode_bytes
from .timecal import fmt_fixed, parse_dt
from .xer import read_xer


def detect(text):
    head = text.lstrip("\ufeff \t\r\n")[:4096]
    if head.startswith("ERMHDR") or head.startswith("%T"):
        return "xer"
    if head.startswith("<"):
        return "mspdi"
    if head.startswith("{"):
        return "native"
    raise SchedError("unknown_format", "This file is not an XER file, a Project XML file or a schedule saved by this tool.")


def parse_json(text):
    if len(text) > 64 * 1024 * 1024:
        raise SchedError("too_big", "The file is larger than 64 MB.")
    def bad_const(c):
        raise SchedError("bad_json", f"The file contains {c}, which is not valid JSON.")
    try:
        return json.loads(text, parse_constant=bad_const)
    except json.JSONDecodeError as e:
        raise SchedError("bad_json", f"The file is not valid JSON (near line {e.lineno}).") from None
    except RecursionError:
        raise SchedError("bad_json", "The file nests too deeply to be a schedule.") from None


def open_file(data, project_id=None):
    """bytes -> {"kind", "project", "report", "stored", "projects"}."""
    text, enc = decode_bytes(data) if isinstance(data, (bytes, bytearray)) else (data, "text")
    kind = detect(text)
    if kind == "xer":
        out = read_xer(text, project_id)
        out["report"]["encoding"] = enc
    elif kind == "mspdi":
        out = read_mspdi(text)
        out["report"]["encoding"] = enc
    else:
        proj = validate_project(parse_json(text))
        out = {"project": proj, "report": {"format": "native", "encoding": enc, "warnings": [], "counts": {
            "activities": len(proj["activities"]), "rels": len(proj["rels"]), "wbs": len(proj["wbs"]),
            "calendars": len(proj["calendars"]), "resources": len(proj["resources"]), "assigns": len(proj["assigns"])},
            "tables": {}, "unknown_tables": []}, "stored": {}, "projects": []}
    out["kind"] = kind
    return out


FIELDS = ("es", "ef", "ls", "lf")


def compare_stored(p, sched, stored, kind="xer"):
    """Dates and floats stored in an imported file against this tool's calculation.
    Two dates agree when no working time lies between them on the activity's calendar (so a
    finish at 16:00 and the next morning's 08:00 agree). Floats agree to the minute."""
    ctx = Ctx(p)
    checked = agree = 0
    diffs = []
    for a in p["activities"]:
        s = stored.get(a["id"])
        if not s:
            continue
        rec = sched["acts"][a["id"]]
        C = ctx.cal[a["id"]]
        if rec["status"] == "complete":
            continue
        for f in FIELDS:
            if not s.get(f) or not rec.get(f):
                continue
            # P6 stores an in-progress activity's remaining early start as its early start; the
            # other format keeps the actual start there, which is not a calculated date
            if rec["status"] == "active" and (f == "ls" or (f == "es" and kind != "xer")):
                continue
            ours = rec["res"] if (f == "es" and rec["status"] == "active") else rec[f]
            checked += 1
            gap = C.work_between(parse_dt(s[f]), parse_dt(ours))
            if gap == 0:
                agree += 1
            elif len(diffs) < 500:
                diffs.append({"act": a["id"], "code": a["code"], "field": f, "file": s[f], "ours": ours, "gap": gap})
        for f in ("tf", "ff"):
            if s.get(f) is None or rec[f] is None:
                continue
            checked += 1
            if s[f] == rec[f]:
                agree += 1
            elif len(diffs) < 500:
                diffs.append({"act": a["id"], "code": a["code"], "field": f, "file": s[f], "ours": rec[f], "gap": rec[f] - s[f]})
    return {"checked": checked, "agree": agree, "diffs": diffs}


CSV_COLS = ["Activity ID", "Activity Name", "WBS", "Type", "Calendar", "Original Duration", "Remaining Duration",
            "Unit", "Start", "Finish", "Early Start", "Early Finish", "Late Start", "Late Finish", "Total Float",
            "Free Float", "Critical Activity", "Status", "Actual Start", "Actual Finish", "Percent Complete", "Predecessors",
            "Constraint", "Constraint Date", "BL Start", "BL Finish", "BL Finish Variance", "Resources"]


_PLAIN_NUMBER = re.compile(r"[+-]?[0-9]+(\.[0-9]+)?")


def _cell(v):
    """A CSV cell. Text a spreadsheet could run as a formula gets a leading apostrophe; a plain
    number such as a negative float stays a number."""
    s = "" if v is None else str(v)
    if s[:1] in ("=", "+", "-", "@", "\t", "\r") and not _PLAIN_NUMBER.fullmatch(s):
        s = "'" + s
    if any(c in s for c in ',"\r\n'):
        s = '"' + s.replace('"', '""') + '"'
    return s


def _d(t):
    return t.replace("T", " ") if t else ""


def export_csv(p, sched, var=None):
    """One row per activity. Durations and floats in days of the activity's calendar (hours when
    the activity's unit is hours), two decimals."""
    cal = {c["id"]: c for c in p["calendars"]}
    wbs = {w["id"]: w for w in p["wbs"]}
    code = {a["id"]: a["code"] for a in p["activities"]}
    rname = {r["id"]: r["code"] for r in p["resources"]}
    preds = {}
    for r in p["rels"]:
        lag = ""
        if r["lag"]:
            lag = ("+" if r["lag"] > 0 else "-") + fmt_fixed(abs(r["lag"]), cal[p["cal"]]["hpd"], 2) + "d"
        preds.setdefault(r["succ"], []).append(f"{code[r['pred']]} {r['type']}{lag}")
    rs = {}
    for x in p["assigns"]:
        rs.setdefault(x["act"], []).append(rname[x["rsrc"]])
    var = var or {}
    lines = [",".join(CSV_COLS)]
    for a in p["activities"]:
        rec = sched["acts"][a["id"]]
        c = cal[a["cal"] or p["cal"]]
        div = 60 if a["unit"] == "h" else c["hpd"]
        n = lambda m: "" if m is None else fmt_fixed(m, div, 2)  # noqa: E731
        v = var.get(a["id"], {})
        row = [a["code"], a["name"], wbs[a["wbs"]]["code"] if a["wbs"] else "", a["type"], c["name"], n(a["od"]), n(a["rd"]),
               a["unit"], _d(a["as"] or rec["es"]), _d(a["af"] or rec["ef"]), _d(rec["es"]), _d(rec["ef"]), _d(rec["ls"]),
               _d(rec["lf"]), n(rec["tf"]), n(rec["ff"]), "Yes" if rec["crit"] else "No", rec["status"], _d(a["as"]),
               _d(a["af"]), fmt_fixed(rec["pct"], 10, 1), "; ".join(preds.get(a["id"], [])), a["cstr"] if a["cstr"] != "ASAP" else "",
               _d(a["cstr_date"]), _d(v.get("bs")), _d(v.get("bf")), n(v.get("fv")), "; ".join(rs.get(a["id"], []))]
        lines.append(",".join(_cell(x) for x in row))
    return "\r\n".join(lines) + "\r\n"


def save_native(p):
    return json.dumps(p, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def open_and_schedule(data):
    out = open_file(data)
    sched = schedule(out["project"])
    out["sched"] = sched
    out["fidelity"] = compare_stored(out["project"], sched, out["stored"], out["kind"]) if out["stored"] else None
    return out
