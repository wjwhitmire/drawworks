"""Microsoft Project XML (MSPDI) files: read and write.

Element names and codes follow the published MSPDI schema:
  PredecessorLink/Type: 0 = FF, 1 = FS, 2 = SF, 3 = SS. LinkLag is in tenths of a minute.
  LagFormat: 3 m, 4 em, 5 h, 6 eh, 7 d, 8 ed, 9 w, 10 ew, 11 mo, 12 emo, 19 %, 20 e% (and the
  estimated "?" variants 35 to 53). Even codes are elapsed time.
  ConstraintType: 0 ASAP, 1 ALAP, 2 must start on, 3 must finish on, 4 SNET, 5 SNLT, 6 FNET, 7 FNLT.
  WeekDay/DayType: 1 = Sunday to 7 = Saturday; 0 = an exception day with a TimePeriod.
  Durations are ISO 8601 work durations such as PT16H0M0S. TotalSlack and FreeSlack are tenths of
  a minute.
Summary tasks become WBS elements; the project summary task (UID 0) is skipped. Must start on and
must finish on are mandatory in that tool (they win over links by default), so they come in as the
mandatory constraints here and go back out as codes 2 and 3.
"""

from __future__ import annotations

import math
import re

from .errors import SchedError
from .cpm import tree_rows, wbs_rollup
from .model import validate_project
from .xer import to_num
from .textio import decode_bytes, kid, kids, parse_xml, val, xml_escape
from .timecal import DAY, fmt_dt, fmt_hm, parse_dt, parse_day, round_div, standard_week

CSTR_IN = {"0": "ASAP", "1": "ALAP", "2": "MS_MAND", "3": "MF_MAND", "4": "SNET", "5": "SNLT", "6": "FNET", "7": "FNLT"}
CSTR_OUT = {"ASAP": 0, "ALAP": 1, "MSO": 2, "MS_MAND": 2, "MFO": 3, "MF_MAND": 3, "SNET": 4, "SNLT": 5, "FNET": 6, "FNLT": 7}
TYPE_IN = {"0": "FF", "1": "FS", "2": "SF", "3": "SS"}
TYPE_OUT = {"FF": 0, "FS": 1, "SF": 2, "SS": 3}
_DUR = re.compile(r"^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?"
                  r"(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$")


def parse_duration(s, mpd=480, mpw=2400):
    """ISO 8601 work duration -> working minutes (None when blank or malformed)."""
    if not s:
        return None
    m = _DUR.match(s.strip())
    if not m:
        return None
    y, mo, w, d, h, mi, se = (float(g) if g else 0.0 for g in m.groups())
    total = (y * 12 + mo) * 20 * mpd + w * mpw + d * mpd + h * 60 + mi + se / 60
    v = math.floor(total + 0.5)
    return -v if s.strip().startswith("-") else v


def fmt_duration(m):
    m = max(0, m)
    return f"PT{m // 60}H{m % 60}M0S"


def _dt(s):
    if not s:
        return None
    try:
        return fmt_dt(parse_dt(s.strip()))
    except SchedError:
        return None


def _int(s, default=None):
    s = (s or "").strip()
    return int(s) if re.fullmatch(r"[+-]?\d{1,15}", s) else default


def _num(s, default=0.0):
    v = to_num(s)
    return v if v is not None and abs(v) < 1e6 else default


def _times(wd):
    out = []
    for wt in kids(kid(wd, "WorkingTimes"), "WorkingTime"):
        a, b = val(wt, "FromTime"), val(wt, "ToTime")
        s, f = _hm(a), _hm(b)
        if s is None or f is None:
            continue
        if f <= s:
            f = DAY
        out.append([s, f])
    out.sort()
    merged = []
    for s, f in out:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], f)
        else:
            merged.append([s, f])
    return merged


def _hm(s):
    m = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", (s or "").strip())
    if not m:
        return None
    v = int(m.group(1)) * 60 + int(m.group(2))
    return v if v <= DAY else None


def _day_range(a, b, limit=3660):
    try:
        da = parse_dt(a.strip()) // DAY
        tb = parse_dt(b.strip())
    except (SchedError, AttributeError):
        return []
    db = (tb - 1) // DAY if tb % DAY == 0 else tb // DAY
    if db < da:
        db = da
    return list(range(da, min(db, da + limit) + 1))


