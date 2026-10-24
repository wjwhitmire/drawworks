"""The schedule data model: validation, defaults and the native file format.

A project is plain JSON. Times are "YYYY-MM-DDTHH:MM" strings on a wall clock. Durations, lags and
float thresholds are integer working minutes. Resource units are integer thousandths per hour
(1000 = one person or one unit working full time) and quantities are integer thousandths
(24500 = 24.5 hours or units).

validate_project returns a cleaned copy with every default filled in, or raises SchedError with a
specific message. Nothing is changed in place.
"""

from __future__ import annotations

import re

from .errors import SchedError
from .timecal import fmt_dt, norm_intervals, parse_day, parse_dt, standard_week

FORMAT = "cpm-schedule"
VERSION = 1

ACT_TYPES = ("task", "start_ms", "finish_ms")
REL_TYPES = ("FS", "SS", "FF", "SF")
CSTR_TYPES = ("ASAP", "ALAP", "SNET", "SNLT", "FNET", "FNLT", "MSO", "MFO", "MS_MAND", "MF_MAND")
PCT_TYPES = ("duration", "physical", "units")
RSRC_TYPES = ("labor", "nonlabor", "material")
SETTINGS = {
    "oos": ("retained", ("retained", "override")),
    "crit": ("tf", ("tf", "longest")),
    "float": ("finish", ("finish", "start", "min")),
    "lag_cal": ("pred", ("pred", "succ", "24h", "project")),
    "unit": ("d", ("d", "h")),
}
INT_SETTINGS = {
    "crit_tf": 0,           # critical when total float is at or below this (working minutes)
    "near_tf": 4800,        # near critical when total float is at or below this (10 days of 8 h)
    "long_lag": 2400,       # schedule check: lags longer than 5 days of 8 h
    "high_float": 21120,    # schedule check: total float above 44 days of 8 h
    "high_dur": 21120,      # schedule check: remaining duration above 44 days of 8 h
}

LIMITS = {"activities": 100000, "rels": 400000, "wbs": 50000, "calendars": 2000, "resources": 20000,
          "assigns": 400000, "baselines": 20, "exceptions": 20000}
ID_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,64}$")
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
MAX_MIN = 60 * 366 * 1440  # sixty years of minutes: the cap on durations and lags


def clean_text(v, field, cap, multiline=False):
    if v is None:
        return ""
    if not isinstance(v, str):
        raise SchedError("bad_field", f"{field}: expected text.")
    if len(v) > 4 * cap + 1000:
        v = v[:4 * cap + 1000]
    v = CTRL.sub("", v)
    if not multiline:
        v = re.sub(r"[\r\n\t]+", " ", v).strip()
    else:
        v = v.replace("\r\n", "\n").replace("\r", "\n")
    if len(v) > cap:
        v = v[:cap]
    return v


def check_id(v, field):
    if isinstance(v, int) and not isinstance(v, bool):
        v = str(v)
    if not isinstance(v, str) or not ID_RE.match(v):
        raise SchedError("bad_field", f"{field}: ids are 1 to 64 letters, digits, dot, dash, colon or underscore.")
    return v


def as_int(v):
    """A whole number (JSON may write 480 as 480.0), or None."""
    if type(v) is int:
        return v
    if type(v) is float and v.is_integer() and abs(v) < 2 ** 53:
        return int(v)
    return None


def check_int(v, field, lo, hi):
    v = as_int(v)
    if v is None or not (lo <= v <= hi):
        raise SchedError("bad_field", f"{field}: expected a whole number from {lo} to {hi}.")
    return v


def check_dt(v, field, optional=True):
    if v is None or v == "":
        if optional:
            return None
        raise SchedError("bad_field", f"{field} is required.")
    return fmt_dt(parse_dt(v, field))


def check_choice(v, field, choices, default):
    if v is None:
        return default
    if v not in choices:
        raise SchedError("bad_field", f"{field}: expected one of {', '.join(choices)}.")
    return v


def _keys(obj, allowed, field):
    if not isinstance(obj, dict):
        raise SchedError("bad_field", f"{field}: expected an object.")
    extra = [k for k in obj if k not in allowed]
    if extra:
        raise SchedError("bad_field", f'{field}: unknown field "{str(extra[0])[:30]}".')


