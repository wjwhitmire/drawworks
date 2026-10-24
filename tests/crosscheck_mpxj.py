"""Cross-check the CPM passes against MPXJ's PrimaveraScheduler, an independent open-source
implementation of P6's scheduling rules (not run by pytest; needs Java and the MPXJ jars).

  python tests/crosscheck_mpxj.py --cp "/path/to/mpxj/lib/*" --runs 80 --cal 5
  python tests/crosscheck_mpxj.py --cp "/path/to/mpxj/lib/*" --runs 80 --cal 5 --constraints

Each run builds a random network (4 to 14 activities, tasks and milestones, FS, SS, FF and SF links
with lags from -4h to +2d), schedules it here, writes it as XER, has MPXJ read the XER and schedule it
from scratch, and compares early and late dates and total float. Two instants with no working time
between them on the activity's calendar count as equal (P6 shows a finish at 17:00 that this tool may
show as the next 08:00). --cal picks the calendars: 5 (Monday to Friday with a lunch hour and two
holidays), 6 (Monday to Saturday, 10 hours), 7 (24 hours every day), 57 or 56 (two calendars mixed).
"""

import argparse
import os
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from fieldsched.cpm import schedule  # noqa: E402
from fieldsched.model import validate_project  # noqa: E402
from fieldsched.textio import encode_cp1252  # noqa: E402
from fieldsched.timecal import compile_calendar, parse_dt  # noqa: E402
from fieldsched.xer import write_xer  # noqa: E402

JAVA = """import org.mpxj.*; import org.mpxj.primavera.PrimaveraXERFileReader; import org.mpxj.cpm.PrimaveraScheduler;
public class Sched { public static void main(String[] a) throws Exception {
  for (String f : a) { PrimaveraXERFileReader r = new PrimaveraXERFileReader(); ProjectFile pf = r.read(f);
    new PrimaveraScheduler().schedule(pf, pf.getProjectProperties().getPlannedStart());
    System.out.println("FILE " + f);
    for (Task t : pf.getTasks()) if (t.getActivityID() != null) System.out.println("T " + t.getActivityID() + " " + t.getEarlyStart() + " "
      + t.getEarlyFinish() + " " + t.getLateStart() + " " + t.getLateFinish() + " " + t.getTotalSlack()); } } }
"""
LUNCH = [[480, 720], [780, 1020]]
CALS = {
    "5": {"id": "c5", "name": "Five day", "hpd": 480, "week": [[], LUNCH, LUNCH, LUNCH, LUNCH, LUNCH, []], "exceptions": {"2026-11-26": [], "2026-11-27": []}},
    "6": {"id": "c6", "name": "Six day", "hpd": 600, "week": [[]] + [[[420, 1020]]] * 6, "exceptions": {"2026-11-26": []}},
    "7": {"id": "c7", "name": "Seven day", "hpd": 1440, "week": [[[0, 1440]]] * 7, "exceptions": {}},
}


def network(seed, cals, constraints):
    rnd = random.Random(seed)
    n = rnd.randint(4, 14)
    acts, rels = [], []
    for i in range(n):
        k = rnd.random()
        typ = "task" if k < 0.8 else "start_ms" if k < 0.9 else "finish_ms"
        cal = rnd.choice(cals)
        od = 0 if typ != "task" else rnd.choice([60, 120, 240, 1, 2, 3, 5, 7])
        od = od * cal["hpd"] if od < 10 else od
        a = {"id": f"a{i}", "code": f"A{1000 + 10 * i}", "name": f"Activity {i}", "type": typ, "od": od, "rd": od, "cal": cal["id"]}
        if constraints and rnd.random() < 0.25:
            ct = rnd.choice(["SNET", "FNET", "SNLT", "FNLT", "MSO", "MFO"])
            day = rnd.choice([3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 23, 24, 25, 30])
            a.update(cstr=ct, cstr_date=f"2026-11-{day:02d}T" + ("08:00" if ct in ("SNET", "SNLT", "MSO") else "17:00"))
        acts.append(a)
    for j in range(1, n):
        for _ in range(rnd.randint(1, 2)):
            i = rnd.randrange(j)
            if not any(r["pred"] == f"a{i}" and r["succ"] == f"a{j}" for r in rels):
                rels.append({"id": f"r{len(rels)}", "pred": f"a{i}", "succ": f"a{j}", "type": rnd.choice(["FS", "FS", "SS", "FF", "SF"]),
                             "lag": rnd.choice([0, 0, 0, 60, 240, 480, -120, -240, 960])})
    return validate_project({"name": f"check {seed}", "start": "2026-11-02T08:00", "cal": cals[0]["id"], "calendars": cals,
                             "activities": acts, "rels": rels})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cp", required=True, help="class path holding the MPXJ jars")
    ap.add_argument("--runs", type=int, default=50)
    ap.add_argument("--cal", default="5", choices=["5", "6", "7", "57", "56"])
    ap.add_argument("--constraints", action="store_true")
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp())
    (tmp / "Sched.java").write_text(JAVA)
    subprocess.run(["javac", "-cp", a.cp, str(tmp / "Sched.java")], check=True)
    cals = [CALS[c] for c in a.cal]
    nets = {}
    for seed in range(a.runs):
        p = network(seed, cals, a.constraints)
        s = schedule(p)
        f = tmp / f"n{seed}.xer"
        f.write_bytes(encode_cp1252(write_xer(p, s)))
        nets[str(f)] = (p, s)
    out = subprocess.run(["java", "-cp", a.cp + os.pathsep + str(tmp), "Sched", *nets], capture_output=True, text=True, check=True).stdout
    total = differ = 0
    cur = None
    for line in out.splitlines():
        if line.startswith("FILE "):
            cur = nets[line[5:]]
            continue
        if not line.startswith("T "):
            continue
        parts = line.split()
        p, s = cur
        act = next((x for x in p["activities"] if x["code"] == parts[1]), None)
        if act is None or len(parts) != 7:  # WBS summaries
            continue
        code, es, ef, ls, lf, tf = parts[1:7]
        r = s["acts"][act["id"]]
        cal = compile_calendar(next(c for c in p["calendars"] if c["id"] == act["cal"]))
        for ours, theirs in ((r["es"], es), (r["ef"], ef), (r["ls"], ls), (r["lf"], lf)):
            total += 1
            x, y = parse_dt(ours), parse_dt(theirs[:16])
            if cal.work_between(min(x, y), max(x, y)):
                differ += 1
                print(f"{p['name']} {code}: here {ours}, MPXJ {theirs}")
        total += 1
        hours = float(re.sub(r"[^0-9.-]", "", tf))
        if abs(r["tf"] / 60 - hours * (cal.hpd / 60 if tf.endswith("d") else 1)) > 0.01:
            differ += 1
            print(f"{p['name']} {code}: float here {r['tf'] / 60}h, MPXJ {tf}")
    print(f"{total} values compared, {differ} differ")


if __name__ == "__main__":
    main()
