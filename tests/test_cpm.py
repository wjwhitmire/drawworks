"""CPM against hand-worked networks. Each case shows its working in comments.

Day convention (tests/helpers.py): ES = k means the start of day k, EF = k means the end of day
k - 1, as in planning textbooks, so EF = ES + duration.
"""

import pytest

from fieldsched.cpm import schedule
from fieldsched.errors import SchedError
from fieldsched.model import validate_project
from helpers import D, FIVE, SEVEN, days, finish, net, start


def table(s, codes):
    return {c: (days(s, c, "es"), days(s, c, "ef"), days(s, c, "ls"), days(s, c, "lf"), s["acts"][c]["tf"] // D,
                s["acts"][c]["ff"] // D) for c in codes}


def test_activity_on_node_textbook_network():
    # A3; B4 after A; C2 after A; D5 after B; E1 after C; F2 after C; G4 after D,E; H3 after F,G
    # forward: A 0-3, B 3-7, C 3-5, D 7-12, E 5-6, F 5-7, G 12-16, H 16-19
    # backward: H 16-19, G 12-16, F 14-16, E 11-12, D 7-12, C LF=min(11,14)=11 so 9-11, B 3-7, A 0-3
    # TF = LF - EF; FF = min(successor ES) - EF
    s = schedule(net({"A": 3, "B": 4, "C": 2, "D": 5, "E": 1, "F": 2, "G": 4, "H": 3},
                     [("A", "B", "FS", 0), ("A", "C", "FS", 0), ("B", "D", "FS", 0), ("C", "E", "FS", 0),
                      ("C", "F", "FS", 0), ("D", "G", "FS", 0), ("E", "G", "FS", 0), ("F", "H", "FS", 0),
                      ("G", "H", "FS", 0)]))
    assert table(s, "ABCDEFGH") == {
        "A": (0, 3, 0, 3, 0, 0), "B": (3, 7, 3, 7, 0, 0), "C": (3, 5, 9, 11, 6, 0), "D": (7, 12, 7, 12, 0, 0),
        "E": (5, 6, 11, 12, 6, 6), "F": (5, 7, 14, 16, 9, 9), "G": (12, 16, 12, 16, 0, 0), "H": (16, 19, 16, 19, 0, 0)}
    assert [c for c in "ABCDEFGH" if s["acts"][c]["crit"]] == list("ABDGH")
    assert [c for c in "ABCDEFGH" if s["acts"][c]["lp"]] == list("ABDGH")
    assert s["finish"] == finish(19)


def test_precedence_network_with_ss_ff_lags():
    # A4; B6 SS+2 from A; C5 FF+1 from B; D3 FS from A; E2 FS from C and D
    # forward: A 0-4; B ES>=0+2 -> 2-8; C EF>=8+1=9 -> 4-9; D 4-7; E ES>=max(9,7) -> 9-11
    # backward: E 9-11; C LF<=9 -> 4-9; D LF<=9 -> 6-9; B LF<=C.LF-1=8 -> 2-8
    #           A: LS<=B.LS-2=0 and LF<=D.LS=6 -> LF=min(6, 0+4)=4 -> 0-4
    # free float: D = 9-7 = 2; all others 0
    s = schedule(net({"A": 4, "B": 6, "C": 5, "D": 3, "E": 2},
                     [("A", "B", "SS", 2), ("B", "C", "FF", 1), ("A", "D", "FS", 0), ("C", "E", "FS", 0), ("D", "E", "FS", 0)]))
    assert table(s, "ABCDE") == {"A": (0, 4, 0, 4, 0, 0), "B": (2, 8, 2, 8, 0, 0), "C": (4, 9, 4, 9, 0, 0),
                                 "D": (4, 7, 6, 9, 2, 2), "E": (9, 11, 9, 11, 0, 0)}
    assert s["rels"]["r0"]["driving"] and s["rels"]["r1"]["driving"] and s["rels"]["r2"]["driving"]
    assert not s["rels"]["r4"]["driving"] and s["rels"]["r4"]["slack"] == 2 * D


def test_negative_lag_and_start_to_finish():
    # A5; B3 FS-2 from A -> ES = 5-2 = 3, 3-6; C2 SF+4 from A -> EF >= 0+4 -> 2-4; D1 FS from B, C -> 6-7
    # backward: D 6-7; B LF<=6 -> 3-6; C LF<=6 -> 4-6 (TF 2); A: LF<=B.LS+2=5, LS<=C.LF-4=2 -> LF=min(5, 2+5) = 5
    s = schedule(net({"A": 5, "B": 3, "C": 2, "D": 1},
                     [("A", "B", "FS", -2), ("A", "C", "SF", 4), ("B", "D", "FS", 0), ("C", "D", "FS", 0)]))
    assert table(s, "ABCD") == {"A": (0, 5, 0, 5, 0, 0), "B": (3, 6, 3, 6, 0, 0), "C": (2, 4, 4, 6, 2, 2),
                                "D": (6, 7, 6, 7, 0, 0)}


def test_multiple_calendars_and_lag_calendar_setting():
    # P on a 5 day calendar, 1 day, starting Friday 2026-01-02; S on a 7 day calendar, FS + 1 day lag.
    # P finishes Fri 16:00. One day of lag counted on:
    #   predecessor (5 day): Mon 01-05 16:00 -> S starts Tue 01-06 08:00
    #   successor (7 day):   Sat 01-03 16:00 -> S starts Sun 01-04 08:00
    #   24 hour:             Sat 01-03 00:00 -> S starts Sat 01-03 08:00
    #   project (5 day):     same as predecessor
    def run(mode):
        p = validate_project({"start": "2026-01-02T08:00", "cal": "c5", "calendars": [FIVE, SEVEN], "settings": {"lag_cal": mode},
                              "activities": [{"id": "P", "od": D, "cal": "c5"}, {"id": "S", "od": D, "cal": "c7"}],
                              "rels": [{"id": "r", "pred": "P", "succ": "S", "lag": D}]})
        return schedule(p)["acts"]["S"]["es"]
    assert run("pred") == "2026-01-06T08:00"
    assert run("succ") == "2026-01-04T08:00"
    assert run("24h") == "2026-01-03T08:00"
    assert run("project") == "2026-01-06T08:00"
    # a 7 day activity after a 5 day one: total float of the 5 day activity counts only its working days
    p = validate_project({"start": "2026-01-02T08:00", "cal": "c5", "calendars": [FIVE, SEVEN],
                          "activities": [{"id": "A", "od": D, "cal": "c5"}, {"id": "B", "od": 4 * D, "cal": "c7"},
                                         {"id": "C", "od": D, "cal": "c5"}],
                          "rels": [{"id": "1", "pred": "A", "succ": "B"}, {"id": "2", "pred": "A", "succ": "C"}]})
    s = schedule(p)
    # A Fri; B Sat-Tue (01-03..01-06); C Mon 01-05; project finish Tue 01-06 16:00; C TF = Tue only = 1 day
    assert s["acts"]["B"]["ef"] == "2026-01-06T16:00" and s["acts"]["C"]["tf"] == D and s["acts"]["A"]["tf"] == 0


@pytest.mark.parametrize("cstr,date,expect", [
    ("SNET", start(5), {"B": (5, 7)}),
    ("FNET", finish(9), {"B": (7, 9)}),
    ("MS_MAND", start(1), {"B": (1, 3)}),
    ("MF_MAND", finish(4), {"B": (2, 4)}),
    ("MSO", start(5), {"B": (5, 7)}),
    ("MSO", start(1), {"B": (3, 5)}),
])
def test_forward_constraints(cstr, date, expect):
    # A3 -> B2 -> C1; B is constrained
    s = schedule(net({"A": 3, "B": {"od": 2 * D, "cstr": cstr, "cstr_date": date}, "C": 1},
                     [("A", "B", "FS", 0), ("B", "C", "FS", 0)]))
    for code, (es, ef) in expect.items():
        assert (days(s, code, "es"), days(s, code, "ef")) == (es, ef)


def test_backward_constraints_and_negative_float():
    # A3 -> B2 -> C1, project finish 6. FNLT on B at end of day 4 (finish 4): B LF = 4, TF = 4 - 5 = -1
    s = schedule(net({"A": 3, "B": {"od": 2 * D, "cstr": "FNLT", "cstr_date": finish(4)}, "C": 1},
                     [("A", "B", "FS", 0), ("B", "C", "FS", 0)]))
    assert s["acts"]["B"]["tf"] == -D and s["acts"]["A"]["tf"] == -D and s["acts"]["C"]["tf"] == 0
    # SNLT on C at day 7 gives C one day of float only through the anchor; must-finish-by moves the anchor
    s = schedule(net({"A": 3, "B": 2, "C": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)], finish_by=finish(8)))
    assert [s["acts"][c]["tf"] for c in "ABC"] == [2 * D] * 3
    assert not any(s["acts"][c]["crit"] for c in "ABC")
    s = schedule(net({"A": 3, "B": 2, "C": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)], finish_by=finish(5)))
    assert [s["acts"][c]["tf"] for c in "ABC"] == [-D] * 3
    s = schedule(net({"A": 3, "B": {"od": 2 * D, "cstr": "SNLT", "cstr_date": start(2)}, "C": 1},
                     [("A", "B", "FS", 0), ("B", "C", "FS", 0)]))
    assert s["acts"]["B"]["tf"] == -D and days(s, "B", "ls") == 2


