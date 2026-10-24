"""Primavera P6 XER files: read and write.

An XER file is tab-separated text. The first line starts with ERMHDR. Each table starts with a
line "%T<tab>NAME", then one "%F<tab>field<tab>field..." line naming the columns, then any number
of "%R<tab>value<tab>value..." rows. "%E" ends the file. Unknown tables and fields are kept out of
the way and reported. The reader uses PROJECT, CALENDAR, SCHEDOPTIONS, PROJWBS, TASK, TASKPRED,
RSRC, RSRCRATE and TASKRSRC. The writer emits the same tables in the order P6 does (a table is
written only when it has rows), with the codes P6 uses for every enumerated field.

Durations, lags and floats are stored in hours (target_drtn_hr_cnt, remain_drtn_hr_cnt, lag_hr_cnt,
total_float_hr_cnt). Dates are "YYYY-MM-DD HH:MM". Calendar work patterns live in the clndr_data
field, a nested parenthesised structure:
  (0||CalendarData()( (0||DaysOfWeek()( (0||1()()) (0||2()( (0||0(s|08:00|f|12:00)()) ... )) ...))
                      (0||Exceptions()( (0||0(d|46352)()) ... )) ))
Days of week are 1 = Sunday to 7 = Saturday. An exception date is a serial day number counted
from 1899-12-30 (the spreadsheet convention); an exception with no work periods is a holiday.
"""

from __future__ import annotations

import re

from .errors import SchedError
from .model import validate_project
from .textio import decode_bytes
from .timecal import DAY, days_from_civil, fmt_day, fmt_dt, fmt_fixed, fmt_hm, parse_dt, round_div, standard_week

MAX_ROWS = 2_000_000
SERIAL_EPOCH = days_from_civil(1899, 12, 30)
KNOWN = {"PROJECT", "CALENDAR", "SCHEDOPTIONS", "PROJWBS", "TASK", "TASKPRED", "RSRC", "RSRCRATE", "TASKRSRC"}

CSTR_IN = {"CS_MSO": "MSO", "CS_MSOA": "SNET", "CS_MSOB": "SNLT", "CS_MEO": "MFO", "CS_MEOA": "FNET",
           "CS_MEOB": "FNLT", "CS_ALAP": "ALAP", "CS_MANDSTART": "MS_MAND", "CS_MANDFIN": "MF_MAND"}
CSTR_OUT = {v: k for k, v in CSTR_IN.items()}
PCT_IN = {"CP_Drtn": "duration", "CP_Phys": "physical", "CP_Units": "units"}
PCT_OUT = {v: k for k, v in PCT_IN.items()}
RSRC_IN = {"RT_Labor": "labor", "RT_Equip": "nonlabor", "RT_Mat": "material"}
RSRC_OUT = {v: k for k, v in RSRC_IN.items()}
# SCHEDOPTIONS codes (total float and relationship lag calendar)
FLOAT_IN = {"FT_FF": "finish", "FT_SS": "start", "FT_Min": "min"}
FLOAT_OUT = {v: k for k, v in FLOAT_IN.items()}
LAGCAL_IN = {"rcal_Predecessor": "pred", "rcal_Successor": "succ", "rcal_24Hour": "24h", "rcal_ProjDefault": "project"}
LAGCAL_OUT = {v: k for k, v in LAGCAL_IN.items()}
# PROJECT fields a P6 export carries, with the values a new P6 project gets; the schedule-specific
# ones are filled in by write_xer
PROJECT_FIELDS = ["proj_id", "fy_start_month_num", "rsrc_self_add_flag", "allow_complete_flag", "rsrc_multi_assign_flag",
                  "checkout_flag", "project_flag", "step_complete_flag", "cost_qty_recalc_flag", "batch_sum_flag",
                  "name_sep_char", "def_complete_pct_type", "proj_short_name", "clndr_id", "task_code_base", "task_code_step",
                  "priority_num", "wbs_max_sum_level", "strgy_priority_num", "critical_drtn_hr_cnt", "last_recalc_date",
                  "plan_start_date", "plan_end_date", "scd_end_date", "add_date", "def_duration_type", "task_code_prefix",
                  "def_qty_type", "add_by_name", "def_rate_type", "add_act_remain_flag", "act_this_per_link_flag",
                  "def_task_type", "act_pct_link_flag", "critical_path_type", "task_code_prefix_flag",
                  "def_rollup_dates_flag", "use_project_baseline_flag", "rem_target_link_flag", "reset_planned_flag",
                  "allow_neg_act_flag", "sum_assign_level", "export_flag"]
