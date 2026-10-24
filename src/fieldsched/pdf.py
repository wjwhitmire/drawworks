"""A print-ready Gantt chart as a vector PDF, written by hand (no PDF library).

The page is laid out like a drawing sheet: the project name and its finish at the top, then the
activity table (ID, name, original duration, start, finish, total float) and the chart sharing one
row grid inside a ruled frame, then a legend and a title block across the bottom. WBS elements print
as tinted band rows with a summary bracket. The two-tier timescale carries flags for the data date
and the finish. Every bar state has its own pen pattern so a gray print still reads: critical is
solid, near critical is hatched inside an outline, other activities are open bars, completed work is
solid ink, and in-progress bars are ink up to the data date, a gap, then the remaining state. The
active baseline is a thin gray bar under each activity, total float a line closed by a tick, and
driving relationships on the critical path are drawn as heavy lines. Text uses the PDF base fonts
Helvetica and Helvetica-Bold in the Windows-1252 character set; other characters print as "?". The
output is byte-for-byte deterministic (no creation date), so the browser and the library produce the
same file.
"""

from __future__ import annotations

import math

from .cpm import tree_rows, wbs_rollup
from .textio import encode_cp1252
from .timecal import DAY, civil_from_days, fmt_fixed, parse_dt, weekday

PAGES = {"letter": (792, 612), "a4": (842, 595), "tabloid": (1224, 792), "a3": (1191, 842)}
PAGE_NAMES = {"letter": "Letter landscape", "a4": "A4 landscape", "tabloid": "Tabloid landscape", "a3": "A3 landscape"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
INK = "0.059 0.098 0.118"
MUTED = "0.29 0.341 0.369"
HAIR = "0.839 0.867 0.878"
HEADBG = "0.945 0.957 0.961"
GRID = "0.886 0.906 0.918"
BANDS = ["0.867 0.894 0.91", "0.914 0.933 0.941", "0.949 0.961 0.965"]
CRIT = "0.71 0.09 0.059"
NEAR = "0.639 0.459 0"
NEAR_TINT = "0.984 0.941 0.851"
NORM = "0.165 0.467 0.541"
NORM_TINT = "0.812 0.898 0.918"
DONE = "0.106 0.145 0.169"
BASE = "0.486 0.529 0.553"
FLOAT = "0.239 0.29 0.318"
DD = "0.137 0.263 0.722"
MARK = "0.561 0.055 0.384"
MARK_TINT = "0.973 0.902 0.945"
WHITE = "1 1 1"


def num(x):
    v = math.floor(x * 100 + 0.5)
    sign = "-" if v < 0 else ""
    v = abs(v)
    s = f"{sign}{v // 100}"
    if v % 100:
        s += ("." + f"{v % 100:02d}").rstrip("0")
    return s


def text_width(s, size):
    w = 0.0
    for ch in s:
        if ch in "il.,:;'|!Ijft r()[]":
            w += 0.28
        elif ch in "mwMW@":
            w += 0.83
        elif "A" <= ch <= "Z":
            w += 0.67
        else:
            w += 0.53
    return w * size


def fit(s, size, width):
    if text_width(s, size) <= width:
        return s
    while s and text_width(s + "...", size) > width:
        s = s[:-1]
    return s + "..."


def pdf_str(s):
    b = encode_cp1252(s)
    out = []
    for c in b:
        ch = chr(c)
        if ch in "\\()":
            out.append("\\" + ch)
        elif c < 32:
            out.append(" ")
        else:
            out.append(ch)
    return "(" + "".join(out) + ")"


def _d(t, time=False):
    if not t:
        return ""
    s = f"{t[8:10]}-{MONTHS[int(t[5:7]) - 1]}-{t[2:4]}"
    return s + " " + t[11:16] if time else s


def _trim(s):
    return s.rstrip("0").rstrip(".") if "." in s else s


def gantt_rows(p):
    """Display rows (kind, record, depth), leaving out WBS elements with no activities under them."""
    parent = {w["id"]: w["parent"] for w in p["wbs"]}
    live = set()
    for a in p["activities"]:
        w = a["wbs"]
        while w and w not in live:
            live.add(w)
            w = parent.get(w)
    return [(k, x, level - 1) for k, x, level, _n in tree_rows(p) if k == "a" or x["id"] in live]


def paginate(rows, per_page):
    """Rows split into pages. A WBS band never ends a page: trailing bands move to the next page so
    they print above their own activities (unless a page would be left with nothing on it)."""
    chunks, i, n = [], 0, len(rows)
    while i < n:
        j = min(i + per_page, n)
        if j < n:
            k = j
            while k > i and rows[k - 1][0] == "w":
                k -= 1
            if k > i:
                j = k
        chunks.append(rows[i:j])
        i = j
    return chunks or [[]]


def _state(rec):
    if rec["status"] == "complete":
        return "done"
    if rec["crit"]:
        return "crit"
    if rec["near"]:
        return "near"
    return "norm"


def _tiers(ppd_px):
    """Timescale tiers for a scale in screen pixels per day: (top kind, bottom kind)."""
    if ppd_px < 3:
        return "year", "quarter"
    if ppd_px < 10:
        return "year", "month"
    if ppd_px < 30:
        return "month", "week"
    if ppd_px < 100:
        return "week", "day"
    return "day", "hour"


def _key(kind, d):
    y, m, _dd = civil_from_days(d)
    if kind == "year":
        return y
    if kind == "quarter":
        return y * 4 + (m - 1) // 3
    if kind == "month":
        return y * 12 + m
    if kind == "week":
        return (d + 3) // 7
    return d


def _label(kind, d, small):
    y, m, dd = civil_from_days(d)
    if kind == "year":
        return str(y)
    if kind == "quarter":
        return "Q" + str((m - 1) // 3 + 1)
    if kind == "month":
        return MONTHS[m - 1] + " " + str(y)
    if kind == "week":
        return f"{dd:02d}" if small else f"Week of {dd:02d} {MONTHS[m - 1]}"
    return f"{dd:02d}" if small else f"{DAYS[weekday(d)]} {dd:02d} {MONTHS[m - 1]}"


def render_pdf(p, sched, page="letter", baseline=True, product="", opts=None):
    o_ = opts or {}
    links = o_.get("links", True)
    layout = o_.get("layout") or "Classic schedule"
    filt = o_.get("filter") or "All activities"
    W, Hh = PAGES.get(page, PAGES["letter"])
    page_name = PAGE_NAMES.get(page, PAGE_NAMES["letter"])
    big = W >= 1000
    k = 1.0 if big else 0.8
    M = 30.0 * k
    rowh = 14.0 if big else 11.0
    fs = 7.5 if big else 6.0
    tier = 16.0 * k
    lane = 14.0 * k
    head = 2 * tier + lane
    top = M + 48.0 * k
    fh = 56.0 * k
    timed = p["settings"]["unit"] == "h"
    dw = 74.0 if timed else 52.0
    cols = [("ID", 46.0, "code"), ("Activity Name", 170.0, "name"), ("Dur", 32.0, "od"), ("Start", dw, "start"), ("Finish", dw, "finish"), ("TF", 30.0, "tf")]
    cols = [(n, w * k, c) for n, w, c in cols]
    table_w = sum(w for _n, w, _c in cols)
    gx = M + table_w
    gw = W - M - gx
    roll = wbs_rollup(p, sched)
    bl = next((b for b in p["baselines"] if b["id"] == p["baseline"]), None) if baseline else None
    rows = gantt_rows(p)
    times = []
    for a in p["activities"]:
        r = sched["acts"][a["id"]]
        times += [parse_dt(r["es"]), parse_dt(r["ef"])]
        if a["as"]:
            times.append(parse_dt(a["as"]))
        if r["lf"]:
            times.append(parse_dt(r["lf"]))
        if bl and a["id"] in bl["acts"]:
            times += [parse_dt(bl["acts"][a["id"]][0]), parse_dt(bl["acts"][a["id"]][1])]
    dd = parse_dt(p["data_date"])
    fin = parse_dt(sched["finish"])
    times += [dd, fin]
    t0 = (min(times) // DAY - 1) * DAY
    t1 = (max(times) // DAY + 2) * DAY
    span = t1 - t0
    ppd = gw * DAY / span

    def X(t):
        return gx + (t - t0) * gw / span

    tk, bk = _tiers(ppd * 4 / 3)
    ly = Hh - M - fh
    body_top = top + head
    per_page = max(1, int((ly - 10 * k - body_top) // rowh))
    chunks = paginate(rows, per_page)
    hpd = {c["id"]: c["hpd"] for c in p["calendars"]}
    bh = rowh * 0.42
    blh = 1.6 * k
    acts = {a["id"]: a for a in p["activities"]}
    streams = []
    for pi, chunk in enumerate(chunks):
        o = []

        def text(x, y, s, size=fs, bold=False, color=INK, right=False):
            if right:
                x = x - text_width(s, size)
            o.append(f"BT /{'F2' if bold else 'F1'} {num(size)} Tf {color} rg {num(x)} {num(Hh - y)} Td {pdf_str(s)} Tj ET")

        def rect(x, y, w, h, fill=None, stroke=None, width=0.6):
            ops = f"{num(x)} {num(Hh - y - h)} {num(w)} {num(h)} re"
            if fill and stroke:
                o.append(f"{fill} rg {stroke} RG {num(width)} w {ops} B")
            elif fill:
                o.append(f"{fill} rg {ops} f")
            else:
                o.append(f"{stroke} RG {num(width)} w {ops} S")

        def line(x1, y1, x2, y2, color, width=0.5, dash=None):
            o.append(f"{color} RG {num(width)} w {'[' + dash + '] 0 d ' if dash else ''}{num(x1)} {num(Hh - y1)} m {num(x2)} {num(Hh - y2)} l S{' [] 0 d' if dash else ''}")

        def poly(pts, fill=None, stroke=None, width=0.6):
            path = " ".join(f"{num(x)} {num(Hh - y)} {'m' if i == 0 else 'l'}" for i, (x, y) in enumerate(pts)) + " h"
            if fill and stroke:
                o.append(f"{fill} rg {stroke} RG {num(width)} w {path} B")
            elif fill:
                o.append(f"{fill} rg {path} f")
            else:
                o.append(f"{stroke} RG {num(width)} w {path} S")

        def hatch(x, y, w, h):
            # near critical: tint, 45 degree hatch clipped to the bar, amber outline
            rect(x, y, w, h, NEAR_TINT)
            yb = Hh - y - h
            seg = [f"q {num(x)} {num(yb)} {num(w)} {num(h)} re W n {NEAR} RG {num(0.9 * k)} w"]
            t = -h
            while t < w:
                seg.append(f"{num(x + t)} {num(yb)} m {num(x + t + h)} {num(yb + h)} l")
                t += 3.0 * k
            seg.append("S Q")
            o.append(" ".join(seg))
            rect(x, y, w, h, None, NEAR, 0.8 * k)

        def diamond(cx, cy, s, st):
            pts = [(cx, cy - s), (cx + s, cy), (cx, cy + s), (cx - s, cy)]
            if st == "crit":
                poly(pts, CRIT)
            elif st == "done":
                poly(pts, DONE)
            elif st == "near":
                poly(pts, NEAR_TINT, NEAR, 0.9 * k)
            else:
                poly(pts, WHITE, NORM, 0.9 * k)

        def bar(x, y, w, h, st):
            w = max(0.8, w)
            if st == "crit":
                rect(x, y, w, h, CRIT)
            elif st == "done":
                rect(x, y, w, h, DONE)
            elif st == "near":
                hatch(x, y, w, h)
            else:
                rect(x, y, w, h, NORM_TINT, NORM, 0.8 * k)

        # ---- header: name, layout line, and the key answer (project finish) at the right
        fin_txt = _d(sched["finish"], True)
        fin_w = text_width(fin_txt, 17.0 * k) + 4
        text(M, M + 19.0 * k, fit(p["name"], 19.0 * k, W - 2 * M - fin_w - 24), 19.0 * k, True)
        sub = f"{layout} layout. {filt}."
        if p["label"]:
            sub += " " + p["label"]
        text(M, M + 36.0 * k, fit(sub, 8.5 * k, W - 2 * M - fin_w - 24), 8.5 * k, False, MUTED)
        text(W - M, M + 12.0 * k, "PROJECT FINISH", 7.0 * k, True, MARK, True)
        text(W - M, M + 34.0 * k, fin_txt, 17.0 * k, True, MARK, True)
        # ---- header row: table labels beside the two-tier timescale and the flag lane
        rect(M, top, W - 2 * M, head, HEADBG)
        x = M
        for name, w, c in cols:
            if c in ("od", "tf"):
                text(x + w - 4, top + head - 6 * k, name, fs, True, MUTED, True)
            else:
                text(x + 3, top + head - 6 * k, name, fs, True, MUTED)
            x += w
        y_body = body_top
        yb = y_body + len(chunk) * rowh
        for ti, kind in enumerate((tk, bk)):
            ty = top + ti * tier
            if kind == "hour":
                d = t0 // DAY
                while d * DAY < t1:
                    for hh in (0, 6, 12, 18):
                        xh = X(d * DAY + hh * 60)
                        line(xh, ty, xh, ty + tier, HAIR, 0.5)
                        if ppd / 4 >= text_width("00", fs) + 4:
                            text(xh + 2, ty + 11 * k, f"{hh:02d}", fs * 0.9, True, MUTED)
                    d += 1
                continue
            marks = []
            prev = None
            d = t0 // DAY
            while d * DAY < t1:
                kk = _key(kind, d)
                if kk != prev:
                    marks.append(d)
                    prev = kk
                d += 1
            small = ti == 1
            for i, d in enumerate(marks):
                xm = X(d * DAY)
                nxt = X(marks[i + 1] * DAY) if i + 1 < len(marks) else W - M
                line(xm, ty, xm, ty + tier, HAIR, 0.5)
                lab = _label(kind, d, small)
                if text_width(lab, fs * 0.9) + 4 <= nxt - xm:
                    text(xm + 2, ty + 11 * k, lab, fs * 0.9, True, MUTED)
                if ti == 0 and xm > gx + 0.5:
                    line(xm, y_body, xm, yb, GRID, 0.5)
        line(gx, top + tier, W - M, top + tier, HAIR, 0.5)
        line(gx, top + 2 * tier, W - M, top + 2 * tier, HAIR, 0.5)

        def flag_box(t, label, size):
            xx = X(t)
            w = text_width(label, size) + 14 * k
            return [xx, w, xx if xx + w <= W - M else xx - w]

        fsz = 6.0 * k
        dd_lab = "DATA DATE " + _d(p["data_date"], timed)
        fin_lab = "FINISH " + _d(sched["finish"], timed)
        fd = flag_box(dd, dd_lab, fsz)
        ff = flag_box(fin, fin_lab, fsz)
        if fd[2] < ff[2] + ff[1] and ff[2] < fd[2] + fd[1]:
            fd[2] = max(gx, min(fd[0] - fd[1], ff[2] - fd[1] - 2))
        fy = top + 2 * tier + 1.5 * k
        fhh = lane - 3 * k
        rect(fd[2], fy, fd[1], fhh, DD)
        text(fd[2] + 10 * k, fy + fhh - 3 * k, dd_lab, fsz, True, WHITE)
        line(fd[2] + 5 * k, fy + 2 * k, fd[2] + 5 * k, fy + fhh - 2 * k, WHITE, 0.9 * k, "1.5 1")
        rect(ff[2], fy, ff[1], fhh, MARK_TINT, MARK, 0.7 * k)
        text(ff[2] + 10 * k, fy + fhh - 3 * k, fin_lab, fsz, True, MARK)
        cy0 = fy + fhh / 2
        poly([(ff[2] + 5 * k, cy0 - 3 * k), (ff[2] + 8 * k, cy0), (ff[2] + 5 * k, cy0 + 3 * k), (ff[2] + 2 * k, cy0)], MARK)
        # ---- rows: bands and text, then links, then bars
        pos = {}
        bars = []
        for i, (kind, item, depth) in enumerate(chunk):
            ry = y_body + i * rowh
            cy = ry + rowh / 2
            if kind == "w":
                rect(M, ry, W - 2 * M, rowh, BANDS[min(2, depth)])
                text(M + 3 + depth * 6 * k, ry + rowh - 4 * k, fit(f"{item['code']}  {item['name']}", fs, table_w - 8 - depth * 6 * k), fs, True)
                r = roll.get(item["id"])
                if r and r.get("es"):
                    x1 = X(parse_dt(r["es"]))
                    x2 = max(X(parse_dt(r["ef"])), x1 + 6)
                    bars.append(("sum", x1, x2, cy))
                continue
            a = item
            rec = sched["acts"][a["id"]]
            div = 60 if a["unit"] == "h" else hpd[a["cal"] or p["cal"]]
            unit = "h" if a["unit"] == "h" else "d"
            line(M, ry + rowh, gx, ry + rowh, HAIR, 0.4)
            st = _state(rec)
            vals = {"code": a["code"], "name": a["name"], "od": _trim(fmt_fixed(a["od"] if a["type"] == "task" else 0, div, 1)) + unit,
                    "start": _d(a["as"] or rec["es"], timed) + (" A" if a["as"] else ""), "finish": _d(a["af"] or rec["ef"], timed) + (" A" if a["af"] else ""),
                    "tf": _trim(fmt_fixed(rec["tf"], div, 1)) + unit if rec["tf"] is not None else ""}
            x = M
            for _n, w, c in cols:
                ind = depth * 6 * k if c == "name" else 0
                s = fit(vals[c], fs, w - 6 - ind)
                red = c == "code" and st == "crit"
                neg = c == "tf" and rec["tf"] is not None and rec["tf"] < 0
                if c in ("od", "tf"):
                    text(x + w - 4, ry + rowh - 4 * k, s, fs, neg, CRIT if neg else INK, True)
                else:
                    text(x + 3 + ind, ry + rowh - 4 * k, s, fs, red, CRIT if red else INK)
                x += w
            has_bl = bool(bl and a["id"] in bl["acts"] and a["type"] == "task")
            by = ry + (rowh - bh) / 2 - (blh / 2 + 0.5 if has_bl else 0)
            bcy = by + bh / 2
            es, ef = parse_dt(rec["es"]), parse_dt(rec["ef"])
            if a["type"] != "task" or (a["od"] == 0 and rec["status"] != "active"):
                s_ = bh / 2 + 1.2 * k
                bars.append(("ms", X(es), s_, bcy, st))
                pos[a["id"]] = (bcy, X(es) - s_, X(es) + s_)
            else:
                x0 = X(es)
                if has_bl:
                    b = bl["acts"][a["id"]]
                    bx1, bx2 = X(parse_dt(b[0])), X(parse_dt(b[1]))
                    bars.append(("bl", bx1, max(0.8, bx2 - bx1), by + bh + 1 * k))
                if rec["status"] == "active":
                    xa = X(parse_dt(a["as"]))
                    xd = min(X(dd), X(ef))
                    bars.append(("act", xa, max(0.8, xd - xa - 0.75), by))
                    xr = X(parse_dt(rec["res"]))
                    bars.append(("bar", xr, X(ef) - xr, by, st))
                    x0 = xa
                else:
                    bars.append(("bar", X(es), X(ef) - X(es), by, st))
                if rec["lf"] and rec["tf"] and rec["tf"] > 0 and rec["status"] != "complete":
                    xl = X(parse_dt(rec["lf"]))
                    if xl > X(ef) + 0.5:
                        bars.append(("float", X(ef), xl, bcy))
                pos[a["id"]] = (bcy, x0, X(ef))
        # driving relationships on the critical path
        if links:
            for r in p["rels"]:
                if r["pred"] not in pos or r["succ"] not in pos:
                    continue
                rr = sched["rels"].get(r["id"])
                if not (rr and rr["driving"] and sched["acts"][r["succ"]]["crit"]):
                    continue
                py, ps, pf = pos[r["pred"]]
                qy, qs, qf = pos[r["succ"]]
                t = r["type"]
                xa = pf if t in ("FS", "FF") else ps
                to_fin = t in ("FF", "SF")
                xb = qf if to_fin else qs
                dr = -1 if to_fin else 1
                if not to_fin and xb - 4 * k >= xa + 2 * k:
                    pts = [(xa, py), (xa + 2 * k, py), (xa + 2 * k, qy), (xb - dr * 1.5 * k, qy)]
                else:
                    mid = qy - rowh / 2 if qy > py else qy + rowh / 2
                    out = xa + 3 * k if t in ("FS", "FF") else xa - 3 * k
                    into = xb + 4 * k if to_fin else xb - 4 * k
                    pts = [(xa, py), (out, py), (out, mid), (into, mid), (into, qy), (xb - dr * 1.5 * k, qy)]
                o.append(f"{CRIT} RG {num(0.9 * k)} w " + " ".join(f"{num(x)} {num(Hh - y)} {'m' if i == 0 else 'l'}" for i, (x, y) in enumerate(pts)) + " S")
                poly([(xb, qy), (xb - dr * 3 * k, qy - 1.8 * k), (xb - dr * 3 * k, qy + 1.8 * k)], CRIT)
        for bb in bars:
            kind = bb[0]
            if kind == "sum":
                _k, x1, x2, cy = bb
                poly([(x1, cy - 2 * k), (x2, cy - 2 * k), (x2, cy + 3.5 * k), (x2 - 3 * k, cy + 0.5 * k), (x1 + 3 * k, cy + 0.5 * k), (x1, cy + 3.5 * k)], INK)
            elif kind == "bl":
                rect(bb[1], bb[3], bb[2], blh, BASE)
            elif kind == "act":
                rect(bb[1], bb[3], bb[2], bh, DONE)
            elif kind == "bar":
                bar(bb[1], bb[3], bb[2], bh, bb[4])
            elif kind == "ms":
                diamond(bb[1], bb[3], bb[2], bb[4])
            elif kind == "float":
                _k, x1, x2, cy = bb
                line(x1, cy, x2, cy, FLOAT, 0.7 * k)
                line(x2, cy - bh / 2 + 0.5, x2, cy + bh / 2 - 0.5, FLOAT, 0.7 * k)
        # data date and finish lines, then the frame
        xdd = X(dd)
        line(xdd, top + 2 * tier, xdd, yb, DD, 1.0 * k, "3 2")
        xf = X(fin)
        line(xf, top + 2 * tier + lane, xf, yb, MARK, 1.0 * k)
        rect(M, top, W - 2 * M, yb - top, None, INK, 0.75)
        line(gx, top, gx, yb, INK, 0.75)
        line(M, body_top, W - M, body_top, INK, 0.5)
        # ---- legend and title block, the way a drawing sheet carries one
        rect(M, ly, W - 2 * M, fh, None, INK, 0.75)
        leg = [("crit", "Critical"), ("near", "Near critical"), ("norm", "Not critical"), ("done", "Actual work"),
               ("base", "Baseline"), ("float", "Total float"), ("ms", "Milestone"), ("sum", "WBS summary")]
        if links:
            leg.append(("link", "Driving link"))
        cws = [150.0 * k, 135.0 * k, 135.0 * k]
        tbx = W - M - (cws[0] + cws[1] + cws[2])
        avail = tbx - M - 18 * k
        per_row = (len(leg) + 1) // 2
        cw = min(112.0 * k, avail / per_row)
        for i, (kk, lab) in enumerate(leg):
            cx = M + 10 * k + (i % per_row) * cw
            cy = ly + 17 * k + (i // per_row) * 22 * k
            sw = 26.0 * k
            if kk in ("crit", "near", "norm", "done"):
                bar(cx, cy - 3.5 * k, sw, 7 * k, kk)
            elif kk == "base":
                rect(cx, cy - 0.8 * k, sw, blh, BASE)
            elif kk == "float":
                line(cx, cy, cx + sw, cy, FLOAT, 0.7 * k)
                line(cx + sw, cy - 3 * k, cx + sw, cy + 3 * k, FLOAT, 0.7 * k)
            elif kk == "ms":
                diamond(cx + sw / 2, cy, 4.5 * k, "crit")
            elif kk == "sum":
                poly([(cx, cy - 3 * k), (cx + sw, cy - 3 * k), (cx + sw, cy + 3 * k), (cx + sw - 3 * k, cy), (cx + 3 * k, cy), (cx, cy + 3 * k)], INK)
            else:
                o.append(f"{CRIT} RG {num(0.9 * k)} w {num(cx)} {num(Hh - cy + 3 * k)} m {num(cx + 8 * k)} {num(Hh - cy + 3 * k)} l {num(cx + 8 * k)} {num(Hh - cy - 3 * k)} l {num(cx + sw - 3 * k)} {num(Hh - cy - 3 * k)} l S")
                poly([(cx + sw, cy + 3 * k), (cx + sw - 3 * k, cy + 1.2 * k), (cx + sw - 3 * k, cy + 4.8 * k)], CRIT)
            text(cx + sw + 6 * k, cy + 2.5 * k, fit(lab, fs, cw - sw - 10 * k), fs, False, INK)
        line(tbx, ly, tbx, ly + fh, INK, 0.75)
        line(tbx, ly + fh / 2, W - M, ly + fh / 2, INK, 0.5)
        line(tbx + cws[0], ly, tbx + cws[0], ly + fh, INK, 0.5)
        line(tbx + cws[0] + cws[1], ly, tbx + cws[0] + cws[1], ly + fh, INK, 0.5)
        bln = bl["name"] if bl else "None shown"
        cells = [("PROJECT", p["name"]), ("DATA DATE", _d(p["data_date"], True)), ("LAYOUT", layout),
                 ("PRINTED", f"{page_name}, {pi + 1} of {len(chunks)}"), ("BASELINE", bln), ((product or "Schedule").upper(), "Field Tools No. 18")]
        for i, (l1, l2) in enumerate(cells):
            cx = tbx + (0 if i % 3 == 0 else cws[0] if i % 3 == 1 else cws[0] + cws[1])
            cy = ly + (i // 3) * fh / 2
            text(cx + 5 * k, cy + 9.5 * k, l1, 5.5 * k, True, MUTED)
            text(cx + 5 * k, cy + 21 * k, fit(l2, 7.5 * k, cws[i % 3] - 10 * k), 7.5 * k, False, INK)
        streams.append("\n".join(o))
    return assemble(streams, W, Hh, p["name"], product)


def assemble(streams, W, Hh, title, product):
    objs = []
    n = len(streams)
    kids = " ".join(f"{5 + 2 * i} 0 R" for i in range(n))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    for i, s in enumerate(streams):
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {Hh}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {6 + 2 * i} 0 R >>")
        objs.append(f"<< /Length {len(s)} >>\nstream\n{s}\nendstream")
    objs.append(f"<< /Title {pdf_str(title)} /Producer {pdf_str(product or 'CPM scheduler')} >>")
    out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = []
    for i, body in enumerate(objs):
        offsets.append(len(out))
        out += f"{i + 1} 0 obj\n{body}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R /Info {len(objs)} 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")
