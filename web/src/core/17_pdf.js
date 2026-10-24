// ---------------------------------------------------------------- print-ready Gantt PDF
// Mirrors src/fieldsched/pdf.py byte for byte.
const PDF_PAGES = { letter: [792, 612], a4: [842, 595], tabloid: [1224, 792], a3: [1191, 842] };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PDF_PAGE_NAMES = { letter: "Letter landscape", a4: "A4 landscape", tabloid: "Tabloid landscape", a3: "A3 landscape" };
const PDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PINK = "0.059 0.098 0.118", PMUTED = "0.29 0.341 0.369", PHAIR = "0.839 0.867 0.878", PHEADBG = "0.945 0.957 0.961", PGRID = "0.886 0.906 0.918";
const PBANDS = ["0.867 0.894 0.91", "0.914 0.933 0.941", "0.949 0.961 0.965"];
const PCRIT = "0.71 0.09 0.059", PNEAR = "0.639 0.459 0", PNEAR_TINT = "0.984 0.941 0.851", PNORM = "0.165 0.467 0.541", PNORM_TINT = "0.812 0.898 0.918";
const PDONE = "0.106 0.145 0.169", PBASE = "0.486 0.529 0.553", PFLOAT = "0.239 0.29 0.318", PDD = "0.137 0.263 0.722", PMARK = "0.561 0.055 0.384", PMARK_TINT = "0.973 0.902 0.945", PWHITE = "1 1 1";
function pnum(x) {
  let v = Math.floor(x * 100 + 0.5);
  const sign = v < 0 ? "-" : "";
  v = Math.abs(v);
  let s = `${sign}${fdiv(v, 100)}`;
  if (v % 100) s += rstripChars("." + pad(v % 100, 2), "0");
  return s;
}
function text_width(s, size) {
  let w = 0;
  for (const ch of s) {
    if ("il.,:;'|!Ijft r()[]".includes(ch)) w += 0.28;
    else if ("mwMW@".includes(ch)) w += 0.83;
    else if (ch >= "A" && ch <= "Z") w += 0.67;
    else w += 0.53;
  }
  return w * size;
}
function fit(s, size, width) {
  if (text_width(s, size) <= width) return s;
  let cs = Array.from(s);
  while (cs.length && text_width(cs.join("") + "...", size) > width) cs.pop();
  return cs.join("") + "...";
}
function pdf_str(s) {
  const b = encode_cp1252(s);
  let out = "";
  for (const c of b) {
    const ch = String.fromCharCode(c);
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\" + ch;
    else if (c < 32) out += " ";
    else out += ch;
  }
  return "(" + out + ")";
}
function _pd(t, time = false) {
  if (!t) return "";
  const s = `${t.slice(8, 10)}-${MONTHS[parseInt(t.slice(5, 7), 10) - 1]}-${t.slice(2, 4)}`;
  return time ? s + " " + t.slice(11, 16) : s;
}
function _ptrim(s) { return s.includes(".") ? rstripChars(rstripChars(s, "0"), ".") : s; }
function gantt_rows(p) {
  const parent = new Map(p.wbs.map((w) => [w.id, w.parent]));
  const live = new Set();
  for (const a of p.activities) { let w = a.wbs; while (w && !live.has(w)) { live.add(w); w = parent.get(w); } }
  return tree_rows(p).filter(([k, x]) => k === "a" || live.has(x.id)).map(([k, x, level]) => [k, x, level - 1]);
}
// A WBS band never ends a page: trailing bands move to the next page, above their own activities.
function paginate(rows, perPage) {
  const chunks = [], n = rows.length;
  let i = 0;
  while (i < n) {
    let j = Math.min(i + perPage, n);
    if (j < n) {
      let k = j;
      while (k > i && rows[k - 1][0] === "w") k--;
      if (k > i) j = k;
    }
    chunks.push(rows.slice(i, j));
    i = j;
  }
  if (!chunks.length) chunks.push([]);
  return chunks;
}
function _pstate(rec) { return rec.status === "complete" ? "done" : rec.crit ? "crit" : rec.near ? "near" : "norm"; }
function _ptiers(px) { return px < 3 ? ["year", "quarter"] : px < 10 ? ["year", "month"] : px < 30 ? ["month", "week"] : px < 100 ? ["week", "day"] : ["day", "hour"]; }
function _pkey(kind, d) {
  const [y, m] = civil_from_days(d);
  if (kind === "year") return y;
  if (kind === "quarter") return y * 4 + fdiv(m - 1, 3);
  if (kind === "month") return y * 12 + m;
  if (kind === "week") return fdiv(d + 3, 7);
  return d;
}
function _plabel(kind, d, small) {
  const [y, m, dd] = civil_from_days(d);
  if (kind === "year") return String(y);
  if (kind === "quarter") return "Q" + String(fdiv(m - 1, 3) + 1);
  if (kind === "month") return MONTHS[m - 1] + " " + String(y);
  if (kind === "week") return small ? pad(dd, 2) : `Week of ${pad(dd, 2)} ${MONTHS[m - 1]}`;
  return small ? pad(dd, 2) : `${PDAYS[weekday(d)]} ${pad(dd, 2)} ${MONTHS[m - 1]}`;
}