PROJECT_DEFAULTS = {"fy_start_month_num": 1, "rsrc_self_add_flag": "Y", "allow_complete_flag": "Y", "rsrc_multi_assign_flag": "Y",
                    "checkout_flag": "N", "project_flag": "Y", "step_complete_flag": "N", "cost_qty_recalc_flag": "N",
                    "batch_sum_flag": "Y", "name_sep_char": ".", "def_complete_pct_type": "CP_Drtn", "task_code_base": 1000,
                    "task_code_step": 10, "priority_num": 10, "wbs_max_sum_level": 0, "strgy_priority_num": 100,
                    "def_duration_type": "DT_FixedDUR2", "task_code_prefix": "A", "def_qty_type": "QT_Hour",
                    "add_by_name": "admin", "def_rate_type": "COST_PER_QTY", "add_act_remain_flag": "N",
                    "act_this_per_link_flag": "Y", "def_task_type": "TT_Task", "act_pct_link_flag": "N",
                    "task_code_prefix_flag": "Y", "def_rollup_dates_flag": "Y", "use_project_baseline_flag": "Y",
                    "rem_target_link_flag": "Y", "reset_planned_flag": "N", "allow_neg_act_flag": "N",
                    "sum_assign_level": "SL_Taskrsrc", "export_flag": "Y"}


def parse_tables(text):
    """XER text -> {"header": [...], "tables": {name: {"fields": [...], "rows": [dict]}}, "warnings": [...]}."""
    tables = {}
    header = None
    warnings = []
    cur = None
    rows_total = 0
    cont = 0
    extra = set()
    lines = text.split("\n")
    for ln in lines:
        if ln.endswith("\r"):
            ln = ln[:-1]
        if not ln:
            continue
        if ln.startswith("%T"):
            name = ln[2:].strip()
            cur = tables.setdefault(name, {"fields": None, "rows": []})
            continue
        if ln.startswith("%F"):
            if cur is None:
                warnings.append("A field list appears before any table; it was ignored.")
                continue
            cur["fields"] = [f.strip() for f in ln.split("\t")[1:]]
            continue
        if ln.startswith("%R"):
            if cur is None or cur["fields"] is None:
                warnings.append("A row appears before its table's field list; it was ignored.")
                continue
            vals = ln.split("\t")[1:]
            fl = cur["fields"]
            if len(vals) > len(fl):
                extra.add(next(k for k, v in tables.items() if v is cur))
            row = {fl[i]: (vals[i] if i < len(vals) else "") for i in range(len(fl))}
            cur["rows"].append(row)
            rows_total += 1
            if rows_total > MAX_ROWS:
                raise SchedError("too_many", "The XER file has more than 2 million rows, the limit for this tool.")
            continue
        if ln.startswith("%E"):
            break
        if ln.startswith("ERMHDR"):
            header = ln.split("\t")
            continue
        if cur is not None and cur["rows"]:
            last = cur["rows"][-1]
            if cur["fields"]:
                k = cur["fields"][-1]
                last[k] = last.get(k, "") + "\n" + ln  # a %F line repeated with other fields mid-table
                cont += 1
            continue
        if header is None and not tables:
            raise SchedError("not_xer", "This does not look like an XER file (no ERMHDR line or %T tables).")
    if header is None and not tables:
        raise SchedError("not_xer", "This does not look like an XER file (no ERMHDR line or %T tables).")
    if cont:
        warnings.append((f"{cont} lines without a %R marker were joined to the rows above." if cont > 1 else "1 line without a %R marker was joined to the row above."))
    for t in sorted(extra):
        warnings.append(f"Table {t} has rows with more values than fields; the extra values were ignored.")
    return {"header": header or [], "tables": tables, "warnings": warnings}


NUM = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def to_num(v):
    """A plain decimal number or None (no inf, nan or digit separators)."""
    v = (v or "").strip()
    return float(v) if NUM.match(v) else None


def _hours(v, field, warnings):
    v = (v or "").strip()
    if not v:
        return 0
    x = to_num(v)
    if x is None:
        warnings.append(f'{field}: "{v[:20]}" is not a number; 0 was used.')
        return 0
    if abs(x) > 500000:
        warnings.append(f"{field}: {v[:20]} hours is out of range; 0 was used.")
        return 0
    return int(x * 60 + (0.5 if x >= 0 else -0.5))


def _date(v):
    v = (v or "").strip()
    if not v:
        return None
    try:
        return fmt_dt(parse_dt(v))
    except SchedError:
        return None


def _hm(s):
    m = re.match(r"^(\d{1,2}):(\d{2})$", s or "")
    if not m:
        return None
    v = int(m.group(1)) * 60 + int(m.group(2))
    return v if 0 <= v <= DAY else None


_DAY_HDR = re.compile(r"\(0\|\|([1-7])\(\)\(")
_EXC_HDR = re.compile(r"d\|(\d{1,6})")
_PERIOD = re.compile(r"s\|(\d{1,2}:\d{2})\|f\|(\d{1,2}:\d{2})|f\|(\d{1,2}:\d{2})\|s\|(\d{1,2}:\d{2})")


def _periods(seg):
    out = []
    for m in _PERIOD.finditer(seg):
        s, f = (_hm(m.group(1)), _hm(m.group(2))) if m.group(1) else (_hm(m.group(4)), _hm(m.group(3)))
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


