// ---------------------------------------------------------------- critical path method
// Mirrors src/fieldsched/cpm.py. The rules are stated there and in the README's method section.
function lag_fwd(cal, t, lag) { return lag > 0 ? cal.add_work(t, lag) : lag < 0 ? cal.sub_work(t, -lag) : t; }
function lag_back(cal, t, lag) { return lag > 0 ? cal.sub_work(t, lag) : lag < 0 ? cal.add_work(t, -lag) : t; }
function status_of(a) { return a.af ? "complete" : a.as ? "active" : "planned"; }

function topo_order(acts, rels) {
  const ids = acts.map((a) => a.id);
  const indeg = new Map(ids.map((i) => [i, 0]));
  const out = new Map(ids.map((i) => [i, []]));
  const inn = new Map(ids.map((i) => [i, []]));
  for (const r of rels) {
    indeg.set(r.succ, indeg.get(r.succ) + 1);
    out.get(r.pred).push(r.succ);
    inn.get(r.succ).push(r.pred);
  }
  const queue = ids.filter((i) => indeg.get(i) === 0);
  const order = [];
  for (let k = 0; k < queue.length; k++) {
    const n = queue[k];
    order.push(n);
    for (const s of out.get(n)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (order.length < ids.length) {
    const left = new Set(ids.filter((i) => indeg.get(i) > 0));
    const code = new Map(acts.map((a) => [a.id, a.code]));
    const start = ids.find((i) => left.has(i));
    const path = [], seen = new Map();
    let cur = start;
    while (!seen.has(cur)) {
      seen.set(cur, path.length);
      path.push(cur);
      cur = inn.get(cur).find((p) => left.has(p));
    }
    const back = path.slice(seen.get(cur));
    const cyc = [back[0]].concat(back.slice(1).reverse(), [back[0]]);
    const err = new SchedError("loop", "Logic loop: " + cyc.map((c) => code.get(c)).join(" -> ") + ". Remove or reverse one of these relationships.");
    err.cycle = cyc;
    throw err;
  }
  return order;
}

class Ctx {
  constructor(p) {
    this.p = p;
    this.cals = new Map(p.calendars.map((c) => [c.id, compile_calendar(c)]));
    this.pcal = this.cals.get(p.cal);
    this.h24 = full_day_calendar();
    this.acts = new Map(p.activities.map((a) => [a.id, a]));
    this.cal = new Map(p.activities.map((a) => [a.id, this.cals.get(a.cal || p.cal)]));
    this.preds = new Map(p.activities.map((a) => [a.id, []]));
    this.succs = new Map(p.activities.map((a) => [a.id, []]));
    for (const r of p.rels) { this.preds.get(r.succ).push(r); this.succs.get(r.pred).push(r); }
    this.status = new Map(p.activities.map((a) => [a.id, status_of(a)]));
    this.settings = p.settings;
  }
  lagcal(r) {
    const m = this.settings.lag_cal;
    if (r.elapsed || m === "24h") return this.h24;
    if (m === "pred") return this.cal.get(r.pred);
    if (m === "succ") return this.cal.get(r.succ);
    return this.pcal;
  }
  norm_ms(cal, t) { return cal.snap_back(t) === t ? t : cal.snap_fwd(t); }
}
function _uses_pred(ctx, r, sst) {
  if (sst === "complete") return false;
  if (sst === "active") return ctx.settings.oos === "override" ? false : r.type !== "SS";
  return true;
}
const maxOf = (xs) => xs.reduce((a, b) => (b > a ? b : a));
const minOf = (xs) => xs.reduce((a, b) => (b < a ? b : a));

function forward_one(ctx, aid, E, base, extraStart) {
  const a = ctx.acts.get(aid), C = ctx.cal.get(aid), st = ctx.status.get(aid);
  if (st === "complete") return [parse_dt(a.as), parse_dt(a.af), null];
  const D = a.rd;
  const sc = [base], fc = [];
  if (extraStart !== undefined && extraStart !== null) sc.push(extraStart);
  for (const r of ctx.preds.get(aid)) {
    if (!_uses_pred(ctx, r, st)) continue;
    const [pes, pef] = E.get(r.pred);
    const t = lag_fwd(ctx.lagcal(r), r.type === "FS" || r.type === "FF" ? pef : pes, r.lag);
    (r.type === "FS" || r.type === "SS" ? sc : fc).push(t);
  }
  const cs = a.cstr, cd = a.cstr_date ? parse_dt(a.cstr_date) : null;
  if (cs === "FNET" || cs === "MFO") fc.push(cd);
  if (st === "active") {
    const es = parse_dt(a.as);
    const resume = maxOf(sc);
    let ef, res;
    if (D > 0) {
      res = C.snap_fwd(resume);
      ef = C.add_work(res, D);
      for (const f of fc) {
        const g = C.snap_back(f);
        if (g > ef) { ef = g; res = C.sub_work(ef, D); }
      }
    } else {
      ef = ctx.norm_ms(C, maxOf(sc.concat(fc)));
      res = ef;
    }
    return [es, ef, res];
  }
  if (cs === "SNET" || cs === "MSO") sc.push(cd);
  const s = maxOf(sc);
  if (a.type === "task" && D > 0) {
    let es = C.snap_fwd(s);
    for (const f of fc) es = Math.max(es, C.snap_fwd(C.sub_work(f, D)));
    if (cs === "MS_MAND") es = C.snap_fwd(cd);
    else if (cs === "MF_MAND") es = C.sub_work(C.snap_back(cd), D);
    return [es, C.add_work(es, D), es];
  }
  let t = maxOf(sc.concat(fc));
  if (cs === "MS_MAND" || cs === "MF_MAND") t = cd;
  const x = a.type === "finish_ms" ? ctx.norm_ms(C, t) : C.snap_fwd(t);
  return [x, x, x];
}

function backward_one(ctx, aid, L, E, anchor) {
  const a = ctx.acts.get(aid), C = ctx.cal.get(aid), st = ctx.status.get(aid);
  const D = a.rd;
  const lfc = [anchor], lsc = [];
  for (const r of ctx.succs.get(aid)) {
    const s = r.succ, sst = ctx.status.get(s);
    if (!_uses_pred(ctx, r, sst) || L.get(s) === null || L.get(s) === undefined) continue;
    const [sls, slf] = L.get(s);
    const lc = ctx.lagcal(r);
    if (r.type === "FS") lfc.push(lag_back(lc, sls, r.lag));
    else if (r.type === "SS") lsc.push(lag_back(lc, sls, r.lag));
    else if (r.type === "FF") lfc.push(lag_back(lc, slf, r.lag));
    else lsc.push(lag_back(lc, slf, r.lag));
  }
  const cs = a.cstr, cd = a.cstr_date ? parse_dt(a.cstr_date) : null;
  if (cs === "FNLT" || cs === "MFO") lfc.push(cd);
  if ((cs === "SNLT" || cs === "MSO") && st === "planned") lsc.push(cd);
  const ef = E.get(aid)[1];
  if (D > 0 && (a.type === "task" || st === "active")) {
    let lf = C.snap_back(minOf(lfc));
    for (const x of lsc) lf = Math.min(lf, C.add_work(C.snap_fwd(x), D));
    if (st === "planned") {
      if (cs === "MS_MAND") lf = C.add_work(C.snap_fwd(cd), D);
      else if (cs === "MF_MAND") lf = C.snap_back(cd);
    }
    return [C.sub_work(lf, D), lf];
  }
  let t = minOf(lfc.concat(lsc));
  if (st === "planned" && (cs === "MS_MAND" || cs === "MF_MAND")) t = cd;
  let x = a.type === "finish_ms" ? C.snap_back(t) : C.snap_fwd(t);
  if (x !== ef && C.work_between(Math.min(x, ef), Math.max(x, ef)) === 0) x = ef;
  return [x, x];
}

function rel_slack(ctx, r, E, onSucc) {
  const sst = ctx.status.get(r.succ);
  if (ctx.status.get(r.pred) === "complete" || !_uses_pred(ctx, r, sst)) return null;
  const [pes, pef] = E.get(r.pred);
  const [, sef, sres] = E.get(r.succ);
  const t = lag_fwd(ctx.lagcal(r), r.type === "FS" || r.type === "FF" ? pef : pes, r.lag);
  const target = r.type === "FS" || r.type === "SS" ? sres : sef;
  return ctx.cal.get(onSucc ? r.succ : r.pred).work_between(t, target);
}

function schedule(p) {
  const ctx = new Ctx(p);
  const acts = p.activities;
  const order = topo_order(acts, p.rels);
  const start = parse_dt(p.start), dd = parse_dt(p.data_date);
  const base = Math.max(start, dd);
  const E = new Map();
  for (const aid of order) E.set(aid, forward_one(ctx, aid, E, base));
  const openEf = acts.filter((a) => ctx.status.get(a.id) !== "complete").map((a) => E.get(a.id)[1]);
  const allEf = acts.map((a) => E.get(a.id)[1]);
  const pf = allEf.length ? maxOf(allEf) : ctx.pcal.snap_fwd(base);
  const anchor = p.finish_by ? parse_dt(p.finish_by) : openEf.length ? maxOf(openEf) : pf;
  const L = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const aid = order[i];
    L.set(aid, ctx.status.get(aid) === "complete" ? null : backward_one(ctx, aid, L, E, anchor));
  }
  const S = p.settings;
  const relOut = {}, ffs = new Map();
  for (const r of p.rels) {
    const sl = rel_slack(ctx, r, E, true);
    relOut[r.id] = { slack: sl, driving: sl !== null && sl <= 0 };
    ffs.set(r.id, rel_slack(ctx, r, E, false));
  }
  const Ea = new Map(E);
  for (let i = order.length - 1; i >= 0; i--) {
    const aid = order[i], a = ctx.acts.get(aid);
    if (a.cstr !== "ALAP" || ctx.status.get(aid) !== "planned") continue;
    const C = ctx.cal.get(aid);
    const ef = Ea.get(aid)[1];
    const slacks = ctx.succs.get(aid).map((r) => rel_slack(ctx, r, Ea, false)).filter((s) => s !== null);
    const lf = L.get(aid)[1];
    const ff = slacks.length ? minOf(slacks) : C.work_between(ef, lf);
    if (ff > 0) {
      let nef = C.add_work(ef, ff), nes;
      if (a.type === "task" && a.rd > 0) nes = C.sub_work(nef, a.rd);
      else if (a.type === "finish_ms") nes = nef;
      else { nef = C.snap_fwd(nef); nes = nef; }
      Ea.set(aid, [nes, nef, nes]);
    }
  }
  const out = {};
  for (const a of acts) {
    const aid = a.id, C = ctx.cal.get(aid);
    const [es, ef, res] = E.get(aid);
    const [xs, xf, xr] = Ea.get(aid);
    const st = ctx.status.get(aid);
    const rec = { es: fmt_dt(xs), ef: fmt_dt(xf), res: fmt_dt(xr), ls: null, lf: null, tf: null, ff: null, crit: false, near: false, lp: false, status: st, pct: pct_complete(p, a) };
    if (st !== "complete") {
      const [ls, lf] = L.get(aid);
      rec.ls = fmt_dt(ls); rec.lf = fmt_dt(lf);
      const fin = C.work_between(ef, lf), sta = C.work_between(res, ls);
      const tf = S.float === "finish" ? fin : S.float === "start" ? sta : Math.min(fin, sta);
      rec.tf = tf;
      const slacks = ctx.succs.get(aid).map((r) => ffs.get(r.id)).filter((s) => s !== null);
      rec.ff = slacks.length ? minOf(slacks) : fin;
      rec.near = tf <= S.near_tf;
    }
    out[aid] = rec;
  }
  if (openEf.length) {
    const last = maxOf(openEf);
    const stack = acts.filter((a) => ctx.status.get(a.id) !== "complete" && ctx.cal.get(a.id).work_between(E.get(a.id)[1], last) === 0).map((a) => a.id);
    const seen = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      out[n].lp = true;
      for (const r of ctx.preds.get(n)) if (relOut[r.id].driving && ctx.status.get(r.pred) !== "complete") stack.push(r.pred);
    }
  }
  for (const a of acts) {
    const rec = out[a.id];
    if (rec.status === "complete") continue;
    rec.crit = S.crit === "longest" ? rec.lp : rec.tf <= S.crit_tf;
    if (rec.crit) rec.near = false;
  }
  return { start: fmt_dt(base), data_date: p.data_date, finish: fmt_dt(pf), anchor: fmt_dt(anchor), acts: out, rels: relOut, oos: out_of_sequence(ctx), order };
}

