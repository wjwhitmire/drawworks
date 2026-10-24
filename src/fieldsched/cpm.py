"""Critical path method: forward pass, backward pass, float, critical path, longest path.

Rules (precedence diagramming as taught in standard planning texts and as both desktop schedulers
implement it):

Forward pass, for an activity of remaining duration D on calendar C:
  FS: ES >= lag(pred EF)        SS: ES >= lag(pred ES)
  FF: EF >= lag(pred EF)        SF: EF >= lag(pred ES)
  lag(t) moves t forward (or back, for a negative lag) by the lag in working minutes on the lag
  calendar (project setting: predecessor, successor, 24 hour or project calendar).
  Not started activities cannot start before the data date (or the project start).
  ES is snapped to the next working minute, EF = ES + D in working time.
Backward pass, mirrored:
  FS: LF <= lag'(succ LS)       SS: LS <= lag'(succ LS)
  FF: LF <= lag'(succ LF)       SF: LS <= lag'(succ LF)
  Open-ended activities finish no later than the project's must-finish-by date if set, otherwise
  the latest early finish in the project.
Total float = LF - EF (finish float, the default), LS - ES (start float) or the smaller of the two,
in working minutes on the activity's calendar. Free float = the smallest relationship slack to any
successor (how far the activity can slip without moving a successor's early date); an activity with
no successors gets its finish float.

Constraints:
  SNET: ES >= date.  FNET: EF >= date.  SNLT: LS <= date.  FNLT: LF <= date.
  MSO and MFO (start on, finish on): both of the above for that end, logic still wins forward.
  MS_MAND and MF_MAND (mandatory): early and late dates are set to the date, overriding logic.
  ALAP: after both passes the activity is moved later by its free float.
Progress (data date DD):
  Complete activities keep their actual dates and carry no float.
  In progress activities keep their actual start; the remaining duration is scheduled from the data
  date. With retained logic it also waits for unfinished FS predecessors and honours FF and SF
  links; with progress override it ignores its predecessors.
"""

from __future__ import annotations

import math

from .errors import SchedError
from .timecal import compile_calendar, fmt_dt, full_day_calendar, parse_dt, round_div


def lag_fwd(cal, t, lag):
    if lag > 0:
        return cal.add_work(t, lag)
    if lag < 0:
        return cal.sub_work(t, -lag)
    return t


def lag_back(cal, t, lag):
    if lag > 0:
        return cal.sub_work(t, lag)
    if lag < 0:
        return cal.add_work(t, -lag)
    return t


def status_of(a):
    if a["af"]:
        return "complete"
    if a["as"]:
        return "active"
    return "planned"


def topo_order(acts, rels):
    """Kahn's algorithm in file order. Raises SchedError('loop') naming one cycle."""
    ids = [a["id"] for a in acts]
    indeg = {i: 0 for i in ids}
    out = {i: [] for i in ids}
    inn = {i: [] for i in ids}
    for r in rels:
        indeg[r["succ"]] += 1
        out[r["pred"]].append(r["succ"])
        inn[r["succ"]].append(r["pred"])
    queue = [i for i in ids if indeg[i] == 0]
    order = []
    k = 0
    while k < len(queue):
        n = queue[k]
        k += 1
        order.append(n)
        for s in out[n]:
            indeg[s] -= 1
            if indeg[s] == 0:
                queue.append(s)
    if len(order) < len(ids):
        left = {i for i in ids if indeg[i] > 0}
        code = {a["id"]: a["code"] for a in acts}
        start = next(i for i in ids if i in left)
        path, seen, cur = [], {}, start
        while cur not in seen:
            seen[cur] = len(path)
            path.append(cur)
            cur = next(p for p in inn[cur] if p in left)
        back = path[seen[cur]:]  # walked through predecessors, so reverse it into link order
        cyc = [back[0]] + back[:0:-1] + [back[0]]
        err = SchedError("loop", "Logic loop: " + " -> ".join(code[c] for c in cyc)
                         + ". Remove or reverse one of these relationships.")
        err.cycle = cyc
        raise err
    return order


