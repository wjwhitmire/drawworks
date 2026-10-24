// ---------------------------------------------------------------- Project XML (MSPDI) files
// Mirrors src/fieldsched/mspdi.py. Codes are listed there with their source.
const MCSTR_IN = { 0: "ASAP", 1: "ALAP", 2: "MS_MAND", 3: "MF_MAND", 4: "SNET", 5: "SNLT", 6: "FNET", 7: "FNLT" };
const MCSTR_OUT = { ASAP: 0, ALAP: 1, MSO: 2, MS_MAND: 2, MFO: 3, MF_MAND: 3, SNET: 4, SNLT: 5, FNET: 6, FNLT: 7 };
const MTYPE_IN = { 0: "FF", 1: "FS", 2: "SF", 3: "SS" };
const MTYPE_OUT = { FF: 0, FS: 1, SF: 2, SS: 3 };
const ELAPSED_FMT = [4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52];
const _DUR_RE = /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

function parse_duration(s, mpd = 480, mpw = 2400) {
  if (!s) return null;
  const m = _DUR_RE.exec(pyStrip(s));
  if (!m) return null;
  const [y, mo, w, d, h, mi, se] = m.slice(1).map((g) => (g ? parseFloat(g) : 0));
  const total = (y * 12 + mo) * 20 * mpd + w * mpw + d * mpd + h * 60 + mi + se / 60;
  const v = Math.floor(total + 0.5);
  return pyStrip(s).startsWith("-") ? -v : v;
}
function fmt_duration(m) { m = Math.max(0, m); return `PT${fdiv(m, 60)}H${m % 60}M0S`; }
function _mdt(s) {
  if (!s) return null;
  try { return fmt_dt(parse_dt(pyStrip(s))); } catch (e) { if (e instanceof SchedError) return null; throw e; }
}
function _mint(s, dflt) { s = pyStrip(s || ""); return /^[+-]?\d{1,15}$/.test(s) ? parseInt(s, 10) : dflt === undefined ? null : dflt; }
function _mnum(s, dflt) { const v = to_num(s); return v !== null && Math.abs(v) < 1e6 ? v : dflt; }
function _mhm(s) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(pyStrip(s || ""));
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return v <= DAY ? v : null;
}
function _mtimes(wd) {
  const out = [];
  for (const wt of xkids(xkid(wd, "WorkingTimes"), "WorkingTime")) {
    const s = _mhm(xval(wt, "FromTime"));
    let f = _mhm(xval(wt, "ToTime"));
    if (s === null || f === null) continue;
    if (f <= s) f = DAY;
    out.push([s, f]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, f] of out) {
    if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], f);
    else merged.push([s, f]);
  }
  return merged;
}
function _day_range(a, b, limit = 3660) {
  let da, tb;
  try {
    if (typeof a !== "string" || typeof b !== "string") return [];
    da = fdiv(parse_dt(pyStrip(a)), DAY);
    tb = parse_dt(pyStrip(b));
  } catch (e) { if (e instanceof SchedError) return []; throw e; }
  let db = mod(tb, DAY) === 0 ? fdiv(tb - 1, DAY) : fdiv(tb, DAY);
  if (db < da) db = da;
  const out = [];
  for (let d = da; d <= Math.min(db, da + limit); d++) out.push(d);
  return out;
}
function _mdedupe(ws) {
  const out = [], n = new Map();
  for (const w of ws) { n.set(w, (n.get(w) || 0) + 1); if (n.get(w) === 1) out.push(w); }
  return out.slice(0, 200).map((w) => (n.get(w) === 1 ? w : `${w} (${n.get(w)} times)`));
}

