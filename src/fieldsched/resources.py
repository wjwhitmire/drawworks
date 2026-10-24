"""Resource histograms and a leveling suggestion.

Units are thousandths per hour (1000 = one full-time unit) and quantities are thousandths.
The histogram's "units" column is the most units in use at any one moment that day, so work
that follows other work on the same day does not count twice. An assignment of u units per hour on an activity places u x (working minutes that day) / 60 on each
day the activity works, on the activity's calendar: remaining work between the remaining early start
and early finish (or late dates), actual work spread evenly by working time between the actual
start and the actual finish (or the data date when still in progress).

The leveling suggestion is a serial method: activities are taken in logic order, the one with the
earliest early start (then least total float, then activity id) first; each is placed at the
earliest moment its logic allows from which every assigned resource stays within its maximum units
for the activity's whole span (when it clashes, it tries again at the end of the clashing work). It never edits the schedule. Each suggestion becomes a start-no-earlier-than constraint
only when the person applies it.
"""

from __future__ import annotations

from .cpm import Ctx, forward_one, status_of
from .errors import SchedError
import heapq

from .timecal import DAY, fmt_day, fmt_dt, parse_dt, round_div

MAX_DAYS = 366 * 20


def _spread(C, a, b):
    """[(day, working minutes)] for the span [a, b) on calendar C."""
    out = []
    if b <= a:
        return out
    d0, d1 = a // DAY, (b - 1) // DAY
    if d1 - d0 > MAX_DAYS:
        raise SchedError("too_long", "A resource span is longer than 20 years.")
    for d in range(d0, d1 + 1):
        w = C.work_between(max(a, d * DAY), min(b, (d + 1) * DAY))
        if w:
            out.append((d, w))
    return out


