// ---------------------------------------------------------------- Primavera P6 XER files
// Mirrors src/fieldsched/xer.py. Tables and rows use prototype-free objects so that a hostile file
// naming a table or field "__proto__" stays an ordinary key.
const XER_MAX_ROWS = 2000000;
const SERIAL_EPOCH = days_from_civil(1899, 12, 30);
const XER_KNOWN = new Set(["PROJECT", "CALENDAR", "SCHEDOPTIONS", "PROJWBS", "TASK", "TASKPRED", "RSRC", "RSRCRATE", "TASKRSRC"]);
const XCSTR_IN = { CS_MSO: "MSO", CS_MSOA: "SNET", CS_MSOB: "SNLT", CS_MEO: "MFO", CS_MEOA: "FNET", CS_MEOB: "FNLT", CS_ALAP: "ALAP", CS_MANDSTART: "MS_MAND", CS_MANDFIN: "MF_MAND" };
const XCSTR_OUT = Object.fromEntries(Object.entries(XCSTR_IN).map(([k, v]) => [v, k]));
const XPCT_IN = { CP_Drtn: "duration", CP_Phys: "physical", CP_Units: "units" };
const XPCT_OUT = Object.fromEntries(Object.entries(XPCT_IN).map(([k, v]) => [v, k]));
const XRSRC_IN = { RT_Labor: "labor", RT_Equip: "nonlabor", RT_Mat: "material" };
const XRSRC_OUT = Object.fromEntries(Object.entries(XRSRC_IN).map(([k, v]) => [v, k]));
// SCHEDOPTIONS codes (total float and relationship lag calendar)
const XFLOAT_IN = { FT_FF: "finish", FT_SS: "start", FT_Min: "min" };
const XFLOAT_OUT = Object.fromEntries(Object.entries(XFLOAT_IN).map(([k, v]) => [v, k]));
const XLAGCAL_IN = { rcal_Predecessor: "pred", rcal_Successor: "succ", rcal_24Hour: "24h", rcal_ProjDefault: "project" };
const XLAGCAL_OUT = Object.fromEntries(Object.entries(XLAGCAL_IN).map(([k, v]) => [v, k]));
// PROJECT fields a P6 export carries, with the values a new P6 project gets; write_xer fills in the rest
const XPROJECT_FIELDS = ["proj_id", "fy_start_month_num", "rsrc_self_add_flag", "allow_complete_flag", "rsrc_multi_assign_flag", "checkout_flag", "project_flag", "step_complete_flag",
  "cost_qty_recalc_flag", "batch_sum_flag", "name_sep_char", "def_complete_pct_type", "proj_short_name", "clndr_id", "task_code_base", "task_code_step", "priority_num", "wbs_max_sum_level",
  "strgy_priority_num", "critical_drtn_hr_cnt", "last_recalc_date", "plan_start_date", "plan_end_date", "scd_end_date", "add_date", "def_duration_type", "task_code_prefix", "def_qty_type",
  "add_by_name", "def_rate_type", "add_act_remain_flag", "act_this_per_link_flag", "def_task_type", "act_pct_link_flag", "critical_path_type", "task_code_prefix_flag", "def_rollup_dates_flag",
  "use_project_baseline_flag", "rem_target_link_flag", "reset_planned_flag", "allow_neg_act_flag", "sum_assign_level", "export_flag"];
const XPROJECT_DEFAULTS = { fy_start_month_num: 1, rsrc_self_add_flag: "Y", allow_complete_flag: "Y", rsrc_multi_assign_flag: "Y", checkout_flag: "N", project_flag: "Y", step_complete_flag: "N",
  cost_qty_recalc_flag: "N", batch_sum_flag: "Y", name_sep_char: ".", def_complete_pct_type: "CP_Drtn", task_code_base: 1000, task_code_step: 10, priority_num: 10, wbs_max_sum_level: 0,
  strgy_priority_num: 100, def_duration_type: "DT_FixedDUR2", task_code_prefix: "A", def_qty_type: "QT_Hour", add_by_name: "admin", def_rate_type: "COST_PER_QTY", add_act_remain_flag: "N",
  act_this_per_link_flag: "Y", def_task_type: "TT_Task", act_pct_link_flag: "N", task_code_prefix_flag: "Y", def_rollup_dates_flag: "Y", use_project_baseline_flag: "Y", rem_target_link_flag: "Y",
  reset_planned_flag: "N", allow_neg_act_flag: "N", sum_assign_level: "SL_Taskrsrc", export_flag: "Y" };
const nullObj = () => Object.create(null);
const lookup = (map, k, d) => (typeof k === "string" && has(map, k) ? map[k] : d);