def parse_clndr_data(s):
    """clndr_data -> (week or None, {date: intervals}).

    Read by markers rather than by counting parentheses, so a file with unbalanced nesting still
    yields its work week: each day header "(0||N()(" owns the work periods up to the next day
    header, and each exception "d|serial" owns the periods up to the next exception."""
    s = re.sub(r"[\s\x7f]+", "", s)
    if "CalendarData" not in s and "DaysOfWeek" not in s:
        raise ValueError("calendar data")
    marks = sorted(i for i in (s.find("VIEW"), s.find("Exceptions")) if i >= 0)
    week = None
    di = s.find("DaysOfWeek")
    if di >= 0:
        end = next((i for i in marks if i > di), len(s))
        sec = s[di:end]
        heads = list(_DAY_HDR.finditer(sec))
        if heads:
            week = [[] for _ in range(7)]
            for k, m in enumerate(heads):
                seg = sec[m.end():heads[k + 1].start() if k + 1 < len(heads) else len(sec)]
                week[int(m.group(1)) - 1] = _periods(seg)
    exc = {}
    ei = s.find("Exceptions")
    if ei >= 0:
        vi = s.find("VIEW", ei)
        sec = s[ei:vi if vi > ei else len(s)]
        heads = list(_EXC_HDR.finditer(sec))
        for k, m in enumerate(heads):
            seg = sec[m.end():heads[k + 1].start() if k + 1 < len(heads) else len(sec)]
            serial = int(m.group(1))
            if serial < 200000:
                exc[fmt_day(SERIAL_EPOCH + serial)] = _periods(seg)
    return week, exc


def _num_id(prefix, v):
    v = (v or "").strip()
    return f"{prefix}{v}" if re.fullmatch(r"[A-Za-z0-9._:\-]{1,60}", v) else None


