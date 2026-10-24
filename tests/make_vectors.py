"""Write tests/vectors.json (reference cases from the Python library for the browser core) and
web/src/core/90_example_data.js (the example projects the page opens with).

Every case records a function name, its arguments and either its result or its error code and
message. web/parity.test.mjs replays them against the JavaScript core and requires exact equality.
Run: python tests/make_vectors.py
"""

import hashlib
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from fieldsched import brand, checks, cpm, files, model, mspdi, pdf, progress, resources, textio, timecal, xer  # noqa: E402
from fieldsched.errors import SchedError  # noqa: E402
from fieldsched.examples import build_example, build_plan, drilling_example, drilling_plan  # noqa: E402

FILES = ROOT / "tests" / "files"
FIX = {}
CASES = []


def fx(name, value):
    FIX[name] = value
    return {"$fx": name}


def resolve(x):
    if isinstance(x, list):
        return [resolve(v) for v in x]
    if isinstance(x, dict):
        if set(x) == {"$fx"}:
            return json.loads(json.dumps(FIX[x["$fx"]]))
        if set(x) == {"$bytes"}:
            return x["$bytes"].encode("latin-1")
        return {k: resolve(v) for k, v in x.items()}
    return x


def post(v):
    if isinstance(v, (bytes, bytearray)):
        return {"$sha256": hashlib.sha256(bytes(v)).hexdigest(), "len": len(v)}
    return json.loads(json.dumps(v))


FNS = {
    "validate_project": model.validate_project, "schedule": cpm.schedule, "topo_order": cpm.topo_order,
    "propose_update": progress.propose_update, "apply_update": progress.apply_update, "take_baseline": progress.take_baseline,
    "variance": progress.variance, "histogram": resources.histogram, "leveling_suggestions": resources.leveling_suggestions,
    "apply_leveling": resources.apply_leveling, "check": checks.check, "apply_fix": checks.apply_fix, "open_ends": checks.open_ends,
    "decode_bytes": textio.decode_bytes, "encode_cp1252": textio.encode_cp1252, "parse_xml": textio.parse_xml,
    "parse_tables": xer.parse_tables, "parse_clndr_data": xer.parse_clndr_data, "read_xer": xer.read_xer, "write_xer": xer.write_xer,
    "parse_duration": mspdi.parse_duration, "read_mspdi": mspdi.read_mspdi, "write_mspdi": mspdi.write_mspdi,
    "detect": files.detect, "parse_json": files.parse_json, "open_file": files.open_file, "compare_stored": files.compare_stored,
    "export_csv": files.export_csv, "render_pdf": pdf.render_pdf, "fmt_fixed": timecal.fmt_fixed, "round_div": timecal.round_div,
    "tree_rows": cpm.tree_rows, "wbs_rollup": cpm.wbs_rollup, "cal_ops": None,
}


def cal_ops(cal, ops):
    """Vector-only adapter: run calendar operations and return their results."""
    c = timecal.compile_calendar(cal)
    out = []
    for op, a, b in ops:
        t = timecal.parse_dt(a)
        if op == "add":
            out.append(timecal.fmt_dt(c.add_work(t, b)))
        elif op == "sub":
            out.append(timecal.fmt_dt(c.sub_work(t, b)))
        elif op == "fwd":
            out.append(timecal.fmt_dt(c.snap_fwd(t)))
        elif op == "back":
            out.append(timecal.fmt_dt(c.snap_back(t)))
        else:
            out.append(c.work_between(t, timecal.parse_dt(b)))
    return out


FNS["cal_ops"] = cal_ops


def case(fn, *args, code_only=False):
    real = resolve(list(args))
    try:
        out = FNS[fn](*real)
    except SchedError as e:
        c = {"fn": fn, "args": list(args), "error": e.code, "message": e.message}
        if code_only:
            c["code_only"] = True
        CASES.append(c)
        return None
    CASES.append({"fn": fn, "args": list(args), "out": post(out)})
    return out


# ---------------------------------------------------------------------------------- calendars
LUNCH = {"id": "c", "name": "Lunch", "hpd": 480, "week": [[] if d in (0, 6) else [[480, 720], [780, 1020]] for d in range(7)],
         "exceptions": {"2026-11-26": [], "2026-11-28": [[480, 720]]}}