def test_as_late_as_possible():
    # A2 -> C1; B1 (ALAP) -> C. C starts day 2, B moves from 0-1 to 1-2; floats stay on early dates
    s = schedule(net({"A": 2, "B": {"od": D, "cstr": "ALAP"}, "C": 1}, [("A", "C", "FS", 0), ("B", "C", "FS", 0)]))
    assert (days(s, "B", "es"), days(s, "B", "ef")) == (1, 2)
    assert s["acts"]["B"]["tf"] == D and not s["acts"]["B"]["crit"]


def test_milestones_and_finish_type_dates():
    # start milestone after a finish shows next morning; a finish milestone keeps the finish time
    s = schedule(net({"A": 2, "S": {"type": "start_ms"}, "F": {"type": "finish_ms"}, "B": 1},
                     [("A", "S", "FS", 0), ("A", "F", "FS", 0), ("S", "B", "FS", 0), ("F", "B", "FS", 0)]))
    assert s["acts"]["S"]["es"] == start(2) and s["acts"]["F"]["es"] == finish(2)
    assert s["acts"]["F"]["tf"] == 0 and s["acts"]["S"]["tf"] == 0


def test_progress_retained_logic_and_override():
    # A5 -> B5 (FS). Data date: start of day 3. A started day 0 with 2 days left -> A EF = 5.
    # B started day 1 out of sequence with 3 days left.
    # retained logic: B's remaining work waits for A: 5-8.  progress override: resumes at the data date: 3-6.
    def run(mode):
        return schedule(net({"A": {"od": 5 * D, "rd": 2 * D, "as": start(0)}, "B": {"od": 5 * D, "rd": 3 * D, "as": start(1)},
                             "C": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)], data_date=start(3),
                            settings={"oos": mode}))
    r = run("retained")
    assert (days(r, "B", "res"), days(r, "B", "ef"), days(r, "A", "ef")) == (5, 8, 5)
    assert r["oos"] == ["r0"] and r["acts"]["B"]["es"] == start(1)
    o = run("override")
    assert (days(o, "B", "res"), days(o, "B", "ef")) == (3, 6)
    assert o["acts"]["A"]["tf"] == 2 * D  # with the link ignored A only meets the anchor (C finishes day 7)
    # complete activities hold their actual dates and carry no float; unstarted work waits for the data date
    c = schedule(net({"A": {"od": 2 * D, "as": start(0), "af": finish(3)}, "B": 2, "C": 1},
                     [("A", "B", "FS", 0)], data_date=start(5)))
    assert c["acts"]["A"]["tf"] is None and c["acts"]["A"]["status"] == "complete"
    assert days(c, "B", "es") == 5 and days(c, "C", "es") == 5


