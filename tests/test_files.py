"""XER and Project XML import and export, round trips, and hostile files.

The two sample files in tests/files were written by hand for a five-activity tenant fit-out on a
5 day calendar (08:00 to 12:00 and 13:00 to 17:00) with Thursday 2026-11-26 as a holiday:
  A1000 start milestone            2026-11-23 08:00
  A1010 3 d after A1000            11-23 08:00 to 11-25 17:00
  A1020 5 d, SS + 1 d after A1010  starts 11-24 08:00; 24, 25, (26 off), 27, 30, 12-01 -> 12-01 17:00
  A1050 2 d after A1000            11-23 08:00 to 11-24 17:00; late 11-30 08:00 to 12-01 17:00, float 4 d = 32 h
  A1030 4 d after A1010, A1020, A1050   12-02 08:00 to 12-07 17:00
  A1040 finish milestone           12-07 17:00
Backward: A1010 is held by the SS link (late start 11-23 08:00), so every activity but A1050 has
zero float. The files store these dates, and the import must agree with every one of them.
"""

import json
import re
from pathlib import Path

import pytest

from fieldsched.cpm import schedule
from fieldsched.errors import SchedError
from fieldsched.examples import build_example, drilling_example
from fieldsched.files import compare_stored, detect, export_csv, open_and_schedule, open_file, parse_json, save_native
from fieldsched.mspdi import parse_duration, read_mspdi, write_mspdi
from fieldsched.pdf import render_pdf
from fieldsched.textio import decode_bytes, encode_cp1252, parse_xml
from fieldsched.xer import parse_clndr_data, parse_tables, read_xer, write_xer

FILES = Path(__file__).parent / "files"


def test_p6_sample_matches_hand_worked_dates():
    out = open_and_schedule((FILES / "sample_p6.xer").read_bytes())
    p, s = out["project"], out["sched"]
    assert out["kind"] == "xer" and out["report"]["encoding"] == "windows-1252"
    assert out["fidelity"]["checked"] == 36 and out["fidelity"]["agree"] == 36
    code = {a["code"]: a for a in p["activities"]}
    assert code["A1010"]["name"] == "Owner\u2019s caf\u00e9 layout design"
    assert code["A1000"]["type"] == "start_ms" and code["A1040"]["type"] == "finish_ms"
    assert s["acts"][code["A1050"]["id"]]["tf"] == 32 * 60
    assert [w["code"] for w in p["wbs"]] == ["DES", "CON"]
    assert p["calendars"][0]["exceptions"] == {"2026-11-26": []}
    assert p["calendars"][0]["week"][1] == [[480, 720], [780, 1020]]
    rep = out["report"]
    assert rep["unknown_tables"] == ["CURRTYPE", "UDFTYPE"]
    assert "1 relationship to activities in other projects was skipped." in rep["warnings"]
    assert any("more values than fields" in w for w in rep["warnings"])
    assert p["resources"][0]["max_units"] == 2000 and p["assigns"][0]["units"] == 2000 and p["assigns"][0]["budget"] == 64000
    assert p["baselines"][0]["name"] == "Planned dates in the file"


def test_mspdi_sample_matches_hand_worked_dates():
    out = open_and_schedule((FILES / "sample_msp.xml").read_bytes())
    p = out["project"]
    assert out["kind"] == "mspdi" and out["fidelity"]["agree"] == out["fidelity"]["checked"] == 36
    assert p["name"] == "Caf\u00e9 tenant improvement"
    assert [w["name"] for w in p["wbs"]] == ["Design and procurement", "Construction"]
    names = [a["name"] for a in p["activities"]]
    assert "Owner's caf\u00e9 layout design" in names and "Permit & inspections" in names
    shop = next(c for c in p["calendars"] if c["name"] == "Shop")
    # the derived calendar keeps the base work week and both styles of exception
    assert shop["week"][3] == [[480, 720], [780, 1020]]
    assert shop["exceptions"] == {"2026-11-26": [], "2026-12-24": [], "2026-12-25": []}
    ss = next(r for r in p["rels"] if r["type"] == "SS")
    assert ss["lag"] == 480
    assert len(p["assigns"]) == 1 and p["resources"][0]["max_units"] == 2000