NIGHT = {"id": "n", "name": "Night shift", "hpd": 600, "week": [[[0, 300], [1140, 1440]] for _ in range(7)], "exceptions": {"2026-12-25": []}}
rng = random.Random(18)
for cal in (LUNCH, NIGHT):
    ops = []
    for _ in range(120):
        t = f"2026-11-{rng.randint(20, 30):02d}T{rng.randint(0, 23):02d}:{rng.choice([0, 1, 30, 59]):02d}"
        k = rng.choice(["add", "sub", "fwd", "back", "between"])
        if k == "between":
            ops.append([k, t, f"2026-12-{rng.randint(1, 9):02d}T{rng.randint(0, 23):02d}:00"])
        else:
            ops.append([k, t, rng.choice([0, 1, 60, 239, 240, 480, 600, 1441, 5000])])
    case("cal_ops", cal, ops)
case("cal_ops", {"id": "x", "name": "Empty", "hpd": 480, "week": [[]] * 7, "exceptions": {}}, [])
for n, d, pl in [(1200, 480, 2), (-240, 480, 1), (5, 2, 0), (-5, 2, 0), (1, 3, 2), (10 ** 12, 7, 3)]:
    case("fmt_fixed", n, d, pl)
    case("round_div", n, d)


# ---------------------------------------------------------------------------------- networks
def net(acts, rels, cal=None, **extra):
    p = {"start": "2026-01-01T08:00", "calendars": [cal or {"id": "c7", "name": "Seven day", "hpd": 480,
                                                             "week": [[[480, 960]] for _ in range(7)], "exceptions": {}}],
         "activities": [dict({"id": k}, **(v if isinstance(v, dict) else {"od": int(v * 480)})) for k, v in acts.items()],
         "rels": [{"id": f"r{i}", "pred": a, "succ": b, "type": t, "lag": int(lag * 480)} for i, (a, b, t, lag) in enumerate(rels)]}
    p.update(extra)
    return p


HAND = [
    net({"A": 3, "B": 4, "C": 2, "D": 5, "E": 1, "F": 2, "G": 4, "H": 3},
        [("A", "B", "FS", 0), ("A", "C", "FS", 0), ("B", "D", "FS", 0), ("C", "E", "FS", 0), ("C", "F", "FS", 0),
         ("D", "G", "FS", 0), ("E", "G", "FS", 0), ("F", "H", "FS", 0), ("G", "H", "FS", 0)]),
    net({"A": 4, "B": 6, "C": 5, "D": 3, "E": 2},
        [("A", "B", "SS", 2), ("B", "C", "FF", 1), ("A", "D", "FS", 0), ("C", "E", "FS", 0), ("D", "E", "FS", 0)]),
    net({"A": 5, "B": 3, "C": 2, "D": 1}, [("A", "B", "FS", -2), ("A", "C", "SF", 4), ("B", "D", "FS", 0), ("C", "D", "FS", 0)]),
    net({"A": 3, "B": {"od": 960, "cstr": "FNLT", "cstr_date": "2026-01-04T16:00"}, "C": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0)]),
    net({"A": 2, "B": {"od": 480, "cstr": "ALAP"}, "C": 1}, [("A", "C", "FS", 0), ("B", "C", "FS", 0)]),
    net({"A": {"od": 2400, "rd": 960, "as": "2026-01-01T08:00"}, "B": {"od": 2400, "rd": 1440, "as": "2026-01-02T08:00"}, "C": 1},
        [("A", "B", "FS", 0), ("B", "C", "FS", 0)], data_date="2026-01-04T08:00"),
    net({"A": {"od": 2400, "rd": 960, "as": "2026-01-01T08:00"}, "B": {"od": 2400, "rd": 1440, "as": "2026-01-02T08:00"}, "C": 1},
        [("A", "B", "FS", 0), ("B", "C", "FS", 0)], data_date="2026-01-04T08:00", settings={"oos": "override"}),
    net({"A": 1, "B": 1, "C": 1, "D": 1}, [("A", "B", "FS", 0), ("B", "C", "FS", 0), ("C", "D", "FS", 0), ("D", "B", "SS", 0)]),
    net({"A": 3, "B": 2, "Z": 1}, [("A", "Z", "FS", 0), ("B", "Z", "FS", 0)], settings={"crit": "longest"}),
    net({"S": {"type": "start_ms"}, "A": 2, "F": {"type": "finish_ms"}, "B": {"od": 480, "cstr": "MS_MAND", "cstr_date": "2026-01-02T08:00"},
         "C": {"od": 480, "cstr": "MF_MAND", "cstr_date": "2026-01-09T16:00"}, "D": {"od": 480, "cstr": "SNLT", "cstr_date": "2026-01-01T08:00"},
         "E": {"od": 480, "cstr": "MSO", "cstr_date": "2026-01-05T08:00"}, "G": {"od": 480, "cstr": "MFO", "cstr_date": "2026-01-06T16:00"}},
        [("S", "A", "FS", 0), ("A", "F", "FS", 0), ("A", "B", "FS", 0), ("B", "C", "SS", 1), ("C", "D", "FF", 0), ("D", "F", "FS", 0),
         ("E", "G", "SF", 1), ("G", "F", "FS", 0)], finish_by="2026-01-12T16:00"),
]
for i, p in enumerate(HAND):
    v = case("validate_project", p)
    if v is not None:
        case("schedule", fx(f"hand{i}", v))


