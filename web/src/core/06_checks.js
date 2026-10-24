// ---------------------------------------------------------------- schedule quality check and fixes
// Mirrors src/fieldsched/checks.py: the DCMA 14-point assessment with its published thresholds, then
// out-of-sequence progress.
const CSTR_WORDS = { SNET: "start on or after", FNET: "finish on or after", MSO: "start on", MFO: "finish on", SNLT: "start on or before",
  FNLT: "finish on or before", MS_MAND: "mandatory start", MF_MAND: "mandatory finish" };
const HARD = { MSO: "SNET", SNLT: "SNET", MS_MAND: "SNET", MFO: "FNET", FNLT: "FNET", MF_MAND: "FNET" };
const MAX_FIXES = 500;

function open_ends(p) {
  const preds = new Map(p.activities.map((a) => [a.id, []]));
  const succs = new Map(p.activities.map((a) => [a.id, []]));
  for (const r of p.rels) { preds.get(r.succ).push(r.type); succs.get(r.pred).push(r.type); }
  const rows = [];
  for (const a of p.activities) {
    if (a.af) continue;
    const i = a.id, pr = preds.get(i), su = succs.get(i);
    if (!pr.length && a.type !== "start_ms") rows.push({ act: i, kind: "no_pred" });
    else if (pr.length && !pr.some((t) => t === "FS" || t === "SS")) rows.push({ act: i, kind: "start_dangle" });
    if (!su.length && a.type !== "finish_ms") rows.push({ act: i, kind: "no_succ" });
    else if (su.length && !su.some((t) => t === "FS" || t === "FF")) rows.push({ act: i, kind: "finish_dangle" });
  }
  return rows;
}
function _reach(adj, src, dst) {
  const seen = new Set([src]), stack = [src];
  while (stack.length) {
    const n = stack.pop();
    if (n === dst) return true;
    for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); stack.push(m); }
  }
  return false;
}
function _days(m, hpd) { const s = fmt_fixed(m, hpd, 2); return s.includes(".") ? rstripChars(rstripChars(s, "0"), ".") : s; }