def read_mspdi(data):
    if isinstance(data, (bytes, bytearray)):
        text, enc = decode_bytes(bytes(data), "XML file")
    else:
        text, enc = data, "text"
    root = parse_xml(text)
    if root["tag"] != "Project":
        raise SchedError("not_mspdi", "This XML file is not a project file (its root element is not Project).")
    warnings = []
    mpd = _int(val(root, "MinutesPerDay"), 480) or 480
    mpw = _int(val(root, "MinutesPerWeek"), mpd * 5) or mpd * 5
    if val(root, "ScheduleFromStart") == "0":
        warnings.append("The project is scheduled from its finish date; it was scheduled from its start here.")

    # calendars, with base calendar inheritance
    raw = {}
    for c in kids(kid(root, "Calendars"), "Calendar"):
        uid = val(c, "UID")
        if uid is None:
            continue
        week = [None] * 7
        exc = {}
        for wd in kids(kid(c, "WeekDays"), "WeekDay"):
            dt = _int(val(wd, "DayType"), -1)
            working = val(wd, "DayWorking") == "1"
            if 1 <= dt <= 7:
                week[dt - 1] = _times(wd) if working else []
            elif dt == 0:
                tp = kid(wd, "TimePeriod")
                for d in _day_range(val(tp, "FromDate"), val(tp, "ToDate")):
                    exc[d] = _times(wd) if working else []
        for ex in kids(kid(c, "Exceptions"), "Exception"):
            tp = kid(ex, "TimePeriod")
            working = val(ex, "DayWorking") == "1"
            for d in _day_range(val(tp, "FromDate"), val(tp, "ToDate")):
                exc[d] = _times(ex) if working else []
        if kid(c, "WorkWeeks") is not None:
            warnings.append(f'Calendar "{val(c, "Name", uid)}" has alternate work weeks; they were not imported.')
        raw[uid] = {"name": (val(c, "Name") or f"Calendar {uid}")[:120], "base": val(c, "BaseCalendarUID"), "week": week, "exc": exc}

    def resolve(uid, depth=0):
        r = raw[uid]
        week = list(r["week"])
        exc = dict(r["exc"])
        b = r["base"]
        if b and b != "-1" and b in raw and b != uid and depth < 10:
            bw, be = resolve(b, depth + 1)
            week = [week[i] if week[i] is not None else bw[i] for i in range(7)]
            exc = {**be, **exc}
        return week, exc

    cals = []
    cal_ids = {}
    for uid in raw:
        week, exc = resolve(uid)
        dflt = standard_week()
        week = [week[i] if week[i] is not None else dflt[i] for i in range(7)]
        if sum(f - s for d in week for s, f in d) == 0:
            warnings.append(f'Calendar "{raw[uid]["name"]}" has no working time; Monday to Friday 08:00 to 16:00 was used.')
            week = standard_week()
        gid = "c" + uid if re.fullmatch(r"-?\d{1,9}", uid) else f"cx{len(cals) + 1}"
        gid = gid.replace("-", "m")
        cal_ids[uid] = gid
        cals.append({"id": gid, "name": raw[uid]["name"], "hpd": mpd, "week": week,
                     "exceptions": {fmt_dt(d * DAY)[:10]: v for d, v in sorted(exc.items())}})
    if not cals:
        cals.append({"id": "std", "name": "Standard", "hpd": mpd, "week": standard_week(), "exceptions": {}})
    pcal = cal_ids.get(val(root, "CalendarUID") or "", cals[0]["id"])
    hpd_of = {c["id"]: c["hpd"] for c in cals}

    wbs, acts, stored, baseline = [], [], {}, {}
    act_ids = {}
    used = set()
    stack = []  # (outline level, wbs id)
    links = []
    for t in kids(kid(root, "Tasks"), "Task"):
        uid = val(t, "UID")
        if uid is None or uid == "0" or val(t, "IsNull") == "1":
            continue
        if val(t, "Active") == "0":
            warnings.append(f'"{val(t, "Name", uid)}" is inactive; it was skipped.')
            continue
        level = _int(val(t, "OutlineLevel"), 1) or 1
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1][1] if stack else None
        name = val(t, "Name") or ""
        if not re.fullmatch(r"\d{1,12}", uid) or uid in used:
            warnings.append("A task without a usable UID was skipped.")
            continue
        used.add(uid)
        if val(t, "Summary") == "1":
            wid = "w" + uid
            wbs.append({"id": wid, "code": (val(t, "WBS") or val(t, "OutlineNumber") or wid)[:60], "name": name, "parent": parent})
            stack.append((level, wid))
            continue
        gid = "t" + uid
        code = (val(t, "WBS") or val(t, "ID") or uid)[:40]
        df = _int(val(t, "DurationFormat"), 7)
        if df in (4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52):
            warnings.append(f"{code} has an elapsed duration; it was imported as working time.")
        od = parse_duration(val(t, "Duration"), mpd, mpw) or 0
        rdv = parse_duration(val(t, "RemainingDuration"), mpd, mpw)
        as_, af = _dt(val(t, "ActualStart")), _dt(val(t, "ActualFinish"))
        if af and not as_:
            as_ = af
        if as_ and af and af < as_:
            af = None
        rd = 0 if af else (rdv if rdv is not None else od)
        milestone = val(t, "Milestone") == "1" and od == 0
        cs = CSTR_IN.get(val(t, "ConstraintType") or "0", "ASAP")
        cd = _dt(val(t, "ConstraintDate"))
        if cs not in ("ASAP", "ALAP") and not cd:
            cs = "ASAP"
        cuid = val(t, "CalendarUID")
        cal = cal_ids.get(cuid) if cuid and cuid != "-1" else None
        if cal == pcal:
            cal = None
        ppc = _num(val(t, "PhysicalPercentComplete"), 0)
        notes = val(t, "Notes") or ""
        act_ids[uid] = gid
        acts.append({"id": gid, "code": code, "name": name, "wbs": parent, "cal": cal,
                     "type": "finish_ms" if milestone else "task", "od": max(0, od), "rd": max(0, rd), "as": as_, "af": af,
                     "pct_type": "physical" if ppc > 0 else "duration", "phys": min(100, max(0, int(ppc) if ppc == int(ppc) else ppc)),
                     "cstr": cs, "cstr_date": cd if cs not in ("ASAP", "ALAP") else None,
                     "unit": "h" if df in (5, 6, 37, 38) or od % hpd_of[cal or pcal] else "d", "notes": notes})
        ts = _int(val(t, "TotalSlack"))
        fs = _int(val(t, "FreeSlack"))
        stored[gid] = {"es": _dt(val(t, "EarlyStart")), "ef": _dt(val(t, "EarlyFinish")), "ls": _dt(val(t, "LateStart")),
                       "lf": _dt(val(t, "LateFinish")), "tf": round_div(ts, 10) if ts is not None else None,
                       "ff": round_div(fs, 10) if fs is not None else None, "start": _dt(val(t, "Start")),
                       "finish": _dt(val(t, "Finish"))}
        for b in kids(t, "Baseline"):
            if val(b, "Number") == "0":
                bs, bf = _dt(val(b, "Start")), _dt(val(b, "Finish"))
                if bs and bf:
                    baseline[gid] = [bs, bf, parse_duration(val(b, "Duration"), mpd, mpw) or 0]
        for pl in kids(t, "PredecessorLink"):
            links.append((gid, pl, code))

    rels = []
    seen = set()
    od_of = {a["id"]: a for a in acts}
    for gid, pl, code in links:
        pu = val(pl, "PredecessorUID")
        if val(pl, "CrossProject") == "1" or pu not in act_ids:
            if pu not in act_ids:
                warnings.append("A link to a summary task, an inactive task or another project was skipped.")
            continue
        pr = act_ids[pu]
        typ = TYPE_IN.get(val(pl, "Type") or "1", "FS")
        lf = _int(val(pl, "LagFormat"), 7)
        raw_lag = _int(val(pl, "LinkLag"), 0) or 0
        elapsed = lf in (4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52)
        if lf in (19, 20, 51, 52):
            pod = od_of[pr]["od"]
            lag = round_div(pod * raw_lag, 1000)
            warnings.append(f"A percent lag into {code} was converted to working time.")
            elapsed = False
        else:
            lag = round_div(raw_lag, 10)
        key = (pr, gid, typ)
        if key in seen or pr == gid:
            continue
        seen.add(key)
        rels.append({"id": f"l{len(rels) + 1}", "pred": pr, "succ": gid, "type": typ, "lag": lag, "elapsed": elapsed})

    rsrcs = []
    rsrc_ids = {}
    for r in kids(kid(root, "Resources"), "Resource"):
        uid = val(r, "UID")
        if not uid or uid == "0" or val(r, "IsNull") == "1" or not re.fullmatch(r"\d{1,12}", uid) or uid in rsrc_ids:
            continue
        typ = {"1": "labor", "0": "material"}.get(val(r, "Type") or "1")
        if typ is None:
            continue
        rid = "r" + uid
        rsrc_ids[uid] = rid
        mu = _num(val(r, "MaxUnits"), 1.0)
        rsrcs.append({"id": rid, "code": (val(r, "Initials") or val(r, "Name") or rid)[:40], "name": val(r, "Name") or "",
                      "type": typ, "max_units": max(0, math.floor(mu * 1000 + 0.5)),
                      "unit": (val(r, "MaterialLabel") or "ea")[:20] if typ == "material" else "h"})
    asg = []
    for x in kids(kid(root, "Assignments"), "Assignment"):
        a, r = act_ids.get(val(x, "TaskUID") or ""), rsrc_ids.get(val(x, "ResourceUID") or "")
        if a is None or r is None:
            continue
        units = math.floor(_num(val(x, "Units"), 1.0) * 1000 + 0.5)
        work = parse_duration(val(x, "Work"), mpd, mpw)
        actual = parse_duration(val(x, "ActualWork"), mpd, mpw) or 0
        budget = round_div(work * 1000, 60) if work is not None else round_div(units * od_of[a]["od"], 60)
        asg.append({"id": f"x{len(asg) + 1}", "act": a, "rsrc": r, "units": max(0, units), "budget": max(0, budget),
                    "actual": max(0, round_div(actual * 1000, 60))})

    start = _dt(val(root, "StartDate")) or min((s["start"] for s in stored.values() if s["start"]), default=None) or "2026-01-01T08:00"
    dd = _dt(val(root, "StatusDate")) or start
    bls = [{"id": "bl0", "name": "Baseline in the file", "taken": dd, "acts": baseline}] if baseline else []
    proj = validate_project({
        "id": "p1", "name": (val(root, "Title") or val(root, "Name") or "Imported project")[:200], "start": start,
        "data_date": dd, "cal": pcal, "calendars": cals, "wbs": _order(wbs), "activities": acts, "rels": rels,
        "resources": rsrcs, "assigns": asg, "baselines": bls, "baseline": "bl0" if bls else None,
        "settings": {"lag_cal": "succ"}})
    report = {"format": "MSPDI", "encoding": enc, "version": val(root, "SaveVersion") or "",
              "counts": {"activities": len(acts), "rels": len(rels), "wbs": len(wbs), "calendars": len(cals),
                         "resources": len(rsrcs), "assigns": len(asg)},
              "warnings": _dedupe(warnings), "tables": {}, "unknown_tables": []}
    return {"project": proj, "report": report, "stored": stored, "projects": []}