def test_xer_record_structure_and_tolerance():
    text = ("ERMHDR\t8.0\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\n%R\t1\tP\t2026-01-05 08:00\n"
            "%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttask_name\ttarget_drtn_hr_cnt\n%R\t10\t1\tA\tFirst line\t8\n"
            "a continued note\n%R\t11\t1\tB\n%T\tWEIRD\n%F\tx\n%R\t1\t2\t3\n%E\nignored after end\n")
    t = parse_tables(text)
    assert t["tables"]["TASK"]["rows"][0]["target_drtn_hr_cnt"] == "8\na continued note"
    assert t["tables"]["TASK"]["rows"][1]["task_name"] == ""
    out = read_xer(text)
    assert [a["code"] for a in out["project"]["activities"]] == ["A", "B"]
    assert "WEIRD" in out["report"]["unknown_tables"]
    with pytest.raises(SchedError) as e:
        read_xer("hello\nworld\n")
    assert e.value.code == "not_xer"
    with pytest.raises(SchedError) as e:
        read_xer("ERMHDR\t8.0\n%T\tTASK\n%F\ttask_id\n%R\t1\n")
    assert e.value.code == "not_xer"


def test_xer_picks_the_exported_project_and_skips_bad_rows():
    text = ("ERMHDR\t8.0\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\texport_flag\n"
            "%R\t1\tOther\t2026-01-05 08:00\tN\n%R\t2\tMine\t2026-01-05 08:00\tY\n"
            "%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\ttarget_drtn_hr_cnt\tstatus_code\tcstr_type\tact_end_date\n"
            "%R\t10\t2\tA\tnot a number\tTK_Complete\tCS_MSO\t\n%R\t\t2\tB\t8\tTK_NotStart\t\t\n%R\t12\t1\tC\t8\t\t\t\n")
    out = read_xer(text)
    p = out["project"]
    assert p["name"] == "Mine" and [a["code"] for a in p["activities"]] == ["A"]
    ws = " ".join(out["report"]["warnings"])
    assert "is not a number" in ws and "without a usable task_id" in ws and "2 projects" in ws
    assert "marked started but has no actual start" in ws and "constraint without a date" in ws
    assert read_xer(text, "1")["project"]["name"] == "Other"
    with pytest.raises(SchedError):
        read_xer(text, "9")


def test_clndr_data_parsing():
    week, exc = parse_clndr_data("(0||CalendarData()((0||DaysOfWeek()((0||1()())(0||2()((0||0(s|00:00|f|00:00)())))))"
                                 "(0||Exceptions()((0||0(d|46352)())(0||1(d|46353)((0||0(s|09:00|f|13:00)()))))))")
    assert week[1] == [[0, 1440]] and week[0] == [] and week[6] == []
    assert exc == {"2026-11-26": [], "2026-11-27": [[540, 780]]}
    with pytest.raises(ValueError):
        parse_clndr_data("garbage")


def test_code_pages():
    assert decode_bytes(b"\xef\xbb\xbfcaf\xc3\xa9") == ("caf\u00e9", "utf-8")
    assert decode_bytes("caf\u00e9 \u2019".encode("cp1252")) == ("caf\u00e9 \u2019", "windows-1252")
    assert decode_bytes(b"\xff\xfeA\x00\xe9\x00") == ("A\u00e9", "utf-16le")
    assert decode_bytes(b"\xfe\xff\x00A\xd8\x3d\xde\x00") == ("A\U0001f600", "utf-16be")
    assert decode_bytes(b"\x81\x8d")[0] == "\x81\x8d"
    assert encode_cp1252("\u20ac caf\u00e9 \u4e2d") == b"\x80 caf\xe9 ?"