function check(p, sched) {
  const S = p.settings;
  const acts = new Map(p.activities.map((a) => [a.id, a]));
  const calHpd = new Map(p.calendars.map((c) => [c.id, c.hpd]));
  const hpd = calHpd.get(p.cal);
  const succAdj = new Map();
  for (const r of p.rels) { if (!succAdj.has(r.pred)) succAdj.set(r.pred, []); succAdj.get(r.pred).push(r.succ); }
  const rec = sched.acts;
  const incomplete = p.activities.filter((a) => !a.af);
  const starts = incomplete.filter((a) => a.type === "start_ms");
  const fins = incomplete.filter((a) => a.type === "finish_ms").sort((x, y) => cmpTuple([rec[x.id].ef, x.code], [rec[y.id].ef, y.code]));
  const startMs = starts.length ? starts[0].id : null;
  const finishMs = fins.length ? fins[fins.length - 1].id : null;
  const out = [];
  let nfix = 0;
  const bl = p.baselines.find((b) => b.id === p.baseline) || null;
  const add = (code, sev, msg, act = null, rel = null, fix = null, label = null) => {
    if (fix !== null) { if (nfix >= MAX_FIXES) { fix = null; label = null; } else nfix++; }
    out.push({ code, sev, act, rel, msg, fix, fix_label: label });
  };
  const hpdOf = (a) => calHpd.get(a.cal || p.cal);
  for (const oe of open_ends(p)) {
    const a = acts.get(oe.act), k = oe.kind;
    if (k === "no_pred") {
      let fix = null;
      if (startMs && startMs !== a.id && nfix < MAX_FIXES && !_reach(succAdj, a.id, startMs)) fix = { kind: "add_rel", pred: startMs, succ: a.id, type: "FS", lag: 0 };
      add("open_start", "warn", `${a.code} has no predecessor.`, a.id, null, fix, fix ? `Link from ${acts.get(startMs).code}` : null);
    } else if (k === "no_succ") {
      let fix = null;
      if (finishMs && finishMs !== a.id && nfix < MAX_FIXES && !_reach(succAdj, finishMs, a.id)) fix = { kind: "add_rel", pred: a.id, succ: finishMs, type: "FS", lag: 0 };
      add("open_finish", "warn", `${a.code} has no successor.`, a.id, null, fix, fix ? `Link to ${acts.get(finishMs).code}` : null);
    } else if (k === "start_dangle") add("start_dangle", "warn", `${a.code} has only FF or SF predecessors, so nothing drives its start.`, a.id);
    else add("finish_dangle", "warn", `${a.code} has only SS or SF successors, so its finish drives nothing.`, a.id);
  }
  for (const r of p.rels) {
    const pa = acts.get(r.pred), sa = acts.get(r.succ);
    if (pa.af && sa.af) continue;
    const name = `${pa.code} to ${sa.code} ${r.type}`;
    if (r.lag < 0) {
      let fix = null, label = null;
      if (r.type === "FS" && pa.type === "task" && pa.od + r.lag > 0) {
        if (!p.rels.some((x) => x.pred === pa.id && x.succ === sa.id && x.type === "SS")) {
          fix = { kind: "set_rel", rel: r.id, type: "SS", lag: pa.od + r.lag };
          label = `Make it SS ${_days(pa.od + r.lag, hpd)}d`;
        }
      }
      add("lead", "warn", `${name} has a negative lag (a lead) of ${_days(-r.lag, hpd)} days.`, null, r.id, fix, label);
    } else if (r.lag > S.long_lag) {
      add("long_lag", "info", `${name} has a lag of ${_days(r.lag, hpd)} days. A lag that long usually hides work; consider an activity.`, null, r.id);
    }
    if (r.type === "SF") add("sf_link", "info", `${name} is a start-to-finish link. These are rare and easy to misread.`, null, r.id);
  }
  const hasSucc = new Set(p.rels.map((r) => r.pred));
  for (const a of incomplete) {
    if (has(HARD, a.cstr)) {
      const msg = `${a.code} has a ${CSTR_WORDS[a.cstr]} constraint (${a.cstr}), which holds dates against logic.`;
      if (a.cstr === "FNLT" && !hasSucc.has(a.id)) add("hard_constraint", "warn", msg, a.id, null, { kind: "set_deadline", act: a.id, date: a.cstr_date }, "Make it the must-finish-by date");
      else if (a.cstr === "FNLT" || a.cstr === "SNLT") add("hard_constraint", "warn", msg + " Keep it only if it is a contract date.", a.id);
      else { const soft = HARD[a.cstr]; add("hard_constraint", "warn", msg, a.id, null, { kind: "set_cstr", act: a.id, cstr: soft, date: a.cstr_date }, `Change to ${CSTR_WORDS[soft]}`); }
    }
    const r = rec[a.id];
    if (r.tf !== null && r.tf < 0) add("neg_float", "error", `${a.code} has negative float of ${_days(r.tf, hpdOf(a))} days. Check its constraints and the must-finish-by date.`, a.id);
    else if (r.tf !== null && r.tf > S.high_float) add("high_float", "info", `${a.code} has ${_days(r.tf, hpdOf(a))} days of total float. Missing logic is the usual cause.`, a.id);
    const inBl = bl && has(bl.acts, a.id);
    const d = inBl ? bl.acts[a.id][2] : a.od, what = inBl ? "a baseline" : "an original";
    if (a.type === "task" && d > S.high_dur) add("high_dur", "info", `${a.code} has ${what} duration of ${_days(d, hpdOf(a))} days. Long activities are hard to status; consider splitting it.`, a.id);
  }
  const dd = parse_dt(p.data_date);
  for (const a of p.activities) if ((a.as && parse_dt(a.as) > dd) || (a.af && parse_dt(a.af) > dd)) add("invalid_dates", "error", `${a.code} has an actual date after the data date.`, a.id);
  for (const rid of sched.oos) {
    const r = p.rels.find((x) => x.id === rid);
    add("oos", "warn", `Out of sequence: ${acts.get(r.succ).code} has progress before ${acts.get(r.pred).code} allows (${r.type}). ` +
      `Under ${S.oos === "retained" ? "retained logic" : "progress override"} the remaining work is scheduled accordingly; fix the actual dates or change the link.`, acts.get(r.succ).id, rid);
  }
  // 12: the longest path must run back through driving links to an activity that starts at the
  // data date; a path that begins later is held by a constraint or a gap in the logic
  const cals = new Map();
  const calOf = (a) => {
    const cid = a.cal || p.cal;
    if (!cals.has(cid)) cals.set(cid, compile_calendar(p.calendars.find((c) => c.id === cid)));
    return cals.get(cid);
  };
  const base = parse_dt(sched.start);
  const lp = p.activities.filter((a) => rec[a.id].lp);
  const driven = new Set(p.rels.filter((r) => sched.rels[r.id].driving && rec[r.pred].lp && rec[r.succ].lp).map((r) => r.succ));
  const cpBreaks = lp.filter((a) => !driven.has(a.id) && calOf(a).work_between(base, parse_dt(rec[a.id].res)) !== 0);
  for (const a of cpBreaks) add("cp_test", "warn", `The longest path starts at ${a.code}, later than the data date, so a constraint or a missing link holds it.`, a.id);

  const n = incomplete.length || 1;
  const nrel = p.rels.filter((r) => !(acts.get(r.pred).af && acts.get(r.succ).af)).length || 1;
  const count = {};
  for (const f of out) count[f.code] = (count[f.code] || 0) + 1;
  const missing = new Set(out.filter((f) => ["open_start", "open_finish", "start_dangle", "finish_dangle"].includes(f.code)).map((f) => f.act)).size;
  const live = p.rels.filter((r) => !(acts.get(r.pred).af && acts.get(r.succ).af));
  const fs = live.filter((r) => r.type === "FS").length;
  const hasRsrc = new Set(p.assigns.map((x) => x.act));
  const noRsrc = incomplete.filter((a) => a.type === "task" && a.od >= hpdOf(a) && !hasRsrc.has(a.id)).length;
  const due = p.activities.filter((a) => bl && has(bl.acts, a.id) && bl.acts[a.id][1] && parse_dt(bl.acts[a.id][1]) <= dd);
  const missed = due.filter((a) => !a.af || parse_dt(a.af) > parse_dt(bl.acts[a.id][1])).length;
  const done = p.activities.filter((a) => a.af).length;
  const metrics = [];
  const share = (name, dcma, num, den, limit, unit) => {
    const permille = fdiv(num * 1000 + fdiv(den, 2), den);
    metrics.push({ name, dcma, kind: "share", unit, count: num, of: den, permille, limit, pass: limit === null ? null : permille <= limit });
  };
  const index = (name, dcma, num, den, unit) => {
    const ok = den > 0, permille = ok ? round_div(num * 1000, den) : null;
    metrics.push({ name, dcma, kind: "index", unit, count: num, of: den, permille, limit: 950, pass: ok ? permille >= 950 : null });
  };
  share("Logic", 1, missing, n, 50, "act");
  share("Leads", 2, count.lead || 0, nrel, 0, "rel");
  share("Lags", 3, live.filter((r) => r.lag > 0).length, nrel, 50, "rel");
  share("Relationship types (not finish to start)", 4, live.length - fs, nrel, 100, "rel");
  share("Hard constraints", 5, count.hard_constraint || 0, n, 50, "act");
  share("High float", 6, count.high_float || 0, n, 50, "act");
  share("Negative float", 7, count.neg_float || 0, n, 0, "act");
  share("High duration", 8, count.high_dur || 0, n, 50, "act");
  share("Invalid dates", 9, count.invalid_dates || 0, n, 0, "act");
  share("Resources (none assigned)", 10, noRsrc, n, null, "act");
  if (due.length) share("Missed activities", 11, missed, due.length, 50, "act");
  else metrics.push({ name: "Missed activities", dcma: 11, kind: "share", unit: "act", count: 0, of: 0, permille: null, limit: 50, pass: null });
  metrics.push({ name: "Critical path test", dcma: 12, kind: "test", unit: "act", count: cpBreaks.length, of: lp.length, permille: null, limit: null, pass: lp.length ? !cpBreaks.length : null });
  const pc = calOf({ cal: null });
  const fin = parse_dt(sched.finish);
  // the target finish: the must-finish-by date, else the latest baseline finish
  let target = p.finish_by;
  if (target === null && bl) for (const k of Object.keys(bl.acts)) { const f = bl.acts[k][1]; if (f && (target === null || f > target)) target = f; }
  const cpl = pc.work_between(base, fin);
  if (target === null || cpl <= 0) index("Critical path length index", 13, 0, 0, "min");
  else index("Critical path length index", 13, cpl + pc.work_between(fin, parse_dt(target)), cpl, "min");
  index("Baseline execution index", 14, done, due.length, "act");
  share("Out of sequence", null, count.oos || 0, nrel, 0, "rel");
  return { findings: out, metrics, counts: count };
}