def read_xer(data, project_id=None):
    """XER bytes (or text) -> {"project", "report", "stored", "projects"}."""
    if isinstance(data, (bytes, bytearray)):
        text, enc = decode_bytes(bytes(data), "XER file")
    else:
        text, enc = data, "text"
    parsed = parse_tables(text)
    T = parsed["tables"]
    warnings = list(parsed["warnings"])
    rows = lambda name: T.get(name, {}).get("rows", [])  # noqa: E731
    projects = [{"id": r.get("proj_id", ""), "name": r.get("proj_short_name", ""), "exported": r.get("export_flag") == "Y"} for r in rows("PROJECT")]
    if not projects:
        raise SchedError("not_xer", "The XER file has no PROJECT table.")
    if project_id is None:
        pick = next((r for r in rows("PROJECT") if r.get("export_flag") == "Y"), rows("PROJECT")[0])
    else:
        pick = next((r for r in rows("PROJECT") if r.get("proj_id") == project_id), None)
        if pick is None:
            raise SchedError("bad_ref", "That project is not in the XER file.")
    pid = pick.get("proj_id", "")
    if len(projects) > 1:
        warnings.append(f"The file holds {len(projects)} projects; {pick.get('proj_short_name', pid)} was opened.")

    # calendars: every calendar the project's activities use, plus the project default
    tasks = [r for r in rows("TASK") if r.get("proj_id", pid) == pid]
    used_cals = {r.get("clndr_id", "") for r in tasks}
    used_cals.add(pick.get("clndr_id", ""))
    cals = []
    cal_ids = {}
    for r in rows("CALENDAR"):
        cid = r.get("clndr_id", "")
        if cid not in used_cals:
            continue
        name = (r.get("clndr_name") or "").strip() or f"Calendar {cid}"
        week, exc = None, {}
        if (r.get("clndr_data") or "").strip():
            try:
                week, exc = parse_clndr_data(r["clndr_data"])
            except (ValueError, IndexError):
                warnings.append(f'Calendar "{name}": the work pattern could not be read; Monday to Friday 08:00 to 16:00 was used.')
        if week is None or sum(f - s for d in week for s, f in d) == 0:
            if week is not None:
                warnings.append(f'Calendar "{name}" has no working time; Monday to Friday 08:00 to 16:00 was used.')
            week = standard_week()
        hpd = _hours(r.get("day_hr_cnt"), f"calendar {name} hours per day", warnings)
        if not (0 < hpd <= DAY):
            hpd = max(sum(f - s for s, f in d) for d in week)
        gid = _num_id("c", cid) or f"c{len(cals) + 1}"
        cal_ids[cid] = gid
        cals.append({"id": gid, "name": name[:120], "hpd": hpd, "week": week, "exceptions": exc})
    if not cals:
        warnings.append("No calendar was found; a Monday to Friday 08:00 to 16:00 calendar was used.")
        cals.append({"id": "std", "name": "Standard", "hpd": 480, "week": standard_week(), "exceptions": {}})
    default_cal = cal_ids.get(pick.get("clndr_id", ""), cals[0]["id"])
    hpd_of = {c["id"]: c["hpd"] for c in cals}
    missing_cal = 0

    # WBS: the project node (proj_node_flag Y) is the project itself, not a WBS element
    wrows = [r for r in rows("PROJWBS") if r.get("proj_id", pid) == pid]
    root_ids = {r.get("wbs_id") for r in wrows if r.get("proj_node_flag") == "Y"}
    wbs = []
    wbs_ids = {}
    for r in sorted(wrows, key=lambda r: (_int(r.get("seq_num")), r.get("wbs_id", ""))):
        if r.get("wbs_id") in root_ids:
            continue
        gid = _num_id("w", r.get("wbs_id"))
        if gid is None:
            continue
        wbs_ids[r["wbs_id"]] = gid
    parent_of = {}
    for r in wrows:
        if r.get("wbs_id") in wbs_ids:
            par = r.get("parent_wbs_id")
            parent_of[wbs_ids[r["wbs_id"]]] = wbs_ids.get(par)
    for r in sorted(wrows, key=lambda r: (_int(r.get("seq_num")), r.get("wbs_id", ""))):
        gid = wbs_ids.get(r.get("wbs_id"))
        if gid:
            wbs.append({"id": gid, "code": (r.get("wbs_short_name") or "").strip()[:60] or gid,
                        "name": (r.get("wbs_name") or "").strip(), "parent": parent_of.get(gid)})
    wbs = _order_wbs(wbs)

    acts = []
    act_ids = {}
    used_gids = set()
    stored = {}
    for r in tasks:
        tid = r.get("task_id", "")
        gid = _num_id("t", tid)
        if gid is None or gid in used_gids:
            warnings.append("An activity without a usable task_id was skipped.")
            continue
        code = (r.get("task_code") or "").strip() or gid
        tt = r.get("task_type", "TT_Task")
        typ = {"TT_Mile": "start_ms", "TT_FinMile": "finish_ms"}.get(tt, "task")
        if tt == "TT_LOE":
            warnings.append(f"{code} is a level of effort activity; it was imported as a task.")
        elif tt == "TT_WBS":
            warnings.append(f"{code} is a WBS summary activity; it was imported as a task.")
        od = _hours(r.get("target_drtn_hr_cnt"), f"{code} original duration", warnings)
        rd = _hours(r.get("remain_drtn_hr_cnt"), f"{code} remaining duration", warnings)
        st = r.get("status_code", "TK_NotStart")
        as_ = _date(r.get("act_start_date")) if st in ("TK_Active", "TK_Complete") else None
        af = _date(r.get("act_end_date")) if st == "TK_Complete" else None
        if st in ("TK_Active", "TK_Complete") and not as_:
            warnings.append(f"{code} is marked started but has no actual start; it was imported as not started.")
            af = None
        if st == "TK_Complete" and not af:
            warnings.append(f"{code} is marked complete but has no actual finish; it was imported as in progress.")
        if as_ and af and af < as_:
            warnings.append(f"{code} finishes before it starts; the actual finish was dropped.")
            af = None
        cs = CSTR_IN.get((r.get("cstr_type") or "").strip(), "ASAP")
        cd = _date(r.get("cstr_date"))
        if cs not in ("ASAP", "ALAP") and not cd:
            warnings.append(f"{code} has a constraint without a date; it was dropped.")
            cs = "ASAP"
        if (r.get("cstr_type2") or "").strip():
            warnings.append(f"{code} has a secondary constraint; only the primary constraint is used.")
        cal = cal_ids.get(r.get("clndr_id", ""))
        if cal is None:
            missing_cal += 1
            cal = default_cal
        phys = to_num(r.get("phys_complete_pct")) or 0.0
        phys = min(100.0, max(0.0, phys))
        if phys == int(phys):
            phys = int(phys)
        act_ids[tid] = gid
        used_gids.add(gid)
        acts.append({"id": gid, "code": code[:40], "name": (r.get("task_name") or "").strip(),
                     "wbs": wbs_ids.get(r.get("wbs_id")), "cal": None if cal == default_cal else cal, "type": typ,
                     "od": max(0, od), "rd": 0 if af else max(0, rd), "as": as_, "af": af,
                     "pct_type": PCT_IN.get(r.get("complete_pct_type", ""), "duration"), "phys": phys,
                     "cstr": cs, "cstr_date": cd if cs not in ("ASAP", "ALAP") else None, "unit": "h" if od % hpd_of[cal] else "d"})
        stored[gid] = {"es": _date(r.get("early_start_date")), "ef": _date(r.get("early_end_date")),
                       "ls": _date(r.get("late_start_date")), "lf": _date(r.get("late_end_date")),
                       "tf": _hours(r.get("total_float_hr_cnt"), code, []) if (r.get("total_float_hr_cnt") or "").strip() else None,
                       "ff": _hours(r.get("free_float_hr_cnt"), code, []) if (r.get("free_float_hr_cnt") or "").strip() else None,
                       "res": _date(r.get("restart_date")), "planned_start": _date(r.get("target_start_date")),
                       "planned_finish": _date(r.get("target_end_date"))}
    if missing_cal:
        warnings.append((f"{missing_cal} activities point" if missing_cal > 1 else "1 activity points") + " to a calendar that is not in the file; the project calendar was used.")

    rels = []
    seen = set()
    skipped_x = 0
    for r in rows("TASKPRED"):
        su, pr = act_ids.get(r.get("task_id")), act_ids.get(r.get("pred_task_id"))
        if su is None and pr is None:
            continue
        if su is None or pr is None:
            skipped_x += 1
            continue
        typ = {"PR_FS": "FS", "PR_SS": "SS", "PR_FF": "FF", "PR_SF": "SF"}.get(r.get("pred_type", "PR_FS"), "FS")
        key = (pr, su, typ)
        if key in seen or pr == su:
            warnings.append("A duplicate or self relationship was skipped.")
            continue
        seen.add(key)
        rid = _num_id("p", r.get("task_pred_id")) or f"p{len(rels) + 1}"
        rels.append({"id": rid, "pred": pr, "succ": su, "type": typ,
                     "lag": _hours(r.get("lag_hr_cnt"), "relationship lag", warnings), "elapsed": False})
    if skipped_x:
        warnings.append((f"{skipped_x} relationships" if skipped_x > 1 else "1 relationship") + " to activities in other projects " + ("were" if skipped_x > 1 else "was") + " skipped.")

    maxu = {}
    for r in rows("RSRCRATE"):
        v = to_num(r.get("max_qty_per_hr"))
        if v is not None and 0 <= v <= 1000 and r.get("rsrc_id") not in maxu:
            maxu[r.get("rsrc_id")] = int(v * 1000 + 0.5)
    used_r = {r.get("rsrc_id") for r in rows("TASKRSRC") if r.get("task_id") in act_ids}
    rsrcs = []
    rsrc_ids = {}
    for r in rows("RSRC"):
        if r.get("rsrc_id") not in used_r:
            continue
        gid = _num_id("r", r.get("rsrc_id"))
        if gid is None:
            continue
        rsrc_ids[r["rsrc_id"]] = gid
        typ = RSRC_IN.get(r.get("rsrc_type", ""), "labor")
        rsrcs.append({"id": gid, "code": (r.get("rsrc_short_name") or "").strip()[:40] or gid,
                      "name": (r.get("rsrc_name") or "").strip(), "type": typ,
                      "max_units": maxu.get(r["rsrc_id"], 1000), "unit": "h" if typ != "material" else "ea"})
    asg = []
    od_of = {x["id"]: x["od"] for x in acts}
    for r in rows("TASKRSRC"):
        a, rs = act_ids.get(r.get("task_id")), rsrc_ids.get(r.get("rsrc_id"))
        if a is None or rs is None:
            continue
        tgt = _qty(r.get("target_qty"))
        act = _qty(r.get("act_reg_qty")) + _qty(r.get("act_ot_qty"))
        per = _qty(r.get("target_qty_per_hr"))
        if per == 0:
            od = od_of[a]
            per = round_div(tgt * 60, od) if od else 0
        asg.append({"id": _num_id("a", r.get("taskrsrc_id")) or f"a{len(asg) + 1}", "act": a, "rsrc": rs,
                    "units": per, "budget": tgt, "actual": act})

    settings = {}
    if (pick.get("critical_drtn_hr_cnt") or "").strip():
        settings["crit_tf"] = max(0, _hours(pick["critical_drtn_hr_cnt"], "critical float threshold", warnings))
    if pick.get("critical_path_type") == "CT_DrivPath":
        settings["crit"] = "longest"
    # schedule options live in SCHEDOPTIONS; older or hand-made files may carry them on PROJECT
    opt = next((r for r in rows("SCHEDOPTIONS") if r.get("proj_id", pid) == pid), pick)
    if opt.get("sched_progress_override") == "Y":
        settings["oos"] = "override"
    elif opt.get("sched_retained_logic") == "N" and opt.get("sched_progress_override") == "N":
        warnings.append("The file schedules progressed activities by actual dates; retained logic was used.")
    ft = (opt.get("sched_float_type") or "").strip()
    if ft in FLOAT_IN:
        settings["float"] = FLOAT_IN[ft]
    lc = (opt.get("sched_calendar_on_relationship_lag") or "").strip()
    if lc in LAGCAL_IN:
        settings["lag_cal"] = LAGCAL_IN[lc]

    start = _date(pick.get("plan_start_date")) or min((x["as"] for x in acts if x["as"]), default=None) or "2026-01-01T08:00"
    dd = _date(pick.get("last_recalc_date")) or _date(pick.get("next_data_date")) or start
    finish_by = _date(pick.get("plan_end_date"))
    baselines = []
    bl_rows = {k: [v["planned_start"], v["planned_finish"], od_of[k]]
               for k, v in stored.items() if v["planned_start"] and v["planned_finish"]}
    if bl_rows:
        baselines.append({"id": "planned", "name": "Planned dates in the file", "taken": dd, "acts": bl_rows})
    proj = validate_project({
        "id": _num_id("p", pid) or "p1", "name": (pick.get("proj_short_name") or "").strip() or "Imported project",
        "start": start, "data_date": dd, "finish_by": finish_by, "cal": default_cal, "settings": settings,
        "calendars": cals, "wbs": wbs, "activities": acts, "rels": rels, "resources": rsrcs, "assigns": asg,
        "baselines": baselines, "baseline": "planned" if baselines else None})
    unknown = sorted(t for t in T if t not in KNOWN)
    report = {"format": "XER", "encoding": enc, "version": parsed["header"][1] if len(parsed["header"]) > 1 else "",
              "tables": {t: len(T[t]["rows"]) for t in sorted(T)}, "unknown_tables": unknown,
              "counts": {"activities": len(acts), "rels": len(rels), "wbs": len(wbs), "calendars": len(cals),
                         "resources": len(rsrcs), "assigns": len(asg)},
              "warnings": _dedupe(warnings)}
    return {"project": proj, "report": report, "stored": stored, "projects": projects}