@pytest.mark.parametrize("make", [drilling_example, build_example])
def test_round_trip_xer(make):
    p = make()
    s = schedule(p)
    data = encode_cp1252(write_xer(p, s))
    out = open_and_schedule(data)
    q, s2 = out["project"], out["sched"]
    assert out["fidelity"]["agree"] == out["fidelity"]["checked"] > 100
    assert len(q["activities"]) == len(p["activities"]) and len(q["rels"]) == len(p["rels"])
    by_code = {a["code"]: a for a in q["activities"]}
    for a in p["activities"]:
        b = by_code[a["code"]]
        assert (b["od"], b["rd"], b["as"], b["af"], b["type"], b["cstr"], b["cstr_date"]) == \
               (a["od"], a["rd"], a["as"], a["af"], a["type"], a["cstr"], a["cstr_date"])
        assert s2["acts"][b["id"]]["es"] == s["acts"][a["id"]]["es"]
        assert s2["acts"][b["id"]]["lf"] == s["acts"][a["id"]]["lf"]
    assert [c["week"] for c in q["calendars"]] == [c["week"] for c in p["calendars"]]
    assert [c["exceptions"] for c in q["calendars"]] == [c["exceptions"] for c in p["calendars"]]
    assert sorted((r["max_units"], r["code"]) for r in q["resources"]) == sorted((r["max_units"], r["code"]) for r in p["resources"])
    assert sum(x["budget"] for x in q["assigns"]) == sum(x["budget"] for x in p["assigns"])
    assert q["settings"]["crit"] == p["settings"]["crit"] and q["settings"]["oos"] == p["settings"]["oos"]
    # writing the imported project again gives the same file
    assert encode_cp1252(write_xer(q, s2)) == data


def _tables(text):
    order, fields, rows = [], {}, {}
    for ln in text.split("\r\n"):
        if ln.startswith("%T\t"):
            order.append(ln[3:])
        elif ln.startswith("%F\t"):
            fields[order[-1]] = ln[3:].split("\t")
        elif ln.startswith("%R\t"):
            rows.setdefault(order[-1], []).append(dict(zip(fields[order[-1]], ln[3:].split("\t"))))
    return order, fields, rows


def test_xer_export_follows_the_p6_layout():
    p = drilling_example()
    text = write_xer(p, schedule(p))
    assert text.startswith("ERMHDR\t19.12\t") and text.endswith("%E\r\n") and "\n" not in text.replace("\r\n", "")
    order, fields, rows = _tables(text)
    # P6's order: what a record refers to is written before it; tables without rows are left out
    assert order == ["CURRTYPE", "PROJECT", "CALENDAR", "SCHEDOPTIONS", "PROJWBS", "RSRC", "RSRCRATE", "TASK", "TASKPRED", "TASKRSRC"]
    assert all(rows.get(t) for t in order)
    assert not any(f.startswith("sched_") for f in fields["PROJECT"])
    opt = rows["SCHEDOPTIONS"][0]
    assert (opt["sched_float_type"], opt["sched_calendar_on_relationship_lag"], opt["sched_retained_logic"], opt["sched_progress_override"]) == \
           ("FT_FF", "rcal_Predecessor", "Y", "N")
    proj = rows["PROJECT"][0]
    root = next(w for w in rows["PROJWBS"] if w["proj_node_flag"] == "Y")
    assert root["wbs_short_name"] == proj["proj_short_name"] and proj["critical_path_type"] == "CT_DrivPath"
    # resources point at a shared resource calendar, activities at project calendars
    cal = {c["clndr_id"]: c for c in rows["CALENDAR"]}
    assert {cal[r["clndr_id"]]["clndr_type"] for r in rows["RSRC"]} == {"CA_Rsrc"} and cal[rows["RSRC"][0]["clndr_id"]]["proj_id"] == ""
    assert {cal[t["clndr_id"]]["clndr_type"] for t in rows["TASK"]} == {"CA_Project"}
    # every row has a value (possibly empty) for every field and every reference resolves
    assert all(len(r) == len(fields[t]) for t in order for r in rows[t])
    tids = {t["task_id"] for t in rows["TASK"]}
    assert all(r["task_id"] in tids and r["pred_task_id"] in tids for r in rows["TASKPRED"])
    wids = {w["wbs_id"] for w in rows["PROJWBS"]}
    assert all(t["wbs_id"] in wids for t in rows["TASK"])
    # a project without resources writes no resource tables
    bare = {**p, "resources": [], "assigns": []}
    assert _tables(write_xer(bare, schedule(bare)))[0] == ["CURRTYPE", "PROJECT", "CALENDAR", "SCHEDOPTIONS", "PROJWBS", "TASK", "TASKPRED"]