function read_mspdi(data) {
  let text, enc;
  if (typeof data === "string") { text = data; enc = "text"; } else [text, enc] = decode_bytes(data, "XML file");
  const root = parse_xml(text);
  if (root.tag !== "Project") throw new SchedError("not_mspdi", "This XML file is not a project file (its root element is not Project).");
  const warnings = [];
  const mpd = _mint(xval(root, "MinutesPerDay"), 480) || 480;
  const mpw = _mint(xval(root, "MinutesPerWeek"), mpd * 5) || mpd * 5;
  if (xval(root, "ScheduleFromStart") === "0") warnings.push("The project is scheduled from its finish date; it was scheduled from its start here.");

  const raw = new Map();
  for (const c of xkids(xkid(root, "Calendars"), "Calendar")) {
    const uid = xval(c, "UID");
    if (uid === null) continue;
    const week = [null, null, null, null, null, null, null];
    const exc = new Map();
    for (const wd of xkids(xkid(c, "WeekDays"), "WeekDay")) {
      const dt = _mint(xval(wd, "DayType"), -1);
      const working = xval(wd, "DayWorking") === "1";
      if (dt >= 1 && dt <= 7) week[dt - 1] = working ? _mtimes(wd) : [];
      else if (dt === 0) {
        const tp = xkid(wd, "TimePeriod");
        for (const d of _day_range(xval(tp, "FromDate"), xval(tp, "ToDate"))) exc.set(d, working ? _mtimes(wd) : []);
      }
    }
    for (const ex of xkids(xkid(c, "Exceptions"), "Exception")) {
      const tp = xkid(ex, "TimePeriod");
      const working = xval(ex, "DayWorking") === "1";
      for (const d of _day_range(xval(tp, "FromDate"), xval(tp, "ToDate"))) exc.set(d, working ? _mtimes(ex) : []);
    }
    if (xkid(c, "WorkWeeks") !== null) warnings.push(`Calendar "${xval(c, "Name", uid)}" has alternate work weeks; they were not imported.`);
    raw.set(uid, { name: pySlice(xval(c, "Name") || `Calendar ${uid}`, 0, 120), base: xval(c, "BaseCalendarUID"), week, exc });
  }
  const resolve = (uid, depth = 0) => {
    const r = raw.get(uid);
    let week = r.week.slice();
    let exc = new Map(r.exc);
    const b = r.base;
    if (b && b !== "-1" && raw.has(b) && b !== uid && depth < 10) {
      const [bw, be] = resolve(b, depth + 1);
      week = week.map((w, i) => (w !== null ? w : bw[i]));
      const merged = new Map(be);
      for (const [k, v] of exc) merged.set(k, v);
      exc = merged;
    }
    return [week, exc];
  };
  const cals = [], calIds = new Map();
  for (const uid of raw.keys()) {
    let [week, exc] = resolve(uid);
    const dflt = standard_week();
    week = week.map((w, i) => (w !== null ? w : dflt[i]));
    if (sumWork(week) === 0) {
      warnings.push(`Calendar "${raw.get(uid).name}" has no working time; Monday to Friday 08:00 to 16:00 was used.`);
      week = standard_week();
    }
    const gid = (/^-?\d{1,9}$/.test(uid) ? "c" + uid : `cx${cals.length + 1}`).replace(/-/g, "m");
    calIds.set(uid, gid);
    const exceptions = {};
    for (const d of Array.from(exc.keys()).sort((a, b) => a - b)) exceptions[fmt_dt(d * DAY).slice(0, 10)] = exc.get(d);
    cals.push({ id: gid, name: raw.get(uid).name, hpd: mpd, week, exceptions });
  }
  if (!cals.length) cals.push({ id: "std", name: "Standard", hpd: mpd, week: standard_week(), exceptions: {} });
  const pcalKey = xval(root, "CalendarUID") || "";
  const pcal = calIds.has(pcalKey) ? calIds.get(pcalKey) : cals[0].id;
  const hpdOf = new Map(cals.map((c) => [c.id, c.hpd]));

  const wbs = [], acts = [], stored = {}, baseline = {};
  const actIds = new Map(), used = new Set(), stack = [], links = [];
  for (const t of xkids(xkid(root, "Tasks"), "Task")) {
    const uid = xval(t, "UID");
    if (uid === null || uid === "0" || xval(t, "IsNull") === "1") continue;
    if (xval(t, "Active") === "0") { warnings.push(`"${xval(t, "Name", uid)}" is inactive; it was skipped.`); continue; }
    if (!/^\d{1,12}$/.test(uid) || used.has(uid)) { warnings.push("A task without a usable UID was skipped."); continue; }
    used.add(uid);
    const level = _mint(xval(t, "OutlineLevel"), 1) || 1;
    while (stack.length && stack[stack.length - 1][0] >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1][1] : null;
    const name = xval(t, "Name") || "";
    if (xval(t, "Summary") === "1") {
      const wid = "w" + uid;
      wbs.push({ id: wid, code: pySlice(xval(t, "WBS") || xval(t, "OutlineNumber") || wid, 0, 60), name, parent });
      stack.push([level, wid]);
      continue;
    }
    const gid = "t" + uid;
    const code = pySlice(xval(t, "WBS") || xval(t, "ID") || uid, 0, 40);
    const df = _mint(xval(t, "DurationFormat"), 7);
    if (ELAPSED_FMT.includes(df)) warnings.push(`${code} has an elapsed duration; it was imported as working time.`);
    const od = parse_duration(xval(t, "Duration"), mpd, mpw) || 0;
    const rdv = parse_duration(xval(t, "RemainingDuration"), mpd, mpw);
    let as = _mdt(xval(t, "ActualStart")), af = _mdt(xval(t, "ActualFinish"));
    if (af && !as) as = af;
    if (as && af && af < as) af = null;
    const rd = af ? 0 : rdv !== null ? rdv : od;
    const milestone = xval(t, "Milestone") === "1" && od === 0;
    let cs = lookup(MCSTR_IN, xval(t, "ConstraintType") || "0", "ASAP");
    const cd = _mdt(xval(t, "ConstraintDate"));
    if (cs !== "ASAP" && cs !== "ALAP" && !cd) cs = "ASAP";
    const cuid = xval(t, "CalendarUID");
    let cal = cuid && cuid !== "-1" ? (calIds.has(cuid) ? calIds.get(cuid) : null) : null;
    if (cal === pcal) cal = null;
    const ppc = _mnum(xval(t, "PhysicalPercentComplete"), 0);
    const notes = xval(t, "Notes") || "";
    actIds.set(uid, gid);
    acts.push({ id: gid, code, name, wbs: parent, cal, type: milestone ? "finish_ms" : "task", od: Math.max(0, od), rd: Math.max(0, rd), as, af,
      pct_type: ppc > 0 ? "physical" : "duration", phys: Math.min(100, Math.max(0, ppc)), cstr: cs, cstr_date: cs !== "ASAP" && cs !== "ALAP" ? cd : null,
      unit: [5, 6, 37, 38].includes(df) || mod(od, hpdOf.get(cal || pcal)) ? "h" : "d", notes });
    const ts = _mint(xval(t, "TotalSlack")), fs = _mint(xval(t, "FreeSlack"));
    stored[gid] = { es: _mdt(xval(t, "EarlyStart")), ef: _mdt(xval(t, "EarlyFinish")), ls: _mdt(xval(t, "LateStart")), lf: _mdt(xval(t, "LateFinish")),
      tf: ts !== null ? round_div(ts, 10) : null, ff: fs !== null ? round_div(fs, 10) : null, start: _mdt(xval(t, "Start")), finish: _mdt(xval(t, "Finish")) };
    for (const b of xkids(t, "Baseline")) {
      if (xval(b, "Number") === "0") {
        const bs = _mdt(xval(b, "Start")), bf = _mdt(xval(b, "Finish"));
        if (bs && bf) baseline[gid] = [bs, bf, parse_duration(xval(b, "Duration"), mpd, mpw) || 0];
      }
    }
    for (const pl of xkids(t, "PredecessorLink")) links.push([gid, pl, code]);
  }
  const rels = [], seen = new Set();
  const odOf = new Map(acts.map((a) => [a.id, a]));
  for (const [gid, pl, code] of links) {
    const pu = xval(pl, "PredecessorUID");
    if (xval(pl, "CrossProject") === "1" || !actIds.has(pu)) {
      if (!actIds.has(pu)) warnings.push("A link to a summary task, an inactive task or another project was skipped.");
      continue;
    }
    const pr = actIds.get(pu);
    const typ = lookup(MTYPE_IN, xval(pl, "Type") || "1", "FS");
    const lf = _mint(xval(pl, "LagFormat"), 7);
    const rawLag = _mint(xval(pl, "LinkLag"), 0) || 0;
    let elapsed = ELAPSED_FMT.includes(lf), lag;
    if ([19, 20, 51, 52].includes(lf)) {
      lag = round_div(odOf.get(pr).od * rawLag, 1000);
      warnings.push(`A percent lag into ${code} was converted to working time.`);
      elapsed = false;
    } else lag = round_div(rawLag, 10);
    const key = pr + "\u0000" + gid + "\u0000" + typ;
    if (seen.has(key) || pr === gid) continue;
    seen.add(key);
    rels.push({ id: `l${rels.length + 1}`, pred: pr, succ: gid, type: typ, lag, elapsed });
  }
  const rsrcs = [], rsrcIds = new Map();
  for (const r of xkids(xkid(root, "Resources"), "Resource")) {
    const uid = xval(r, "UID");
    if (!uid || uid === "0" || xval(r, "IsNull") === "1" || !/^\d{1,12}$/.test(uid) || rsrcIds.has(uid)) continue;
    const typ = lookup({ 1: "labor", 0: "material" }, xval(r, "Type") || "1", null);
    if (typ === null) continue;
    const rid = "r" + uid;
    rsrcIds.set(uid, rid);
    const mu = _mnum(xval(r, "MaxUnits"), 1.0);
    rsrcs.push({ id: rid, code: pySlice(xval(r, "Initials") || xval(r, "Name") || rid, 0, 40), name: xval(r, "Name") || "", type: typ,
      max_units: Math.max(0, Math.floor(mu * 1000 + 0.5)), unit: typ === "material" ? pySlice(xval(r, "MaterialLabel") || "ea", 0, 20) : "h" });
  }
  const asg = [];
  for (const x of xkids(xkid(root, "Assignments"), "Assignment")) {
    const tk = xval(x, "TaskUID") || "", rk = xval(x, "ResourceUID") || "";
    const a = actIds.has(tk) ? actIds.get(tk) : null, r = rsrcIds.has(rk) ? rsrcIds.get(rk) : null;
    if (a === null || r === null) continue;
    const units = Math.floor(_mnum(xval(x, "Units"), 1.0) * 1000 + 0.5);
    const work = parse_duration(xval(x, "Work"), mpd, mpw);
    const actual = parse_duration(xval(x, "ActualWork"), mpd, mpw) || 0;
    const budget = work !== null ? round_div(work * 1000, 60) : round_div(units * odOf.get(a).od, 60);
    asg.push({ id: `x${asg.length + 1}`, act: a, rsrc: r, units: Math.max(0, units), budget: Math.max(0, budget), actual: Math.max(0, round_div(actual * 1000, 60)) });
  }
  const starts = Object.values(stored).filter((s) => s.start).map((s) => s.start);
  const start = _mdt(xval(root, "StartDate")) || (starts.length ? minOf(starts) : null) || "2026-01-01T08:00";
  const dd = _mdt(xval(root, "StatusDate")) || start;
  const bls = Object.keys(baseline).length ? [{ id: "bl0", name: "Baseline in the file", taken: dd, acts: baseline }] : [];
  const ids = new Set(wbs.map((w) => w.id));
  for (const w of wbs) if (!ids.has(w.parent)) w.parent = null;
  const proj = validate_project({ id: "p1", name: pySlice(xval(root, "Title") || xval(root, "Name") || "Imported project", 0, 200), start, data_date: dd, cal: pcal,
    calendars: cals, wbs, activities: acts, rels, resources: rsrcs, assigns: asg, baselines: bls, baseline: bls.length ? "bl0" : null, settings: { lag_cal: "succ" } });
  const report = { format: "MSPDI", encoding: enc, version: xval(root, "SaveVersion") || "",
    counts: { activities: acts.length, rels: rels.length, wbs: wbs.length, calendars: cals.length, resources: rsrcs.length, assigns: asg.length },
    warnings: _mdedupe(warnings), tables: {}, unknown_tables: [] };
  return { project: proj, report, stored, projects: [] };
}