def _qty(v):
    x = to_num(v)
    if x is None or x < 0 or x > 1e7:
        return 0
    return int(x * 1000 + 0.5)


def _int(v):
    m = re.fullmatch(r"\s*([+-]?\d{1,15})\s*", v or "")
    return int(m.group(1)) if m else 0


def _dedupe(ws):
    out, seen = [], {}
    for w in ws:
        if w in seen:
            seen[w] += 1
            continue
        seen[w] = 1
        out.append(w)
    res = []
    for w in out[:200]:
        res.append(w if seen[w] == 1 else f"{w} ({seen[w]} times)")
    if len(out) > 200:
        res.append((f"{len(out) - 200} more warnings were" if len(out) > 201 else "1 more warning was") + " not listed.")
    return res


def _order_wbs(wbs):
    """Parents before children, siblings in file order; dangling parents become top level."""
    ids = {w["id"] for w in wbs}
    kids = {}
    for w in wbs:
        if w["parent"] not in ids:
            w["parent"] = None
        kids.setdefault(w["parent"], []).append(w)
    out = []
    stack = list(reversed(kids.get(None, [])))
    seen = set()
    while stack:
        w = stack.pop()
        if w["id"] in seen:
            continue
        seen.add(w["id"])
        out.append(w)
        stack.extend(reversed(kids.get(w["id"], [])))
    for w in wbs:  # anything left is in a parent loop: put it at the top
        if w["id"] not in seen:
            w["parent"] = None
            out.append(w)
    return out