@pytest.mark.parametrize("settings", [
    {"float": "start", "lag_cal": "succ", "oos": "override", "crit": "tf", "crit_tf": 480},
    {"float": "min", "lag_cal": "24h", "oos": "retained", "crit": "longest", "crit_tf": 0},
    {"float": "finish", "lag_cal": "project", "oos": "retained", "crit": "tf", "crit_tf": 90},
])
def test_xer_schedule_options_round_trip(settings):
    p = build_example()
    p = {**p, "settings": {**p["settings"], **settings}}
    q = read_xer(write_xer(p, schedule(p)))["project"]
    assert {k: q["settings"][k] for k in settings} == settings


def test_xer_schedule_options_codes_and_fallbacks():
    head = "ERMHDR\t8\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\n%R\t1\tP\t2026-01-05 08:00\n"
    opts = "%T\tSCHEDOPTIONS\n%F\tproj_id\tsched_float_type\tsched_calendar_on_relationship_lag\tsched_retained_logic\tsched_progress_override\n"
    s = read_xer(head + opts + "%R\t1\tFT_SS\trcal_24Hour\tN\tY\n")["project"]["settings"]
    assert (s["float"], s["lag_cal"], s["oos"]) == ("start", "24h", "override")
    out = read_xer(head + opts + "%R\t1\tFT_Min\trcal_ProjDefault\tN\tN\n")
    assert (out["project"]["settings"]["float"], out["project"]["settings"]["lag_cal"], out["project"]["settings"]["oos"]) == ("min", "project", "retained")
    assert any("actual dates" in w for w in out["report"]["warnings"])
    # options for another project in the same file are not used; unknown codes keep the defaults
    s = read_xer(head + opts + "%R\t2\tFT_SS\trcal_Successor\tN\tY\n%R\t1\tFT_Odd\trcal_Odd\tY\tN\n")["project"]["settings"]
    assert (s["float"], s["lag_cal"], s["oos"]) == ("finish", "pred", "retained")
    # a hand-made file with the options on PROJECT still reads
    s = read_xer("ERMHDR\t8\n%T\tPROJECT\n%F\tproj_id\tplan_start_date\tsched_progress_override\tsched_float_type\n"
                 "%R\t1\t2026-01-05 08:00\tY\tFT_SS\n")["project"]["settings"]
    assert (s["float"], s["oos"]) == ("start", "override")


