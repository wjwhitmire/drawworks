"""Values worked by hand for the full function test, independent of the parity vectors.

Calendar: Monday to Friday, 08:00 to 12:00 and 13:00 to 17:00 (480 working minutes a day), project
start Monday 2026-11-02 08:00. Durations and lags are working minutes.
"""

from fieldsched.checks import check
from fieldsched.cpm import schedule
from fieldsched.model import validate_project
from fieldsched.progress import propose_update
from fieldsched.resources import histogram, leveling_suggestions
from fieldsched.xer import read_xer

LUNCH = [[], *[[[480, 720], [780, 1020]]] * 5, []]


def proj(acts, rels, **kw):
    return validate_project(dict({"name": "hand", "start": "2026-11-02T08:00",
                                  "calendars": [{"id": "c", "name": "5d", "hpd": 480, "week": LUNCH}],
                                  "activities": acts, "rels": rels}, **kw))


def act(i, od, **kw):
    return dict({"id": i, "code": i, "name": i, "od": od, "rd": od}, **kw)


def rel(i, a, b, t, lag=0):
    return {"id": i, "pred": a, "succ": b, "type": t, "lag": lag}


def test_every_relationship_type_with_lags_and_a_start_constraint():
    # A 5d.  B: A FS+2d, 1d.  C: A FF+1d, 1d.  D: B FS, C SS+2d, 3d, start on or after Wed 11-11 08:00.
    # E: A SF, 2h.
    # Forward:  A Mon 02 08:00 - Fri 06 17:00.
    #   B: Fri 17:00 + 2d = Tue 10 17:00, the next working minute Wed 11 08:00; finishes Wed 17:00.
    #   C: finish >= Fri 17:00 + 1d = Mon 09 17:00, so Mon 09 08:00 - 17:00.
    #   D: start >= B's finish Wed 11 17:00 (= Thu 12 08:00), C's start + 2d (Tue 10 17:00) and the
    #      constraint Wed 11 08:00; Thu 12 08:00 + 3d = Mon 16 17:00 (the project finish).
    #   E: finish >= A's start Mon 08:00; the project start holds it at Mon 08:00 - 10:00.
    # Backward from Mon 16 17:00:
    #   D 12 08:00 - 16 17:00, float 0.  B: finish <= D's late start, Wed 11 17:00; float 0.
    #   C: start <= D's late start - 2d = Tue 10 08:00, so Tue 10 08:00 - 17:00; float 1d. Its free
    #      float is the slack on SS+2d: C's start + 2d = Tue 17:00 against D's start Thu 08:00 = 1d.
    #   A: finish <= B's late start - 2d = Mon 09 08:00 (= Fri 06 17:00) and C's late finish - 1d
    #      = Tue 10 08:00 (= Mon 09 17:00); so Fri 06 17:00, float 0.
    #   E: open end, late finish Mon 16 17:00; float = 11 working days - 2h = 5160 minutes.
    p = proj([act("A", 2400), act("B", 480), act("C", 480), act("D", 1440, cstr="SNET", cstr_date="2026-11-11T08:00"), act("E", 120)],
             [rel("1", "A", "B", "FS", 960), rel("2", "A", "C", "FF", 480), rel("3", "B", "D", "FS"), rel("4", "C", "D", "SS", 960),
              rel("5", "A", "E", "SF")])
    s = schedule(p)["acts"]
    want = {"A": ("2026-11-02T08:00", "2026-11-06T17:00", "2026-11-02T08:00", "2026-11-06T17:00", 0, 0),
            "B": ("2026-11-11T08:00", "2026-11-11T17:00", "2026-11-11T08:00", "2026-11-11T17:00", 0, 0),
            "C": ("2026-11-09T08:00", "2026-11-09T17:00", "2026-11-10T08:00", "2026-11-10T17:00", 480, 480),
            "D": ("2026-11-12T08:00", "2026-11-16T17:00", "2026-11-12T08:00", "2026-11-16T17:00", 0, 0),
            "E": ("2026-11-02T08:00", "2026-11-02T10:00", "2026-11-16T15:00", "2026-11-16T17:00", 5160, 5160)}
    for k, (es, ef, ls, lf, tf, ff) in want.items():
        r = s[k]
        assert (r["es"], r["ef"], r["ls"], r["lf"], r["tf"], r["ff"]) == (es, ef, ls, lf, tf, ff), k
    assert [k for k in "ABCDE" if s[k]["crit"]] == ["A", "B", "D"]


