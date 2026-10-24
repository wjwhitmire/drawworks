// ---------------------------------------------------------------- resource histograms and leveling
// Mirrors src/fieldsched/resources.py.
const RES_MAX_DAYS = 366 * 20;
function _spread(C, a, b) {
  const out = [];
  if (b <= a) return out;
  const d0 = fdiv(a, DAY), d1 = fdiv(b - 1, DAY);
  if (d1 - d0 > RES_MAX_DAYS) throw new SchedError("too_long", "A resource span is longer than 20 years.");
  for (let d = d0; d <= d1; d++) {
    const w = C.work_between(Math.max(a, d * DAY), Math.min(b, (d + 1) * DAY));
    if (w) out.push([d, w]);
  }
  return out;
}
const evSort = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
function day_peaks(spans) {
  const ev = [];
  for (const [a, b, u] of spans) { ev.push([a, 1, u]); ev.push([b, 0, -u]); }
  ev.sort(evSort);
  const peaks = new Map();
  let load = 0;
  for (let i = 0; i < ev.length; i++) {
    const [t, , du] = ev[i];
    load += du;
    const nxt = i + 1 < ev.length ? ev[i + 1][0] : t;
    if (nxt > t && load > 0) {
      for (let d = fdiv(t, DAY); d <= fdiv(nxt - 1, DAY); d++) if (load > (peaks.get(d) || 0)) peaks.set(d, load);
    }
  }
  return peaks;
}
function peak_load(spans, a, b) {
  const ev = [];
  for (const [s, e, u] of spans) if (s < b && e > a) { ev.push([Math.max(s, a), 1, u]); ev.push([Math.min(e, b), 0, -u]); }
  ev.sort(evSort);
  let load = 0, top = 0;
  for (const [, , du] of ev) { load += du; if (load > top) top = load; }
  return top;
}

function histogram(p, sched, rsrcId, which = "early", bucket = "day") {
  const ctx = new Ctx(p);
  const r = p.resources.find((x) => x.id === rsrcId);
  if (!r) throw new SchedError("bad_ref", "That resource does not exist.");
  const dd = parse_dt(p.data_date);
  const act = new Map(), rem = new Map(), spans = [];
  for (const x of p.assigns) {
    if (x.rsrc !== rsrcId) continue;
    const a = ctx.acts.get(x.act), C = ctx.cal.get(a.id), rec = sched.acts[a.id], st = status_of(a);
    if (st !== "planned" && x.actual) {
      const end = a.af ? parse_dt(a.af) : Math.max(dd, parse_dt(a.as));
      const sp = _spread(C, parse_dt(a.as), end);
      const tot = sp.reduce((t, [, w]) => t + w, 0);
      for (const [d, w] of sp) act.set(d, (act.get(d) || 0) + round_div(x.actual * w, tot));
    }
    if (st !== "complete" && a.rd > 0) {
      let s, b;
      if (which === "late") { b = parse_dt(rec.lf); s = C.sub_work(b, a.rd); } else { s = parse_dt(rec.res); b = parse_dt(rec.ef); }
      for (const [d, w] of _spread(C, s, b)) rem.set(d, (rem.get(d) || 0) + x.units * w);
      if (b > s) spans.push([s, b, x.units]);
    }
  }
  const units = day_peaks(spans);
  const days = Array.from(new Set([...act.keys(), ...rem.keys()])).sort((a, b) => a - b);
  let rows = [];
  if (days.length) {
    const pc = ctx.pcal;
    for (let d = days[0]; d <= days[days.length - 1]; d++)
      rows.push({ d, actual: act.get(d) || 0, remaining: round_div(rem.get(d) || 0, 60), units: units.get(d) || 0, limit: round_div(r.max_units * pc.day_work(d), 60) });
  }
  if (bucket === "week") {
    const weeks = new Map();
    for (const row of rows) {
      const k = row.d - mod(row.d + 3, 7);
      if (!weeks.has(k)) weeks.set(k, { d: k, actual: 0, remaining: 0, units: 0, limit: 0 });
      const w = weeks.get(k);
      w.actual += row.actual; w.remaining += row.remaining; w.units = Math.max(w.units, row.units); w.limit += row.limit;
    }
    rows = Array.from(weeks.keys()).sort((a, b) => a - b).map((k) => weeks.get(k));
  }
  const out = rows.map((row) => ({ date: fmt_day(row.d), actual: row.actual, remaining: row.remaining, units: row.units, limit: row.limit, over: row.units > r.max_units }));
  return { rsrc: rsrcId, max_units: r.max_units, bucket, which, rows: out, peak: out.reduce((m, x) => Math.max(m, x.units), 0) };
}

