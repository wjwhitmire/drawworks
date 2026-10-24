"""Small builders for hand-worked networks.

Day networks use a 7-day calendar working 08:00 to 16:00, starting Thursday 2026-01-01, so day k
of a textbook network starts at (2026-01-01 + k days) 08:00 and an early finish of k (textbook
convention, the end of day k - 1) is (2026-01-01 + k - 1 days) 16:00.
"""

from fieldsched.model import validate_project
from fieldsched.timecal import days_from_civil, fmt_dt

D = 480
BASE = days_from_civil(2026, 1, 1)
SEVEN = {"id": "c7", "name": "Seven day", "hpd": D, "week": [[[480, 960]] for _ in range(7)], "exceptions": {}}
FIVE = {"id": "c5", "name": "Five day", "hpd": D, "week": [[] if d in (0, 6) else [[480, 960]] for d in range(7)],
        "exceptions": {}}


def start(k):
    return fmt_dt((BASE + k) * 1440 + 480)


def finish(k):
    return fmt_dt((BASE + k - 1) * 1440 + 960)


def net(acts, rels, cal=None, **extra):
    """acts: {code: days or dict}; rels: [(pred, succ, type, lag_days)]."""
    rows = []
    for code, v in acts.items():
        a = {"id": code, "code": code}
        if isinstance(v, dict):
            a.update(v)
            if "od" in a and isinstance(a["od"], (int, float)) and a.get("_days", True):
                pass
        else:
            a["od"] = int(v * D)
        rows.append(a)
    p = {"start": start(0), "calendars": [cal or SEVEN], "activities": rows,
         "rels": [{"id": f"r{i}", "pred": p, "succ": s, "type": t, "lag": int(lag * D)} for i, (p, s, t, lag) in enumerate(rels)]}
    p.update(extra)
    return validate_project(p)


def days(s, code, field):
    """A date from the schedule as a textbook day number (start-type or finish-type)."""
    from fieldsched.timecal import parse_dt
    t = parse_dt(s["acts"][code][field])
    day, mod = divmod(t, 1440)
    if mod == 480:
        return day - BASE
    if mod == 960:
        return day - BASE + 1
    raise AssertionError(f"{code} {field} {s['acts'][code][field]} is not on a day boundary")