def test_xer_odd_files():
    base = drilling_example()
    p = {**base, "activities": [{**a, "name": a["name"] + "\tcol中é"} if i == 3 else a for i, a in enumerate(base["activities"])]}
    text = write_xer(p, schedule(p))
    # a tab in a name never splits a row; LF-only and CRLF files read the same; extra tables are listed
    lines = text.split("\r\n")
    i = lines.index("%T\tTASK")
    width = len(lines[i + 1].split("\t"))
    body = lines[i + 2:lines.index("%T\tTASKPRED")]
    assert len(body) == len(p["activities"]) and all(len(ln.split("\t")) == width for ln in body)
    a = read_xer(text)["project"]
    b = read_xer(text.replace("\r\n", "\n"))["project"]
    assert a == b and a["activities"][3]["name"].endswith("col中é")
    lossy = read_xer(encode_cp1252(text))["project"]
    assert lossy["activities"][3]["name"].endswith("col?é")
    extra = text.replace("%T\tTASK\r\n", "%T\tACTVCODE\r\n%F\tactv_code_id\tshort_name\r\n%R\t1\tX\r\n%T\tTASK\r\n")
    assert read_xer(extra)["report"]["unknown_tables"] == ["ACTVCODE", "CURRTYPE"]
    # missing tables: no calendars, no WBS, no relationships still opens with a fallback calendar
    t2 = re.sub(r"%T\tCALENDAR.*?(?=%T)|%T\tPROJWBS.*?(?=%T)|%T\tTASKPRED.*?(?=%T)", "", text, flags=re.S)
    out = read_xer(t2)
    assert out["project"]["rels"] == [] and out["project"]["wbs"] == [] and len(out["project"]["activities"]) == len(p["activities"])
    assert any("No calendar" in w for w in out["report"]["warnings"])
    # a large file: 20,000 activities in a chain read and schedule
    big = ["ERMHDR\t8", "%T\tPROJECT", "%F\tproj_id\tproj_short_name\tplan_start_date", "%R\t1\tBIG\t2026-01-05 08:00",
           "%T\tTASK", "%F\ttask_id\tproj_id\ttask_code\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt"]
    big += [f"%R\t{i}\t1\tA{i}\t2\t2" for i in range(1, 20001)]
    big += ["%T\tTASKPRED", "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt"]
    big += [f"%R\t{i}\t{i + 1}\t{i}\tPR_FS\t0" for i in range(1, 20000)]
    q = read_xer("\r\n".join(big) + "\r\n%E\r\n")["project"]
    assert len(q["activities"]) == 20000 and len(q["rels"]) == 19999
    assert "2039" < schedule(q)["finish"] < "2047"


@pytest.mark.parametrize("make", [drilling_example, build_example])
def test_round_trip_mspdi(make):
    p = make()
    s = schedule(p)
    xml = write_mspdi(p, s)
    out = open_and_schedule(xml.encode("utf-8"))
    q, s2 = out["project"], out["sched"]
    assert out["fidelity"]["agree"] == out["fidelity"]["checked"] > 100
    by_code = {a["code"]: a for a in q["activities"]}
    for a in p["activities"]:
        b = by_code[a["code"]]
        assert (b["od"], b["rd"], b["as"], b["af"], b["name"]) == (a["od"], a["rd"], a["as"], a["af"], a["name"])
        # the other format has one kind of milestone and mandatory must-start/finish-on dates
        assert b["type"] == ("finish_ms" if a["type"] != "task" else "task")
        assert s2["acts"][b["id"]]["ef"] == s["acts"][a["id"]]["ef"]
    assert len(q["wbs"]) == len(p["wbs"])
    assert {(r["type"], r["lag"]) for r in q["rels"]} == {(r["type"], r["lag"]) for r in p["rels"]}
    assert q["baselines"][0]["acts"] == {by_code[k]["id"]: v for k, v in
                                         ((next(a["code"] for a in p["activities"] if a["id"] == i), v)
                                          for i, v in p["baselines"][0]["acts"].items())}


def test_native_round_trip_and_detection():
    p = build_example()
    text = save_native(p)
    assert open_file(text.encode())["project"] == p
    assert detect("\ufeff  ERMHDR\t...") == "xer" and detect("<?xml") == "mspdi" and detect(" {") == "native"
    with pytest.raises(SchedError):
        detect("PK\x03\x04")
    with pytest.raises(SchedError) as e:
        parse_json('{"a": NaN}')
    assert e.value.code == "bad_json"
    with pytest.raises(SchedError):
        parse_json("[" * 100000)
    obj = json.loads(text)
    obj["version"] = 9
    with pytest.raises(SchedError) as e:
        open_file(json.dumps(obj).encode())
    assert e.value.code == "newer_file"


