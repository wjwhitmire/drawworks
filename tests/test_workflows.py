"""Update progress, baselines and variance, resources and leveling, schedule checks."""

import pytest

from fieldsched.checks import apply_fix, check, open_ends
from fieldsched.cpm import schedule
from fieldsched.errors import SchedError
from fieldsched.examples import build_example, build_plan, drilling_example, drilling_plan
from fieldsched.progress import apply_update, propose_update, take_baseline, variance
from fieldsched.resources import apply_leveling, histogram, leveling_suggestions
from helpers import D, days, finish, net, start


def test_update_progress_rolls_the_data_date():
    # A3 -> B3 -> C3; move the data date from day 0 to day 4
    p = net({"A": 3, "B": 3, "C": 3, "P": {"od": 3 * D, "pct_type": "physical"}}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)])
    s = schedule(p)
    props = propose_update(p, s, start(4))
    by = {x["act"]: x for x in props}
    assert set(by) == {"A", "B", "P"}
    assert by["A"]["as"] == start(0) and by["A"]["af"] == finish(3) and by["A"]["rd"] == 0
    assert by["B"]["as"] == start(3) and by["B"]["af"] is None and by["B"]["rd"] == 2 * D
    assert by["P"]["af"] == finish(3) and by["P"]["phys"] == 100
    assert "before the new data date" in by["B"]["why"]
    q = apply_update(p, props, start(4))
    s2 = schedule(q)
    assert q["data_date"] == start(4) and s2["acts"]["A"]["status"] == "complete"
    assert days(s2, "B", "res") == 4 and days(s2, "B", "ef") == 6 and days(s2, "C", "ef") == 9
    # rolling again only touches in-progress work
    props2 = propose_update(q, s2, start(5))
    assert [x["act"] for x in props2] == ["B"] and props2[0]["rd"] == D
    with pytest.raises(SchedError):
        propose_update(q, s2, start(2))


def test_baseline_and_variance_sign():
    p = net({"A": 3, "B": 2}, [("A", "B", "FS", 0)])
    p = take_baseline(p, schedule(p), "b1", "Plan")
    late = net({"A": 4, "B": 2}, [("A", "B", "FS", 0)])
    late = {**late, "baselines": p["baselines"], "baseline": "b1"}
    from fieldsched.model import validate_project
    late = validate_project(late)
    v = variance(late, schedule(late))
    # B now finishes a day late: baseline minus current = -1 day; A's duration grew a day
    assert v["B"]["fv"] == -D and v["B"]["sv"] == -D and v["A"]["dv"] == -D and v["A"]["fv"] == -D
    with pytest.raises(SchedError):
        q = p
        for i in range(25):
            q = take_baseline(q, schedule(q), f"b{i + 2}", "x")


def test_histogram_and_overallocation():
    # R max 1 unit. A (2 d) and B (2 d) in parallel, each 1 unit per hour -> 2 units on days 0 and 1
    p = net({"A": 2, "B": 2, "C": {"od": D, "as": start(0), "af": finish(1)}}, [], data_date=start(1),
            resources=[{"id": "R", "max_units": 1000}],
            assigns=[{"id": "1", "act": "A", "rsrc": "R", "units": 1000, "budget": 16000},
                     {"id": "2", "act": "B", "rsrc": "R", "units": 1000, "budget": 16000},
                     {"id": "3", "act": "C", "rsrc": "R", "units": 1000, "budget": 8000, "actual": 8000}])
    s = schedule(p)
    h = histogram(p, s, "R")
    rows = {r["date"]: r for r in h["rows"]}
    assert rows["2026-01-01"]["actual"] == 8000 and rows["2026-01-01"]["remaining"] == 0
    assert rows["2026-01-02"]["remaining"] == 16000 and rows["2026-01-02"]["units"] == 2000 and rows["2026-01-02"]["over"]
    assert rows["2026-01-02"]["limit"] == 8000 and h["peak"] == 2000
    w = histogram(p, s, "R", bucket="week")
    assert sum(r["remaining"] for r in w["rows"]) == 32000
    lv = leveling_suggestions(p, s)
    assert len(lv["suggestions"]) == 1
    sug = lv["suggestions"][0]
    assert sug["act"] == "B" and sug["to"] == start(3) and sug["delay"] == 2 * D and sug["within_float"] is False
    q = apply_leveling(p, lv["suggestions"])
    s2 = schedule(q)
    assert days(s2, "B", "es") == 3 and not any(r["over"] for r in histogram(q, s2, "R")["rows"])


