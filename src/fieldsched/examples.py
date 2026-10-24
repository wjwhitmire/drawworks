"""The two example projects shipped with the tool. Both are invented: the well, the lease, the
building, the dates and every duration are made up for demonstration and labeled as such."""

from __future__ import annotations

from .cpm import schedule
from .model import validate_project
from .progress import apply_update, propose_update, take_baseline

H = 60
DRILL_LABEL = "Example data: an invented land well program. The well, lease, rig and every date and duration are made up."
BUILD_LABEL = "Example data: an invented two-story commercial building. The site, owner and every date and duration are made up."


def _acts(rows, cal_of, unit):
    out = []
    for code, name, wbs, cal, dur, typ in rows:
        out.append({"id": code, "code": code, "name": name, "wbs": wbs, "cal": cal_of.get(cal), "type": typ,
                    "od": dur, "rd": dur, "unit": unit if cal != "office" else "d"})
    return out


def _rels(rows):
    return [{"id": f"r{i + 1}", "pred": p, "succ": s, "type": t, "lag": lag} for i, (p, s, t, lag) in enumerate(rows)]


def drilling_plan():
    rig = {"id": "rig24", "name": "Rig 24 hour, 7 day", "hpd": 1440, "week": [[[0, 1440]] for _ in range(7)], "exceptions": {}}
    office = {"id": "office", "name": "Office 5 x 10", "hpd": 600,
              "week": [[] if d in (0, 6) else [[420, 1020]] for d in range(7)],
              "exceptions": {"2026-11-26": [], "2026-11-27": [], "2026-12-24": [], "2026-12-25": []}}
    D = 600  # one office day
    wbs = [
        {"id": "PRE", "code": "PRE", "name": "Pre-spud planning and permits", "parent": None},
        {"id": "MOVE", "code": "MOVE", "name": "Rig move and rig up", "parent": None},
        {"id": "DRL", "code": "DRL", "name": "Drilling", "parent": None},
        {"id": "SURF", "code": "DRL.SURF", "name": "Surface hole, 17-1/2 in", "parent": "DRL"},
        {"id": "INT", "code": "DRL.INT", "name": "Intermediate hole, 12-1/4 in", "parent": "DRL"},
        {"id": "PROD", "code": "DRL.PROD", "name": "Production hole and lateral, 8-3/4 in", "parent": "DRL"},
        {"id": "CSG", "code": "CSG", "name": "Production casing and rig release", "parent": None},
        {"id": "HAND", "code": "HAND", "name": "Completion handoff", "parent": None},
    ]
    rows = [
        ("A1000", "Well program kickoff", "PRE", "office", 0, "start_ms"),
        ("A1010", "Finalize drilling program and well plan", "PRE", "office", 3 * D, "task"),
        ("A1020", "Permit to drill approved", "PRE", "office", 0, "finish_ms"),
        ("A1030", "Pre-spud meeting with rig and service crews", "PRE", "office", 4 * H, "task"),
        ("A1040", "Order casing, wellhead and float equipment", "PRE", "office", 2 * D, "task"),
        ("A1050", "Casing and wellhead delivery (vendor lead time)", "PRE", "rig", 7 * 24 * H, "task"),
        ("A1100", "Rig down at previous location", "MOVE", "rig", 36 * H, "task"),
        ("A1110", "Move rig loads to new pad", "MOVE", "rig", 48 * H, "task"),
        ("A1120", "Rig up", "MOVE", "rig", 30 * H, "task"),
        ("A1130", "Pre-spud inspection and safety walk", "MOVE", "rig", 6 * H, "task"),
        ("A1200", "Spud well", "SURF", "rig", 0, "start_ms"),
        ("A1210", "Drill 17-1/2 in surface hole to 1,800 ft", "SURF", "rig", 30 * H, "task"),
        ("A1220", "Run 13-3/8 in surface casing", "SURF", "rig", 10 * H, "task"),
        ("A1230", "Cement surface casing", "SURF", "rig", 6 * H, "task"),
        ("A1240", "Wait on cement", "SURF", "rig", 8 * H, "task"),
        ("A1250", "Nipple up BOP and pressure test", "SURF", "rig", 14 * H, "task"),
        ("A1300", "Drill 12-1/4 in intermediate hole to 7,500 ft", "INT", "rig", 72 * H, "task"),
        ("A1310", "Wiper trip and condition hole", "INT", "rig", 10 * H, "task"),
        ("A1320", "Run 9-5/8 in intermediate casing", "INT", "rig", 18 * H, "task"),
        ("A1330", "Cement intermediate casing", "INT", "rig", 8 * H, "task"),
        ("A1340", "Test casing and drill out shoe track", "INT", "rig", 8 * H, "task"),
        ("A1400", "Drill 8-3/4 in curve", "PROD", "rig", 40 * H, "task"),
        ("A1410", "Drill 8-3/4 in lateral to total depth", "PROD", "rig", 150 * H, "task"),
        ("A1420", "Circulate and condition hole at TD", "PROD", "rig", 8 * H, "task"),
        ("A1430", "Trip out for open hole logs", "PROD", "rig", 12 * H, "task"),
        ("A1440", "Open hole wireline logging", "PROD", "rig", 16 * H, "task"),
        ("A1450", "Log review and casing point sign-off", "PROD", "rig", 4 * H, "task"),
        ("A1500", "Run 5-1/2 in production casing", "CSG", "rig", 30 * H, "task"),
        ("A1510", "Cement production casing", "CSG", "rig", 10 * H, "task"),
        ("A1520", "Nipple down BOP and set slips", "CSG", "rig", 8 * H, "task"),
        ("A1530", "Rig release", "CSG", "rig", 0, "finish_ms"),
        ("A1600", "Completion handoff package", "HAND", "rig", 12 * H, "task"),
        ("A1610", "Rig down for move to next pad", "HAND", "rig", 24 * H, "task"),
        ("A1620", "Well handed to completions", "HAND", "office", 0, "finish_ms"),
    ]
    acts = _acts(rows, {"rig": None, "office": "office"}, "h")
    for a in acts:
        if a["code"] == "A1020":
            a["cstr"], a["cstr_date"] = "FNET", "2026-11-06T12:00"
            a["notes"] = "The state approval date is outside the crew's control, so it is held with a finish no earlier than constraint."
        if a["code"] == "A1620":
            a["cstr"], a["cstr_date"] = "FNLT", "2026-12-11T17:00"
            a["notes"] = "Completions crew is booked from this date."
    rels = _rels([
        ("A1000", "A1010", "FS", 0), ("A1000", "A1020", "FS", 0), ("A1010", "A1030", "FS", 0),
        ("A1010", "A1040", "SS", 1 * D), ("A1040", "A1050", "FS", 0),
        ("A1000", "A1100", "FS", 0), ("A1100", "A1110", "FS", -12 * H), ("A1110", "A1120", "FS", 0),
        ("A1120", "A1130", "FS", 0), ("A1030", "A1130", "FS", 0), ("A1020", "A1130", "FS", 0),
        ("A1130", "A1200", "FS", 0), ("A1200", "A1210", "FS", 0), ("A1210", "A1220", "FS", 0),
        ("A1220", "A1230", "FS", 0), ("A1230", "A1240", "FS", 0), ("A1240", "A1250", "FS", 0),
        ("A1250", "A1300", "FS", 0), ("A1300", "A1310", "FS", 0), ("A1310", "A1320", "FS", 0),
        ("A1050", "A1320", "FS", 0), ("A1320", "A1330", "FS", 0), ("A1330", "A1340", "FS", 0),
        ("A1340", "A1400", "FS", 0), ("A1400", "A1410", "FS", 0), ("A1410", "A1420", "FS", 0),
        ("A1420", "A1430", "FS", 0), ("A1430", "A1440", "FS", 0), ("A1440", "A1450", "SS", 8 * H),
        ("A1440", "A1450", "FF", 4 * H), ("A1450", "A1500", "FS", 0), ("A1500", "A1510", "FS", 0),
        ("A1510", "A1520", "FS", 0), ("A1520", "A1530", "FS", 0), ("A1530", "A1600", "FS", 0),
        ("A1530", "A1610", "FS", 0), ("A1600", "A1620", "FS", 0),
    ])
    rsrc = [
        {"id": "RIG", "code": "RIG", "name": "Drilling rig (invented Rig 14)", "type": "nonlabor", "max_units": 1000},
        {"id": "DD", "code": "DD", "name": "Directional drilling crew", "type": "labor", "max_units": 2000},
        {"id": "CSGC", "code": "CSGC", "name": "Casing crew", "type": "labor", "max_units": 1000},
        {"id": "CMT", "code": "CMT", "name": "Cementing unit", "type": "nonlabor", "max_units": 1000},
        {"id": "WL", "code": "WL", "name": "Wireline logging unit", "type": "nonlabor", "max_units": 1000},
        {"id": "TRK", "code": "TRK", "name": "Rig move trucks", "type": "nonlabor", "max_units": 6000},
        {"id": "ENG", "code": "ENG", "name": "Drilling engineer", "type": "labor", "max_units": 1000},
    ]
    asg_rows = [("A1100", "RIG", 1000), ("A1110", "TRK", 6000), ("A1120", "RIG", 1000)]
    for code in ("A1210", "A1220", "A1230", "A1240", "A1250", "A1300", "A1310", "A1320", "A1330", "A1340", "A1400",
                 "A1410", "A1420", "A1430", "A1440", "A1500", "A1510", "A1520"):
        asg_rows.append((code, "RIG", 1000))
    asg_rows += [("A1300", "DD", 2000), ("A1400", "DD", 2000), ("A1410", "DD", 2000), ("A1220", "CSGC", 1000),
                 ("A1320", "CSGC", 1000), ("A1500", "CSGC", 1000), ("A1230", "CMT", 1000), ("A1330", "CMT", 1000),
                 ("A1510", "CMT", 1000), ("A1440", "WL", 1000), ("A1010", "ENG", 1000), ("A1040", "ENG", 1000),
                 ("A1450", "ENG", 1000), ("A1600", "ENG", 1000)]
    dur = {a["id"]: a["od"] for a in acts}
    asg = [{"id": f"x{i + 1}", "act": a, "rsrc": r, "units": u, "budget": (u * dur[a] + 30) // 60, "actual": 0}
           for i, (a, r, u) in enumerate(asg_rows)]
    return validate_project({
        "id": "drill", "name": "Example Ranch 14-2H well program", "label": DRILL_LABEL, "start": "2026-11-02T07:00",
        "data_date": "2026-11-02T07:00", "cal": "rig24", "calendars": [rig, office], "wbs": wbs, "activities": acts,
        "rels": rels, "resources": rsrc, "assigns": asg,
        "settings": {"unit": "h", "crit": "longest", "crit_tf": 0, "near_tf": 24 * H, "long_lag": 48 * H, "high_float": 20 * 1440,
                     "high_dur": 10 * 1440}})


def build_plan():
    std = {"id": "std5", "name": "Standard 5 day, 8 hour", "hpd": 480,
           "week": [[] if d in (0, 6) else [[420, 660], [690, 930]] for d in range(7)],
           "exceptions": {"2026-11-26": [], "2026-11-27": [], "2026-12-24": [], "2026-12-25": [], "2027-01-01": [],
                          "2027-01-18": [], "2027-02-15": []}}
    D = 480
    wbs = [
        {"id": "PRE", "code": "1", "name": "Preconstruction", "parent": None},
        {"id": "SITE", "code": "2", "name": "Sitework", "parent": None},
        {"id": "FND", "code": "3", "name": "Foundations", "parent": None},
        {"id": "STR", "code": "4", "name": "Structure", "parent": None},
        {"id": "ENV", "code": "5", "name": "Building envelope", "parent": None},
        {"id": "MEP", "code": "6", "name": "Mechanical, electrical, plumbing", "parent": None},
        {"id": "FIN", "code": "7", "name": "Interiors and finishes", "parent": None},
        {"id": "CLO", "code": "8", "name": "Inspections and closeout", "parent": None},
    ]
    rows = [
        ("C1000", "Notice to proceed", "PRE", "std", 0, "start_ms"),
        ("C1010", "Submittals and approvals", "PRE", "std", 10 * D, "task"),
        ("C1020", "Building permit issued", "PRE", "std", 0, "finish_ms"),
        ("C1030", "Mobilize and set up site office", "PRE", "std", 2 * D, "task"),
        ("C1100", "Clear and rough grade", "SITE", "std", 4 * D, "task"),
        ("C1110", "Underground utilities", "SITE", "std", 6 * D, "task"),
        ("C1120", "Building pad and compaction", "SITE", "std", 3 * D, "task"),
        ("C1200", "Footings and grade beams", "FND", "std", 5 * D, "task"),
        ("C1210", "Under-slab plumbing and electrical", "FND", "std", 4 * D, "task"),
        ("C1220", "Slab on grade", "FND", "std", 3 * D, "task"),
        ("C1300", "Steel erection", "STR", "std", 10 * D, "task"),
        ("C1310", "Metal deck and second floor slab", "STR", "std", 6 * D, "task"),
        ("C1320", "Roof framing and deck", "STR", "std", 4 * D, "task"),
        ("C1400", "Exterior framing and sheathing", "ENV", "std", 8 * D, "task"),
        ("C1410", "Roofing", "ENV", "std", 5 * D, "task"),
        ("C1420", "Windows and storefront", "ENV", "std", 6 * D, "task"),
        ("C1430", "Exterior finish", "ENV", "std", 10 * D, "task"),
        ("C1440", "Building dried in", "ENV", "std", 0, "finish_ms"),
        ("C1500", "MEP rough-in", "MEP", "std", 15 * D, "task"),
        ("C1510", "Set rooftop HVAC units", "MEP", "std", 3 * D, "task"),
        ("C1520", "Temporary heat", "MEP", "std", 20 * D, "task"),
        ("C1530", "HVAC startup and balance", "MEP", "std", 2 * D, "task"),
        ("C1600", "Insulation and drywall", "FIN", "std", 12 * D, "task"),
        ("C1610", "Prime and paint", "FIN", "std", 8 * D, "task"),
        ("C1620", "Flooring", "FIN", "std", 6 * D, "task"),
        ("C1630", "Ceiling grid and light fixtures", "FIN", "std", 6 * D, "task"),
        ("C1640", "Doors, hardware and specialties", "FIN", "std", 5 * D, "task"),
        ("C1700", "Final inspections", "CLO", "std", 3 * D, "task"),
        ("C1710", "Punch list", "CLO", "std", 5 * D, "task"),
        ("C1720", "Landscaping", "CLO", "std", 4 * D, "task"),
        ("C1730", "Substantial completion", "CLO", "std", 0, "finish_ms"),
    ]
    acts = _acts(rows, {"std": None}, "d")
    for a in acts:
        if a["code"] == "C1020":
            a["cstr"], a["cstr_date"] = "FNET", "2026-11-13T15:30"
        if a["code"] == "C1730":
            a["cstr"], a["cstr_date"] = "FNLT", "2027-04-30T15:30"
            a["notes"] = "Contract substantial completion date."
        if a["code"] == "C1720":
            a["cstr"] = "ALAP"
            a["notes"] = "As late as possible so new plantings are not damaged by finishing work."
    rels = _rels([
        ("C1000", "C1010", "FS", 0), ("C1000", "C1020", "FS", 0), ("C1000", "C1030", "FS", 0),
        ("C1030", "C1100", "FS", 0), ("C1020", "C1100", "FS", 0), ("C1100", "C1110", "SS", 2 * D),
        ("C1100", "C1120", "FS", 0), ("C1120", "C1200", "FS", 0), ("C1010", "C1200", "FS", 0),
        ("C1200", "C1210", "FS", 0), ("C1210", "C1220", "FS", 0), ("C1110", "C1220", "FS", 0),
        ("C1220", "C1300", "FS", 0), ("C1300", "C1310", "SS", 5 * D), ("C1300", "C1310", "FF", 2 * D),
        ("C1310", "C1320", "FS", 0), ("C1310", "C1400", "SS", 3 * D), ("C1320", "C1410", "FS", 0),
        ("C1400", "C1420", "FS", 0), ("C1420", "C1430", "FS", 0), ("C1410", "C1440", "FS", 0),
        ("C1420", "C1440", "FS", 0), ("C1440", "C1500", "FS", 0), ("C1410", "C1510", "FS", 0),
        ("C1440", "C1520", "FS", 0), ("C1530", "C1520", "SF", 0), ("C1510", "C1530", "FS", 0),
        ("C1500", "C1530", "FS", 0), ("C1500", "C1600", "FS", 0), ("C1600", "C1610", "SS", 4 * D),
        ("C1600", "C1610", "FF", 2 * D), ("C1610", "C1620", "FS", 0), ("C1600", "C1630", "FS", 0),
        ("C1620", "C1640", "FS", 0), ("C1640", "C1700", "FS", 0), ("C1630", "C1700", "FS", 0),
        ("C1530", "C1700", "FS", 0), ("C1700", "C1710", "FS", 0), ("C1710", "C1730", "FS", 0),
        ("C1430", "C1720", "FS", 0), ("C1720", "C1730", "FS", 0),
    ])
    rsrc = [
        {"id": "CRANE", "code": "CRANE", "name": "Crawler crane", "type": "nonlabor", "max_units": 1000},
        {"id": "CARP", "code": "CARP", "name": "Carpenters", "type": "labor", "max_units": 6000},
        {"id": "ELEC", "code": "ELEC", "name": "Electricians", "type": "labor", "max_units": 4000},
        {"id": "PLMB", "code": "PLMB", "name": "Plumbers", "type": "labor", "max_units": 3000},
        {"id": "LAB", "code": "LAB", "name": "Laborers", "type": "labor", "max_units": 6000},
        {"id": "CONC", "code": "CONC", "name": "Ready-mix concrete", "type": "material", "max_units": 0, "unit": "yd3"},
    ]
    asg_rows = [("C1300", "CRANE", 1000), ("C1310", "CRANE", 1000), ("C1510", "CRANE", 1000),
                ("C1100", "LAB", 4000), ("C1110", "LAB", 3000), ("C1110", "PLMB", 2000), ("C1200", "LAB", 4000),
                ("C1200", "CARP", 4000), ("C1210", "PLMB", 2000), ("C1210", "ELEC", 2000), ("C1220", "LAB", 5000),
                ("C1400", "CARP", 4000), ("C1500", "ELEC", 3000), ("C1500", "PLMB", 2000), ("C1530", "ELEC", 1000),
                ("C1600", "CARP", 6000), ("C1610", "LAB", 2000), ("C1630", "ELEC", 2000), ("C1640", "CARP", 2000),
                ("C1310", "CARP", 3000), ("C1200", "CONC", 18750), ("C1220", "CONC", 25000)]
    dur = {a["id"]: a["od"] for a in acts}
    asg = [{"id": f"x{i + 1}", "act": a, "rsrc": r, "units": u, "budget": (u * dur[a] + 30) // 60, "actual": 0}
           for i, (a, r, u) in enumerate(asg_rows)]
    return validate_project({
        "id": "build", "name": "Example two-story office building", "label": BUILD_LABEL, "start": "2026-11-02T07:00",
        "data_date": "2026-11-02T07:00", "cal": "std5", "calendars": [std], "wbs": wbs, "activities": acts,
        "rels": rels, "resources": rsrc, "assigns": asg, "settings": {"unit": "d"}})


def _progress(p, dd, tweak):
    s = schedule(p)
    p = take_baseline(p, s, "bl1", "Original plan", p["start"])
    s = schedule(p)
    props = propose_update(p, s, dd)
    props = [tweak(x) for x in props]
    props = [x for x in props if x]
    return apply_update(p, props, dd)


DRILL_ACTUALS = {  # code: (actual start, actual finish or None, remaining hours when in progress)
    "A1000": ("2026-11-02T07:00", "2026-11-02T07:00", 0),
    "A1010": ("2026-11-02T07:00", "2026-11-04T17:00", 0),
    "A1020": ("2026-11-06T10:00", "2026-11-06T10:00", 0),
    "A1030": ("2026-11-05T07:00", "2026-11-05T11:00", 0),
    "A1040": ("2026-11-03T07:00", "2026-11-04T17:00", 0),
    "A1050": ("2026-11-04T17:00", None, 130),
    "A1100": ("2026-11-02T07:00", "2026-11-03T19:00", 0),
    "A1110": ("2026-11-03T07:00", "2026-11-05T13:00", 0),
    "A1120": ("2026-11-05T13:00", "2026-11-06T23:00", 0),
    "A1130": ("2026-11-06T23:00", "2026-11-07T05:00", 0),
    "A1200": ("2026-11-07T05:00", "2026-11-07T05:00", 0),
    "A1210": ("2026-11-07T05:00", None, 28),
}


def drilling_example():
    """The plan, baselined, then statused at 07:00 on 2026-11-07: the rig move ran six hours long,
    rig up took four more, and the casing vendor slipped a day."""
    p = drilling_plan()
    p = take_baseline(p, schedule(p), "bl1", "Original plan", p["start"])
    acts = []
    for a in p["activities"]:
        if a["code"] in DRILL_ACTUALS:
            s, f, rem = DRILL_ACTUALS[a["code"]]
            a = {**a, "as": s, "af": f, "rd": 0 if f else rem * H}
        acts.append(a)
    asg = []
    for x in p["assigns"]:
        if x["act"] in DRILL_ACTUALS and DRILL_ACTUALS[x["act"]][1]:
            x = {**x, "actual": x["budget"]}
        asg.append(x)
    return validate_project({**p, "activities": acts, "assigns": asg, "data_date": "2026-11-07T07:00"})


def build_example():
    def tweak(x):
        if x["act"] == "C1200":  # footings running two days behind
            x["rd"] = x["rd"] + 2 * 480
        if x["act"] == "C1210":
            return None
        return x
    p = _progress(build_plan(), "2026-12-07T07:00", tweak)
    # under-slab rough-in started before the footings finished: out of sequence on purpose
    acts = [({**a, "as": "2026-12-03T07:00", "rd": 3 * 480} if a["id"] == "C1210" else a) for a in p["activities"]]
    return validate_project({**p, "activities": acts})


EXAMPLES = {"drill": drilling_example, "build": build_example}