class Ctx:
    """Compiled calendars and lookups shared by the scheduling functions."""

    def __init__(self, p):
        self.p = p
        self.cals = {c["id"]: compile_calendar(c) for c in p["calendars"]}
        self.pcal = self.cals[p["cal"]]
        self.h24 = full_day_calendar()
        self.acts = {a["id"]: a for a in p["activities"]}
        self.cal = {a["id"]: self.cals[a["cal"] or p["cal"]] for a in p["activities"]}
        self.preds = {a["id"]: [] for a in p["activities"]}
        self.succs = {a["id"]: [] for a in p["activities"]}
        for r in p["rels"]:
            self.preds[r["succ"]].append(r)
            self.succs[r["pred"]].append(r)
        self.status = {a["id"]: status_of(a) for a in p["activities"]}
        self.settings = p["settings"]

    def lagcal(self, r):
        mode = self.settings["lag_cal"]
        if r["elapsed"] or mode == "24h":
            return self.h24
        if mode == "pred":
            return self.cal[r["pred"]]
        if mode == "succ":
            return self.cal[r["succ"]]
        return self.pcal

    def norm_ms(self, cal, t):
        """A zero-duration finish keeps a finish-type instant and moves anything else forward."""
        return t if cal.snap_back(t) == t else cal.snap_fwd(t)


def _uses_pred(ctx, r, succ_status):
    """Whether relationship r constrains its successor in the forward pass."""
    if succ_status == "complete":
        return False
    if succ_status == "active":
        if ctx.settings["oos"] == "override":
            return False
        return r["type"] != "SS"
    return True


def forward_one(ctx, aid, E, base, extra_start=None):
    """Early dates for one activity given early dates E of its predecessors: (es, ef, res)."""
    a = ctx.acts[aid]
    C = ctx.cal[aid]
    st = ctx.status[aid]
    if st == "complete":
        return parse_dt(a["as"]), parse_dt(a["af"]), None
    D = a["rd"]
    sc, fc = [base], []
    if extra_start is not None:
        sc.append(extra_start)
    for r in ctx.preds[aid]:
        if not _uses_pred(ctx, r, st):
            continue
        pes, pef, _ = E[r["pred"]]
        t = lag_fwd(ctx.lagcal(r), pef if r["type"] in ("FS", "FF") else pes, r["lag"])
        (sc if r["type"] in ("FS", "SS") else fc).append(t)
    cs = a["cstr"]
    cd = parse_dt(a["cstr_date"]) if a["cstr_date"] else None
    if cs in ("FNET", "MFO"):
        fc.append(cd)
    if st == "active":
        es = parse_dt(a["as"])
        resume = max(sc)
        if D > 0:
            res = C.snap_fwd(resume)
            ef = C.add_work(res, D)
            for f in fc:
                g = C.snap_back(f)
                if g > ef:
                    ef = g
                    res = C.sub_work(ef, D)
        else:
            ef = ctx.norm_ms(C, max(sc + fc))
            res = ef
        return es, ef, res
    if cs in ("SNET", "MSO"):
        sc.append(cd)
    s = max(sc)
    if a["type"] == "task" and D > 0:
        es = C.snap_fwd(s)
        for f in fc:
            es = max(es, C.snap_fwd(C.sub_work(f, D)))
        if cs == "MS_MAND":
            es = C.snap_fwd(cd)
        elif cs == "MF_MAND":
            es = C.sub_work(C.snap_back(cd), D)
        ef = C.add_work(es, D)
        return es, ef, es
    t = max(sc + fc)
    if cs in ("MS_MAND", "MF_MAND"):
        t = cd
    if a["type"] == "finish_ms":
        x = ctx.norm_ms(C, t)
    else:
        x = C.snap_fwd(t)
    return x, x, x


def backward_one(ctx, aid, L, E, anchor):
    """Late dates for one activity given late dates L of its successors: (ls, lf)."""
    a = ctx.acts[aid]
    C = ctx.cal[aid]
    st = ctx.status[aid]
    D = a["rd"]
    lfc, lsc = [anchor], []
    for r in ctx.succs[aid]:
        s = r["succ"]
        sst = ctx.status[s]
        if not _uses_pred(ctx, r, sst) or L.get(s) is None:
            continue
        sls, slf = L[s]
        lc = ctx.lagcal(r)
        if r["type"] == "FS":
            lfc.append(lag_back(lc, sls, r["lag"]))
        elif r["type"] == "SS":
            lsc.append(lag_back(lc, sls, r["lag"]))
        elif r["type"] == "FF":
            lfc.append(lag_back(lc, slf, r["lag"]))
        else:
            lsc.append(lag_back(lc, slf, r["lag"]))
    cs = a["cstr"]
    cd = parse_dt(a["cstr_date"]) if a["cstr_date"] else None
    if cs in ("FNLT", "MFO"):
        lfc.append(cd)
    if cs in ("SNLT", "MSO") and st == "planned":
        lsc.append(cd)
    es, ef, res = E[aid]
    if D > 0 and (a["type"] == "task" or st == "active"):
        lf = C.snap_back(min(lfc))
        for x in lsc:
            lf = min(lf, C.add_work(C.snap_fwd(x), D))
        if st == "planned":
            if cs == "MS_MAND":
                lf = C.add_work(C.snap_fwd(cd), D)
            elif cs == "MF_MAND":
                lf = C.snap_back(cd)
        ls = C.sub_work(lf, D)
        return ls, lf
    t = min(lfc + lsc)
    if st == "planned" and cs in ("MS_MAND", "MF_MAND"):
        t = cd
    x = C.snap_back(t) if a["type"] == "finish_ms" else C.snap_fwd(t)
    # a late date with no working time between it and the early date is shown as the early date
    if x != ef and C.work_between(min(x, ef), max(x, ef)) == 0:
        x = ef
    return x, x