def test_mspdi_details():
    assert parse_duration("PT8H30M0S") == 510 and parse_duration("P1DT2H") == 600 and parse_duration("PT0.5H") == 30
    assert parse_duration("nonsense") is None and parse_duration("-PT1H") == -60
    xml = """<Project xmlns="http://schemas.microsoft.com/project"><StartDate>2026-01-05T08:00:00</StartDate>
    <Tasks><Task><UID>1</UID><Name>A</Name><Duration>PT16H0M0S</Duration><DurationFormat>6</DurationFormat></Task>
    <Task><UID>2</UID><Name>B</Name><Duration>PT8H0M0S</Duration><Active>0</Active></Task>
    <Task><UID>3</UID><Name>C</Name><Duration>PT8H0M0S</Duration><ConstraintType>7</ConstraintType>
    <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>0</Type><LinkLag>14400</LinkLag><LagFormat>8</LagFormat></PredecessorLink>
    <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type></PredecessorLink>
    <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>2</Type><LinkLag>500</LinkLag><LagFormat>19</LagFormat></PredecessorLink>
    </Task></Tasks></Project>"""
    out = read_mspdi(xml)
    p = out["project"]
    assert [a["name"] for a in p["activities"]] == ["A", "C"]
    ff = next(r for r in p["rels"] if r["type"] == "FF")
    assert ff["lag"] == 1440 and ff["elapsed"] is True
    sf = next(r for r in p["rels"] if r["type"] == "SF")
    assert sf["lag"] == 480  # 50 percent of 16 h
    assert p["activities"][1]["cstr"] == "ASAP"  # FNLT without a date is dropped
    ws = " ".join(out["report"]["warnings"])
    assert "inactive" in ws and "elapsed duration" in ws and "percent lag" in ws
    with pytest.raises(SchedError) as e:
        read_mspdi("<Other/>")
    assert e.value.code == "not_mspdi"


# ------------------------------------------------------------------------------------ hostile files

BILLION_LAUGHS = """<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>
<Project><Name>&lol3;</Name></Project>"""
EXTERNAL = """<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]><Project><Name>&x;</Name></Project>"""


@pytest.mark.parametrize("xml,code", [
    (BILLION_LAUGHS, "xml_doctype"),
    (EXTERNAL, "xml_doctype"),
    ("<Project><Name>&lol;</Name></Project>", "xml_entity"),
    ("<Project><Name>a & b</Name></Project>", "xml_bad"),
    ("<Project><Name>x</Project>", "xml_bad"),
    ("<Project>" + "<a>" * 100 + "</a>" * 100 + "</Project>", "xml_deep"),
    ("<Project></Project><Project/>", "xml_bad"),
    ("text<Project/>", "xml_bad"),
    ("<Project><Name>&#0;</Name></Project>", "xml_bad"),
    ("<Project><![CDATA[x</Project>", "xml_bad"),
    ("<Project", "xml_bad"),
    ("", "xml_bad"),
])
def test_hostile_xml_is_refused(xml, code):
    with pytest.raises(SchedError) as e:
        parse_xml(xml)
    assert e.value.code == code


def test_xml_entities_and_cdata_are_read():
    r = parse_xml('<?xml version="1.0"?><!-- c --><p:Project xmlns:p="u" a=\'1 &amp; 2\'><Name><![CDATA[<b>]]> &#x41;&#66;&lt;</Name><E/></p:Project>')
    assert r["tag"] == "Project" and r["attrs"]["a"] == "1 & 2"
    assert r["kids"][0]["text"] == "<b> AB<" and r["kids"][1]["tag"] == "E"


