"""Progress: baselines, variance, and Update progress, which rolls the data date forward.

Update progress proposes, it never applies on its own. For each activity it explains why:
  not started, planned to start before the new data date -> actual start = planned start;
  planned to finish before the new data date               -> actual finish = planned finish;
  otherwise                                                -> remaining duration = the planned work
                                                              left after the new data date.
The person ticks the proposals they accept, and apply_update writes them with the new data date.
"""

from __future__ import annotations

import math

from .cpm import Ctx, status_of
from .errors import SchedError
from .model import validate_project
from .timecal import fmt_dt, parse_dt


def propose_update(p, sched, new_dd):
    nd = parse_dt(new_dd, "new data date")
    if nd < parse_dt(p["data_date"]):
        raise SchedError("bad_date", "The new data date is before the current data date.")
    ctx = Ctx(p)
    out = []
    for a in p["activities"]:
        st = status_of(a)
        if st == "complete":
            continue
        rec = sched["acts"][a["id"]]
        C = ctx.cal[a["id"]]
        es, ef, res = parse_dt(rec["es"]), parse_dt(rec["ef"]), parse_dt(rec["res"])
        prop = {"act": a["id"], "code": a["code"], "as": a["as"], "af": None, "rd": a["rd"]}
        if st == "planned":
            if es >= nd:
                continue
            prop["as"] = rec["es"]
            why = f"Planned to start {rec['es'].replace('T', ' ')}, before the new data date"
        else:
            if res >= nd:
                continue
            why = f"In progress; planned work continues from {rec['res'].replace('T', ' ')}"
        if ef <= nd:
            prop["af"] = rec["ef"]
            prop["rd"] = 0
            why += f"; planned to finish {rec['ef'].replace('T', ' ')}, so it is proposed complete."
        else:
            prop["rd"] = C.work_between(nd, ef)
            why += "; remaining duration is the planned work after the new data date."
        if a["pct_type"] == "physical":
            od = a["od"]
            done = 100 if prop["af"] else (math.floor((od - prop["rd"]) * 100 / od + 0.5) if od else 0)
            prop["phys"] = max(0, min(100, done))
        prop["why"] = why
        out.append(prop)
    return out


def apply_update(p, props, new_dd):
    """A new project with the accepted proposals applied and the data date moved."""
    q = {**p, "data_date": fmt_dt(parse_dt(new_dd, "new data date"))}
    acts = {a["id"]: dict(a) for a in p["activities"]}
    for pr in props:
        a = acts.get(pr.get("act"))
        if a is None:
            raise SchedError("bad_ref", "A proposal points to an activity that does not exist.")
        if pr.get("as"):
            a["as"] = pr["as"]
        if pr.get("af"):
            a["af"] = pr["af"]
        if "rd" in pr and pr["rd"] is not None:
            a["rd"] = pr["rd"]
        if "phys" in pr:
            a["phys"] = pr["phys"]
    q["activities"] = [acts[a["id"]] for a in p["activities"]]
    return validate_project(q)


def take_baseline(p, sched, bid, name, taken=None):
    """A new project with a baseline snapshot of the current dates added and made active."""
    rows = {}
    for a in p["activities"]:
        rec = sched["acts"][a["id"]]
        rows[a["id"]] = [a["as"] or rec["es"], a["af"] or rec["ef"], a["od"]]
    bls = [b for b in p["baselines"] if b["id"] != bid]
    if len(bls) >= 20:
        raise SchedError("too_many", "A project keeps at most 20 baselines. Delete one first.")
    bls.append({"id": bid, "name": name, "taken": taken or p["data_date"], "acts": rows})
    return validate_project({**p, "baselines": bls, "baseline": bid})


def variance(p, sched, bid=None):
    """Variance against a baseline in working minutes, sign as in the common P6 convention:
    baseline minus current, so a negative finish variance means the activity is late."""
    bid = bid or p["baseline"]
    bl = next((b for b in p["baselines"] if b["id"] == bid), None)
    if bl is None:
        return {}
    ctx = Ctx(p)
    dd = parse_dt(p["data_date"])
    out = {}
    for a in p["activities"]:
        row = bl["acts"].get(a["id"])
        if row is None:
            continue
        C = ctx.cal[a["id"]]
        rec = sched["acts"][a["id"]]
        cs = parse_dt(a["as"] or rec["es"])
        cf = parse_dt(a["af"] or rec["ef"])
        bs, bf = parse_dt(row[0]), parse_dt(row[1])
        if a["af"]:
            atc = C.work_between(parse_dt(a["as"]), parse_dt(a["af"]))
        elif a["as"]:
            atc = C.work_between(parse_dt(a["as"]), max(dd, parse_dt(a["as"]))) + a["rd"]
        else:
            atc = a["rd"]
        out[a["id"]] = {"bs": row[0], "bf": row[1], "bd": row[2], "sv": C.work_between(cs, bs),
                        "fv": C.work_between(cf, bf), "dv": row[2] - atc}
    return out