def random_project(seed):
    r = random.Random(seed)
    cals = [
        {"id": "c5", "name": "Five day", "hpd": 480, "week": [[] if d in (0, 6) else [[420, 660], [690, 930]] for d in range(7)],
         "exceptions": {"2026-02-16": [], "2026-03-07": [[480, 720]]}},
        {"id": "c7", "name": "Seven day", "hpd": 600, "week": [[[360, 960]] for _ in range(7)], "exceptions": {}},
        {"id": "c24", "name": "Round the clock", "hpd": 1440, "week": [[[0, 1440]] for _ in range(7)], "exceptions": {}},
        {"id": "c4", "name": "Four tens", "hpd": 600, "week": [[] if d in (0, 5, 6) else [[360, 960]] for d in range(7)],
         "exceptions": {"2026-02-23": []}},
    ]
    n = r.randint(6, 40)
    start = f"2026-02-{r.randint(1, 9):02d}T{r.choice(['00:00', '07:00', '08:00', '12:30'])}"
    acts = []
    for i in range(n):
        typ = r.choices(["task", "start_ms", "finish_ms"], [8, 1, 1])[0]
        od = r.choice([0, 30, 60, 240, 480, 600, 960, 1440, 2400, 4800]) if typ == "task" else 0
        a = {"id": f"a{i}", "code": f"A{1000 + 10 * i}", "type": typ, "od": od, "cal": r.choice([None, "c5", "c7", "c24", "c4"])}
        if r.random() < 0.15:
            cs = r.choice(["SNET", "SNLT", "FNET", "FNLT", "MSO", "MFO", "MS_MAND", "MF_MAND", "ALAP"])
            a["cstr"] = cs
            if cs != "ALAP":
                a["cstr_date"] = f"2026-02-{r.randint(3, 27):02d}T{r.choice(['00:00', '08:00', '12:00', '16:00'])}"
        if r.random() < 0.1:
            a["pct_type"] = r.choice(["physical", "units"])
            a["phys"] = r.choice([0, 12.5, 50, 99])
        acts.append(a)
    rels = []
    seen = set()
    for i in range(1, n):
        for _ in range(r.randint(0, 3)):
            j = r.randint(max(0, i - 8), i - 1)
            t = r.choices(["FS", "SS", "FF", "SF"], [6, 2, 2, 1])[0]
            if (j, i, t) in seen:
                continue
            seen.add((j, i, t))
            lag = r.choice([0, 0, 0, 60, 480, -240, -480, 1440, 30])
            rels.append({"id": f"r{len(rels)}", "pred": f"a{j}", "succ": f"a{i}", "type": t, "lag": lag, "elapsed": r.random() < 0.1})
    settings = {"oos": r.choice(["retained", "override"]), "crit": r.choice(["tf", "longest"]), "float": r.choice(["finish", "start", "min"]),
                "lag_cal": r.choice(["pred", "succ", "24h", "project"]), "crit_tf": r.choice([0, 480]), "near_tf": 2400}
    p = {"id": f"rnd{seed}", "name": f"Random {seed}", "start": start, "cal": r.choice(["c5", "c7"]), "calendars": cals,
         "activities": acts, "rels": rels, "settings": settings,
         "resources": [{"id": "R1", "max_units": 1000}, {"id": "R2", "max_units": 2000, "type": "nonlabor"}],
         "assigns": [{"id": f"x{k}", "act": f"a{r.randrange(n)}", "rsrc": r.choice(["R1", "R2"]), "units": r.choice([500, 1000, 1500]),
                      "budget": 8000, "actual": r.choice([0, 2000])} for k in range(r.randint(0, 8))]}
    if r.random() < 0.3:
        p["finish_by"] = "2026-03-20T16:00"
    p["assigns"] = list({(x["act"], x["rsrc"]): x for x in p["assigns"]}.values())
    q = model.validate_project(p)
    s = cpm.schedule(q)
    # progress: roll the data date to the middle with Update progress, then disturb it out of sequence
    mid = timecal.fmt_dt((timecal.parse_dt(q["start"]) + timecal.parse_dt(s["finish"])) // 2)
    if r.random() < 0.6:
        props = progress.propose_update(q, s, mid)
        for pr in props:
            if r.random() < 0.3 and pr["rd"]:
                pr["rd"] += 120
        q = progress.apply_update(q, props, mid)
        acts2 = []
        for a in q["activities"]:
            if not a["as"] and r.random() < 0.08 and a["type"] == "task":
                a = {**a, "as": mid, "rd": max(0, a["rd"] - 60)}
            acts2.append(a)
        q = model.validate_project({**q, "activities": acts2})
    return q


for seed in range(70):
    q = random_project(seed)
    ref = fx(f"rnd{seed}", q)
    s = case("schedule", ref)
    if s is None:
        continue
    sref = fx(f"rnd{seed}_s", s)
    case("check", ref, sref)
    case("open_ends", ref)
    if seed % 3 == 0:
        case("propose_update", ref, sref, timecal.fmt_dt(timecal.parse_dt(q["data_date"]) + 3 * 1440))
        case("variance", ref, sref)
        case("histogram", ref, sref, "R1", "early", "day")
        case("histogram", ref, sref, "R2", "late", "week")
        case("leveling_suggestions", ref, sref)
        case("wbs_rollup", ref, sref)
    if seed % 5 == 0:
        case("write_xer", ref, sref)
        case("write_mspdi", ref, sref)
        case("export_csv", ref, sref)
        case("render_pdf", ref, sref, "letter", True, "")
        case("take_baseline", ref, sref, "b1", "Plan", None)

# ---------------------------------------------------------------------------------- examples
for name, make in (("drill_plan", drilling_plan), ("drill", drilling_example), ("build_plan", build_plan), ("build", build_example)):
    p = make()
    ref = fx(name, p)
    case("validate_project", ref)
    s = case("schedule", ref)
    sref = fx(name + "_s", s)
    var = progress.variance(p, s)
    case("variance", ref, sref)
    res = case("check", ref, sref)
    for f in res["findings"]:
        if f["fix"]:
            case("apply_fix", ref, f["fix"])
    lv = case("leveling_suggestions", ref, sref)
    case("apply_leveling", ref, lv["suggestions"])
    for rr in p["resources"]:
        case("histogram", ref, sref, rr["id"], "early", "day")
    props = case("propose_update", ref, sref, timecal.fmt_dt(timecal.parse_dt(p["data_date"]) + 4 * 1440))
    case("apply_update", ref, props, timecal.fmt_dt(timecal.parse_dt(p["data_date"]) + 4 * 1440))
    case("take_baseline", ref, sref, "b2", "Update", None)
    case("export_csv", ref, sref, var)
    case("tree_rows", ref)
    for page in ("letter", "a4", "tabloid", "a3"):
        case("render_pdf", ref, sref, page, True, brand.PRODUCT_NAME)
    case("render_pdf", ref, sref, "tabloid", False, brand.PRODUCT_NAME, {"links": False, "layout": "Logic", "filter": "Critical activities"})
    x = case("write_xer", ref, sref)
    case("read_xer", x)
    case("read_xer", {"$bytes": textio.encode_cp1252(x).decode("latin-1")})
    m = case("write_mspdi", ref, sref)
    case("read_mspdi", m)
    case("open_file", {"$bytes": m.encode("utf-8").decode("latin-1")})
    case("open_file", files.save_native(p))

# ---------------------------------------------------------------------------------- files
for fname in ("sample_p6.xer", "sample_msp.xml"):
    raw = {"$bytes": (FILES / fname).read_bytes().decode("latin-1")}
    out = case("open_file", raw)
    s = cpm.schedule(out["project"])
    case("schedule", fx(fname, out["project"]))
    case("compare_stored", fx(fname, out["project"]), fx(fname + "_s", s), fx(fname + "_st", out["stored"]), out["kind"])
case("parse_clndr_data", "(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|00:00|f|00:00)())))))(0||Exceptions()((0||0(d|46352)())(0||1(d|46353)((0||0(s|09:00|f|13:00)()))))))")
case("parse_tables", "ERMHDR\t8\n%T\tA\n%F\tx\ty\n%R\t1\n%R\t1\t2\t3\nmore\n%T\t__proto__\n%F\t__proto__\tconstructor\n%R\tp\tq\n%E\n")
case("parse_tables", "ERMHDR\t8\n%T\tA\n%F\tx\n%R\t1\n%F\tx\ty\nloose line\n%E\n")  # a field list repeated mid-table, then a continuation
case("read_xer", "ERMHDR\t8\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\texport_flag\n%R\t1\tOther\t2026-01-05 08:00\tN\n%R\t2\tMine\t2026-01-05 08:00\tY\n"
     "%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttarget_drtn_hr_cnt\tstatus_code\tcstr_type\tact_end_date\ttask_type\tphys_complete_pct\n"
     "%R\t10\t2\tA\tnot a number\tTK_Complete\tCS_MSO\t\tTT_LOE\t1_0\n%R\t\t2\tB\t8\tTK_NotStart\t\t\tTT_WBS\t\n%R\t12\t1\tC\t8\t\t\t\t\t\n"
     "%R\t13\t2\tD\t1e400\tTK_Active\t\t\t\t55.5\n%T\tTASKPRED\n%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt\n%R\t1\t13\t10\tPR_SF\t-4\n"
     "%R\t2\t13\t10\tPR_SF\t-4\n%R\t3\t10\t12\tPR_FS\t0\n")
case("read_xer", "ERMHDR\t8\n%T\tPROJECT\n%F\tproj_id\n%R\t1\n", "7")
case("read_xer", "hello\n")
case("read_mspdi", (Path(__file__).parent / "files" / "sample_msp.xml").read_text(encoding="utf-8"))
case("read_mspdi", """<Project xmlns="http://schemas.microsoft.com/project"><StartDate>2026-01-05T08:00:00</StartDate><MinutesPerDay>450</MinutesPerDay>
<Calendars><Calendar><UID>5</UID><Name>A</Name><BaseCalendarUID>6</BaseCalendarUID><WeekDays><WeekDay><DayType>2</DayType><DayWorking>0</DayWorking></WeekDay></WeekDays><WorkWeeks/></Calendar>
<Calendar><UID>6</UID><Name>B</Name><BaseCalendarUID>5</BaseCalendarUID></Calendar><Calendar><UID>x</UID><Name>Odd</Name></Calendar></Calendars><CalendarUID>5</CalendarUID>
<Tasks><Task><UID>1</UID><Name>A</Name><Duration>PT16H0M0S</Duration><DurationFormat>6</DurationFormat><CalendarUID>x</CalendarUID></Task>
<Task><UID>2</UID><Name>B</Name><Duration>PT8H0M0S</Duration><Active>0</Active></Task><Task><UID>2</UID><Name>dup</Name></Task>
<Task><UID>3</UID><Name>C</Name><Duration>P1DT2.5H</Duration><ConstraintType>7</ConstraintType><PhysicalPercentComplete>12.5</PhysicalPercentComplete>
<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>0</Type><LinkLag>14400</LinkLag><LagFormat>8</LagFormat></PredecessorLink>
<PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type></PredecessorLink>
<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>2</Type><LinkLag>500</LinkLag><LagFormat>19</LagFormat></PredecessorLink></Task></Tasks>
<Resources><Resource><UID>4</UID><Name>Gravel</Name><Type>0</Type><MaterialLabel>ton</MaterialLabel><MaxUnits>0</MaxUnits></Resource><Resource><UID>4</UID></Resource></Resources>
<Assignments><Assignment><TaskUID>3</TaskUID><ResourceUID>4</ResourceUID><Units>12</Units></Assignment></Assignments></Project>""")
for d in ["PT8H30M0S", "P1DT2H", "PT0.5H", "nonsense", "-PT1H", "P1W", "P1M", ""]:
    case("parse_duration", d, 480, 2400)
HOSTILE = [
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><Project><Name>&lol;</Name></Project>',
    "<Project><Name>&lol;</Name></Project>", "<Project><Name>a & b</Name></Project>", "<Project><Name>x</Project>",
    "<Project>" + "<a>" * 70 + "</a>" * 70 + "</Project>", "<Project></Project><Project/>", "text<Project/>",
    "<Project><Name>&#0;</Name></Project>", "<Project><![CDATA[x</Project>", "<Project", "",
    '<?xml version="1.0"?><!-- c --><p:Project xmlns:p="u" a=\'1 &amp; 2\'><Name><![CDATA[<b>]]> &#x41;&#66;&lt;&#x1F600;</Name><E/></p:Project>',
]
for h in HOSTILE:
    case("parse_xml", h)
for b in [b"\xef\xbb\xbfcaf\xc3\xa9", "caf\u00e9 \u2019".encode("cp1252"), b"\xff\xfeA\x00\xe9\x00\x3d\xd8", b"\xfe\xff\x00A\xd8\x3d\xde\x00\x00",
          b"\x81\x8d\x9d", b"\xc0\xaf", b"\xed\xa0\x80", b"\xf4\x90\x80\x80", b"\xe2\x82", b"plain"]:
    case("decode_bytes", {"$bytes": b.decode("latin-1")})
case("encode_cp1252", "\u20ac caf\u00e9 \u4e2d \U0001f600")
for t in ["\ufeff  ERMHDR", "<?xml", " {", "PK\x03\x04"]:
    case("detect", t)
case("parse_json", '{"a": [1, 2.5, "x"]}')
case("parse_json", "[" * 1000, code_only=True)
case("parse_json", "{bad", code_only=True)

# ---------------------------------------------------------------------------------- validation
BAD = [
    {"start": "2026-02-30"}, {"start": "2026-01-05", "extra": 1}, {"start": "2026-01-05", "activities": [{"id": "a"}, {"id": "a"}]},
    {"start": "2026-01-05", "activities": [{"id": "a", "wbs": "x"}]}, {"start": "2026-01-05", "activities": [{"id": "a", "od": -1}]},
    {"start": "2026-01-05", "activities": [{"id": "a", "od": 1.5}]}, {"start": "2026-01-05", "activities": [{"id": "a", "od": 480.0, "phys": 50.0}]},
    {"start": "2026-01-05", "activities": [{"id": "a", "af": "2026-01-05"}]}, {"start": "2026-01-05", "activities": [{"id": "a", "cstr": "SNET"}]},
    {"start": "2026-01-05", "activities": [{"id": "bad id!"}]}, {"start": "2026-01-05", "activities": [{"id": 7}]},
    {"start": "2026-01-05", "activities": [{"id": "a"}], "rels": [{"pred": "a", "succ": "a"}]},
    {"start": "2026-01-05", "calendars": [{"id": "c", "name": "x", "week": [[]] * 7}]},
    {"start": "2026-01-05", "calendars": [{"id": "c", "name": "x", "week": [[[600, 500]]] * 7}]},
    {"start": "2026-01-05", "calendars": [{"id": "c", "week": [[[0, 1440]]] * 7, "exceptions": {"2026-01-07": [], "2026-01-06": [[0, 60], [30, 90]]}}]},
    {"start": "2026-01-05", "wbs": [{"id": "w1", "parent": "w2"}, {"id": "w2", "parent": "w1"}]},
    {"start": "2026-01-05", "settings": {"oos": "maybe"}}, {"start": "2026-01-05", "settings": None, "format": "other"},
    {"start": "2026-01-05", "version": 9}, {"start": "2026-01-05", "version": True}, {"start": 20260105},
    {"start": "2026-01-05", "name": "  A\u0000B\nC \U0001f600" * 30, "activities": [{"id": "a", "notes": "x\r\ny"}]},
    {"start": "2026-01-05", "baselines": [{"id": "b", "acts": {"z": ["2026-01-05", "2026-01-06", 480], "a": ["2026-01-05", None, 0]}}], "baseline": "b"},
    {"start": "2026-01-05", "baseline": "nope", "cal": 5},
    {"start": "2026-01-05", "activities": [{"id": "a"}, {"id": "b"}], "rels": [{"pred": "a", "succ": "b"}, {"pred": "a", "succ": "b"}]},
]
for b in BAD:
    case("validate_project", b)

VECTORS = {"cases": CASES, "fixtures": FIX, "constants": {"product_name": brand.PRODUCT_NAME, "format": model.FORMAT, "version": model.VERSION}}
(ROOT / "tests" / "vectors.json").write_text(json.dumps(VECTORS, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
examples = {"drill": drilling_example(), "build": build_example()}
(ROOT / "web" / "src" / "core" / "90_example_data.js").write_text(
    "// Generated by tests/make_vectors.py from src/fieldsched/examples.py. Do not edit by hand.\n"
    "// Both projects are invented examples and are labeled as such.\n"
    "const EXAMPLES = " + json.dumps(examples, sort_keys=True, indent=1, ensure_ascii=False) + ";\n", encoding="utf-8")
print(f"wrote {len(CASES)} cases and {len(FIX)} fixtures")