def _order(wbs):
    ids = {w["id"] for w in wbs}
    for w in wbs:
        if w["parent"] not in ids:
            w["parent"] = None
    return wbs


def _dedupe(ws):
    out, n = [], {}
    for w in ws:
        n[w] = n.get(w, 0) + 1
        if n[w] == 1:
            out.append(w)
    return [w if n[w] == 1 else f"{w} ({n[w]} times)" for w in out[:200]]


# ---------------------------------------------------------------------------------------- writing

def _x(s):
    return (s + ":00") if s else ""


def _actual(a):
    return a["od"] if a["af"] else max(0, a["od"] - a["rd"]) if a["as"] else 0


def _dur(a):
    """Project holds Duration = ActualDuration + RemainingDuration for every task."""
    return a["od"] if a["af"] else _actual(a) + a["rd"]


def write_mspdi(p, sched):
    E = xml_escape
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<Project xmlns="http://schemas.microsoft.com/project">']
    cal_uid = {c["id"]: i + 1 for i, c in enumerate(p["calendars"])}
    pc = next(c for c in p["calendars"] if c["id"] == p["cal"])
    mpd = pc["hpd"]
    mpw = sum(f - s for d in pc["week"] for s, f in d) or mpd * 5
    first = pc["week"][1][0][0] if pc["week"][1] else 480

    def tag(name, v):
        out.append(f"<{name}>{E(v)}</{name}>")

    tag("SaveVersion", 14)
    tag("Name", p["name"])
    tag("Title", p["name"])
    tag("ScheduleFromStart", 1)
    tag("StartDate", _x(p["start"]))
    tag("FinishDate", _x(sched["finish"]))
    tag("CriticalSlackLimit", round_div(p["settings"]["crit_tf"], mpd))
    tag("CurrencyCode", "USD")
    tag("CalendarUID", cal_uid[p["cal"]])
    tag("DefaultStartTime", fmt_hm(first) + ":00")
    tag("MinutesPerDay", mpd)
    tag("MinutesPerWeek", mpw)
    tag("DaysPerMonth", 20)
    tag("DurationFormat", 7)
    tag("HonorConstraints", 1)
    tag("StatusDate", _x(p["data_date"]))
    tag("CurrentDate", _x(p["data_date"]))
    tag("NewTaskStartDate", 0)
    out.append("<Calendars>")
    for c in p["calendars"]:
        out.append("<Calendar>")
        tag("UID", cal_uid[c["id"]])
        tag("Name", c["name"])
        tag("IsBaseCalendar", 1)
        tag("BaseCalendarUID", -1)
        out.append("<WeekDays>")
        for d in range(7):
            ivs = c["week"][d]
            out.append(f"<WeekDay><DayType>{d + 1}</DayType><DayWorking>{1 if ivs else 0}</DayWorking>")
            if ivs:
                out.append("<WorkingTimes>" + "".join(
                    f"<WorkingTime><FromTime>{fmt_hm(s)}:00</FromTime><ToTime>{fmt_hm(f % DAY)}:00</ToTime></WorkingTime>"
                    for s, f in ivs) + "</WorkingTimes>")
            out.append("</WeekDay>")
        out.append("</WeekDays>")
        if c["exceptions"]:
            out.append("<Exceptions>")
            items = sorted((parse_day(k), v) for k, v in c["exceptions"].items())
            groups = []
            for d, v in items:
                if groups and groups[-1][1] == d - 1 and groups[-1][2] == v:
                    groups[-1][1] = d
                else:
                    groups.append([d, d, v])
            for a, b, v in groups:
                out.append("<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod>"
                           f"<FromDate>{fmt_dt(a * DAY)}:00</FromDate><ToDate>{fmt_dt(b * DAY + 1439)}:00</ToDate></TimePeriod>"
                           f"<Occurrences>1</Occurrences><Name>{'Holiday' if not v else 'Exception'}</Name><Type>1</Type>"
                           f"<DayWorking>{1 if v else 0}</DayWorking>")
                if v:
                    out.append("<WorkingTimes>" + "".join(
                        f"<WorkingTime><FromTime>{fmt_hm(s)}:00</FromTime><ToTime>{fmt_hm(f % DAY)}:00</ToTime></WorkingTime>"
                        for s, f in v) + "</WorkingTimes>")
                out.append("</Exception>")
            out.append("</Exceptions>")
        out.append("</Calendar>")
    out.append("</Calendars>")

    # task order: WBS tree in order, each element's activities after it
    rows = tree_rows(p)
    roll = wbs_rollup(p, sched)
    uid = {}
    for i, (kind, x, _l, _o) in enumerate(rows):
        uid[(kind, x["id"])] = i + 1
    preds = {}
    for r in p["rels"]:
        preds.setdefault(r["succ"], []).append(r)
    bl = next((b for b in p["baselines"] if b["id"] == p["baseline"]), None)
    hpd_of = {c["id"]: c["hpd"] for c in p["calendars"]}

    out.append("<Tasks>")
    out.append(f"<Task><UID>0</UID><ID>0</ID><Name>{E(p['name'])}</Name><Type>1</Type><IsNull>0</IsNull>"
               f"<OutlineNumber>0</OutlineNumber><OutlineLevel>0</OutlineLevel><Start>{_x(sched['start'])}</Start>"
               f"<Finish>{_x(sched['finish'])}</Finish><Summary>1</Summary></Task>")
    for i, (k, x, level, onum) in enumerate(rows):
        if k == "w":
            r = roll.get(x["id"], {})
            out.append(f"<Task><UID>{uid[('w', x['id'])]}</UID><ID>{i + 1}</ID><Name>{E(x['name'] or x['code'])}</Name>"
                       f"<Type>1</Type><IsNull>0</IsNull><WBS>{E(x['code'])}</WBS><OutlineNumber>{onum}</OutlineNumber>"
                       f"<OutlineLevel>{level}</OutlineLevel>"
                       + (f"<Start>{_x(r['es'])}</Start><Finish>{_x(r['ef'])}</Finish>" if r.get("es") else "")
                       + "<Milestone>0</Milestone><Summary>1</Summary></Task>")
            continue
        a = x
        rec = sched["acts"][a["id"]]
        hpd = hpd_of[a["cal"] or p["cal"]]
        start = a["as"] or rec["es"]
        finish = a["af"] or rec["ef"]
        out.append("<Task>")
        tag("UID", uid[("a", a["id"])])
        tag("ID", i + 1)
        tag("Name", a["name"])
        tag("Type", 1)
        tag("IsNull", 0)
        tag("WBS", a["code"])
        tag("OutlineNumber", onum)
        tag("OutlineLevel", level)
        tag("Start", _x(start))
        tag("Finish", _x(finish))
        tag("Duration", fmt_duration(_dur(a)))
        tag("DurationFormat", 7 if a["unit"] == "d" else 5)
        tag("Milestone", 1 if a["type"] != "task" else 0)
        tag("Summary", 0)
        tag("Critical", 1 if rec["crit"] else 0)
        tag("EarlyStart", _x(rec["es"]))
        tag("EarlyFinish", _x(rec["ef"]))
        if rec["ls"]:
            tag("LateStart", _x(rec["ls"]))
            tag("LateFinish", _x(rec["lf"]))
        if rec["ff"] is not None:
            tag("FreeSlack", rec["ff"] * 10)
            tag("TotalSlack", rec["tf"] * 10)
        tag("PercentComplete", 100 if a["af"] else (0 if not a["as"] or not a["od"] else max(0, min(99, (a["od"] - a["rd"]) * 100 // a["od"]))))
        if a["as"]:
            tag("ActualStart", _x(a["as"]))
        if a["af"]:
            tag("ActualFinish", _x(a["af"]))
        if a["as"]:
            tag("ActualDuration", fmt_duration(_actual(a)))
        tag("RemainingDuration", fmt_duration(a["rd"]))
        tag("ConstraintType", CSTR_OUT[a["cstr"]])
        tag("CalendarUID", cal_uid[a["cal"]] if a["cal"] else -1)
        if a["cstr_date"]:
            tag("ConstraintDate", _x(a["cstr_date"]))
        if a["notes"]:
            tag("Notes", a["notes"])
        if a["pct_type"] == "physical":
            tag("PhysicalPercentComplete", a["phys"])
        for r in preds.get(a["id"], []):
            fmt = (8 if r["elapsed"] else 7) if r["lag"] % hpd == 0 else (6 if r["elapsed"] else 5)
            out.append(f"<PredecessorLink><PredecessorUID>{uid[('a', r['pred'])]}</PredecessorUID><Type>{TYPE_OUT[r['type']]}</Type>"
                       f"<CrossProject>0</CrossProject><LinkLag>{r['lag'] * 10}</LinkLag><LagFormat>{fmt}</LagFormat></PredecessorLink>")
        if bl and a["id"] in bl["acts"]:
            b = bl["acts"][a["id"]]
            out.append(f"<Baseline><Number>0</Number><Start>{_x(b[0])}</Start><Finish>{_x(b[1])}</Finish>"
                       f"<Duration>{fmt_duration(b[2])}</Duration><DurationFormat>7</DurationFormat></Baseline>")
        out.append("</Task>")
    out.append("</Tasks>")
    out.append("<Resources>")
    ruid = {}
    for i, r in enumerate(p["resources"]):
        ruid[r["id"]] = i + 1
        out.append(f"<Resource><UID>{i + 1}</UID><ID>{i + 1}</ID><Name>{E(r['name'] or r['code'])}</Name>"
                   f"<Type>{0 if r['type'] == 'material' else 1}</Type><IsNull>0</IsNull><Initials>{E(r['code'])}</Initials>"
                   + (f"<MaterialLabel>{E(r['unit'])}</MaterialLabel>" if r["type"] == "material" else "")
                   + f"<MaxUnits>{r['max_units'] // 1000}.{r['max_units'] % 1000:03d}</MaxUnits></Resource>")
    out.append("</Resources>")
    out.append("<Assignments>")
    acts = {a["id"]: a for a in p["activities"]}
    for i, x in enumerate(p["assigns"]):
        a = acts[x["act"]]
        rem = round_div(x["units"] * a["rd"], 1000)
        out.append(f"<Assignment><UID>{i + 1}</UID><TaskUID>{uid[('a', x['act'])]}</TaskUID><ResourceUID>{ruid[x['rsrc']]}</ResourceUID>"
                   f"<ActualWork>{fmt_duration(round_div(x['actual'] * 60, 1000))}</ActualWork>"
                   f"<RemainingWork>{fmt_duration(rem)}</RemainingWork>"
                   f"<Units>{x['units'] // 1000}.{x['units'] % 1000:03d}</Units>"
                   f"<Work>{fmt_duration(round_div(x['budget'] * 60, 1000))}</Work></Assignment>")
    out.append("</Assignments>")
    out.append("</Project>")
    return "\n".join(out) + "\n"
