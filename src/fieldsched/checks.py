"""Schedule quality check with suggested fixes, plus the open-ends report.

The metrics are the DCMA 14-point schedule assessment with its published thresholds:
   1 Logic (activities missing a predecessor or successor)  <= 5% of incomplete activities
   2 Leads (negative lags)                                   = 0% of relationships
   3 Lags (positive lags)                                    <= 5% of relationships
   4 Relationship types: finish to start                     >= 90% (other types <= 10%)
   5 Hard constraints (MSO, MFO, SNLT, FNLT, mandatory)       <= 5% of incomplete activities
   6 High float (total float over 44 working days)           <= 5%
   7 Negative float                                          = 0%
   8 High duration (baseline duration over 44 working days)  <= 5%
   9 Invalid dates (actual dates after the data date)        = 0%
  10 Resources (activities of a day or more with none)       reported, no threshold
  11 Missed activities (baseline finish passed, not finished on time) <= 5%
  12 Critical path test (the longest path runs unbroken back to the data date) pass or fail
  13 Critical path length index (CPL + float to the target finish) / CPL >= 0.95
  14 Baseline execution index (activities finished / baseline finish passed) >= 0.95
11, 13 and 14 need a baseline (13 uses the must-finish-by date when there is one). The 44 day
limits are settings in working minutes (44 days of 8 hours by default). Out-of-sequence progress
is reported after the fourteen. Each finding can carry a fix the person may apply (it goes on the
undo stack like any edit):
  open start  -> link from the project's start milestone (FS)
  open finish -> link to the project's finish milestone (FS)
  hard constraint -> the soft constraint on the same end (start or finish no earlier than); a
                     finish-no-later-than on a last activity -> the project's must-finish-by date
  lead (negative lag) on FS -> SS with lag = predecessor duration minus the lead, when positive
"""

from __future__ import annotations

from .errors import SchedError
from .model import validate_project
from .timecal import compile_calendar, fmt_fixed, parse_dt, round_div

CSTR_WORDS = {"SNET": "start on or after", "FNET": "finish on or after", "MSO": "start on", "MFO": "finish on", "SNLT": "start on or before",
              "FNLT": "finish on or before", "MS_MAND": "mandatory start", "MF_MAND": "mandatory finish"}
HARD = {"MSO": "SNET", "SNLT": "SNET", "MS_MAND": "SNET", "MFO": "FNET", "FNLT": "FNET", "MF_MAND": "FNET"}
MAX_FIXES = 500


def open_ends(p):
    """Incomplete activities missing logic: no predecessor, no successor, or a dangling end."""
    preds = {a["id"]: [] for a in p["activities"]}
    succs = {a["id"]: [] for a in p["activities"]}
    for r in p["rels"]:
        preds[r["succ"]].append(r["type"])
        succs[r["pred"]].append(r["type"])
    rows = []
    for a in p["activities"]:
        if a["af"]:
            continue
        i = a["id"]
        if not preds[i] and a["type"] != "start_ms":
            rows.append({"act": i, "kind": "no_pred"})
        elif preds[i] and not any(t in ("FS", "SS") for t in preds[i]):
            rows.append({"act": i, "kind": "start_dangle"})
        if not succs[i] and a["type"] != "finish_ms":
            rows.append({"act": i, "kind": "no_succ"})
        elif succs[i] and not any(t in ("FS", "FF") for t in succs[i]):
            rows.append({"act": i, "kind": "finish_dangle"})
    return rows


def _reach(adj, src, dst):
    seen, stack = {src}, [src]
    while stack:
        n = stack.pop()
        if n == dst:
            return True
        for m in adj.get(n, ()):
            if m not in seen:
                seen.add(m)
                stack.append(m)
    return False


def _days(m, hpd):
    s = fmt_fixed(m, hpd, 2)
    return s.rstrip("0").rstrip(".") if "." in s else s