function tree_rows(p) {
  const kidsOf = new Map(), actsOf = new Map();
  for (const w of p.wbs) { if (!kidsOf.has(w.parent)) kidsOf.set(w.parent, []); kidsOf.get(w.parent).push(w); }
  for (const a of p.activities) { if (!actsOf.has(a.wbs)) actsOf.set(a.wbs, []); actsOf.get(a.wbs).push(a); }
  const items = (parent) => (actsOf.get(parent) || []).map((a) => ["a", a]).concat((kidsOf.get(parent) || []).map((w) => ["w", w]));
  const rows = [], frames = [[items(null), 0, 1, ""]];
  while (frames.length) {
    const f = frames[frames.length - 1];
    const [its, i, level, prefix] = f;
    if (i >= its.length) { frames.pop(); continue; }
    f[1]++;
    const [kind, x] = its[i];
    const num = prefix + String(i + 1);
    rows.push([kind, x, level, num]);
    if (kind === "w") frames.push([items(x.id), 0, level + 1, num + "."]);
  }
  return rows;
}
const _mx = (s) => (s ? s + ":00" : "");
const milli = (v) => `${fdiv(v, 1000)}.${pad(v % 1000, 3)}`;
// Project holds Duration = ActualDuration + RemainingDuration for every task
function _mactual(a) { return a.af ? a.od : a.as ? Math.max(0, a.od - a.rd) : 0; }
function _mdur(a) { return a.af ? a.od : _mactual(a) + a.rd; }
function write_mspdi(p, sched) {
  const E = xml_escape;
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<Project xmlns="http://schemas.microsoft.com/project">'];
  const calUid = new Map(p.calendars.map((c, i) => [c.id, i + 1]));
  const pc = p.calendars.find((c) => c.id === p.cal);
  const mpd = pc.hpd;
  const mpw = sumWork(pc.week) || mpd * 5;
  const first = pc.week[1].length ? pc.week[1][0][0] : 480;
  const tag = (name, v) => out.push(`<${name}>${E(v)}</${name}>`);
  tag("SaveVersion", 14); tag("Name", p.name); tag("Title", p.name); tag("ScheduleFromStart", 1); tag("StartDate", _mx(p.start)); tag("FinishDate", _mx(sched.finish));
  tag("CriticalSlackLimit", round_div(p.settings.crit_tf, mpd)); tag("CurrencyCode", "USD"); tag("CalendarUID", calUid.get(p.cal)); tag("DefaultStartTime", fmt_hm(first) + ":00");
  tag("MinutesPerDay", mpd); tag("MinutesPerWeek", mpw); tag("DaysPerMonth", 20); tag("DurationFormat", 7); tag("HonorConstraints", 1);
  tag("StatusDate", _mx(p.data_date)); tag("CurrentDate", _mx(p.data_date)); tag("NewTaskStartDate", 0);
  const wt = (ivs) => "<WorkingTimes>" + ivs.map(([s, f]) => `<WorkingTime><FromTime>${fmt_hm(s)}:00</FromTime><ToTime>${fmt_hm(f % DAY)}:00</ToTime></WorkingTime>`).join("") + "</WorkingTimes>";
  out.push("<Calendars>");
  for (const c of p.calendars) {
    out.push("<Calendar>");
    tag("UID", calUid.get(c.id)); tag("Name", c.name); tag("IsBaseCalendar", 1); tag("BaseCalendarUID", -1);
    out.push("<WeekDays>");
    for (let d = 0; d < 7; d++) {
      const ivs = c.week[d];
      out.push(`<WeekDay><DayType>${d + 1}</DayType><DayWorking>${ivs.length ? 1 : 0}</DayWorking>`);
      if (ivs.length) out.push(wt(ivs));
      out.push("</WeekDay>");
    }
    out.push("</WeekDays>");
    const keys = Object.keys(c.exceptions);
    if (keys.length) {
      out.push("<Exceptions>");
      const items = keys.map((k) => [parse_day(k), c.exceptions[k]]).sort((a, b) => a[0] - b[0]);
      const groups = [];
      for (const [d, v] of items) {
        const g = groups[groups.length - 1];
        if (g && g[1] === d - 1 && JSON.stringify(g[2]) === JSON.stringify(v)) g[1] = d;
        else groups.push([d, d, v]);
      }
      for (const [a, b, v] of groups) {
        out.push("<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod>" +
          `<FromDate>${fmt_dt(a * DAY)}:00</FromDate><ToDate>${fmt_dt(b * DAY + 1439)}:00</ToDate></TimePeriod>` +
          `<Occurrences>1</Occurrences><Name>${!v.length ? "Holiday" : "Exception"}</Name><Type>1</Type><DayWorking>${v.length ? 1 : 0}</DayWorking>`);
        if (v.length) out.push(wt(v));
        out.push("</Exception>");
      }
      out.push("</Exceptions>");
    }
    out.push("</Calendar>");
  }
  out.push("</Calendars>");
  const rows = tree_rows(p);
  const roll = wbs_rollup(p, sched);
  const uidA = new Map(), uidW = new Map();
  rows.forEach(([kind, x], i) => (kind === "a" ? uidA : uidW).set(x.id, i + 1));
  const preds = new Map();
  for (const r of p.rels) { if (!preds.has(r.succ)) preds.set(r.succ, []); preds.get(r.succ).push(r); }
  const bl = p.baselines.find((b) => b.id === p.baseline) || null;
  const hpdOf = new Map(p.calendars.map((c) => [c.id, c.hpd]));
  out.push("<Tasks>");
  out.push(`<Task><UID>0</UID><ID>0</ID><Name>${E(p.name)}</Name><Type>1</Type><IsNull>0</IsNull><OutlineNumber>0</OutlineNumber><OutlineLevel>0</OutlineLevel>` +
    `<Start>${_mx(sched.start)}</Start><Finish>${_mx(sched.finish)}</Finish><Summary>1</Summary></Task>`);
  rows.forEach(([k, x, level, onum], i) => {
    if (k === "w") {
      const r = roll[x.id] || {};
      out.push(`<Task><UID>${uidW.get(x.id)}</UID><ID>${i + 1}</ID><Name>${E(x.name || x.code)}</Name><Type>1</Type><IsNull>0</IsNull><WBS>${E(x.code)}</WBS>` +
        `<OutlineNumber>${onum}</OutlineNumber><OutlineLevel>${level}</OutlineLevel>` + (r.es ? `<Start>${_mx(r.es)}</Start><Finish>${_mx(r.ef)}</Finish>` : "") +
        "<Milestone>0</Milestone><Summary>1</Summary></Task>");
      return;
    }
    const a = x, rec = sched.acts[a.id], hpd = hpdOf.get(a.cal || p.cal);
    out.push("<Task>");
    tag("UID", uidA.get(a.id)); tag("ID", i + 1); tag("Name", a.name); tag("Type", 1); tag("IsNull", 0); tag("WBS", a.code); tag("OutlineNumber", onum); tag("OutlineLevel", level);
    tag("Start", _mx(a.as || rec.es)); tag("Finish", _mx(a.af || rec.ef)); tag("Duration", fmt_duration(_mdur(a))); tag("DurationFormat", a.unit === "d" ? 7 : 5);
    tag("Milestone", a.type !== "task" ? 1 : 0); tag("Summary", 0); tag("Critical", rec.crit ? 1 : 0); tag("EarlyStart", _mx(rec.es)); tag("EarlyFinish", _mx(rec.ef));
    if (rec.ls) { tag("LateStart", _mx(rec.ls)); tag("LateFinish", _mx(rec.lf)); }
    if (rec.ff !== null) { tag("FreeSlack", rec.ff * 10); tag("TotalSlack", rec.tf * 10); }
    tag("PercentComplete", a.af ? 100 : !a.as || !a.od ? 0 : Math.max(0, Math.min(99, fdiv((a.od - a.rd) * 100, a.od))));
    if (a.as) tag("ActualStart", _mx(a.as));
    if (a.af) tag("ActualFinish", _mx(a.af));
    if (a.as) tag("ActualDuration", fmt_duration(_mactual(a)));
    tag("RemainingDuration", fmt_duration(a.rd)); tag("ConstraintType", MCSTR_OUT[a.cstr]); tag("CalendarUID", a.cal ? calUid.get(a.cal) : -1);
    if (a.cstr_date) tag("ConstraintDate", _mx(a.cstr_date));
    if (a.notes) tag("Notes", a.notes);
    if (a.pct_type === "physical") tag("PhysicalPercentComplete", a.phys);
    for (const r of preds.get(a.id) || []) {
      const fmt = mod(r.lag, hpd) === 0 ? (r.elapsed ? 8 : 7) : r.elapsed ? 6 : 5;
      out.push(`<PredecessorLink><PredecessorUID>${uidA.get(r.pred)}</PredecessorUID><Type>${MTYPE_OUT[r.type]}</Type><CrossProject>0</CrossProject><LinkLag>${r.lag * 10}</LinkLag><LagFormat>${fmt}</LagFormat></PredecessorLink>`);
    }
    if (bl && has(bl.acts, a.id)) {
      const b = bl.acts[a.id];
      out.push(`<Baseline><Number>0</Number><Start>${_mx(b[0])}</Start><Finish>${_mx(b[1])}</Finish><Duration>${fmt_duration(b[2])}</Duration><DurationFormat>7</DurationFormat></Baseline>`);
    }
    out.push("</Task>");
  });
  out.push("</Tasks>");
  out.push("<Resources>");
  const ruid = new Map();
  p.resources.forEach((r, i) => {
    ruid.set(r.id, i + 1);
    out.push(`<Resource><UID>${i + 1}</UID><ID>${i + 1}</ID><Name>${E(r.name || r.code)}</Name><Type>${r.type === "material" ? 0 : 1}</Type><IsNull>0</IsNull><Initials>${E(r.code)}</Initials>` +
      (r.type === "material" ? `<MaterialLabel>${E(r.unit)}</MaterialLabel>` : "") + `<MaxUnits>${milli(r.max_units)}</MaxUnits></Resource>`);
  });
  out.push("</Resources>");
  out.push("<Assignments>");
  const actsById = new Map(p.activities.map((a) => [a.id, a]));
  p.assigns.forEach((x, i) => {
    const a = actsById.get(x.act);
    const rem = round_div(x.units * a.rd, 1000);
    out.push(`<Assignment><UID>${i + 1}</UID><TaskUID>${uidA.get(x.act)}</TaskUID><ResourceUID>${ruid.get(x.rsrc)}</ResourceUID>` +
      `<ActualWork>${fmt_duration(round_div(x.actual * 60, 1000))}</ActualWork><RemainingWork>${fmt_duration(rem)}</RemainingWork>` +
      `<Units>${milli(x.units)}</Units><Work>${fmt_duration(round_div(x.budget * 60, 1000))}</Work></Assignment>`);
  });
  out.push("</Assignments>");
  out.push("</Project>");
  return out.join("\n") + "\n";
}