def test_percent_complete_types():
    s = schedule(net({"A": {"od": 4 * D, "rd": D, "as": start(0)},
                      "B": {"od": 4 * D, "as": start(0), "pct_type": "physical", "phys": 62.5},
                      "C": {"od": 2 * D, "as": start(0), "pct_type": "units"}}, [], data_date=start(1),
                     resources=[{"id": "R"}], assigns=[{"id": "x", "act": "C", "rsrc": "R", "units": 1000, "budget": 16000, "actual": 4000}]))
    assert s["acts"]["A"]["pct"] == 750 and s["acts"]["B"]["pct"] == 625
    # units: 4 actual of 4 + 16 remaining (1 unit/h x 16 h) = 20 percent
    assert s["acts"]["C"]["pct"] == 200


def test_loop_is_named():
    with pytest.raises(SchedError) as e:
        schedule(net({"A": 1, "B": 1, "C": 1, "D": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0), ("C", "D", "FS", 0), ("D", "B", "SS", 0)]))
    assert e.value.code == "loop"
    assert e.value.message.startswith("Logic loop: ") and "B -> C -> D -> B" in e.value.message
    assert e.value.cycle == ["B", "C", "D", "B"]
    with pytest.raises(SchedError) as e:
        net({"A": 1}, [("A", "A", "FS", 0)])
    assert e.value.code == "loop"