def check(p, sched):
    S = p["settings"]
    acts = {a["id"]: a for a in p["activities"]}
    cal_hpd = {c["id"]: c["hpd"] for c in p["calendars"]}
    hpd = cal_hpd[p["cal"]]
    succ_adj = {}
    for r in p["rels"]:
        succ_adj.setdefault(r["pred"], []).append(r["succ"])
    rec = sched["acts"]
    incomplete = [a for a in p["activities"] if not a["af"]]
    starts = [a for a in incomplete if a["type"] == "start_ms"]
    fins = sorted([a for a in incomplete if a["type"] == "finish_ms"], key=lambda a: (rec[a["id"]]["ef"], a["code"]))
    start_ms = starts[0]["id"] if starts else None
    finish_ms = fins[-1]["id"] if fins else None
    out = []
    nfix = 0
    bl = next((b for b in p["baselines"] if b["id"] == p["baseline"]), None)

    def add(code, sev, msg, act=None, rel=None, fix=None, label=None):
        nonlocal nfix
        if fix is not None:
            if nfix >= MAX_FIXES:
                fix = label = None
            else:
                nfix += 1
        out.append({"code": code, "sev": sev, "act": act, "rel": rel, "msg": msg, "fix": fix, "fix_label": label})

    for oe in open_ends(p):
        a = acts[oe["act"]]
        k = oe["kind"]
        if k == "no_pred":
            fix = None
            if start_ms and start_ms != a["id"] and nfix < MAX_FIXES and not _reach(succ_adj, a["id"], start_ms):
                fix = {"kind": "add_rel", "pred": start_ms, "succ": a["id"], "type": "FS", "lag": 0}
            add("open_start", "warn", f"{a['code']} has no predecessor.", a["id"], fix=fix,
                label=f"Link from {acts[start_ms]['code']}" if fix else None)
        elif k == "no_succ":
            fix = None
            if finish_ms and finish_ms != a["id"] and nfix < MAX_FIXES and not _reach(succ_adj, finish_ms, a["id"]):
                fix = {"kind": "add_rel", "pred": a["id"], "succ": finish_ms, "type": "FS", "lag": 0}
            add("open_finish", "warn", f"{a['code']} has no successor.", a["id"], fix=fix,
                label=f"Link to {acts[finish_ms]['code']}" if fix else None)
        elif k == "start_dangle":
            add("start_dangle", "warn", f"{a['code']} has only FF or SF predecessors, so nothing drives its start.", a["id"])
        else:
            add("finish_dangle", "warn", f"{a['code']} has only SS or SF successors, so its finish drives nothing.", a["id"])

    for r in p["rels"]:
        pa, sa = acts[r["pred"]], acts[r["succ"]]
        if pa["af"] and sa["af"]:
            continue
        name = f"{pa['code']} to {sa['code']} {r['type']}"
        if r["lag"] < 0:
            fix = label = None
            if r["type"] == "FS" and pa["type"] == "task" and pa["od"] + r["lag"] > 0:
                ss = (pa["id"], sa["id"], "SS")
                if not any((x["pred"], x["succ"], x["type"]) == ss for x in p["rels"]):
                    fix = {"kind": "set_rel", "rel": r["id"], "type": "SS", "lag": pa["od"] + r["lag"]}
                    label = f"Make it SS {_days(pa['od'] + r['lag'], hpd)}d"
            add("lead", "warn", f"{name} has a negative lag (a lead) of {_days(-r['lag'], hpd)} days.", rel=r["id"], fix=fix, label=label)
        elif r["lag"] > S["long_lag"]:
            add("long_lag", "info", f"{name} has a lag of {_days(r['lag'], hpd)} days. A lag that long usually hides work; consider an activity.", rel=r["id"])
        if r["type"] == "SF":
            add("sf_link", "info", f"{name} is a start-to-finish link. These are rare and easy to misread.", rel=r["id"])

    has_succ = {r["pred"] for r in p["rels"]}
    for a in incomplete:
        if a["cstr"] in HARD:
            msg = f"{a['code']} has a {CSTR_WORDS[a['cstr']]} constraint ({a['cstr']}), which holds dates against logic."
            if a["cstr"] == "FNLT" and a["id"] not in has_succ:
                # a finish-no-later-than on the last activity is a deadline: keep it as the project's must-finish-by date
                add("hard_constraint", "warn", msg, a["id"], fix={"kind": "set_deadline", "act": a["id"], "date": a["cstr_date"]},
                    label="Make it the must-finish-by date")
            elif a["cstr"] in ("FNLT", "SNLT"):
                add("hard_constraint", "warn", msg + " Keep it only if it is a contract date.", a["id"])
            else:
                soft = HARD[a["cstr"]]
                add("hard_constraint", "warn", msg, a["id"], fix={"kind": "set_cstr", "act": a["id"], "cstr": soft, "date": a["cstr_date"]},
                    label=f"Change to {CSTR_WORDS[soft]}")
        r = rec[a["id"]]
        if r["tf"] is not None and r["tf"] < 0:
            add("neg_float", "error", f"{a['code']} has negative float of {_days(r['tf'], cal_hpd[a['cal'] or p['cal']])} days. Check its constraints and the must-finish-by date.", a["id"])
        elif r["tf"] is not None and r["tf"] > S["high_float"]:
            add("high_float", "info", f"{a['code']} has {_days(r['tf'], cal_hpd[a['cal'] or p['cal']])} days of total float. Missing logic is the usual cause.", a["id"])
        d, what = (bl["acts"][a["id"]][2], "a baseline") if bl and a["id"] in bl["acts"] else (a["od"], "an original")
        if a["type"] == "task" and d > S["high_dur"]:
            add("high_dur", "info", f"{a['code']} has {what} duration of {_days(d, cal_hpd[a['cal'] or p['cal']])} days. Long activities are hard to status; consider splitting it.", a["id"])

    dd = parse_dt(p["data_date"])
    for a in p["activities"]:
        if (a["as"] and parse_dt(a["as"]) > dd) or (a["af"] and parse_dt(a["af"]) > dd):
            add("invalid_dates", "error", f"{a['code']} has an actual date after the data date.", a["id"])
    for rid in sched["oos"]:
        r = next(x for x in p["rels"] if x["id"] == rid)
        add("oos", "warn", f"Out of sequence: {acts[r['succ']]['code']} has progress before {acts[r['pred']]['code']} allows ({r['type']}). "
            f"Under {'retained logic' if S['oos'] == 'retained' else 'progress override'} the remaining work is scheduled accordingly; "
            "fix the actual dates or change the link.", acts[r["succ"]]["id"], rel=rid)

    # 12: the longest path must run back through driving links to an activity that starts at the
    # data date; a path that begins later is held by a constraint or a gap in the logic
    cals = {}

    def cal_of(a):
        cid = a["cal"] or p["cal"]
        if cid not in cals:
            cals[cid] = compile_calendar(next(c for c in p["calendars"] if c["id"] == cid))
        return cals[cid]

    base = parse_dt(sched["start"])
    lp = [a for a in p["activities"] if rec[a["id"]]["lp"]]
    driven = {r["succ"] for r in p["rels"] if sched["rels"][r["id"]]["driving"] and rec[r["pred"]]["lp"] and rec[r["succ"]]["lp"]}
    cp_breaks = [a for a in lp if a["id"] not in driven and cal_of(a).work_between(base, parse_dt(rec[a["id"]]["res"])) != 0]
    for a in cp_breaks:
        add("cp_test", "warn", f"The longest path starts at {a['code']}, later than the data date, so a constraint or a missing link holds it.", a["id"])

    n = len(incomplete) or 1
    nrel = len([r for r in p["rels"] if not (acts[r["pred"]]["af"] and acts[r["succ"]]["af"])]) or 1
    count = {}
    for f in out:
        count[f["code"]] = count.get(f["code"], 0) + 1
    missing = len({f["act"] for f in out if f["code"] in ("open_start", "open_finish", "start_dangle", "finish_dangle")})
    live = [r for r in p["rels"] if not (acts[r["pred"]]["af"] and acts[r["succ"]]["af"])]
    fs = len([r for r in live if r["type"] == "FS"])
    has_rsrc = {x["act"] for x in p["assigns"]}
    no_rsrc = len([a for a in incomplete if a["type"] == "task" and a["od"] >= cal_hpd[a["cal"] or p["cal"]] and a["id"] not in has_rsrc])
    due = [a for a in p["activities"] if bl and a["id"] in bl["acts"] and bl["acts"][a["id"]][1] and parse_dt(bl["acts"][a["id"]][1]) <= dd]
    missed = len([a for a in due if not a["af"] or parse_dt(a["af"]) > parse_dt(bl["acts"][a["id"]][1])])
    done = len([a for a in p["activities"] if a["af"]])
    metrics = []

    def share(name, dcma, num, den, limit, unit):
        permille = (num * 1000 + den // 2) // den
        metrics.append({"name": name, "dcma": dcma, "kind": "share", "unit": unit, "count": num, "of": den, "permille": permille,
                        "limit": limit, "pass": None if limit is None else permille <= limit})

    def index(name, dcma, num, den, unit):
        ok = den > 0
        permille = round_div(num * 1000, den) if ok else None
        metrics.append({"name": name, "dcma": dcma, "kind": "index", "unit": unit, "count": num, "of": den, "permille": permille,
                        "limit": 950, "pass": permille >= 950 if ok else None})

    share("Logic", 1, missing, n, 50, "act")
    share("Leads", 2, count.get("lead", 0), nrel, 0, "rel")
    share("Lags", 3, len([r for r in live if r["lag"] > 0]), nrel, 50, "rel")
    share("Relationship types (not finish to start)", 4, len(live) - fs, nrel, 100, "rel")
    share("Hard constraints", 5, count.get("hard_constraint", 0), n, 50, "act")
    share("High float", 6, count.get("high_float", 0), n, 50, "act")
    share("Negative float", 7, count.get("neg_float", 0), n, 0, "act")
    share("High duration", 8, count.get("high_dur", 0), n, 50, "act")
    share("Invalid dates", 9, count.get("invalid_dates", 0), n, 0, "act")
    share("Resources (none assigned)", 10, no_rsrc, n, None, "act")
    if due:
        share("Missed activities", 11, missed, len(due), 50, "act")
    else:
        metrics.append({"name": "Missed activities", "dcma": 11, "kind": "share", "unit": "act", "count": 0, "of": 0, "permille": None,
                        "limit": 50, "pass": None})
    metrics.append({"name": "Critical path test", "dcma": 12, "kind": "test", "unit": "act", "count": len(cp_breaks), "of": len(lp),
                    "permille": None, "limit": None, "pass": (not cp_breaks) if lp else None})
    pc = cal_of({"cal": None})
    fin = parse_dt(sched["finish"])
    # the target finish: the must-finish-by date, else the latest baseline finish
    target = p["finish_by"]
    if target is None and bl:
        target = max((v[1] for v in bl["acts"].values() if v[1]), default=None)
    cpl = pc.work_between(base, fin)
    if target is None or cpl <= 0:
        index("Critical path length index", 13, 0, 0, "min")
    else:
        index("Critical path length index", 13, cpl + pc.work_between(fin, parse_dt(target)), cpl, "min")
    index("Baseline execution index", 14, done, len(due), "act")
    share("Out of sequence", None, count.get("oos", 0), nrel, 0, "rel")
    return {"findings": out, "metrics": metrics, "counts": count}


def _next_id(rows, prefix):
    used = {r["id"] for r in rows}
    n = len(rows) + 1
    while f"{prefix}{n}" in used:
        n += 1
    return f"{prefix}{n}"


def apply_fix(p, fix):
    k = fix.get("kind")
    if k == "add_rel":
        rel = {"id": _next_id(p["rels"], "r"), "pred": fix["pred"], "succ": fix["succ"], "type": fix["type"],
               "lag": fix["lag"], "elapsed": False}
        return validate_project({**p, "rels": p["rels"] + [rel]})
    if k == "set_rel":
        rels = [({**r, "type": fix["type"], "lag": fix["lag"]} if r["id"] == fix["rel"] else r) for r in p["rels"]]
        return validate_project({**p, "rels": rels})
    if k == "set_deadline":
        acts = [({**a, "cstr": "ASAP", "cstr_date": None} if a["id"] == fix["act"] else a) for a in p["activities"]]
        fb = p["finish_by"] if p["finish_by"] and p["finish_by"] < fix["date"] else fix["date"]
        return validate_project({**p, "activities": acts, "finish_by": fb})
    if k == "set_cstr":
        acts = [({**a, "cstr": fix["cstr"], "cstr_date": fix["date"]} if a["id"] == fix["act"] else a) for a in p["activities"]]
        return validate_project({**p, "activities": acts})
    raise SchedError("bad_fix", "Unknown fix.")