def test_huge_files_are_refused(monkeypatch):
    big = b" " * (64 * 1024 * 1024 + 1)
    with pytest.raises(SchedError) as e:
        open_file(big)
    assert e.value.code == "too_big"
    import fieldsched.xer as xer
    monkeypatch.setattr(xer, "MAX_ROWS", 10)
    rows = "".join(f"%R\t{i}\t1\tA{i}\n" for i in range(20))
    with pytest.raises(SchedError) as e:
        read_xer("ERMHDR\t8\n%T\tTASK\n%F\ttask_id\tproj_id\ttask_code\n" + rows)
    assert e.value.code == "too_many"
    import fieldsched.textio as tio
    monkeypatch.setattr(tio, "MAX_NODES", 50)
    with pytest.raises(SchedError) as e:
        parse_xml("<Project>" + "<T/>" * 60 + "</Project>")
    assert e.value.code == "too_many"


def test_hostile_xer_values():
    text = ("ERMHDR\t8\n%T\tPROJECT\n%F\tproj_id\tproj_short_name\tplan_start_date\tlast_recalc_date\n%R\t1\t=cmd|' /C calc'!A0\t"
            "not a date\t2026-02-30 08:00\n%T\tCALENDAR\n%F\tclndr_id\tclndr_name\tclndr_data\tday_hr_cnt\n%R\t5\tBad\t((((((\t-4\n"
            "%T\tTASK\n%F\ttask_id\tproj_id\tclndr_id\ttask_code\ttask_name\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\n"
            "%R\t1\t1\t5\tA\t" + "x" * 5000 + "\t1e308\t-5\n"
            "%R\t2\t1\t77\tB\t\x00ctrl\x07\t8\t8\n"
            "%T\tTASKPRED\n%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt\n%R\t1\t2\t1\tPR_XX\tnan\n%R\t2\t1\t1\tPR_FS\t0\n"
            "%R\t3\t1\t2\tPR_FS\t0\n")
    out = read_xer(text)
    p = out["project"]
    a, b = p["activities"]
    assert len(a["name"]) == 300 and a["od"] == 0 and a["rd"] == 0 and b["name"] == "ctrl"
    assert p["start"] == "2026-01-01T08:00"
    ws = " ".join(out["report"]["warnings"])
    assert "could not be read" in ws and "out of range" in ws and "not in the file" in ws
    # a loop in the file imports, and scheduling names it
    with pytest.raises(SchedError) as e:
        schedule(p)
    assert e.value.code == "loop"
    csv = export_csv(p, {"acts": {x["id"]: {"es": None, "ef": None, "ls": None, "lf": None, "tf": None, "ff": None, "crit": False,
                                         "status": "planned", "pct": 0} for x in p["activities"]}})
    assert "'=cmd" not in csv  # the project name is not a CSV cell; activity cells are guarded below
    q = {**p, "activities": [{**p["activities"][0], "name": "=HYPERLINK(1)"}, p["activities"][1]]}
    assert "'=HYPERLINK(1)" in export_csv(q, {"acts": {x["id"]: {"es": None, "ef": None, "ls": None, "lf": None, "tf": None,
                                                                 "ff": None, "crit": False, "status": "planned", "pct": 0}
                                                       for x in p["activities"]}})


def test_csv_guards_formulas_but_keeps_numbers():
    from fieldsched.files import _cell
    assert [_cell(v) for v in ("-2.50", "+3", "12", "-0")] == ["-2.50", "+3", "12", "-0"]
    assert [_cell(v) for v in ("=1+2", "-1+2", "+cmd|' /C calc'!A0", "@SUM(A1)", "\tx", "-", "- 2", "-2,5")] == \
           ["'=1+2", "'-1+2", "'+cmd|' /C calc'!A0", "'@SUM(A1)", "'\tx", "'-", "'- 2", '"\'-2,5"']
    p = build_example()
    p = {**p, "finish_by": "2027-01-04T17:00"}  # earlier than the finish: negative float
    s = schedule(p)
    import csv
    import io
    rows = list(csv.reader(io.StringIO(export_csv(p, s))))
    tf = rows[0].index("Total Float")
    assert any(r[tf].startswith("-") and float(r[tf]) < 0 for r in rows[1:])