function parse_tables(text) {
  const tables = nullObj();
  let header = null, cur = null, curName = null, rowsTotal = 0, cont = 0;
  const warnings = [], extra = new Set();
  for (let ln of text.split("\n")) {
    if (ln.endsWith("\r")) ln = ln.slice(0, -1);
    if (!ln) continue;
    if (ln.startsWith("%T")) {
      curName = pyStrip(ln.slice(2));
      if (!has(tables, curName)) tables[curName] = { fields: null, rows: [] };
      cur = tables[curName];
      continue;
    }
    if (ln.startsWith("%F")) {
      if (cur === null) { warnings.push("A field list appears before any table; it was ignored."); continue; }
      cur.fields = ln.split("\t").slice(1).map(pyStrip);
      continue;
    }
    if (ln.startsWith("%R")) {
      if (cur === null || cur.fields === null) { warnings.push("A row appears before its table's field list; it was ignored."); continue; }
      const vals = ln.split("\t").slice(1), fl = cur.fields;
      if (vals.length > fl.length) extra.add(curName);
      const row = nullObj();
      for (let i = 0; i < fl.length; i++) row[fl[i]] = i < vals.length ? vals[i] : "";
      cur.rows.push(row);
      rowsTotal++;
      if (rowsTotal > XER_MAX_ROWS) throw new SchedError("too_many", "The XER file has more than 2 million rows, the limit for this tool.");
      continue;
    }
    if (ln.startsWith("%E")) break;
    if (ln.startsWith("ERMHDR")) { header = ln.split("\t"); continue; }
    if (cur !== null && cur.rows.length) {
      const last = cur.rows[cur.rows.length - 1];
      if (cur.fields && cur.fields.length) { const k = cur.fields[cur.fields.length - 1]; last[k] = (has(last, k) ? last[k] : "") + "\n" + ln; cont++; }
      continue;
    }
    if (header === null && !Object.keys(tables).length) throw new SchedError("not_xer", "This does not look like an XER file (no ERMHDR line or %T tables).");
  }
  if (header === null && !Object.keys(tables).length) throw new SchedError("not_xer", "This does not look like an XER file (no ERMHDR line or %T tables).");
  if (cont) warnings.push(cont > 1 ? `${cont} lines without a %R marker were joined to the rows above.` : "1 line without a %R marker was joined to the row above.");
  for (const t of Array.from(extra).sort(cmp)) warnings.push(`Table ${t} has rows with more values than fields; the extra values were ignored.`);
  return { header: header || [], tables, warnings };
}
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function to_num(v) { v = pyStrip(v || ""); return NUM_RE.test(v) ? parseFloat(v) : null; }
function _hours(v, field, warnings) {
  v = pyStrip(v || "");
  if (!v) return 0;
  const x = to_num(v);
  if (x === null) { warnings.push(`${field}: "${pySlice(v, 0, 20)}" is not a number; 0 was used.`); return 0; }
  if (Math.abs(x) > 500000) { warnings.push(`${field}: ${pySlice(v, 0, 20)} hours is out of range; 0 was used.`); return 0; }
  return Math.trunc(x * 60 + (x >= 0 ? 0.5 : -0.5));
}
function _xdate(v) {
  v = pyStrip(v || "");
  if (!v) return null;
  try { return fmt_dt(parse_dt(v)); } catch (e) { if (e instanceof SchedError) return null; throw e; }
}
function _xhm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return v >= 0 && v <= DAY ? v : null;
}
const _PERIOD_RE = /s\|(\d{1,2}:\d{2})\|f\|(\d{1,2}:\d{2})|f\|(\d{1,2}:\d{2})\|s\|(\d{1,2}:\d{2})/g;
function _xperiods(seg) {
  const out = [];
  for (const m of seg.matchAll(_PERIOD_RE)) {
    const s = m[1] !== undefined ? _xhm(m[1]) : _xhm(m[4]);
    let f = m[1] !== undefined ? _xhm(m[2]) : _xhm(m[3]);
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
function parse_clndr_data(s) {
  s = s.replace(/[\s\x7f]+/g, "");
  if (!s.includes("CalendarData") && !s.includes("DaysOfWeek")) throw new SchedError("bad_calendar_data", "calendar data");
  const marks = [s.indexOf("VIEW"), s.indexOf("Exceptions")].filter((i) => i >= 0).sort((a, b) => a - b);
  let week = null;
  const di = s.indexOf("DaysOfWeek");
  if (di >= 0) {
    const endI = marks.find((i) => i > di);
    const sec = s.slice(di, endI === undefined ? s.length : endI);
    const heads = Array.from(sec.matchAll(/\(0\|\|([1-7])\(\)\(/g));
    if (heads.length) {
      week = [[], [], [], [], [], [], []];
      heads.forEach((m, k) => {
        const seg = sec.slice(m.index + m[0].length, k + 1 < heads.length ? heads[k + 1].index : sec.length);
        week[+m[1] - 1] = _xperiods(seg);
      });
    }
  }
  const exc = {};
  const ei = s.indexOf("Exceptions");
  if (ei >= 0) {
    const vi = s.indexOf("VIEW", ei);
    const sec = s.slice(ei, vi > ei ? vi : s.length);
    const heads = Array.from(sec.matchAll(/d\|(\d{1,6})/g));
    heads.forEach((m, k) => {
      const seg = sec.slice(m.index + m[0].length, k + 1 < heads.length ? heads[k + 1].index : sec.length);
      const serial = +m[1];
      if (serial < 200000) exc[fmt_day(SERIAL_EPOCH + serial)] = _xperiods(seg);
    });
  }
  return [week, exc];
}
function _num_id(prefix, v) { v = pyStrip(v || ""); return /^[A-Za-z0-9._:\-]{1,60}$/.test(v) ? `${prefix}${v}` : null; }
function _xqty(v) { const x = to_num(v); return x === null || x < 0 || x > 1e7 ? 0 : Math.trunc(x * 1000 + 0.5); }
function _xint(v) { const m = /^\s*([+-]?\d{1,15})\s*$/.exec(v || ""); return m ? parseInt(m[1], 10) : 0; }
function _dedupe(ws) {
  const out = [], seen = new Map();
  for (const w of ws) { if (seen.has(w)) { seen.set(w, seen.get(w) + 1); continue; } seen.set(w, 1); out.push(w); }
  const res = out.slice(0, 200).map((w) => (seen.get(w) === 1 ? w : `${w} (${seen.get(w)} times)`));
  if (out.length > 200) res.push((out.length > 201 ? `${out.length - 200} more warnings were` : "1 more warning was") + " not listed.");
  return res;
}
function _order_wbs(wbs) {
  const ids = new Set(wbs.map((w) => w.id));
  const kids = new Map();
  for (const w of wbs) {
    if (!ids.has(w.parent)) w.parent = null;
    if (!kids.has(w.parent)) kids.set(w.parent, []);
    kids.get(w.parent).push(w);
  }
  const out = [], seen = new Set();
  const stack = (kids.get(null) || []).slice().reverse();
  while (stack.length) {
    const w = stack.pop();
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
    stack.push(...(kids.get(w.id) || []).slice().reverse());
  }
  for (const w of wbs) if (!seen.has(w.id)) { w.parent = null; out.push(w); }
  return out;
}
const sumWork = (week) => week.reduce((t, d) => t + d.reduce((u, [s, f]) => u + f - s, 0), 0);

function read_xer(data, projectId) {
  let text, enc;
  if (typeof data === "string") { text = data; enc = "text"; } else [text, enc] = decode_bytes(data, "XER file");
  const parsed = parse_tables(text);
  const T = parsed.tables;
  const warnings = parsed.warnings.slice();
  const rows = (name) => (has(T, name) ? T[name].rows : []);
  const projects = rows("PROJECT").map((r) => ({ id: get(r, "proj_id", ""), name: get(r, "proj_short_name", ""), exported: get(r, "export_flag") === "Y" }));
  if (!projects.length) throw new SchedError("not_xer", "The XER file has no PROJECT table.");
  let pick;
  if (projectId === undefined || projectId === null) pick = rows("PROJECT").find((r) => get(r, "export_flag") === "Y") || rows("PROJECT")[0];
  else {
    pick = rows("PROJECT").find((r) => get(r, "proj_id") === projectId) || null;
    if (pick === null) throw new SchedError("bad_ref", "That project is not in the XER file.");
  }
  const pid = get(pick, "proj_id", "");
  if (projects.length > 1) warnings.push(`The file holds ${projects.length} projects; ${get(pick, "proj_short_name", pid)} was opened.`);

  const tasks = rows("TASK").filter((r) => get(r, "proj_id", pid) === pid);
  const usedCals = new Set(tasks.map((r) => get(r, "clndr_id", "")));
  usedCals.add(get(pick, "clndr_id", ""));
  const cals = [], calIds = new Map();
  for (const r of rows("CALENDAR")) {
    const cid = get(r, "clndr_id", "");
    if (!usedCals.has(cid)) continue;
    const name = pyStrip(get(r, "clndr_name") || "") || `Calendar ${cid}`;
    let week = null, exc = {};
    if (pyStrip(get(r, "clndr_data") || "")) {
      try { [week, exc] = parse_clndr_data(r.clndr_data); } catch (e) {
        if (!(e instanceof SchedError)) throw e;
        warnings.push(`Calendar "${name}": the work pattern could not be read; Monday to Friday 08:00 to 16:00 was used.`);
      }
    }
    if (week === null || sumWork(week) === 0) {
      if (week !== null) warnings.push(`Calendar "${name}" has no working time; Monday to Friday 08:00 to 16:00 was used.`);
      week = standard_week();
    }
    let hpd = _hours(get(r, "day_hr_cnt"), `calendar ${name} hours per day`, warnings);
    if (!(hpd > 0 && hpd <= DAY)) hpd = Math.max(...week.map((d) => d.reduce((u, [s, f]) => u + f - s, 0)));
    const gid = _num_id("c", cid) || `c${cals.length + 1}`;
    calIds.set(cid, gid);
    cals.push({ id: gid, name: pySlice(name, 0, 120), hpd, week, exceptions: exc });
  }
  if (!cals.length) {
    warnings.push("No calendar was found; a Monday to Friday 08:00 to 16:00 calendar was used.");
    cals.push({ id: "std", name: "Standard", hpd: 480, week: standard_week(), exceptions: {} });
  }
  const defaultCal = calIds.has(get(pick, "clndr_id", "")) ? calIds.get(get(pick, "clndr_id", "")) : cals[0].id;
  const hpdOf = new Map(cals.map((c) => [c.id, c.hpd]));
  let missingCal = 0;

  const wrows = rows("PROJWBS").filter((r) => get(r, "proj_id", pid) === pid);
  const rootIds = new Set(wrows.filter((r) => get(r, "proj_node_flag") === "Y").map((r) => get(r, "wbs_id")));
  const wkey = (r) => [_xint(get(r, "seq_num")), get(r, "wbs_id", "")];
  const wsorted = wrows.slice().sort((a, b) => cmpTuple(wkey(a), wkey(b)));
  const wbsIds = new Map();
  for (const r of wsorted) {
    if (rootIds.has(get(r, "wbs_id"))) continue;
    const gid = _num_id("w", get(r, "wbs_id"));
    if (gid === null) continue;
    wbsIds.set(r.wbs_id, gid);
  }
  const parentOf = new Map();
  for (const r of wrows) if (wbsIds.has(get(r, "wbs_id"))) { const par = get(r, "parent_wbs_id"); parentOf.set(wbsIds.get(r.wbs_id), wbsIds.has(par) ? wbsIds.get(par) : null); }
  let wbs = [];
  for (const r of wsorted) {
    const gid = wbsIds.get(get(r, "wbs_id"));
    if (gid) wbs.push({ id: gid, code: pySlice(pyStrip(get(r, "wbs_short_name") || ""), 0, 60) || gid, name: pyStrip(get(r, "wbs_name") || ""), parent: parentOf.has(gid) ? parentOf.get(gid) : null });
  }
  wbs = _order_wbs(wbs);

  const acts = [], actIds = new Map(), usedGids = new Set(), stored = {};
  for (const r of tasks) {
    const tid = get(r, "task_id", "");
    const gid = _num_id("t", tid);
    if (gid === null || usedGids.has(gid)) { warnings.push("An activity without a usable task_id was skipped."); continue; }
    const code = pyStrip(get(r, "task_code") || "") || gid;
    const tt = get(r, "task_type", "TT_Task");
    const typ = tt === "TT_Mile" ? "start_ms" : tt === "TT_FinMile" ? "finish_ms" : "task";
    if (tt === "TT_LOE") warnings.push(`${code} is a level of effort activity; it was imported as a task.`);
    else if (tt === "TT_WBS") warnings.push(`${code} is a WBS summary activity; it was imported as a task.`);
    const od = _hours(get(r, "target_drtn_hr_cnt"), `${code} original duration`, warnings);
    const rd = _hours(get(r, "remain_drtn_hr_cnt"), `${code} remaining duration`, warnings);
    const st = get(r, "status_code", "TK_NotStart");
    const as = st === "TK_Active" || st === "TK_Complete" ? _xdate(get(r, "act_start_date")) : null;
    let af = st === "TK_Complete" ? _xdate(get(r, "act_end_date")) : null;
    if ((st === "TK_Active" || st === "TK_Complete") && !as) { warnings.push(`${code} is marked started but has no actual start; it was imported as not started.`); af = null; }
    if (st === "TK_Complete" && !af) warnings.push(`${code} is marked complete but has no actual finish; it was imported as in progress.`);
    if (as && af && af < as) { warnings.push(`${code} finishes before it starts; the actual finish was dropped.`); af = null; }
    let cs = lookup(XCSTR_IN, pyStrip(get(r, "cstr_type") || ""), "ASAP");
    const cd = _xdate(get(r, "cstr_date"));
    if (cs !== "ASAP" && cs !== "ALAP" && !cd) { warnings.push(`${code} has a constraint without a date; it was dropped.`); cs = "ASAP"; }
    if (pyStrip(get(r, "cstr_type2") || "")) warnings.push(`${code} has a secondary constraint; only the primary constraint is used.`);
    let cal = calIds.has(get(r, "clndr_id", "")) ? calIds.get(get(r, "clndr_id", "")) : null;
    if (cal === null) { missingCal++; cal = defaultCal; }
    let phys = to_num(get(r, "phys_complete_pct")) || 0;
    phys = Math.min(100, Math.max(0, phys));
    actIds.set(tid, gid);
    usedGids.add(gid);
    acts.push({ id: gid, code: pySlice(code, 0, 40), name: pyStrip(get(r, "task_name") || ""), wbs: wbsIds.has(get(r, "wbs_id")) ? wbsIds.get(r.wbs_id) : null,
      cal: cal === defaultCal ? null : cal, type: typ, od: Math.max(0, od), rd: af ? 0 : Math.max(0, rd), as, af,
      pct_type: lookup(XPCT_IN, get(r, "complete_pct_type", ""), "duration"), phys, cstr: cs, cstr_date: cs !== "ASAP" && cs !== "ALAP" ? cd : null,
      unit: mod(od, hpdOf.get(cal)) ? "h" : "d" });
    const tfv = get(r, "total_float_hr_cnt"), ffv = get(r, "free_float_hr_cnt");
    stored[gid] = { es: _xdate(get(r, "early_start_date")), ef: _xdate(get(r, "early_end_date")), ls: _xdate(get(r, "late_start_date")), lf: _xdate(get(r, "late_end_date")),
      tf: pyStrip(tfv || "") ? _hours(tfv, code, []) : null, ff: pyStrip(ffv || "") ? _hours(ffv, code, []) : null,
      res: _xdate(get(r, "restart_date")), planned_start: _xdate(get(r, "target_start_date")), planned_finish: _xdate(get(r, "target_end_date")) };
  }
  if (missingCal) warnings.push((missingCal > 1 ? `${missingCal} activities point` : "1 activity points") + " to a calendar that is not in the file; the project calendar was used.");

  const rels = [], seen = new Set();
  let skippedX = 0;
  for (const r of rows("TASKPRED")) {
    const su = actIds.has(get(r, "task_id")) ? actIds.get(r.task_id) : null, pr = actIds.has(get(r, "pred_task_id")) ? actIds.get(r.pred_task_id) : null;
    if (su === null && pr === null) continue;
    if (su === null || pr === null) { skippedX++; continue; }
    const typ = lookup({ PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" }, get(r, "pred_type", "PR_FS"), "FS");
    const key = pr + "\u0000" + su + "\u0000" + typ;
    if (seen.has(key) || pr === su) { warnings.push("A duplicate or self relationship was skipped."); continue; }
    seen.add(key);
    const rid = _num_id("p", get(r, "task_pred_id")) || `p${rels.length + 1}`;
    rels.push({ id: rid, pred: pr, succ: su, type: typ, lag: _hours(get(r, "lag_hr_cnt"), "relationship lag", warnings), elapsed: false });
  }
  if (skippedX) warnings.push((skippedX > 1 ? `${skippedX} relationships` : "1 relationship") + " to activities in other projects " + (skippedX > 1 ? "were" : "was") + " skipped.");

  const maxu = new Map();
  for (const r of rows("RSRCRATE")) {
    const v = to_num(get(r, "max_qty_per_hr"));
    if (v !== null && v >= 0 && v <= 1000 && !maxu.has(get(r, "rsrc_id"))) maxu.set(get(r, "rsrc_id"), Math.trunc(v * 1000 + 0.5));
  }
  const usedR = new Set(rows("TASKRSRC").filter((r) => actIds.has(get(r, "task_id"))).map((r) => get(r, "rsrc_id")));
  const rsrcs = [], rsrcIds = new Map();
  for (const r of rows("RSRC")) {
    if (!usedR.has(get(r, "rsrc_id"))) continue;
    const gid = _num_id("r", get(r, "rsrc_id"));
    if (gid === null) continue;
    rsrcIds.set(r.rsrc_id, gid);
    const typ = lookup(XRSRC_IN, get(r, "rsrc_type", ""), "labor");
    rsrcs.push({ id: gid, code: pySlice(pyStrip(get(r, "rsrc_short_name") || ""), 0, 40) || gid, name: pyStrip(get(r, "rsrc_name") || ""), type: typ,
      max_units: maxu.has(r.rsrc_id) ? maxu.get(r.rsrc_id) : 1000, unit: typ !== "material" ? "h" : "ea" });
  }
  const asg = [], odOf = new Map(acts.map((x) => [x.id, x.od]));
  for (const r of rows("TASKRSRC")) {
    const a = actIds.has(get(r, "task_id")) ? actIds.get(r.task_id) : null, rs = rsrcIds.has(get(r, "rsrc_id")) ? rsrcIds.get(r.rsrc_id) : null;
    if (a === null || rs === null) continue;
    const tgt = _xqty(get(r, "target_qty"));
    const act = _xqty(get(r, "act_reg_qty")) + _xqty(get(r, "act_ot_qty"));
    let per = _xqty(get(r, "target_qty_per_hr"));
    if (per === 0) { const od = odOf.get(a); per = od ? round_div(tgt * 60, od) : 0; }
    asg.push({ id: _num_id("a", get(r, "taskrsrc_id")) || `a${asg.length + 1}`, act: a, rsrc: rs, units: per, budget: tgt, actual: act });
  }

  const settings = {};
  if (pyStrip(get(pick, "critical_drtn_hr_cnt") || "")) settings.crit_tf = Math.max(0, _hours(pick.critical_drtn_hr_cnt, "critical float threshold", warnings));
  if (get(pick, "critical_path_type") === "CT_DrivPath") settings.crit = "longest";
  // schedule options live in SCHEDOPTIONS; older or hand-made files may carry them on PROJECT
  const opt = rows("SCHEDOPTIONS").find((r) => get(r, "proj_id", pid) === pid) || pick;
  if (get(opt, "sched_progress_override") === "Y") settings.oos = "override";
  else if (get(opt, "sched_retained_logic") === "N" && get(opt, "sched_progress_override") === "N") warnings.push("The file schedules progressed activities by actual dates; retained logic was used.");
  const ft = pyStrip(get(opt, "sched_float_type") || "");
  if (has(XFLOAT_IN, ft)) settings.float = XFLOAT_IN[ft];
  const lc = pyStrip(get(opt, "sched_calendar_on_relationship_lag") || "");
  if (has(XLAGCAL_IN, lc)) settings.lag_cal = XLAGCAL_IN[lc];

  const actualStarts = acts.filter((x) => x.as).map((x) => x.as);
  const start = _xdate(get(pick, "plan_start_date")) || (actualStarts.length ? minOf(actualStarts) : null) || "2026-01-01T08:00";
  const dd = _xdate(get(pick, "last_recalc_date")) || _xdate(get(pick, "next_data_date")) || start;
  const finishBy = _xdate(get(pick, "plan_end_date"));
  const baselines = [], blRows = {};
  for (const k of Object.keys(stored)) { const v = stored[k]; if (v.planned_start && v.planned_finish) blRows[k] = [v.planned_start, v.planned_finish, odOf.get(k)]; }
  if (Object.keys(blRows).length) baselines.push({ id: "planned", name: "Planned dates in the file", taken: dd, acts: blRows });
  const proj = validate_project({ id: _num_id("p", pid) || "p1", name: pyStrip(get(pick, "proj_short_name") || "") || "Imported project", start, data_date: dd,
    finish_by: finishBy, cal: defaultCal, settings, calendars: cals, wbs, activities: acts, rels, resources: rsrcs, assigns: asg,
    baselines, baseline: baselines.length ? "planned" : null });
  const names = Object.keys(T).sort(cmp);
  const tables = nullObj();
  for (const t of names) tables[t] = T[t].rows.length;
  const report = { format: "XER", encoding: enc, version: parsed.header.length > 1 ? parsed.header[1] : "", tables, unknown_tables: names.filter((t) => !XER_KNOWN.has(t)),
    counts: { activities: acts.length, rels: rels.length, wbs: wbs.length, calendars: cals.length, resources: rsrcs.length, assigns: asg.length }, warnings: _dedupe(warnings) };
  return { project: proj, report, stored, projects };
}

// ---- writing
function _hrs(m) { const s = fmt_fixed(m, 60, 2); return s.includes(".") ? rstripChars(rstripChars(s, "0"), ".") : s; }
const _xd = (s) => (s ? s.replace("T", " ") : "");
const _xclean = (s) => (s || "").replace(/[\t\r\n]+/g, " ");
function _xids(rows, prefix) {
  const re = new RegExp("^" + prefix + "(\\d{1,9})$");
  const nums = [];
  for (const r of rows) { const m = re.exec(r.id); if (!m) break; nums.push(parseInt(m[1], 10)); }
  const out = new Map();
  if (nums.length === rows.length && new Set(nums).size === nums.length) rows.forEach((r, i) => out.set(r.id, nums[i]));
  else rows.forEach((r, i) => out.set(r.id, 1000 + i));
  return out;
}
function clndr_data(c) {
  const parts = ["(0||CalendarData()((0||DaysOfWeek()("];
  for (let d = 0; d < 7; d++) parts.push(`(0||${d + 1}()(` + c.week[d].map(([s, f], i) => `(0||${i}(s|${fmt_hm(s)}|f|${fmt_hm(f % DAY)})())`).join("") + "))");
  parts.push("))(0||VIEW(ShowTotal|Y)())(0||Exceptions()(");
  Object.keys(c.exceptions).sort(cmp).forEach((k, i) => {
    const serial = fdiv(parse_dt(k), DAY) - SERIAL_EPOCH;
    parts.push(`(0||${i}(d|${serial})(` + c.exceptions[k].map(([s, f], j) => `(0||${j}(s|${fmt_hm(s)}|f|${fmt_hm(f % DAY)})())`).join("") + "))");
  });
  parts.push("))))");
  return parts.join("");
}
function write_xer(p, sched, today) {
  today = (today || p.data_date).slice(0, 10);
  const pid = _xids([{ id: p.id }], "p").get(p.id);
  const cid = _xids(p.calendars, "c"), wid = _xids(p.wbs, "w"), tid = _xids(p.activities, "t"), rid = _xids(p.rels, "p"), sid = _xids(p.resources, "r"), aid = _xids(p.assigns, "a");
  const rootWbs = Math.max(0, ...wid.values()) + 1;
  const out = [`ERMHDR\t19.12\t${today}\tProject\tadmin\tadmin\tdbxDatabaseNoName\tProject Management\tUSD`];
  const table = (name, fields, rows) => {
    if (!rows.length) return; // P6 writes no header for a table without rows
    out.push(`%T\t${name}`);
    out.push("%F\t" + fields.join("\t"));
    for (const r of rows) out.push("%R\t" + fields.map((f) => _xclean(pyStr(has(r, f) ? r[f] : ""))).join("\t"));
  };
  // tables in the order P6 writes them: referenced records come before the records that use them
  table("CURRTYPE", ["curr_id", "decimal_digit_cnt", "curr_symbol", "decimal_symbol", "digit_group_symbol", "pos_curr_fmt_type", "neg_curr_fmt_type", "curr_type", "curr_short_name", "group_digit_cnt", "base_exch_rate"],
    [{ curr_id: 1, decimal_digit_cnt: 2, curr_symbol: "$", decimal_symbol: ".", digit_group_symbol: ",", pos_curr_fmt_type: "#1.1", neg_curr_fmt_type: "(#1.1)", curr_type: "US Dollar", curr_short_name: "USD", group_digit_cnt: 3, base_exch_rate: 1 }]);
  const pc = p.calendars.find((c) => c.id === p.cal);
  const S = p.settings;
  const short = pySlice(p.name, 0, 40);
  table("PROJECT", XPROJECT_FIELDS, [Object.assign({}, XPROJECT_DEFAULTS, { proj_id: pid, proj_short_name: short, clndr_id: cid.get(pc.id), plan_start_date: _xd(p.start),
    plan_end_date: _xd(p.finish_by), scd_end_date: _xd(sched.finish), last_recalc_date: _xd(p.data_date), add_date: `${today} 00:00`, critical_drtn_hr_cnt: _hrs(S.crit_tf),
    critical_path_type: S.crit === "longest" ? "CT_DrivPath" : "CT_TotFloat" })]);
  const calRow = (c, num, kind, proj) => {
    const wk = sumWork(c.week);
    return { clndr_id: num, default_flag: "N", clndr_name: c.name, proj_id: proj, base_clndr_id: "", last_chng_date: `${today} 00:00`, clndr_type: kind,
      day_hr_cnt: _hrs(c.hpd), week_hr_cnt: _hrs(wk), month_hr_cnt: _hrs(fdiv(wk * 52, 12)), year_hr_cnt: _hrs(wk * 52), rsrc_private: "N", clndr_data: clndr_data(c) };
  };
  const crows = p.calendars.map((c) => calRow(c, cid.get(c.id), "CA_Project", pid));
  // P6 resources take a global or resource calendar, never a project calendar: give them a shared
  // resource calendar with the project calendar's work pattern
  const rcal = Math.max(...cid.values()) + 1;
  if (p.resources.length) crows.push(calRow(Object.assign({}, pc, { name: pySlice(pc.name + " (resources)", 0, 120) }), rcal, "CA_Rsrc", ""));
  table("CALENDAR", ["clndr_id", "default_flag", "clndr_name", "proj_id", "base_clndr_id", "last_chng_date", "clndr_type", "day_hr_cnt", "week_hr_cnt", "month_hr_cnt", "year_hr_cnt", "rsrc_private", "clndr_data"], crows);
  table("SCHEDOPTIONS", ["schedoptions_id", "proj_id", "sched_open_critical_flag", "sched_lag_early_start_flag", "sched_retained_logic", "sched_setplantoforecast", "sched_float_type",
    "sched_calendar_on_relationship_lag", "sched_use_expect_end_flag", "sched_progress_override"],
  [{ schedoptions_id: 1, proj_id: pid, sched_open_critical_flag: "N", sched_lag_early_start_flag: "N", sched_retained_logic: S.oos === "retained" ? "Y" : "N", sched_setplantoforecast: "N",
    sched_float_type: XFLOAT_OUT[S.float], sched_calendar_on_relationship_lag: XLAGCAL_OUT[S.lag_cal], sched_use_expect_end_flag: "N", sched_progress_override: S.oos === "override" ? "Y" : "N" }]);
  const wrows = [{ wbs_id: rootWbs, proj_id: pid, obs_id: "", seq_num: 0, est_wt: 1, proj_node_flag: "Y", sum_data_flag: "Y", status_code: "WS_Open", wbs_short_name: short, wbs_name: p.name, parent_wbs_id: "" }];
  p.wbs.forEach((w, i) => wrows.push({ wbs_id: wid.get(w.id), proj_id: pid, obs_id: "", seq_num: (i + 1) * 10, est_wt: 1, proj_node_flag: "N", sum_data_flag: "Y", status_code: "WS_Open",
    wbs_short_name: pySlice(w.code, 0, 40), wbs_name: w.name || w.code, parent_wbs_id: w.parent ? wid.get(w.parent) : rootWbs }));
  table("PROJWBS", ["wbs_id", "proj_id", "obs_id", "seq_num", "est_wt", "proj_node_flag", "sum_data_flag", "status_code", "wbs_short_name", "wbs_name", "parent_wbs_id"], wrows);
  table("RSRC", ["rsrc_id", "clndr_id", "rsrc_seq_num", "rsrc_name", "rsrc_short_name", "def_qty_per_hr", "cost_qty_type", "active_flag", "auto_compute_act_flag", "def_cost_qty_link_flag", "ot_flag", "curr_id", "rsrc_type"],
    p.resources.map((r, i) => ({ rsrc_id: sid.get(r.id), clndr_id: rcal, rsrc_seq_num: i, rsrc_name: r.name || r.code, rsrc_short_name: r.code, def_qty_per_hr: fmt_fixed(1000, 1000, 2),
      cost_qty_type: "QT_Hour", active_flag: "Y", auto_compute_act_flag: "N", def_cost_qty_link_flag: "Y", ot_flag: "N", curr_id: 1, rsrc_type: XRSRC_OUT[r.type] })));
  table("RSRCRATE", ["rsrc_rate_id", "rsrc_id", "max_qty_per_hr", "cost_per_qty", "start_date"],
    p.resources.map((r, i) => ({ rsrc_rate_id: i + 1, rsrc_id: sid.get(r.id), max_qty_per_hr: fmt_fixed(r.max_units, 1000, 3), cost_per_qty: "0", start_date: "2000-01-01 00:00" })));
  const trows = p.activities.map((a) => {
    const rec = sched.acts[a.id], st = rec.status;
    return { task_id: tid.get(a.id), proj_id: pid, wbs_id: a.wbs ? wid.get(a.wbs) : rootWbs, clndr_id: cid.get(a.cal || p.cal), phys_complete_pct: a.phys, rev_fdbk_flag: "N", est_wt: 1,
      lock_plan_flag: "N", auto_compute_act_flag: "N", complete_pct_type: XPCT_OUT[a.pct_type], task_type: { task: "TT_Task", start_ms: "TT_Mile", finish_ms: "TT_FinMile" }[a.type],
      duration_type: "DT_FixedDUR2", status_code: { planned: "TK_NotStart", active: "TK_Active", complete: "TK_Complete" }[st], task_code: a.code, task_name: a.name,
      total_float_hr_cnt: rec.tf !== null ? _hrs(rec.tf) : "", free_float_hr_cnt: rec.ff !== null ? _hrs(rec.ff) : "", remain_drtn_hr_cnt: _hrs(a.rd), target_drtn_hr_cnt: _hrs(a.od),
      cstr_date: _xd(a.cstr_date), act_start_date: _xd(a.as), act_end_date: _xd(a.af), late_start_date: _xd(rec.ls), late_end_date: _xd(rec.lf),
      early_start_date: _xd(st === "active" ? rec.res : rec.es), early_end_date: _xd(rec.ef), restart_date: st !== "complete" ? _xd(rec.res) : "", reend_date: st !== "complete" ? _xd(rec.ef) : "",
      rem_late_start_date: _xd(rec.ls), rem_late_end_date: _xd(rec.lf),
      target_start_date: _xd(a.as || rec.es), target_end_date: _xd(a.af || rec.ef), cstr_type: lookup(XCSTR_OUT, a.cstr, ""), priority_type: "PT_Normal", driving_path_flag: rec.lp ? "Y" : "N" };
  });
  table("TASK", ["task_id", "proj_id", "wbs_id", "clndr_id", "phys_complete_pct", "rev_fdbk_flag", "est_wt", "lock_plan_flag", "auto_compute_act_flag", "complete_pct_type", "task_type", "duration_type",
    "status_code", "task_code", "task_name", "total_float_hr_cnt", "free_float_hr_cnt", "remain_drtn_hr_cnt", "target_drtn_hr_cnt", "cstr_date", "act_start_date", "act_end_date",
    "late_start_date", "late_end_date", "early_start_date", "early_end_date", "restart_date", "reend_date", "rem_late_start_date", "rem_late_end_date", "target_start_date", "target_end_date",
    "cstr_type", "priority_type", "driving_path_flag"], trows);
  table("TASKPRED", ["task_pred_id", "task_id", "pred_task_id", "proj_id", "pred_proj_id", "pred_type", "lag_hr_cnt"],
    p.rels.map((r) => ({ task_pred_id: rid.get(r.id), task_id: tid.get(r.succ), pred_task_id: tid.get(r.pred), proj_id: pid, pred_proj_id: pid, pred_type: "PR_" + r.type, lag_hr_cnt: _hrs(r.lag) })));
  const odOf = new Map(p.activities.map((a) => [a.id, a]));
  const rtype = new Map(p.resources.map((r) => [r.id, r.type]));
  table("TASKRSRC", ["taskrsrc_id", "task_id", "proj_id", "rsrc_id", "remain_qty", "target_qty", "remain_qty_per_hr", "target_qty_per_hr", "act_reg_qty", "act_ot_qty", "rsrc_type", "cost_qty_link_flag", "rate_type"],
    p.assigns.map((x) => ({ taskrsrc_id: aid.get(x.id), task_id: tid.get(x.act), proj_id: pid, rsrc_id: sid.get(x.rsrc), remain_qty: fmt_fixed(round_div(x.units * odOf.get(x.act).rd, 60), 1000, 3),
      target_qty: fmt_fixed(x.budget, 1000, 3), remain_qty_per_hr: fmt_fixed(x.units, 1000, 3), target_qty_per_hr: fmt_fixed(x.units, 1000, 3), act_reg_qty: fmt_fixed(x.actual, 1000, 3),
      act_ot_qty: "0", rsrc_type: XRSRC_OUT[rtype.get(x.rsrc)], cost_qty_link_flag: "Y", rate_type: "COST_PER_QTY" })));
  out.push("%E");
  return out.join("\r\n") + "\r\n";
}