def _list(obj, key, limit_key):
    v = obj.get(key, [])
    if v is None:
        v = []
    if not isinstance(v, list):
        raise SchedError("bad_field", f"{key}: expected a list.")
    if len(v) > LIMITS[limit_key]:
        raise SchedError("too_many", f"{key}: more than {LIMITS[limit_key]:,} records. This tool is capped there.")
    return v


def _unique(rows, what):
    seen = set()
    for r in rows:
        if r["id"] in seen:
            raise SchedError("duplicate_id", f'Two {what} share the id "{r["id"]}".')
        seen.add(r["id"])
    return seen


PROJECT_KEYS = ("format", "version", "id", "name", "label", "start", "data_date", "finish_by", "cal", "settings",
                "calendars", "wbs", "activities", "rels", "resources", "assigns", "baselines", "baseline")


def validate_project(obj):
    _keys(obj, PROJECT_KEYS, "project")
    fmt = obj.get("format", FORMAT)
    if fmt != FORMAT:
        raise SchedError("bad_format", "This is not a schedule file from this tool.")
    ver = obj.get("version", VERSION)
    if type(ver) is not int or ver < 1:
        raise SchedError("bad_format", "The schedule file has no valid version number.")
    if ver > VERSION:
        raise SchedError("newer_file", "This schedule was saved by a newer version. Update the tool to open it.")
    p = {"format": FORMAT, "version": VERSION}
    p["id"] = check_id(obj.get("id", "p1"), "project id")
    p["name"] = clean_text(obj.get("name"), "project name", 200) or "Untitled project"
    p["label"] = clean_text(obj.get("label"), "project label", 300)
    p["start"] = check_dt(obj.get("start"), "project start", optional=False)
    p["data_date"] = check_dt(obj.get("data_date"), "data date") or p["start"]
    p["finish_by"] = check_dt(obj.get("finish_by"), "must finish by")

    st = obj.get("settings") or {}
    _keys(st, tuple(SETTINGS) + tuple(INT_SETTINGS), "settings")
    p["settings"] = {}
    for k, (dflt, choices) in SETTINGS.items():
        p["settings"][k] = check_choice(st.get(k), f"settings.{k}", choices, dflt)
    for k, dflt in INT_SETTINGS.items():
        p["settings"][k] = check_int(st.get(k, dflt), f"settings.{k}", 0, MAX_MIN)

    cals = []
    for i, c in enumerate(_list(obj, "calendars", "calendars")):
        _keys(c, ("id", "name", "hpd", "week", "exceptions"), f"calendar {i + 1}")
        cid = check_id(c.get("id"), f"calendar {i + 1} id")
        name = clean_text(c.get("name"), "calendar name", 120) or cid
        week = c.get("week")
        if not isinstance(week, list) or len(week) != 7:
            raise SchedError("bad_calendar", f'Calendar "{name}": the work week needs 7 days, Sunday first.')
        week = [norm_intervals(week[d], f'calendar "{name}" day {d}') for d in range(7)]
        if sum(f - s for day in week for s, f in day) == 0:
            raise SchedError("no_work", f'Calendar "{name}" has no working time in its work week.')
        exc_in = c.get("exceptions") or {}
        if not isinstance(exc_in, dict) or len(exc_in) > LIMITS["exceptions"]:
            raise SchedError("bad_calendar", f'Calendar "{name}": exceptions must be a map of at most {LIMITS["exceptions"]:,} dates.')
        exc = {}
        for k in sorted(exc_in):
            day = parse_day(k, f'calendar "{name}" exception')
            exc[fmt_dt(day * 1440)[:10]] = norm_intervals(exc_in[k], f'calendar "{name}" exception {k}')
        hpd = c.get("hpd")
        if hpd is None:
            days = [sum(f - s for s, f in d) for d in week if d]
            hpd = max(days) if days else 480
        cals.append({"id": cid, "name": name, "hpd": check_int(hpd, f'calendar "{name}" minutes per day', 1, 1440),
                     "week": week, "exceptions": exc})
    if not cals:
        cals.append({"id": "std", "name": "Standard", "hpd": 480, "week": standard_week(), "exceptions": {}})
    cal_ids = _unique(cals, "calendars")
    p["calendars"] = cals
    p["cal"] = obj.get("cal") or cals[0]["id"]
    if p["cal"] not in cal_ids:
        raise SchedError("bad_ref", f'The project calendar "{str(p["cal"])[:64]}" does not exist.')

    wbs = []
    for i, w in enumerate(_list(obj, "wbs", "wbs")):
        _keys(w, ("id", "code", "name", "parent"), f"WBS {i + 1}")
        wid = check_id(w.get("id"), f"WBS {i + 1} id")
        wbs.append({"id": wid, "code": clean_text(w.get("code"), "WBS code", 60) or wid,
                    "name": clean_text(w.get("name"), "WBS name", 200), "parent": w.get("parent") or None})
    wbs_ids = _unique(wbs, "WBS elements")
    parent = {}
    for w in wbs:
        if w["parent"] is not None:
            if w["parent"] not in wbs_ids:
                raise SchedError("bad_ref", f'WBS "{w["code"]}" has a parent that does not exist.')
            parent[w["id"]] = w["parent"]
    for w in wbs:  # no WBS loops
        seen, cur = set(), w["id"]
        while cur in parent:
            if cur in seen:
                raise SchedError("bad_ref", f'WBS "{w["code"]}" is inside itself.')
            seen.add(cur)
            cur = parent[cur]
    p["wbs"] = wbs

    acts = []
    for i, a in enumerate(_list(obj, "activities", "activities")):
        _keys(a, ("id", "code", "name", "wbs", "cal", "type", "od", "rd", "as", "af", "pct_type", "phys",
                  "cstr", "cstr_date", "unit", "notes"), f"activity {i + 1}")
        aid = check_id(a.get("id"), f"activity {i + 1} id")
        code = clean_text(a.get("code"), "activity id", 40) or aid
        f = f'activity "{code}"'
        typ = check_choice(a.get("type"), f + " type", ACT_TYPES, "task")
        od = check_int(a.get("od", 0), f + " original duration", 0, MAX_MIN)
        rd = check_int(a.get("rd", od), f + " remaining duration", 0, MAX_MIN)
        if typ != "task":
            od = rd = 0
        as_ = check_dt(a.get("as"), f + " actual start")
        af = check_dt(a.get("af"), f + " actual finish")
        if af and not as_:
            raise SchedError("bad_progress", f"{f} has an actual finish but no actual start.")
        if as_ and af and parse_dt(af) < parse_dt(as_):
            raise SchedError("bad_progress", f"{f} finishes before it starts.")
        if af:
            rd = 0
        cstr = check_choice(a.get("cstr"), f + " constraint", CSTR_TYPES, "ASAP")
        cdate = check_dt(a.get("cstr_date"), f + " constraint date")
        if cstr not in ("ASAP", "ALAP") and not cdate:
            raise SchedError("bad_field", f"{f}: the {cstr} constraint needs a date.")
        if cstr in ("ASAP", "ALAP"):
            cdate = None
        w = a.get("wbs") or None
        if w is not None and w not in wbs_ids:
            raise SchedError("bad_ref", f"{f} points to a WBS element that does not exist.")
        c = a.get("cal") or None
        if c is not None and c not in cal_ids:
            raise SchedError("bad_ref", f"{f} points to a calendar that does not exist.")
        phys = a.get("phys", 0)
        if type(phys) not in (int, float) or isinstance(phys, bool) or not (0 <= phys <= 100):
            raise SchedError("bad_field", f"{f}: physical percent complete is 0 to 100.")
        if type(phys) is float and phys.is_integer():
            phys = int(phys)
        acts.append({"id": aid, "code": code, "name": clean_text(a.get("name"), "activity name", 300), "wbs": w,
                     "cal": c, "type": typ, "od": od, "rd": rd, "as": as_, "af": af,
                     "pct_type": check_choice(a.get("pct_type"), f + " percent complete type", PCT_TYPES, "duration"),
                     "phys": phys, "cstr": cstr, "cstr_date": cdate,
                     "unit": check_choice(a.get("unit"), f + " unit", ("d", "h"), p["settings"]["unit"]),
                     "notes": clean_text(a.get("notes"), "notes", 4000, multiline=True)})
    act_ids = _unique(acts, "activities")
    p["activities"] = acts

    rels = []
    pairs = set()
    code_of = {a["id"]: a["code"] for a in acts}
    for i, r in enumerate(_list(obj, "rels", "rels")):
        _keys(r, ("id", "pred", "succ", "type", "lag", "elapsed"), f"relationship {i + 1}")
        rid = check_id(r.get("id", f"r{i + 1}"), f"relationship {i + 1} id")
        pr, su = r.get("pred"), r.get("succ")
        if pr not in act_ids or su not in act_ids:
            raise SchedError("bad_ref", f"Relationship {i + 1} points to an activity that does not exist.")
        if pr == su:
            raise SchedError("loop", f'Activity "{code_of[pr]}" is linked to itself.')
        typ = check_choice(r.get("type"), f"relationship {i + 1} type", REL_TYPES, "FS")
        key = (pr, su, typ)
        if key in pairs:
            raise SchedError("duplicate_rel", f'{code_of[pr]} to {code_of[su]} {typ} is listed twice.')
        pairs.add(key)
        lag = as_int(r.get("lag", 0))
        if lag is None or abs(lag) > MAX_MIN:
            raise SchedError("bad_field", f"Relationship {code_of[pr]} to {code_of[su]}: lag is whole working minutes.")
        rels.append({"id": rid, "pred": pr, "succ": su, "type": typ, "lag": lag, "elapsed": r.get("elapsed") is True})
    _unique(rels, "relationships")
    p["rels"] = rels

    rsrcs = []
    for i, r in enumerate(_list(obj, "resources", "resources")):
        _keys(r, ("id", "code", "name", "type", "max_units", "unit"), f"resource {i + 1}")
        rid = check_id(r.get("id"), f"resource {i + 1} id")
        rsrcs.append({"id": rid, "code": clean_text(r.get("code"), "resource id", 40) or rid,
                      "name": clean_text(r.get("name"), "resource name", 200),
                      "type": check_choice(r.get("type"), "resource type", RSRC_TYPES, "labor"),
                      "max_units": check_int(r.get("max_units", 1000), "resource max units", 0, 10 ** 6),
                      "unit": clean_text(r.get("unit"), "resource unit", 20) or "h"})
    rsrc_ids = _unique(rsrcs, "resources")
    p["resources"] = rsrcs

    asg = []
    for i, x in enumerate(_list(obj, "assigns", "assigns")):
        _keys(x, ("id", "act", "rsrc", "units", "budget", "actual"), f"assignment {i + 1}")
        xid = check_id(x.get("id", f"x{i + 1}"), f"assignment {i + 1} id")
        if x.get("act") not in act_ids or x.get("rsrc") not in rsrc_ids:
            raise SchedError("bad_ref", f"Assignment {i + 1} points to an activity or resource that does not exist.")
        asg.append({"id": xid, "act": x["act"], "rsrc": x["rsrc"],
                    "units": check_int(x.get("units", 1000), "assignment units per hour", 0, 10 ** 6),
                    "budget": check_int(x.get("budget", 0), "assignment budgeted quantity", 0, 10 ** 10),
                    "actual": check_int(x.get("actual", 0), "assignment actual quantity", 0, 10 ** 10)})
    _unique(asg, "assignments")
    p["assigns"] = asg

    bls = []
    for i, b in enumerate(_list(obj, "baselines", "baselines")):
        _keys(b, ("id", "name", "taken", "acts"), f"baseline {i + 1}")
        bid = check_id(b.get("id"), f"baseline {i + 1} id")
        rows = b.get("acts") or {}
        if not isinstance(rows, dict) or len(rows) > LIMITS["activities"]:
            raise SchedError("bad_field", f"Baseline {i + 1}: activities must be a map.")
        out = {}
        for k in sorted(rows):
            v = rows[k]
            if not isinstance(v, list) or len(v) != 3:
                raise SchedError("bad_field", f"Baseline {i + 1}: each activity is [start, finish, duration].")
            out[check_id(k, "baseline activity id")] = [check_dt(v[0], "baseline start"), check_dt(v[1], "baseline finish"),
                                                       check_int(v[2], "baseline duration", 0, MAX_MIN)]
        bls.append({"id": bid, "name": clean_text(b.get("name"), "baseline name", 120) or bid,
                    "taken": check_dt(b.get("taken"), "baseline date"), "acts": out})
    bl_ids = _unique(bls, "baselines")
    p["baselines"] = bls
    p["baseline"] = obj.get("baseline") or None
    if p["baseline"] is not None and p["baseline"] not in bl_ids:
        p["baseline"] = None
    return p


def new_project(name="New project", start="2026-11-02T08:00"):
    return validate_project({"name": name, "start": start, "data_date": start})