def day_peaks(spans):
    """{day: the most units in use at any one moment that day} for [(start, end, units)]."""
    ev = []
    for a, b, u in spans:
        ev.append((a, 1, u))
        ev.append((b, 0, -u))
    ev.sort()
    peaks = {}
    load = 0
    for i, (t, _k, du) in enumerate(ev):
        load += du
        nxt = ev[i + 1][0] if i + 1 < len(ev) else t
        if nxt > t and load > 0:
            for d in range(t // DAY, (nxt - 1) // DAY + 1):
                if load > peaks.get(d, 0):
                    peaks[d] = load
    return peaks


def peak_load(spans, a, b):
    """The most units in use at any moment in [a, b) for [(start, end, units)]."""
    ev = []
    for s, e, u in spans:
        if s < b and e > a:
            ev.append((max(s, a), 1, u))
            ev.append((min(e, b), 0, -u))
    ev.sort()
    load = top = 0
    for _t, _k, du in ev:
        load += du
        if load > top:
            top = load
    return top


def histogram(p, sched, rsrc_id, which="early", bucket="day"):
    ctx = Ctx(p)
    r = next((x for x in p["resources"] if x["id"] == rsrc_id), None)
    if r is None:
        raise SchedError("bad_ref", "That resource does not exist.")
    dd = parse_dt(p["data_date"])
    act = {}
    rem = {}
    spans = []
    for x in p["assigns"]:
        if x["rsrc"] != rsrc_id:
            continue
        a = ctx.acts[x["act"]]
        C = ctx.cal[a["id"]]
        rec = sched["acts"][a["id"]]
        st = status_of(a)
        if st != "planned" and x["actual"]:
            end = parse_dt(a["af"]) if a["af"] else max(dd, parse_dt(a["as"]))
            sp = _spread(C, parse_dt(a["as"]), end)
            tot = sum(w for _, w in sp)
            for d, w in sp:
                act[d] = act.get(d, 0) + round_div(x["actual"] * w, tot)
        if st != "complete" and a["rd"] > 0:
            if which == "late":
                b = parse_dt(rec["lf"])
                s = C.sub_work(b, a["rd"])
            else:
                s, b = parse_dt(rec["res"]), parse_dt(rec["ef"])
            for d, w in _spread(C, s, b):
                rem[d] = rem.get(d, 0) + x["units"] * w
            if b > s:
                spans.append((s, b, x["units"]))
    units = day_peaks(spans)
    days = sorted(set(act) | set(rem))
    rows = []
    if days:
        pc = ctx.pcal
        for d in range(days[0], days[-1] + 1):
            rows.append({"d": d, "actual": act.get(d, 0), "remaining": round_div(rem.get(d, 0), 60),
                         "units": units.get(d, 0), "limit": round_div(r["max_units"] * pc.day_work(d), 60)})
    if bucket == "week":
        weeks = {}
        for row in rows:
            k = row["d"] - (row["d"] + 3) % 7  # Monday
            w = weeks.setdefault(k, {"d": k, "actual": 0, "remaining": 0, "units": 0, "limit": 0})
            w["actual"] += row["actual"]
            w["remaining"] += row["remaining"]
            w["units"] = max(w["units"], row["units"])
            w["limit"] += row["limit"]
        rows = [weeks[k] for k in sorted(weeks)]
    out = []
    for row in rows:
        out.append({"date": fmt_day(row["d"]), "actual": row["actual"], "remaining": row["remaining"],
                    "units": row["units"], "limit": row["limit"], "over": row["units"] > r["max_units"]})
    return {"rsrc": rsrc_id, "max_units": r["max_units"], "bucket": bucket, "which": which, "rows": out,
            "peak": max((x["units"] for x in out), default=0)}


def leveling_suggestions(p, sched):
    ctx = Ctx(p)
    rmax = {r["id"]: r["max_units"] for r in p["resources"]}
    by_act = {}
    for x in p["assigns"]:
        if x["units"] > 0 and rmax.get(x["rsrc"], 0) > 0:
            by_act.setdefault(x["act"], []).append(x)
    use = {}  # rsrc -> [(start, end, units)] already placed

    start = parse_dt(p["start"])
    base = max(start, parse_dt(p["data_date"]))
    E = {}
    indeg = {a["id"]: 0 for a in p["activities"]}
    for r in p["rels"]:
        indeg[r["succ"]] += 1
    acts = sched["acts"]

    def key(aid):
        rec = acts[aid]
        return (rec["es"], rec["tf"] if rec["tf"] is not None else -10 ** 12, ctx.acts[aid]["code"], aid)

    ready = [key(i) for i, n in indeg.items() if n == 0]
    heapq.heapify(ready)
    out = []
    while ready:
        aid = heapq.heappop(ready)[3]
        a = ctx.acts[aid]
        C = ctx.cal[aid]
        es, ef, res = forward_one(ctx, aid, E, base)
        st = status_of(a)
        xs = by_act.get(aid, [])
        if st == "planned" and xs and a["cstr"] not in ("MS_MAND", "MF_MAND"):
            tries = 0
            while es < ef:
                # only other work can be waited out: an assignment over the maximum on its own is
                # placed where nothing else overlaps it
                clash = [x for x in xs for pk in (peak_load(use.get(x["rsrc"], []), es, ef),) if pk > 0 and pk + x["units"] > rmax[x["rsrc"]]]
                if not clash or tries > 20000:
                    break
                tries += 1
                ends = [e for x in clash for s0, e, _u in use.get(x["rsrc"], []) if s0 < ef and e > es]
                nxt = min(ends) if ends else C.snap_fwd(es + 1)
                es, ef, res = forward_one(ctx, aid, E, base, extra_start=max(nxt, es + 1))
            if es > parse_dt(acts[aid]["es"]):
                old = parse_dt(acts[aid]["es"])
                delay = C.work_between(old, es)
                tf = acts[aid]["tf"]
                rs = sorted({x["rsrc"] for x in xs})
                out.append({"act": aid, "code": a["code"], "from": acts[aid]["es"], "to": fmt_dt(es), "delay": delay,
                            "within_float": tf is not None and delay <= tf, "rsrc": rs,
                            "why": "Over the maximum units of " + ", ".join(rs) + " on its early dates."})
        if st != "complete" and xs:
            s = res if st == "active" else es
            if ef > s:
                for x in xs:
                    use.setdefault(x["rsrc"], []).append((s, ef, x["units"]))
        E[aid] = (es, ef, res)
        for r in ctx.succs[aid]:
            indeg[r["succ"]] -= 1
            if indeg[r["succ"]] == 0:
                heapq.heappush(ready, key(r["succ"]))
    if len(E) < len(p["activities"]):
        raise SchedError("loop", "The logic has a loop; schedule first to see where.")
    finish = max((e[1] for e in E.values()), default=None)
    return {"suggestions": out, "finish": fmt_dt(finish) if finish is not None else None}


def apply_leveling(p, suggestions):
    """Start-no-earlier-than constraints for accepted suggestions on activities without one."""
    from .model import validate_project
    want = {s["act"]: s["to"] for s in suggestions}
    acts = []
    for a in p["activities"]:
        if a["id"] in want and a["cstr"] in ("ASAP", "SNET"):
            a = {**a, "cstr": "SNET", "cstr_date": want[a["id"]]}
        acts.append(a)
    return validate_project({**p, "activities": acts})