# ---------------------------------------------------------------------------------------- writing

def _hrs(m):
    s = fmt_fixed(m, 60, 2)
    return s.rstrip("0").rstrip(".") if "." in s else s


def _xd(s):
    return s.replace("T", " ") if s else ""


def _clean(s):
    return re.sub(r"[\t\r\n]+", " ", s or "")


def _ids(rows, prefix):
    """Integer ids for XER: reuse the numbers of ids like 't1234' when they are all unique."""
    nums = []
    for r in rows:
        m = re.fullmatch(prefix + r"(\d{1,9})", r["id"])
        if not m:
            break
        nums.append(int(m.group(1)))
    if len(nums) == len(rows) and len(set(nums)) == len(nums):
        return {r["id"]: n for r, n in zip(rows, nums)}
    return {r["id"]: 1000 + i for i, r in enumerate(rows)}


def clndr_data(c):
    parts = ["(0||CalendarData()((0||DaysOfWeek()("]
    for d in range(7):
        ivs = c["week"][d]
        parts.append(f"(0||{d + 1}()(" + "".join(
            f"(0||{i}(s|{fmt_hm(s)}|f|{fmt_hm(f % DAY)})())" for i, (s, f) in enumerate(ivs)) + "))")
    parts.append("))(0||VIEW(ShowTotal|Y)())(0||Exceptions()(")
    for i, (k, ivs) in enumerate(sorted(c["exceptions"].items())):
        serial = parse_dt(k) // DAY - SERIAL_EPOCH
        parts.append(f"(0||{i}(d|{serial})(" + "".join(
            f"(0||{j}(s|{fmt_hm(s)}|f|{fmt_hm(f % DAY)})())" for j, (s, f) in enumerate(ivs)) + "))")
    parts.append("))))")
    return "".join(parts)