def rel_slack(ctx, r, E, on_succ=False):
    """Working minutes the predecessor end can slip before the successor's early date moves,
    measured on the predecessor's calendar (free float) or the successor's (driving links)."""
    sst = ctx.status[r["succ"]]
    if ctx.status[r["pred"]] == "complete" or not _uses_pred(ctx, r, sst):
        return None
    pes, pef, _ = E[r["pred"]]
    ses, sef, sres = E[r["succ"]]
    t = lag_fwd(ctx.lagcal(r), pef if r["type"] in ("FS", "FF") else pes, r["lag"])
    target = sres if r["type"] in ("FS", "SS") else sef
    return ctx.cal[r["succ"] if on_succ else r["pred"]].work_between(t, target)


def schedule(p):
    """Schedule a validated project. Returns plain JSON: dates as strings, floats in minutes."""
    ctx = Ctx(p)
    acts = p["activities"]
    order = topo_order(acts, p["rels"])
    start = parse_dt(p["start"])
    dd = parse_dt(p["data_date"])
    base = max(start, dd)

    E = {}
    for aid in order:
        E[aid] = forward_one(ctx, aid, E, base)
    open_ef = [E[a["id"]][1] for a in acts if ctx.status[a["id"]] != "complete"]
    all_ef = [E[a["id"]][1] for a in acts]
    pf = max(all_ef) if all_ef else ctx.pcal.snap_fwd(base)
    anchor = parse_dt(p["finish_by"]) if p["finish_by"] else (max(open_ef) if open_ef else pf)

    L = {}
    for aid in reversed(order):
        if ctx.status[aid] == "complete":
            L[aid] = None
        else:
            L[aid] = backward_one(ctx, aid, L, E, anchor)

    S = p["settings"]
    rel_out = {}
    ffs = {}
    for r in p["rels"]:
        sl = rel_slack(ctx, r, E, on_succ=True)
        rel_out[r["id"]] = {"slack": sl, "driving": sl is not None and sl <= 0}
        ffs[r["id"]] = rel_slack(ctx, r, E)

    # ALAP: shown later by its free float; floats and the critical path use the early dates
    Ea = dict(E)
    for aid in reversed(order):
        a = ctx.acts[aid]
        if a["cstr"] != "ALAP" or ctx.status[aid] != "planned":
            continue
        C = ctx.cal[aid]
        es, ef, res = Ea[aid]
        slacks = [rel_slack(ctx, r, Ea) for r in ctx.succs[aid]]
        slacks = [s for s in slacks if s is not None]
        ls, lf = L[aid]
        ff = min(slacks) if slacks else C.work_between(ef, lf)
        if ff > 0:
            nef = C.add_work(ef, ff)
            if a["type"] == "task" and a["rd"] > 0:
                nes = C.sub_work(nef, a["rd"])
            elif a["type"] == "finish_ms":
                nes = nef
            else:
                nes = nef = C.snap_fwd(nef)
            Ea[aid] = (nes, nef, nes)

    out = {}
    for a in acts:
        aid = a["id"]
        C = ctx.cal[aid]
        es, ef, res = E[aid]
        st = ctx.status[aid]
        xs, xf, xr = Ea[aid]
        rec = {"es": fmt_dt(xs), "ef": fmt_dt(xf), "res": fmt_dt(xr), "ls": None, "lf": None, "tf": None, "ff": None,
               "crit": False, "near": False, "lp": False, "status": st, "pct": pct_complete(p, a)}
        if st != "complete":
            ls, lf = L[aid]
            rec["ls"], rec["lf"] = fmt_dt(ls), fmt_dt(lf)
            fin = C.work_between(ef, lf)
            sta = C.work_between(res, ls)
            tf = fin if S["float"] == "finish" else sta if S["float"] == "start" else min(fin, sta)
            rec["tf"] = tf
            slacks = [ffs[r["id"]] for r in ctx.succs[aid] if ffs[r["id"]] is not None]
            rec["ff"] = min(slacks) if slacks else fin
            rec["near"] = tf <= S["near_tf"]
        out[aid] = rec

    # longest path: from the latest-finishing open activities back through driving relationships
    if open_ef:
        last = max(open_ef)
        stack = [a["id"] for a in acts if ctx.status[a["id"]] != "complete"
                 and ctx.cal[a["id"]].work_between(E[a["id"]][1], last) == 0]
        seen = set()
        while stack:
            n = stack.pop()
            if n in seen:
                continue
            seen.add(n)
            out[n]["lp"] = True
            for r in ctx.preds[n]:
                if rel_out[r["id"]]["driving"] and ctx.status[r["pred"]] != "complete":
                    stack.append(r["pred"])
    for a in acts:
        rec = out[a["id"]]
        if rec["status"] == "complete":
            continue
        rec["crit"] = rec["lp"] if S["crit"] == "longest" else rec["tf"] <= S["crit_tf"]
        if rec["crit"]:
            rec["near"] = False

    return {"start": fmt_dt(base), "data_date": p["data_date"], "finish": fmt_dt(pf), "anchor": fmt_dt(anchor),
            "acts": out, "rels": rel_out, "oos": out_of_sequence(ctx), "order": order}


