// ---------------------------------------------------------------- progress, baselines, variance
// Mirrors src/fieldsched/progress.py.
function propose_update(p, sched, newDd) {
  const nd = parse_dt(newDd, "new data date");
  if (nd < parse_dt(p.data_date)) throw new SchedError("bad_date", "The new data date is before the current data date.");
  const ctx = new Ctx(p);
  const out = [];
  for (const a of p.activities) {
    const st = status_of(a);
    if (st === "complete") continue;
    const rec = sched.acts[a.id], C = ctx.cal.get(a.id);
    const es = parse_dt(rec.es), ef = parse_dt(rec.ef), res = parse_dt(rec.res);
    const prop = { act: a.id, code: a.code, as: a.as, af: null, rd: a.rd };
    let why;
    if (st === "planned") {
      if (es >= nd) continue;
      prop.as = rec.es;
      why = `Planned to start ${rec.es.replace("T", " ")}, before the new data date`;
    } else {
      if (res >= nd) continue;
      why = `In progress; planned work continues from ${rec.res.replace("T", " ")}`;
    }
    if (ef <= nd) {
      prop.af = rec.ef;
      prop.rd = 0;
      why += `; planned to finish ${rec.ef.replace("T", " ")}, so it is proposed complete.`;
    } else {
      prop.rd = C.work_between(nd, ef);
      why += "; remaining duration is the planned work after the new data date.";
    }
    if (a.pct_type === "physical") {
      const od = a.od;
      const done = prop.af ? 100 : od ? Math.floor((od - prop.rd) * 100 / od + 0.5) : 0;
      prop.phys = Math.max(0, Math.min(100, done));
    }
    prop.why = why;
    out.push(prop);
  }
  return out;
}

function apply_update(p, props, newDd) {
  const q = Object.assign({}, p, { data_date: fmt_dt(parse_dt(newDd, "new data date")) });
  const acts = new Map(p.activities.map((a) => [a.id, Object.assign({}, a)]));
  for (const pr of props) {
    const a = acts.get(get(pr, "act"));
    if (a === undefined) throw new SchedError("bad_ref", "A proposal points to an activity that does not exist.");
    if (truthy(get(pr, "as"))) a.as = pr.as;
    if (truthy(get(pr, "af"))) a.af = pr.af;
    if (has(pr, "rd") && pr.rd !== null) a.rd = pr.rd;
    if (has(pr, "phys")) a.phys = pr.phys;
  }
  q.activities = p.activities.map((a) => acts.get(a.id));
  return validate_project(q);
}

function take_baseline(p, sched, bid, name, taken) {
  const rows = {};
  for (const a of p.activities) {
    const rec = sched.acts[a.id];
    rows[a.id] = [a.as || rec.es, a.af || rec.ef, a.od];
  }
  const bls = p.baselines.filter((b) => b.id !== bid);
  if (bls.length >= 20) throw new SchedError("too_many", "A project keeps at most 20 baselines. Delete one first.");
  bls.push({ id: bid, name, taken: taken || p.data_date, acts: rows });
  return validate_project(Object.assign({}, p, { baselines: bls, baseline: bid }));
}

function variance(p, sched, bid) {
  bid = bid || p.baseline;
  const bl = p.baselines.find((b) => b.id === bid);
  if (!bl) return {};
  const ctx = new Ctx(p);
  const dd = parse_dt(p.data_date);
  const out = {};
  for (const a of p.activities) {
    const row = has(bl.acts, a.id) ? bl.acts[a.id] : null;
    if (row === null) continue;
    const C = ctx.cal.get(a.id), rec = sched.acts[a.id];
    const cs = parse_dt(a.as || rec.es), cf = parse_dt(a.af || rec.ef);
    const bs = parse_dt(row[0]), bf = parse_dt(row[1]);
    let atc;
    if (a.af) atc = C.work_between(parse_dt(a.as), parse_dt(a.af));
    else if (a.as) atc = C.work_between(parse_dt(a.as), Math.max(dd, parse_dt(a.as))) + a.rd;
    else atc = a.rd;
    out[a.id] = { bs: row[0], bf: row[1], bd: row[2], sv: C.work_between(cs, bs), fv: C.work_between(cf, bf), dv: row[2] - atc };
  }
  return out;
}