function _next_id(rows, prefix) {
  const used = new Set(rows.map((r) => r.id));
  let n = rows.length + 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
function apply_fix(p, fix) {
  const k = get(fix, "kind");
  if (k === "add_rel") {
    const rel = { id: _next_id(p.rels, "r"), pred: fix.pred, succ: fix.succ, type: fix.type, lag: fix.lag, elapsed: false };
    return validate_project(Object.assign({}, p, { rels: p.rels.concat([rel]) }));
  }
  if (k === "set_rel") return validate_project(Object.assign({}, p, { rels: p.rels.map((r) => (r.id === fix.rel ? Object.assign({}, r, { type: fix.type, lag: fix.lag }) : r)) }));
  if (k === "set_deadline") {
    const acts = p.activities.map((a) => (a.id === fix.act ? Object.assign({}, a, { cstr: "ASAP", cstr_date: null }) : a));
    const fb = p.finish_by && p.finish_by < fix.date ? p.finish_by : fix.date;
    return validate_project(Object.assign({}, p, { activities: acts, finish_by: fb }));
  }
  if (k === "set_cstr") return validate_project(Object.assign({}, p, { activities: p.activities.map((a) => (a.id === fix.act ? Object.assign({}, a, { cstr: fix.cstr, cstr_date: fix.date }) : a)) }));
  throw new SchedError("bad_fix", "Unknown fix.");
}