def test_open_ends_and_checks_with_fixes():
    p = net({"S": {"type": "start_ms"}, "A": 2, "B": 2, "F": {"type": "finish_ms"}, "G": {"od": D, "cstr": "MSO", "cstr_date": start(1)}},
            [("S", "A", "FS", 0), ("A", "F", "FS", -1), ("B", "F", "SS", 0), ("S", "G", "SF", 0), ("G", "F", "FS", 40)],
            settings={"long_lag": 10 * D})
    oe = {(x["act"], x["kind"]) for x in open_ends(p)}
    assert oe == {("B", "no_pred"), ("B", "finish_dangle"), ("G", "start_dangle")}
    s = schedule(p)
    res = check(p, s)
    codes = sorted(f["code"] for f in res["findings"])
    # G's start-on constraint holds the longest path at day 1, so the critical path test reports it
    assert codes == ["cp_test", "finish_dangle", "hard_constraint", "lead", "long_lag", "open_start", "sf_link", "start_dangle"]
    fix = {f["code"]: f for f in res["findings"]}
    assert fix["open_start"]["fix"] == {"kind": "add_rel", "pred": "S", "succ": "B", "type": "FS", "lag": 0}
    assert fix["lead"]["fix"] == {"kind": "set_rel", "rel": "r1", "type": "SS", "lag": D} and fix["lead"]["fix_label"] == "Make it SS 1d"
    assert fix["hard_constraint"]["fix"]["cstr"] == "SNET"
    q = apply_fix(apply_fix(apply_fix(p, fix["open_start"]["fix"]), fix["lead"]["fix"]), fix["hard_constraint"]["fix"])
    res2 = check(q, schedule(q))
    # turning the lead into SS leaves A's finish driving nothing, which the check now reports
    # (G's start-no-earlier-than still holds the longest path)
    assert sorted((f["code"], f["act"]) for f in res2["findings"] if f["act"]) == [
        ("cp_test", "G"), ("finish_dangle", "A"), ("finish_dangle", "B"), ("start_dangle", "G")]
    metrics = {m["name"]: m for m in res["metrics"]}
    assert metrics["Leads"]["count"] == 1 and not metrics["Leads"]["pass"]
    with pytest.raises(SchedError):
        apply_fix(p, {"kind": "nope"})


def test_check_flags_negative_float_oos_and_invalid_dates():
    p = net({"A": {"od": 5 * D, "rd": 2 * D, "as": start(0)}, "B": {"od": 2 * D, "rd": D, "as": start(1)},
             "C": {"od": D, "cstr": "FNLT", "cstr_date": finish(5)}, "X": {"od": D, "as": start(9), "af": finish(10)}},
            [("A", "B", "FS", 0), ("B", "C", "FS", 0)], data_date=start(3))
    res = check(p, schedule(p))
    codes = {f["code"] for f in res["findings"]}
    assert {"neg_float", "oos", "invalid_dates"} <= codes


def test_examples_are_consistent():
    for build in (drilling_example, build_example, drilling_plan, build_plan):
        p = build()
        s = schedule(p)
        assert p["label"].startswith("Example data")
        assert all(r["tf"] is None or r["tf"] >= 0 for r in s["acts"].values())
        res = check(p, s)
        assert not [f for f in res["findings"] if f["sev"] == "error"]
    d = drilling_example()
    s = schedule(d)
    lp = [a["code"] for a in d["activities"] if s["acts"][a["id"]]["lp"]]
    assert lp[0] == "A1210" and lp[-1] == "A1620" and "A1410" in lp
    assert s["oos"] == []
    b = build_example()
    s = schedule(b)
    assert [r for r in b["rels"] if r["id"] in s["oos"]][0]["succ"] == "C1210"
    assert leveling_suggestions(d, schedule(d))["suggestions"] == []
    assert leveling_suggestions(build_plan(), schedule(build_plan()))["suggestions"]


