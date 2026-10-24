"""Command line: schedule a file, check it, convert between formats, print a Gantt PDF.

  fieldsched schedule FILE            print activity dates, float and the critical path
  fieldsched check FILE               schedule quality findings and metrics
  fieldsched convert FILE --to FMT    FMT: json, xer, mspdi, csv, pdf (with --out PATH)
  fieldsched example NAME --out PATH  write an example project (drill or build) as JSON
  fieldsched fidelity FILE            compare dates stored in an XER or XML file with ours

FILE is an XER file, a Project XML (MSPDI) file or a JSON schedule saved by this tool. The
command reads only the file named and writes only to standard output or --out.
"""

from __future__ import annotations

import argparse
import sys

from .brand import PRODUCT_NAME
from .checks import check
from .cpm import schedule
from .errors import SchedError
from .examples import EXAMPLES
from .files import compare_stored, export_csv, open_file, save_native
from .mspdi import write_mspdi
from .pdf import render_pdf
from .progress import variance
from .textio import MAX_BYTES, encode_cp1252
from .timecal import fmt_fixed
from .xer import write_xer


def _read(path):
    with open(path, "rb") as f:
        data = f.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise SchedError("too_big", "The file is larger than 64 MB.")
    return data


def _write(out, data):
    if out:
        with open(out, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    elif isinstance(data, str):
        sys.stdout.write(data)
    else:  # PDF and Windows-1252 XER bytes go out unchanged
        sys.stdout.flush()
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="fieldsched", description=f"{PRODUCT_NAME}: CPM scheduling from the command line.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("schedule", "check", "fidelity"):
        sp = sub.add_parser(name)
        sp.add_argument("file")
    sp = sub.add_parser("convert")
    sp.add_argument("file")
    sp.add_argument("--to", required=True, choices=["json", "xer", "mspdi", "csv", "pdf"])
    sp.add_argument("--out")
    sp.add_argument("--page", default="letter", choices=["letter", "a4", "tabloid", "a3"])
    sp = sub.add_parser("example")
    sp.add_argument("name", choices=sorted(EXAMPLES))
    sp.add_argument("--out")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "example":
            _write(args.out, save_native(EXAMPLES[args.name]()))
            return 0
        opened = open_file(_read(args.file))
        p = opened["project"]
        s = schedule(p)
        for w in opened["report"]["warnings"]:
            print("note: " + w, file=sys.stderr)
        if args.cmd == "schedule":
            hpd = {c["id"]: c["hpd"] for c in p["calendars"]}
            print(f"{p['name']}  data date {p['data_date']}  finish {s['finish']}")
            print("ID          Early start       Early finish      Late finish       TF(d)   Crit")
            for a in p["activities"]:
                r = s["acts"][a["id"]]
                tf = fmt_fixed(r["tf"], hpd[a["cal"] or p["cal"]], 2) if r["tf"] is not None else "done"
                print(f"{a['code'][:10]:10}  {r['es']:16}  {r['ef']:16}  {(r['lf'] or ''):16}  {tf:>6}  {'yes' if r['crit'] else ''}")
        elif args.cmd == "check":
            res = check(p, s)
            for f in res["findings"]:
                print(f"{f['sev']:5}  {f['code']:16}  {f['msg']}")
            for mt in res["metrics"]:
                state = {True: "pass", False: "FAIL", None: "info" if mt["of"] else "n/a"}[mt["pass"]]
                tag = f"DCMA {mt['dcma']:02d}" if mt["dcma"] else "extra  "
                if mt["permille"] is None:
                    value = "needs a baseline or progress" if not mt["of"] else f"{mt['count']} of {mt['of']}"
                elif mt["kind"] == "index":
                    value = f"{fmt_fixed(mt['permille'], 1000, 2)} (at least 0.95)"
                else:
                    limit = "reported only" if mt["limit"] is None else f"limit {fmt_fixed(mt['limit'], 10, 1)}%"
                    value = f"{mt['count']} of {mt['of']} = {fmt_fixed(mt['permille'], 10, 1)}% ({limit})"
                print(f"{state:4}  {tag}  {mt['name']}: {value}")
        elif args.cmd == "fidelity":
            fid = compare_stored(p, s, opened["stored"], opened["kind"])
            print(f"{fid['agree']} of {fid['checked']} stored dates and floats agree")
            for d in fid["diffs"][:50]:
                print(f"  {d['code']} {d['field']}: file {d['file']}, ours {d['ours']}")
        else:
            if args.to == "json":
                data = save_native(p)
            elif args.to == "xer":
                text = write_xer(p, s)
                data = encode_cp1252(text)
                lost = data.count(b"?") - text.count("?")
                if lost:
                    print(f"warning: {lost} characters outside the Windows-1252 code page were written as '?'", file=sys.stderr)
            elif args.to == "mspdi":
                data = write_mspdi(p, s)
            elif args.to == "csv":
                data = export_csv(p, s, variance(p, s))
            else:
                data = render_pdf(p, s, args.page, True, PRODUCT_NAME)
            _write(args.out, data)
        return 0
    except SchedError as e:
        print(f"error: {e.message}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"error: {e.strerror}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