def test_longest_path_versus_total_float_threshold():
    # two parallel chains; the short one has 1 day of float, marked critical with a 1 day threshold
    p = net({"A": 3, "B": 2, "Z": 1}, [("A", "Z", "FS", 0), ("B", "Z", "FS", 0)], settings={"crit_tf": D})
    s = schedule(p)
    assert s["acts"]["B"]["crit"] and s["acts"]["A"]["crit"] and not s["acts"]["B"]["lp"]
    p = net({"A": 3, "B": 2, "Z": 1}, [("A", "Z", "FS", 0), ("B", "Z", "FS", 0)], settings={"crit": "longest"})
    s = schedule(p)
    assert s["acts"]["A"]["crit"] and not s["acts"]["B"]["crit"] and s["acts"]["B"]["near"]


def test_float_type_setting():
    # B2 FF+0 into C with C5 starting at 0: start float and finish float differ for C
    p = {"A": 4, "B": 1}
    s = schedule(net(p, [("A", "B", "SS", 0)], settings={"float": "start"}))
    assert s["acts"]["B"]["tf"] == 3 * D
    s = schedule(net(p, [("A", "B", "SS", 0)], settings={"float": "min"}))
    assert s["acts"]["B"]["tf"] == 3 * D


def test_hours_durations_and_lunch():
    cal = {"id": "c", "name": "Lunch", "hpd": 480, "week": [[] if d in (0, 6) else [[480, 720], [780, 1020]] for d in range(7)],
           "exceptions": {}}
    p = validate_project({"start": "2026-11-23T08:00", "calendars": [cal],
                          "activities": [{"id": "A", "od": 360, "unit": "h"}, {"id": "B", "od": 180, "unit": "h"}],
                          "rels": [{"id": "r", "pred": "A", "succ": "B", "type": "FS", "lag": 60}]})
    s = schedule(p)
    assert s["acts"]["A"]["ef"] == "2026-11-23T15:00"
    assert s["acts"]["B"]["es"] == "2026-11-23T16:00" and s["acts"]["B"]["ef"] == "2026-11-24T10:00"


def test_empty_project_and_isolated_activity():
    s = schedule(validate_project({"start": "2026-01-05T08:00"}))
    assert s["acts"] == {} and s["finish"] == "2026-01-05T08:00"


def test_large_network_is_quick():
    import random
    import time
    r = random.Random(7)
    n = 3000
    acts = {f"A{i}": r.choice([1, 2, 5]) for i in range(n)}
    rels = [(f"A{j}", f"A{i}", r.choice(["FS", "SS", "FF"]), r.choice([0, 0, 1])) for i in range(1, n)
            for j in {r.randint(max(0, i - 20), i - 1) for _ in range(2)}]
    p = net(acts, rels, cal=FIVE)
    t = time.time()
    s = schedule(p)
    assert time.time() - t < 10 and s["finish"] > "2026"