function out_of_sequence(ctx) {
  const bad = [];
  for (const r of ctx.p.rels) {
    const pa = ctx.acts.get(r.pred), sa = ctx.acts.get(r.succ), t = r.type;
    const mine = t === "FS" || t === "SS" ? sa.as : sa.af;
    if (!mine) continue;
    const ref = t === "FS" || t === "FF" ? pa.af : pa.as;
    if (!ref) { bad.push(r.id); continue; }
    const lc = ctx.lagcal(r);
    const allowed = lag_fwd(lc, parse_dt(ref), r.lag);
    if (lc.work_between(parse_dt(mine), allowed) > 0) bad.push(r.id);
  }
  return bad;
}

function pct_complete(p, a) {
  if (a.af) return 1000;
  if (a.pct_type === "physical") return a.as ? Math.floor(a.phys * 10 + 0.5) : 0;
  if (a.pct_type === "units") {
    let act = 0, rem = 0;
    for (const x of p.assigns) if (x.act === a.id) { act += x.actual; rem += round_div(x.units * a.rd, 60); }
    return act + rem ? round_div(act * 1000, act + rem) : 0;
  }
  if (!a.as) return 0;
  const od = a.od;
  if (od <= 0) return 0;
  return Math.max(0, round_div((od - a.rd) * 1000, od));
}

function wbs_rollup(p, sched) {
  const parent = new Map(p.wbs.map((w) => [w.id, w.parent]));
  const roll = {};
  for (const a of p.activities) {
    const rec = sched.acts[a.id];
    let w = a.wbs, guard = 0;
    while (w !== null && w !== undefined && guard < 1000) {
      const r = roll[w] || (roll[w] = { es: null, ef: null, tf: null, n: 0, crit: false });
      if (r.es === null || rec.es < r.es) r.es = rec.es;
      if (r.ef === null || rec.ef > r.ef) r.ef = rec.ef;
      if (rec.tf !== null && (r.tf === null || rec.tf < r.tf)) r.tf = rec.tf;
      r.n += 1;
      r.crit = r.crit || rec.crit;
      w = parent.get(w);
      guard++;
    }
  }
  return roll;
}