def out_of_sequence(ctx):
    """Relationships whose successor has progress its predecessor does not allow: the successor
    started (FS, SS) or finished (FF, SF) while the predecessor's end was not yet reached, or
    earlier than the lag allows (working time on the lag calendar)."""
    bad = []
    for r in ctx.p["rels"]:
        pa, sa = ctx.acts[r["pred"]], ctx.acts[r["succ"]]
        t = r["type"]
        mine = sa["as"] if t in ("FS", "SS") else sa["af"]
        if not mine:
            continue
        ref = pa["af"] if t in ("FS", "FF") else pa["as"]
        if not ref:
            bad.append(r["id"])
            continue
        lc = ctx.lagcal(r)
        allowed = lag_fwd(lc, parse_dt(ref), r["lag"])
        if lc.work_between(parse_dt(mine), allowed) > 0:
            bad.append(r["id"])
    return bad


def pct_complete(p, a):
    """Percent complete in tenths of a percent for the activity's percent complete type."""
    if a["af"]:
        return 1000
    if a["pct_type"] == "physical":
        return math.floor(a["phys"] * 10 + 0.5) if a["as"] else 0
    if a["pct_type"] == "units":
        act = rem = 0
        for x in p["assigns"]:
            if x["act"] == a["id"]:
                act += x["actual"]
                rem += round_div(x["units"] * a["rd"], 60)
        return round_div(act * 1000, act + rem) if act + rem else 0
    if not a["as"]:
        return 0
    od = a["od"]
    if od <= 0:
        return 0
    return max(0, round_div((od - a["rd"]) * 1000, od))


def wbs_rollup(p, sched):
    """Summary dates per WBS element: earliest start, latest finish, smallest total float."""
    parent = {w["id"]: w["parent"] for w in p["wbs"]}
    roll = {}
    for a in p["activities"]:
        rec = sched["acts"][a["id"]]
        w = a["wbs"]
        guard = 0
        while w is not None and guard < 1000:
            r = roll.setdefault(w, {"es": None, "ef": None, "tf": None, "n": 0, "crit": False})
            if r["es"] is None or rec["es"] < r["es"]:
                r["es"] = rec["es"]
            if r["ef"] is None or rec["ef"] > r["ef"]:
                r["ef"] = rec["ef"]
            if rec["tf"] is not None and (r["tf"] is None or rec["tf"] < r["tf"]):
                r["tf"] = rec["tf"]
            r["n"] += 1
            r["crit"] = r["crit"] or rec["crit"]
            w = parent.get(w)
            guard += 1
    return roll


def tree_rows(p):
    """Display order: each WBS element's activities, then its child elements, depth first.
    Returns [(kind "a" or "w", record, outline level from 1, outline number "1.2.3")]."""
    kids_of, acts_of = {}, {}
    for w in p["wbs"]:
        kids_of.setdefault(w["parent"], []).append(w)
    for a in p["activities"]:
        acts_of.setdefault(a["wbs"], []).append(a)

    def items(parent):
        return [("a", a) for a in acts_of.get(parent, [])] + [("w", w) for w in kids_of.get(parent, [])]

    rows = []
    frames = [[items(None), 0, 1, ""]]
    while frames:
        f = frames[-1]
        its, i, level, prefix = f
        if i >= len(its):
            frames.pop()
            continue
        f[1] += 1
        kind, x = its[i]
        num = prefix + str(i + 1)
        rows.append((kind, x, level, num))
        if kind == "w":
            frames.append([items(x["id"]), 0, level + 1, num + "."])
    return rows