function render_pdf(p, sched, page = "letter", baseline = true, product = "", opts = null) {
  const o_ = opts || {};
  const links = o_.links === undefined || o_.links === null ? true : !!o_.links;
  const layout = o_.layout || "Classic schedule";
  const filt = o_.filter || "All activities";
  const [W, Hh] = has(PDF_PAGES, page) ? PDF_PAGES[page] : PDF_PAGES.letter;
  const pageName = has(PDF_PAGE_NAMES, page) ? PDF_PAGE_NAMES[page] : PDF_PAGE_NAMES.letter;
  const big = W >= 1000;
  const k = big ? 1.0 : 0.8;
  const M = 30.0 * k, rowh = big ? 14.0 : 11.0, fs = big ? 7.5 : 6.0;
  const tier = 16.0 * k, lane = 14.0 * k, head = 2 * tier + lane;
  const top = M + 48.0 * k, fh = 56.0 * k;
  const timed = p.settings.unit === "h";
  const dw = timed ? 74.0 : 52.0;
  const cols = [["ID", 46.0, "code"], ["Activity Name", 170.0, "name"], ["Dur", 32.0, "od"], ["Start", dw, "start"], ["Finish", dw, "finish"], ["TF", 30.0, "tf"]].map(([n, w, c]) => [n, w * k, c]);
  let tableW = 0;
  for (const c of cols) tableW += c[1];
  const gx = M + tableW, gw = W - M - gx;
  const roll = wbs_rollup(p, sched);
  const bl = baseline ? p.baselines.find((b) => b.id === p.baseline) || null : null;
  const rows = gantt_rows(p);
  const times = [];
  for (const a of p.activities) {
    const r = sched.acts[a.id];
    times.push(parse_dt(r.es), parse_dt(r.ef));
    if (a.as) times.push(parse_dt(a.as));
    if (r.lf) times.push(parse_dt(r.lf));
    if (bl && has(bl.acts, a.id)) times.push(parse_dt(bl.acts[a.id][0]), parse_dt(bl.acts[a.id][1]));
  }
  const dd = parse_dt(p.data_date), fin = parse_dt(sched.finish);
  times.push(dd, fin);
  const t0 = (fdiv(minOf(times), DAY) - 1) * DAY, t1 = (fdiv(maxOf(times), DAY) + 2) * DAY;
  const span = t1 - t0;
  const ppd = gw * DAY / span;
  const X = (t) => gx + (t - t0) * gw / span;
  const [tk, bk] = _ptiers(ppd * 4 / 3);
  const ly = Hh - M - fh;
  const bodyTop = top + head;
  const perPage = Math.max(1, Math.floor((ly - 10 * k - bodyTop) / rowh));
  const chunks = paginate(rows, perPage);
  const hpd = new Map(p.calendars.map((c) => [c.id, c.hpd]));
  const bh = rowh * 0.42, blh = 1.6 * k;
  const streams = [];
  chunks.forEach((chunk, pi) => {
    const o = [];
    const text = (x, y, s, size = fs, bold = false, color = PINK, right = false) => {
      if (right) x = x - text_width(s, size);
      o.push(`BT /${bold ? "F2" : "F1"} ${pnum(size)} Tf ${color} rg ${pnum(x)} ${pnum(Hh - y)} Td ${pdf_str(s)} Tj ET`);
    };
    const rect = (x, y, w, h, fill = null, stroke = null, width = 0.6) => {
      const ops = `${pnum(x)} ${pnum(Hh - y - h)} ${pnum(w)} ${pnum(h)} re`;
      if (fill && stroke) o.push(`${fill} rg ${stroke} RG ${pnum(width)} w ${ops} B`);
      else if (fill) o.push(`${fill} rg ${ops} f`);
      else o.push(`${stroke} RG ${pnum(width)} w ${ops} S`);
    };
    const line = (x1, y1, x2, y2, color, width = 0.5, dash = null) => {
      o.push(`${color} RG ${pnum(width)} w ${dash ? "[" + dash + "] 0 d " : ""}${pnum(x1)} ${pnum(Hh - y1)} m ${pnum(x2)} ${pnum(Hh - y2)} l S${dash ? " [] 0 d" : ""}`);
    };
    const poly = (pts, fill = null, stroke = null, width = 0.6) => {
      const path = pts.map(([x, y], i) => `${pnum(x)} ${pnum(Hh - y)} ${i === 0 ? "m" : "l"}`).join(" ") + " h";
      if (fill && stroke) o.push(`${fill} rg ${stroke} RG ${pnum(width)} w ${path} B`);
      else if (fill) o.push(`${fill} rg ${path} f`);
      else o.push(`${stroke} RG ${pnum(width)} w ${path} S`);
    };
    const hatch = (x, y, w, h) => {
      rect(x, y, w, h, PNEAR_TINT);
      const yb = Hh - y - h;
      const seg = [`q ${pnum(x)} ${pnum(yb)} ${pnum(w)} ${pnum(h)} re W n ${PNEAR} RG ${pnum(0.9 * k)} w`];
      let t = -h;
      while (t < w) { seg.push(`${pnum(x + t)} ${pnum(yb)} m ${pnum(x + t + h)} ${pnum(yb + h)} l`); t += 3.0 * k; }
      seg.push("S Q");
      o.push(seg.join(" "));
      rect(x, y, w, h, null, PNEAR, 0.8 * k);
    };
    const diamond = (cx, cy, s, st) => {
      const pts = [[cx, cy - s], [cx + s, cy], [cx, cy + s], [cx - s, cy]];
      if (st === "crit") poly(pts, PCRIT);
      else if (st === "done") poly(pts, PDONE);
      else if (st === "near") poly(pts, PNEAR_TINT, PNEAR, 0.9 * k);
      else poly(pts, PWHITE, PNORM, 0.9 * k);
    };
    const bar = (x, y, w, h, st) => {
      w = Math.max(0.8, w);
      if (st === "crit") rect(x, y, w, h, PCRIT);
      else if (st === "done") rect(x, y, w, h, PDONE);
      else if (st === "near") hatch(x, y, w, h);
      else rect(x, y, w, h, PNORM_TINT, PNORM, 0.8 * k);
    };
    // header: name, layout line, and the key answer (project finish) at the right
    const finTxt = _pd(sched.finish, true);
    const finW = text_width(finTxt, 17.0 * k) + 4;
    text(M, M + 19.0 * k, fit(p.name, 19.0 * k, W - 2 * M - finW - 24), 19.0 * k, true);
    let sub = `${layout} layout. ${filt}.`;
    if (p.label) sub += " " + p.label;
    text(M, M + 36.0 * k, fit(sub, 8.5 * k, W - 2 * M - finW - 24), 8.5 * k, false, PMUTED);
    text(W - M, M + 12.0 * k, "PROJECT FINISH", 7.0 * k, true, PMARK, true);
    text(W - M, M + 34.0 * k, finTxt, 17.0 * k, true, PMARK, true);
    // header row: table labels beside the two-tier timescale and the flag lane
    rect(M, top, W - 2 * M, head, PHEADBG);
    let x = M;
    for (const [name, w, c] of cols) {
      if (c === "od" || c === "tf") text(x + w - 4, top + head - 6 * k, name, fs, true, PMUTED, true);
      else text(x + 3, top + head - 6 * k, name, fs, true, PMUTED);
      x += w;
    }
    const yBody = bodyTop;
    const yb = yBody + chunk.length * rowh;
    [tk, bk].forEach((kind, ti) => {
      const ty = top + ti * tier;
      if (kind === "hour") {
        let d = fdiv(t0, DAY);
        while (d * DAY < t1) {
          for (const hh of [0, 6, 12, 18]) {
            const xh = X(d * DAY + hh * 60);
            line(xh, ty, xh, ty + tier, PHAIR, 0.5);
            if (ppd / 4 >= text_width("00", fs) + 4) text(xh + 2, ty + 11 * k, pad(hh, 2), fs * 0.9, true, PMUTED);
          }
          d += 1;
        }
        return;
      }
      const marks = [];
      let prev = null;
      let d = fdiv(t0, DAY);
      while (d * DAY < t1) { const kk = _pkey(kind, d); if (kk !== prev) { marks.push(d); prev = kk; } d += 1; }
      const small = ti === 1;
      marks.forEach((dm, i) => {
        const xm = X(dm * DAY);
        const nxt = i + 1 < marks.length ? X(marks[i + 1] * DAY) : W - M;
        line(xm, ty, xm, ty + tier, PHAIR, 0.5);
        const lab = _plabel(kind, dm, small);
        if (text_width(lab, fs * 0.9) + 4 <= nxt - xm) text(xm + 2, ty + 11 * k, lab, fs * 0.9, true, PMUTED);
        if (ti === 0 && xm > gx + 0.5) line(xm, yBody, xm, yb, PGRID, 0.5);
      });
    });
    line(gx, top + tier, W - M, top + tier, PHAIR, 0.5);
    line(gx, top + 2 * tier, W - M, top + 2 * tier, PHAIR, 0.5);
    const flagBox = (t, label, size) => { const xx = X(t); const w = text_width(label, size) + 14 * k; return [xx, w, xx + w <= W - M ? xx : xx - w]; };
    const fsz = 6.0 * k;
    const ddLab = "DATA DATE " + _pd(p.data_date, timed), finLab = "FINISH " + _pd(sched.finish, timed);
    const fd = flagBox(dd, ddLab, fsz), ff = flagBox(fin, finLab, fsz);
    if (fd[2] < ff[2] + ff[1] && ff[2] < fd[2] + fd[1]) fd[2] = Math.max(gx, Math.min(fd[0] - fd[1], ff[2] - fd[1] - 2));
    const fy = top + 2 * tier + 1.5 * k, fhh = lane - 3 * k;
    rect(fd[2], fy, fd[1], fhh, PDD);
    text(fd[2] + 10 * k, fy + fhh - 3 * k, ddLab, fsz, true, PWHITE);
    line(fd[2] + 5 * k, fy + 2 * k, fd[2] + 5 * k, fy + fhh - 2 * k, PWHITE, 0.9 * k, "1.5 1");
    rect(ff[2], fy, ff[1], fhh, PMARK_TINT, PMARK, 0.7 * k);
    text(ff[2] + 10 * k, fy + fhh - 3 * k, finLab, fsz, true, PMARK);
    const cy0 = fy + fhh / 2;
    poly([[ff[2] + 5 * k, cy0 - 3 * k], [ff[2] + 8 * k, cy0], [ff[2] + 5 * k, cy0 + 3 * k], [ff[2] + 2 * k, cy0]], PMARK);
    // rows: bands and text, then links, then bars
    const pos = new Map();
    const bars = [];
    chunk.forEach(([kind, item, depth], i) => {
      const ry = yBody + i * rowh;
      const cy = ry + rowh / 2;
      if (kind === "w") {
        rect(M, ry, W - 2 * M, rowh, PBANDS[Math.min(2, depth)]);
        text(M + 3 + depth * 6 * k, ry + rowh - 4 * k, fit(`${item.code}  ${item.name}`, fs, tableW - 8 - depth * 6 * k), fs, true);
        const r = roll[item.id];
        if (r && r.es) { const x1 = X(parse_dt(r.es)); const x2 = Math.max(X(parse_dt(r.ef)), x1 + 6); bars.push(["sum", x1, x2, cy]); }
        return;
      }
      const a = item;
      const rec = sched.acts[a.id];
      const div = a.unit === "h" ? 60 : hpd.get(a.cal || p.cal);
      const unit = a.unit === "h" ? "h" : "d";
      line(M, ry + rowh, gx, ry + rowh, PHAIR, 0.4);
      const st = _pstate(rec);
      const vals = { code: a.code, name: a.name, od: _ptrim(fmt_fixed(a.type === "task" ? a.od : 0, div, 1)) + unit,
        start: _pd(a.as || rec.es, timed) + (a.as ? " A" : ""), finish: _pd(a.af || rec.ef, timed) + (a.af ? " A" : ""),
        tf: rec.tf !== null ? _ptrim(fmt_fixed(rec.tf, div, 1)) + unit : "" };
      let xc = M;
      for (const [, w, c] of cols) {
        const ind = c === "name" ? depth * 6 * k : 0;
        const s = fit(vals[c], fs, w - 6 - ind);
        const red = c === "code" && st === "crit";
        const neg = c === "tf" && rec.tf !== null && rec.tf < 0;
        if (c === "od" || c === "tf") text(xc + w - 4, ry + rowh - 4 * k, s, fs, neg, neg ? PCRIT : PINK, true);
        else text(xc + 3 + ind, ry + rowh - 4 * k, s, fs, red, red ? PCRIT : PINK);
        xc += w;
      }
      const hasBl = !!(bl && has(bl.acts, a.id) && a.type === "task");
      const by = ry + (rowh - bh) / 2 - (hasBl ? blh / 2 + 0.5 : 0);
      const bcy = by + bh / 2;
      const es = parse_dt(rec.es), ef = parse_dt(rec.ef);
      if (a.type !== "task" || (a.od === 0 && rec.status !== "active")) {
        const s_ = bh / 2 + 1.2 * k;
        bars.push(["ms", X(es), s_, bcy, st]);
        pos.set(a.id, [bcy, X(es) - s_, X(es) + s_]);
      } else {
        let x0 = X(es);
        if (hasBl) { const b = bl.acts[a.id]; const bx1 = X(parse_dt(b[0])), bx2 = X(parse_dt(b[1])); bars.push(["bl", bx1, Math.max(0.8, bx2 - bx1), by + bh + 1 * k]); }
        if (rec.status === "active") {
          const xa = X(parse_dt(a.as));
          const xd = Math.min(X(dd), X(ef));
          bars.push(["act", xa, Math.max(0.8, xd - xa - 0.75), by]);
          const xr = X(parse_dt(rec.res));
          bars.push(["bar", xr, X(ef) - xr, by, st]);
          x0 = xa;
        } else bars.push(["bar", X(es), X(ef) - X(es), by, st]);
        if (rec.lf && rec.tf && rec.tf > 0 && rec.status !== "complete") {
          const xl = X(parse_dt(rec.lf));
          if (xl > X(ef) + 0.5) bars.push(["float", X(ef), xl, bcy]);
        }
        pos.set(a.id, [bcy, x0, X(ef)]);
      }
    });
    // driving relationships on the critical path
    if (links) {
      for (const r of p.rels) {
        if (!pos.has(r.pred) || !pos.has(r.succ)) continue;
        const rr = sched.rels[r.id];
        if (!(rr && rr.driving && sched.acts[r.succ].crit)) continue;
        const [py, ps, pf] = pos.get(r.pred);
        const [qy, qs, qf] = pos.get(r.succ);
        const t = r.type;
        const xa = t === "FS" || t === "FF" ? pf : ps;
        const toFin = t === "FF" || t === "SF";
        const xb = toFin ? qf : qs;
        const dr = toFin ? -1 : 1;
        let pts;
        if (!toFin && xb - 4 * k >= xa + 2 * k) pts = [[xa, py], [xa + 2 * k, py], [xa + 2 * k, qy], [xb - dr * 1.5 * k, qy]];
        else {
          const mid = qy > py ? qy - rowh / 2 : qy + rowh / 2;
          const out = t === "FS" || t === "FF" ? xa + 3 * k : xa - 3 * k;
          const into = toFin ? xb + 4 * k : xb - 4 * k;
          pts = [[xa, py], [out, py], [out, mid], [into, mid], [into, qy], [xb - dr * 1.5 * k, qy]];
        }
        o.push(`${PCRIT} RG ${pnum(0.9 * k)} w ` + pts.map(([px, py2], i) => `${pnum(px)} ${pnum(Hh - py2)} ${i === 0 ? "m" : "l"}`).join(" ") + " S");
        poly([[xb, qy], [xb - dr * 3 * k, qy - 1.8 * k], [xb - dr * 3 * k, qy + 1.8 * k]], PCRIT);
      }
    }
    for (const bb of bars) {
      const kind = bb[0];
      if (kind === "sum") { const [, x1, x2, cy] = bb; poly([[x1, cy - 2 * k], [x2, cy - 2 * k], [x2, cy + 3.5 * k], [x2 - 3 * k, cy + 0.5 * k], [x1 + 3 * k, cy + 0.5 * k], [x1, cy + 3.5 * k]], PINK); }
      else if (kind === "bl") rect(bb[1], bb[3], bb[2], blh, PBASE);
      else if (kind === "act") rect(bb[1], bb[3], bb[2], bh, PDONE);
      else if (kind === "bar") bar(bb[1], bb[3], bb[2], bh, bb[4]);
      else if (kind === "ms") diamond(bb[1], bb[3], bb[2], bb[4]);
      else if (kind === "float") {
        const [, x1, x2, cy] = bb;
        line(x1, cy, x2, cy, PFLOAT, 0.7 * k);
        line(x2, cy - bh / 2 + 0.5, x2, cy + bh / 2 - 0.5, PFLOAT, 0.7 * k);
      }
    }
    // data date and finish lines, then the frame
    const xdd = X(dd);
    line(xdd, top + 2 * tier, xdd, yb, PDD, 1.0 * k, "3 2");
    const xf = X(fin);
    line(xf, top + 2 * tier + lane, xf, yb, PMARK, 1.0 * k);
    rect(M, top, W - 2 * M, yb - top, null, PINK, 0.75);
    line(gx, top, gx, yb, PINK, 0.75);
    line(M, bodyTop, W - M, bodyTop, PINK, 0.5);
    // legend and title block, the way a drawing sheet carries one
    rect(M, ly, W - 2 * M, fh, null, PINK, 0.75);
    const leg = [["crit", "Critical"], ["near", "Near critical"], ["norm", "Not critical"], ["done", "Actual work"],
      ["base", "Baseline"], ["float", "Total float"], ["ms", "Milestone"], ["sum", "WBS summary"]];
    if (links) leg.push(["link", "Driving link"]);
    const cws = [150.0 * k, 135.0 * k, 135.0 * k];
    const tbx = W - M - (cws[0] + cws[1] + cws[2]);
    const avail = tbx - M - 18 * k;
    const perRow = fdiv(leg.length + 1, 2);
    const cw = Math.min(112.0 * k, avail / perRow);
    leg.forEach(([kk, lab], i) => {
      const cx = M + 10 * k + (i % perRow) * cw;
      const cy = ly + 17 * k + fdiv(i, perRow) * 22 * k;
      const sw = 26.0 * k;
      if (kk === "crit" || kk === "near" || kk === "norm" || kk === "done") bar(cx, cy - 3.5 * k, sw, 7 * k, kk);
      else if (kk === "base") rect(cx, cy - 0.8 * k, sw, blh, PBASE);
      else if (kk === "float") { line(cx, cy, cx + sw, cy, PFLOAT, 0.7 * k); line(cx + sw, cy - 3 * k, cx + sw, cy + 3 * k, PFLOAT, 0.7 * k); }
      else if (kk === "ms") diamond(cx + sw / 2, cy, 4.5 * k, "crit");
      else if (kk === "sum") poly([[cx, cy - 3 * k], [cx + sw, cy - 3 * k], [cx + sw, cy + 3 * k], [cx + sw - 3 * k, cy], [cx + 3 * k, cy], [cx, cy + 3 * k]], PINK);
      else {
        o.push(`${PCRIT} RG ${pnum(0.9 * k)} w ${pnum(cx)} ${pnum(Hh - cy + 3 * k)} m ${pnum(cx + 8 * k)} ${pnum(Hh - cy + 3 * k)} l ${pnum(cx + 8 * k)} ${pnum(Hh - cy - 3 * k)} l ${pnum(cx + sw - 3 * k)} ${pnum(Hh - cy - 3 * k)} l S`);
        poly([[cx + sw, cy + 3 * k], [cx + sw - 3 * k, cy + 1.2 * k], [cx + sw - 3 * k, cy + 4.8 * k]], PCRIT);
      }
      text(cx + sw + 6 * k, cy + 2.5 * k, fit(lab, fs, cw - sw - 10 * k), fs, false, PINK);
    });
    line(tbx, ly, tbx, ly + fh, PINK, 0.75);
    line(tbx, ly + fh / 2, W - M, ly + fh / 2, PINK, 0.5);
    line(tbx + cws[0], ly, tbx + cws[0], ly + fh, PINK, 0.5);
    line(tbx + cws[0] + cws[1], ly, tbx + cws[0] + cws[1], ly + fh, PINK, 0.5);
    const bln = bl ? bl.name : "None shown";
    const cells = [["PROJECT", p.name], ["DATA DATE", _pd(p.data_date, true)], ["LAYOUT", layout],
      ["PRINTED", `${pageName}, ${pi + 1} of ${chunks.length}`], ["BASELINE", bln], [(product || "Schedule").toUpperCase(), "Field Tools No. 18"]];
    cells.forEach(([l1, l2], i) => {
      const cx = tbx + (i % 3 === 0 ? 0 : i % 3 === 1 ? cws[0] : cws[0] + cws[1]);
      const cy = ly + fdiv(i, 3) * fh / 2;
      text(cx + 5 * k, cy + 9.5 * k, l1, 5.5 * k, true, PMUTED);
      text(cx + 5 * k, cy + 21 * k, fit(l2, 7.5 * k, cws[i % 3] - 10 * k), 7.5 * k, false, PINK);
    });
    streams.push(o.join("\n"));
  });
  return pdf_assemble(streams, W, Hh, p.name, product);
}
function pdf_assemble(streams, W, Hh, title, product) {
  const objs = [];
  const n = streams.length;
  const kids = streams.map((_, i) => `${5 + 2 * i} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  streams.forEach((s, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hh}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push(`<< /Title ${pdf_str(title)} /Producer ${pdf_str(product || "CPM scheduler")} >>`);
  let out = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${pad(o, 10)} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}