def test_histogram_and_leveling_by_hand():
    # X 2d at 2 units an hour and Y 1d at 1 unit an hour, both on Monday, crew maximum 1 unit.
    # Monday: 2 x 8 + 1 x 8 = 24 unit-hours, 3 units at once; Tuesday 16; limit 8 a day.
    p = proj([act("X", 960), act("Y", 480)], [], resources=[{"id": "R", "code": "R", "name": "Crew", "max_units": 1000}],
             assigns=[{"id": "x1", "act": "X", "rsrc": "R", "units": 2000, "budget": 32000},
                      {"id": "x2", "act": "Y", "rsrc": "R", "units": 1000, "budget": 8000}])
    s = schedule(p)
    rows = histogram(p, s, "R")["rows"]
    assert [(r["date"], r["remaining"], r["units"], r["limit"], r["over"]) for r in rows] == [
        ("2026-11-02", 24000, 3000, 8000, True), ("2026-11-03", 16000, 2000, 8000, True)]
    week = histogram(p, s, "R", bucket="week")["rows"]
    assert (week[0]["remaining"], week[0]["limit"]) == (40000, 16000)
    # X is over the maximum on its own and stays; Y waits for X to end (Tue 17:00), 2 days later,
    # more than its 1 day of float, so the finish moves to Wed 17:00
    lv = leveling_suggestions(p, s)
    assert [(x["act"], x["to"], x["delay"], x["within_float"]) for x in lv["suggestions"]] == [("Y", "2026-11-04T08:00", 960, False)]
    assert lv["finish"] == "2026-11-04T17:00"


def test_update_progress_proposals_by_hand():
    # A 3d from Monday; B 1d Monday then C 1d Tuesday. New data date Wed 08:00.
    p = proj([act("A", 1440), act("B", 480), act("C", 480)], [rel("1", "B", "C", "FS")])
    props = {x["act"]: (x["as"], x["af"], x["rd"]) for x in propose_update(p, schedule(p), "2026-11-04T08:00")}
    assert props == {"A": ("2026-11-02T08:00", None, 480), "B": ("2026-11-02T08:00", "2026-11-02T17:00", 0),
                     "C": ("2026-11-03T08:00", "2026-11-03T17:00", 0)}


def test_dcma_counts_by_hand():
    # Start milestone S, tasks T1 to T8 (i days each), finish milestone F: 10 incomplete activities.
    # 10 relationships: one lead (T2 to T3 FS -1h), one lag (T4 to T5 FS +1d), one SS (T3 to T4).
    # T8 has no successor (1 open end); T5 has a start on constraint (1 hard constraint) that holds
    # the longest path later than the data date (critical path test fails).
    acts = [act("S", 0, type="start_ms")] + [act(f"T{i}", 480 * i) for i in range(1, 9)] + [act("F", 0, type="finish_ms")]
    acts[5].update(cstr="MSO", cstr_date="2026-11-16T08:00")
    rels = [rel("r1", "S", "T1", "FS"), rel("r2", "T1", "T2", "FS"), rel("r3", "T2", "T3", "FS", -60), rel("r4", "T3", "T4", "SS"),
            rel("r5", "T4", "T5", "FS", 480), rel("r6", "T5", "T6", "FS"), rel("r7", "T6", "T7", "FS"), rel("r8", "T7", "F", "FS"),
            rel("r9", "S", "T8", "FS"), rel("r10", "T3", "F", "FS")]
    p = proj(acts, rels)
    res = check(p, schedule(p))
    m = {x["dcma"]: (x["count"], x["of"], x["pass"]) for x in res["metrics"] if x["dcma"]}
    assert m[1] == (1, 10, False)        # 10% open ends, over 5%
    assert m[2] == (1, 10, False)        # any lead fails
    assert m[3] == (1, 10, False)        # 10% lags, over 5%
    assert m[4] == (1, 10, True)         # 90% finish to start meets the 90% floor
    assert m[5] == (1, 10, False)        # 10% hard constraints
    assert m[7][2] is True and m[10][:2] == (8, 10)
    assert m[12][2] is False
    msg = next(f for f in res["findings"] if f["code"] == "hard_constraint")
    assert "start on constraint (MSO)" in msg["msg"] and msg["fix_label"] == "Change to start on or after"


def test_xer_projects_say_which_was_exported():
    text = ("ERMHDR\t8.0\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\texport_flag\n"
            "%R\t1\tOther\t2026-01-05 08:00\tN\n%R\t2\tMine\t2026-01-05 08:00\tY\n"
            "%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttarget_drtn_hr_cnt\n%R\t10\t2\tA\t8\n")
    assert read_xer(text)["projects"] == [{"id": "1", "name": "Other", "exported": False}, {"id": "2", "name": "Mine", "exported": True}]


def test_xer_continuation_after_a_repeated_field_list():
    # found by mutation fuzzing: a %F line repeated with more fields, then a line without a marker
    from fieldsched.xer import parse_tables
    t = parse_tables("ERMHDR\t8\n%T\tA\n%F\tx\n%R\t1\n%F\tx\ty\nloose line\n%E\n")
    assert t["tables"]["A"]["rows"] == [{"x": "1", "y": "\nloose line"}]