def test_dcma_fourteen_points():
    # A3 -> B2 -> C1 on a 7 day calendar; thresholds as published
    p = net({"A": 3, "B": 2, "C": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)])
    res = check(p, schedule(p))
    m = {x["dcma"]: x for x in res["metrics"]}
    assert sorted(k for k in m if k) == list(range(1, 15)) and res["metrics"][-1]["name"] == "Out of sequence"
    assert [(m[k]["limit"], m[k]["kind"]) for k in (1, 2, 3, 4, 5, 6, 7, 8, 9)] == [
        (50, "share"), (0, "share"), (50, "share"), (100, "share"), (50, "share"), (50, "share"), (0, "share"), (50, "share"), (0, "share")]
    assert p["settings"]["high_float"] == p["settings"]["high_dur"] == 44 * 8 * 60
    assert m[10]["pass"] is None and m[10]["count"] == 3  # no resources: reported, no threshold
    # no baseline and no must-finish-by: 11, 13 and 14 do not apply; the path is unbroken
    assert m[11]["pass"] is m[13]["pass"] is m[14]["pass"] is None and m[12]["pass"] is True
    # CPLI against a must-finish-by date: path 6 days, finish 1 day late -> (6 - 1) / 6 = 0.833
    q = {**p, "finish_by": finish(5)}
    m = {x["dcma"]: x for x in check(q, schedule(q))["metrics"]}
    assert (m[13]["count"], m[13]["of"], m[13]["permille"], m[13]["pass"]) == (5 * D, 6 * D, 833, False)
    q = {**p, "finish_by": finish(7)}
    m = {x["dcma"]: x for x in check(q, schedule(q))["metrics"]}
    assert (m[13]["permille"], m[13]["pass"]) == (1167, True)
    # a start-no-earlier-than on the first activity breaks the path back to the data date
    q = net({"A": {"od": 3 * D, "cstr": "SNET", "cstr_date": start(2)}, "B": 2, "C": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)])
    res = check(q, schedule(q))
    m = {x["dcma"]: x for x in res["metrics"]}
    assert m[12]["pass"] is False and [f["act"] for f in res["findings"] if f["code"] == "cp_test"] == ["A"]
    # baseline: A, B and C all due before the data date (start of day 6); A finished on time, B a
    # day late, C not at all: missed 2 of 3; BEI = 2 finished / 3 due = 0.667
    q = net({"A": {"od": 3 * D, "as": start(0), "af": finish(3)}, "B": {"od": 2 * D, "as": start(3), "af": finish(6)}, "C": 1},
            [("A", "B", "FS", 0), ("B", "C", "FS", 0)], data_date=start(6),
            baselines=[{"id": "b", "name": "Plan", "acts": {"A": [start(0), finish(3), 3 * D], "B": [start(3), finish(5), 2 * D],
                                                             "C": [start(5), finish(6), D]}}], baseline="b")
    m = {x["dcma"]: x for x in check(q, schedule(q))["metrics"]}
    assert (m[11]["count"], m[11]["of"], m[11]["pass"]) == (2, 3, False)
    assert (m[14]["count"], m[14]["of"], m[14]["permille"], m[14]["pass"]) == (2, 3, 667, False)
    # high duration uses the baseline duration: 50 days planned, 10 left
    q = net({"A": {"od": 50 * D, "rd": 10 * D, "as": start(0)}}, [], data_date=start(40))
    assert any(f["code"] == "high_dur" and "original duration of 50 days" in f["msg"] for f in check(q, schedule(q))["findings"])


def test_leveling_does_not_chase_an_assignment_over_the_maximum_on_its_own():
    # A needs 2 units of a 1 unit resource: no delay can fix that, so nothing is suggested for it;
    # B (1 unit) overlaps A and waits for it
    p = net({"A": 2, "B": 1}, [], resources=[{"id": "R", "max_units": 1000}],
            assigns=[{"id": "x", "act": "A", "rsrc": "R", "units": 2000}, {"id": "y", "act": "B", "rsrc": "R", "units": 1000}])
    lv = leveling_suggestions(p, schedule(p))
    assert [(s["act"], s["to"], s["delay"]) for s in lv["suggestions"]] == [("B", start(2), 2 * D)]