def test_csv_and_pdf_exports():
    p = build_example()
    s = schedule(p)
    from fieldsched.progress import variance
    csv = export_csv(p, s, variance(p, s))
    lines = csv.split("\r\n")
    assert lines[0].startswith("Activity ID,Activity Name,WBS") and len(lines) == len(p["activities"]) + 2
    assert any(",Yes," in ln for ln in lines)
    pdf = render_pdf(p, s, "tabloid", True, "Test")
    assert pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF") and b"/Count 1" in pdf
    # header finish, legend with driving links, title block, near critical hatch clipped to the bar
    for part in (b"(PROJECT FINISH)", b"(30-Mar-27 15:30)", b"(Driving link)", b"(Tabloid landscape, 1 of 1)", b"(TEST)", b"re W n"):
        assert part in pdf, part
    assert b"(Driving link)" not in render_pdf(p, s, "tabloid", True, "Test", {"links": False})
    # the xref offsets point at each object
    import re
    xref = int(re.search(rb"startxref\n(\d+)", pdf).group(1))
    offsets = [int(x) for x in re.findall(rb"(\d{10}) 00000 n", pdf[xref:])]
    for i, off in enumerate(offsets):
        assert pdf[off:off + 12].startswith(f"{i + 1} 0 obj".encode())
    d = drilling_example()
    big = {**d, "activities": d["activities"] * 1}
    pdf2 = render_pdf(big, schedule(big), "a4", False)
    pages = int(re.search(rb"/Count (\d+)", pdf2).group(1))
    assert pages == 2 and render_pdf(big, schedule(big), "a4", False) == pdf2 and b"(A4 landscape, 2 of 2)" in pdf2
    many = {**p, "wbs": [], "activities": [{**a, "wbs": None} for a in p["activities"]] * 1}
    assert b"/Count 1" in render_pdf(many, schedule(many), "tabloid")


def test_pdf_pages_keep_wbs_bands_with_their_activities():
    from fieldsched.pdf import gantt_rows, paginate
    rows = gantt_rows(drilling_example())
    old_style_orphans = 0
    for per in range(4, 40):
        old = [rows[i:i + per] for i in range(0, len(rows), per)]
        old_style_orphans += sum(1 for c in old[:-1] if c[-1][0] == "w")
        pages = paginate(rows, per)
        assert [r for c in pages for r in c] == rows and all(len(c) <= per for c in pages)
        assert all(c[-1][0] != "w" for c in pages[:-1]), per
    assert old_style_orphans > 0  # the drilling example does hit the case
    # nested bands move together; a page of bands only is kept rather than left empty
    nest = [("w", 1, 0), ("w", 2, 1), ("a", 3, 2), ("a", 4, 2), ("w", 5, 0), ("w", 6, 1), ("a", 7, 2)]
    assert [len(c) for c in paginate(nest, 6)] == [4, 3]
    assert [len(c) for c in paginate([("w", 1, 0), ("w", 2, 1), ("a", 3, 2)], 2)] == [2, 1]
    assert paginate([], 5) == [[]]


def test_compare_stored_reports_differences():
    p = build_example()
    s = schedule(p)
    a = p["activities"][-1]
    stored = {a["id"]: {"es": "2030-01-01T08:00", "tf": 99}}
    r = compare_stored(p, s, stored)
    assert r["checked"] == 2 and r["agree"] == 0 and {d["field"] for d in r["diffs"]} == {"es", "tf"}