def write_xer(p, sched, today=None):
    """A project as XER text. Encode with textio.encode_cp1252 for P6."""
    today = (today or p["data_date"])[:10]
    pid = _ids([{"id": p["id"]}], "p")[p["id"]]
    cid = _ids(p["calendars"], "c")
    wid = _ids(p["wbs"], "w")
    tid = _ids(p["activities"], "t")
    rid = _ids(p["rels"], "p")
    sid = _ids(p["resources"], "r")
    aid = _ids(p["assigns"], "a")
    root_wbs = max(list(wid.values()) + [0]) + 1
    out = [f"ERMHDR\t19.12\t{today}\tProject\tadmin\tadmin\tdbxDatabaseNoName\tProject Management\tUSD"]

    def table(name, fields, rows):
        if not rows:  # P6 writes no header for a table without rows
            return
        out.append(f"%T\t{name}")
        out.append("%F\t" + "\t".join(fields))
        for r in rows:
            out.append("%R\t" + "\t".join(_clean(str(r.get(f, ""))) for f in fields))

    # tables in the order P6 writes them: referenced records come before the records that use them
    table("CURRTYPE", ["curr_id", "decimal_digit_cnt", "curr_symbol", "decimal_symbol", "digit_group_symbol",
                       "pos_curr_fmt_type", "neg_curr_fmt_type", "curr_type", "curr_short_name", "group_digit_cnt",
                       "base_exch_rate"],
          [{"curr_id": 1, "decimal_digit_cnt": 2, "curr_symbol": "$", "decimal_symbol": ".", "digit_group_symbol": ",",
            "pos_curr_fmt_type": "#1.1", "neg_curr_fmt_type": "(#1.1)", "curr_type": "US Dollar", "curr_short_name": "USD",
            "group_digit_cnt": 3, "base_exch_rate": 1}])
    pc = next(c for c in p["calendars"] if c["id"] == p["cal"])
    S = p["settings"]
    short = p["name"][:40]
    table("PROJECT", PROJECT_FIELDS,
          [{**PROJECT_DEFAULTS, "proj_id": pid, "proj_short_name": short, "clndr_id": cid[pc["id"]],
            "plan_start_date": _xd(p["start"]), "plan_end_date": _xd(p["finish_by"]), "scd_end_date": _xd(sched["finish"]),
            "last_recalc_date": _xd(p["data_date"]), "add_date": f"{today} 00:00", "critical_drtn_hr_cnt": _hrs(S["crit_tf"]),
            "critical_path_type": "CT_DrivPath" if S["crit"] == "longest" else "CT_TotFloat"}])

    def cal_row(c, num, kind, proj):
        wk = sum(f - s for d in c["week"] for s, f in d)
        return {"clndr_id": num, "default_flag": "N", "clndr_name": c["name"], "proj_id": proj, "base_clndr_id": "",
                "last_chng_date": f"{today} 00:00", "clndr_type": kind, "day_hr_cnt": _hrs(c["hpd"]), "week_hr_cnt": _hrs(wk),
                "month_hr_cnt": _hrs(wk * 52 // 12), "year_hr_cnt": _hrs(wk * 52), "rsrc_private": "N", "clndr_data": clndr_data(c)}

    crows = [cal_row(c, cid[c["id"]], "CA_Project", pid) for c in p["calendars"]]
    # P6 resources take a global or resource calendar, never a project calendar: give them a shared
    # resource calendar with the project calendar's work pattern
    rcal = max(cid.values()) + 1
    if p["resources"]:
        crows.append(cal_row({**pc, "name": (pc["name"] + " (resources)")[:120]}, rcal, "CA_Rsrc", ""))
    table("CALENDAR", ["clndr_id", "default_flag", "clndr_name", "proj_id", "base_clndr_id", "last_chng_date", "clndr_type",
                       "day_hr_cnt", "week_hr_cnt", "month_hr_cnt", "year_hr_cnt", "rsrc_private", "clndr_data"], crows)
    table("SCHEDOPTIONS", ["schedoptions_id", "proj_id", "sched_open_critical_flag", "sched_lag_early_start_flag",
                           "sched_retained_logic", "sched_setplantoforecast", "sched_float_type",
                           "sched_calendar_on_relationship_lag", "sched_use_expect_end_flag", "sched_progress_override"],
          [{"schedoptions_id": 1, "proj_id": pid, "sched_open_critical_flag": "N", "sched_lag_early_start_flag": "N",
            "sched_retained_logic": "Y" if S["oos"] == "retained" else "N", "sched_setplantoforecast": "N",
            "sched_float_type": FLOAT_OUT[S["float"]], "sched_calendar_on_relationship_lag": LAGCAL_OUT[S["lag_cal"]],
            "sched_use_expect_end_flag": "N", "sched_progress_override": "Y" if S["oos"] == "override" else "N"}])
    wrows = [{"wbs_id": root_wbs, "proj_id": pid, "obs_id": "", "seq_num": 0, "est_wt": 1, "proj_node_flag": "Y",
              "sum_data_flag": "Y", "status_code": "WS_Open", "wbs_short_name": short, "wbs_name": p["name"], "parent_wbs_id": ""}]
    for i, w in enumerate(p["wbs"]):
        wrows.append({"wbs_id": wid[w["id"]], "proj_id": pid, "obs_id": "", "seq_num": (i + 1) * 10, "est_wt": 1,
                      "proj_node_flag": "N", "sum_data_flag": "Y", "status_code": "WS_Open", "wbs_short_name": w["code"][:40],
                      "wbs_name": w["name"] or w["code"], "parent_wbs_id": wid[w["parent"]] if w["parent"] else root_wbs})
    table("PROJWBS", ["wbs_id", "proj_id", "obs_id", "seq_num", "est_wt", "proj_node_flag", "sum_data_flag", "status_code",
                      "wbs_short_name", "wbs_name", "parent_wbs_id"], wrows)
    table("RSRC", ["rsrc_id", "clndr_id", "rsrc_seq_num", "rsrc_name", "rsrc_short_name", "def_qty_per_hr", "cost_qty_type",
                   "active_flag", "auto_compute_act_flag", "def_cost_qty_link_flag", "ot_flag", "curr_id", "rsrc_type"],
          [{"rsrc_id": sid[r["id"]], "clndr_id": rcal, "rsrc_seq_num": i, "rsrc_name": r["name"] or r["code"],
            "rsrc_short_name": r["code"], "def_qty_per_hr": fmt_fixed(1000, 1000, 2), "cost_qty_type": "QT_Hour",
            "active_flag": "Y", "auto_compute_act_flag": "N", "def_cost_qty_link_flag": "Y", "ot_flag": "N", "curr_id": 1,
            "rsrc_type": RSRC_OUT[r["type"]]} for i, r in enumerate(p["resources"])])
    table("RSRCRATE", ["rsrc_rate_id", "rsrc_id", "max_qty_per_hr", "cost_per_qty", "start_date"],
          [{"rsrc_rate_id": i + 1, "rsrc_id": sid[r["id"]], "max_qty_per_hr": fmt_fixed(r["max_units"], 1000, 3),
            "cost_per_qty": "0", "start_date": "2000-01-01 00:00"} for i, r in enumerate(p["resources"])])
    trows = []
    for a in p["activities"]:
        rec = sched["acts"][a["id"]]
        st = rec["status"]
        trows.append({
            "task_id": tid[a["id"]], "proj_id": pid, "wbs_id": wid[a["wbs"]] if a["wbs"] else root_wbs,
            "clndr_id": cid[a["cal"] or p["cal"]], "phys_complete_pct": a["phys"], "rev_fdbk_flag": "N", "est_wt": 1,
            "lock_plan_flag": "N", "auto_compute_act_flag": "N", "complete_pct_type": PCT_OUT[a["pct_type"]],
            "task_type": {"task": "TT_Task", "start_ms": "TT_Mile", "finish_ms": "TT_FinMile"}[a["type"]],
            "duration_type": "DT_FixedDUR2",
            "status_code": {"planned": "TK_NotStart", "active": "TK_Active", "complete": "TK_Complete"}[st],
            "task_code": a["code"], "task_name": a["name"], "total_float_hr_cnt": _hrs(rec["tf"]) if rec["tf"] is not None else "",
            "free_float_hr_cnt": _hrs(rec["ff"]) if rec["ff"] is not None else "", "remain_drtn_hr_cnt": _hrs(a["rd"]),
            "target_drtn_hr_cnt": _hrs(a["od"]), "cstr_date": _xd(a["cstr_date"]), "act_start_date": _xd(a["as"]),
            "act_end_date": _xd(a["af"]), "late_start_date": _xd(rec["ls"]), "late_end_date": _xd(rec["lf"]),
            "early_start_date": _xd(rec["res"] if st == "active" else rec["es"]), "early_end_date": _xd(rec["ef"]), "restart_date": _xd(rec["res"]) if st != "complete" else "",
            "reend_date": _xd(rec["ef"]) if st != "complete" else "", "rem_late_start_date": _xd(rec["ls"]),
            "rem_late_end_date": _xd(rec["lf"]),
            "target_start_date": _xd(a["as"] or rec["es"]), "target_end_date": _xd(a["af"] or rec["ef"]),
            "cstr_type": CSTR_OUT.get(a["cstr"], ""), "priority_type": "PT_Normal",
            "driving_path_flag": "Y" if rec["lp"] else "N"})
    table("TASK", ["task_id", "proj_id", "wbs_id", "clndr_id", "phys_complete_pct", "rev_fdbk_flag", "est_wt",
                   "lock_plan_flag", "auto_compute_act_flag", "complete_pct_type", "task_type", "duration_type",
                   "status_code", "task_code", "task_name", "total_float_hr_cnt", "free_float_hr_cnt",
                   "remain_drtn_hr_cnt", "target_drtn_hr_cnt", "cstr_date", "act_start_date", "act_end_date",
                   "late_start_date", "late_end_date", "early_start_date", "early_end_date", "restart_date",
                   "reend_date", "rem_late_start_date", "rem_late_end_date", "target_start_date", "target_end_date",
                   "cstr_type", "priority_type", "driving_path_flag"], trows)
    table("TASKPRED", ["task_pred_id", "task_id", "pred_task_id", "proj_id", "pred_proj_id", "pred_type", "lag_hr_cnt"],
          [{"task_pred_id": rid[r["id"]], "task_id": tid[r["succ"]], "pred_task_id": tid[r["pred"]], "proj_id": pid,
            "pred_proj_id": pid, "pred_type": "PR_" + r["type"], "lag_hr_cnt": _hrs(r["lag"])} for r in p["rels"]])
    od_of = {a["id"]: a for a in p["activities"]}
    rtype = {r["id"]: r["type"] for r in p["resources"]}
    table("TASKRSRC", ["taskrsrc_id", "task_id", "proj_id", "rsrc_id", "remain_qty", "target_qty", "remain_qty_per_hr",
                       "target_qty_per_hr", "act_reg_qty", "act_ot_qty", "rsrc_type", "cost_qty_link_flag", "rate_type"],
          [{"taskrsrc_id": aid[x["id"]], "task_id": tid[x["act"]], "proj_id": pid, "rsrc_id": sid[x["rsrc"]],
            "remain_qty": fmt_fixed(round_div(x["units"] * od_of[x["act"]]["rd"], 60), 1000, 3),
            "target_qty": fmt_fixed(x["budget"], 1000, 3), "remain_qty_per_hr": fmt_fixed(x["units"], 1000, 3),
            "target_qty_per_hr": fmt_fixed(x["units"], 1000, 3), "act_reg_qty": fmt_fixed(x["actual"], 1000, 3),
            "act_ot_qty": "0", "rsrc_type": RSRC_OUT[rtype[x["rsrc"]]], "cost_qty_link_flag": "Y",
            "rate_type": "COST_PER_QTY"} for x in p["assigns"]])
    out.append("%E")
    return "\r\n".join(out) + "\r\n"