// a small binary heap ordered by cmpTuple, standing in for Python's heapq
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a; a.push(v);
    let i = a.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (cmpTuple(a[i], a[j]) >= 0) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && cmpTuple(a[l], a[m]) < 0) m = l;
        if (r < a.length && cmpTuple(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

function leveling_suggestions(p, sched) {
  const ctx = new Ctx(p);
  const rmax = new Map(p.resources.map((r) => [r.id, r.max_units]));
  const byAct = new Map();
  for (const x of p.assigns) if (x.units > 0 && (rmax.get(x.rsrc) || 0) > 0) { if (!byAct.has(x.act)) byAct.set(x.act, []); byAct.get(x.act).push(x); }
  const use = new Map();
  const base = Math.max(parse_dt(p.start), parse_dt(p.data_date));
  const E = new Map();
  const indeg = new Map(p.activities.map((a) => [a.id, 0]));
  for (const r of p.rels) indeg.set(r.succ, indeg.get(r.succ) + 1);
  const acts = sched.acts;
  const key = (aid) => [acts[aid].es, acts[aid].tf !== null ? acts[aid].tf : -(10 ** 12), ctx.acts.get(aid).code, aid];
  const ready = new Heap();
  for (const [i, n] of indeg) if (n === 0) ready.push(key(i));
  const out = [];
  while (ready.size) {
    const aid = ready.pop()[3];
    const a = ctx.acts.get(aid), C = ctx.cal.get(aid);
    let [es, ef, res] = forward_one(ctx, aid, E, base);
    const st = status_of(a);
    const xs = byAct.get(aid) || [];
    if (st === "planned" && xs.length && a.cstr !== "MS_MAND" && a.cstr !== "MF_MAND") {
      let tries = 0;
      while (es < ef) {
        // only other work can be waited out: an assignment over the maximum on its own is placed
        // where nothing else overlaps it
        const clash = xs.filter((x) => { const pk = peak_load(use.get(x.rsrc) || [], es, ef); return pk > 0 && pk + x.units > rmax.get(x.rsrc); });
        if (!clash.length || tries > 20000) break;
        tries++;
        const ends = [];
        for (const x of clash) for (const [s0, e] of use.get(x.rsrc) || []) if (s0 < ef && e > es) ends.push(e);
        const nxt = ends.length ? minOf(ends) : C.snap_fwd(es + 1);
        [es, ef, res] = forward_one(ctx, aid, E, base, Math.max(nxt, es + 1));
      }
      if (es > parse_dt(acts[aid].es)) {
        const old = parse_dt(acts[aid].es);
        const delay = C.work_between(old, es);
        const tf = acts[aid].tf;
        const rs = Array.from(new Set(xs.map((x) => x.rsrc))).sort(cmp);
        out.push({ act: aid, code: a.code, from: acts[aid].es, to: fmt_dt(es), delay, within_float: tf !== null && delay <= tf, rsrc: rs,
          why: "Over the maximum units of " + rs.join(", ") + " on its early dates." });
      }
    }
    if (st !== "complete" && xs.length) {
      const s = st === "active" ? res : es;
      if (ef > s) for (const x of xs) { if (!use.has(x.rsrc)) use.set(x.rsrc, []); use.get(x.rsrc).push([s, ef, x.units]); }
    }
    E.set(aid, [es, ef, res]);
    for (const r of ctx.succs.get(aid)) {
      indeg.set(r.succ, indeg.get(r.succ) - 1);
      if (indeg.get(r.succ) === 0) ready.push(key(r.succ));
    }
  }
  if (E.size < p.activities.length) throw new SchedError("loop", "The logic has a loop; schedule first to see where.");
  const fins = Array.from(E.values()).map((e) => e[1]);
  return { suggestions: out, finish: fins.length ? fmt_dt(maxOf(fins)) : null };
}

function apply_leveling(p, suggestions) {
  const want = new Map(suggestions.map((s) => [s.act, s.to]));
  const acts = p.activities.map((a) => (want.has(a.id) && (a.cstr === "ASAP" || a.cstr === "SNET") ? Object.assign({}, a, { cstr: "SNET", cstr_date: want.get(a.id) }) : a));
  return validate_project(Object.assign({}, p, { activities: acts }));
}
