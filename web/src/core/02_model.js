// ---------------------------------------------------------------- the schedule data model
// Mirrors src/fieldsched/model.py: validation, defaults and the native file format.
const FORMAT = "cpm-schedule";
const VERSION = 1;
const ACT_TYPES = ["task", "start_ms", "finish_ms"];
const REL_TYPES = ["FS", "SS", "FF", "SF"];
const CSTR_TYPES = ["ASAP", "ALAP", "SNET", "SNLT", "FNET", "FNLT", "MSO", "MFO", "MS_MAND", "MF_MAND"];
const PCT_TYPES = ["duration", "physical", "units"];
const RSRC_TYPES = ["labor", "nonlabor", "material"];
const SETTINGS = {
  oos: ["retained", ["retained", "override"]],
  crit: ["tf", ["tf", "longest"]],
  float: ["finish", ["finish", "start", "min"]],
  lag_cal: ["pred", ["pred", "succ", "24h", "project"]],
  unit: ["d", ["d", "h"]],
};
const INT_SETTINGS = { crit_tf: 0, near_tf: 4800, long_lag: 2400, high_float: 21120, high_dur: 21120 };
const LIMITS = { activities: 100000, rels: 400000, wbs: 50000, calendars: 2000, resources: 20000, assigns: 400000, baselines: 20, exceptions: 20000 };
const ID_RE = /^[A-Za-z0-9._:\-]{1,64}$/;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MAX_MIN = 60 * 366 * 1440;
const has = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d) => (has(o, k) ? o[k] : d === undefined ? null : d);
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const HAS_ASTRAL = /[\ud800-\udfff]/;
const pyLen = (s) => (HAS_ASTRAL.test(s) ? Array.from(s).length : s.length);
const pySlice = (s, a, b) => (HAS_ASTRAL.test(s) ? Array.from(s).slice(a, b).join("") : s.slice(a, b));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
function pyTypeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  return Array.isArray(v) ? "list" : "dict";
}
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function clean_text(v, field, cap, multiline) {
  if (v === null || v === undefined) return "";
  if (!isStr(v)) throw new SchedError("bad_field", `${field}: expected text.`);
  if (pyLen(v) > 4 * cap + 1000) v = pySlice(v, 0, 4 * cap + 1000);
  v = v.replace(CTRL_RE, "");
  if (!multiline) v = pyStrip(v.replace(/[\r\n\t]+/g, " "));
  else v = v.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (pyLen(v) > cap) v = pySlice(v, 0, cap);
  return v;
}
function check_id(v, field) {
  if (isInt(v) && typeof v !== "boolean") v = String(v);
  if (!isStr(v) || !ID_RE.test(v)) throw new SchedError("bad_field", `${field}: ids are 1 to 64 letters, digits, dot, dash, colon or underscore.`);
  return v;
}
function as_int(v) {
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2 ** 53 ? v : null;
}
function check_int(v, field, lo, hi) {
  v = as_int(v);
  if (v === null || !(lo <= v && v <= hi)) throw new SchedError("bad_field", `${field}: expected a whole number from ${lo} to ${hi}.`);
  return v;
}
function check_dt(v, field, optional = true) {
  if (v === null || v === undefined || v === "") {
    if (optional) return null;
    throw new SchedError("bad_field", `${field} is required.`);
  }
  return fmt_dt(parse_dt(v, field));
}
function check_choice(v, field, choices, dflt) {
  if (v === null || v === undefined) return dflt;
  if (!choices.includes(v)) throw new SchedError("bad_field", `${field}: expected one of ${choices.join(", ")}.`);
  return v;
}
function _keys(obj, allowed, field) {
  if (!isObj(obj)) throw new SchedError("bad_field", `${field}: expected an object.`);
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new SchedError("bad_field", `${field}: unknown field "${pySlice(extra[0], 0, 30)}".`);
}
function _list(obj, key, limitKey) {
  let v = get(obj, key, []);
  if (v === null) v = [];
  if (!Array.isArray(v)) throw new SchedError("bad_field", `${key}: expected a list.`);
  if (v.length > LIMITS[limitKey]) throw new SchedError("too_many", `${key}: more than ${commas(LIMITS[limitKey])} records. This tool is capped there.`);
  return v;
}
function _unique(rows, what) {
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) throw new SchedError("duplicate_id", `Two ${what} share the id "${r.id}".`);
    seen.add(r.id);
  }
  return seen;
}
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0));
const orNull = (v) => (truthy(v) ? v : null);
const sortedKeys = (o) => Object.keys(o).sort(cmp);

const PROJECT_KEYS = ["format", "version", "id", "name", "label", "start", "data_date", "finish_by", "cal", "settings",
  "calendars", "wbs", "activities", "rels", "resources", "assigns", "baselines", "baseline"];

function validate_project(obj) {
  _keys(obj, PROJECT_KEYS, "project");
  const fmt = get(obj, "format", FORMAT);
  if (fmt !== FORMAT) throw new SchedError("bad_format", "This is not a schedule file from this tool.");
  const ver = get(obj, "version", VERSION);
  if (!isInt(ver) || typeof ver === "boolean" || ver < 1) throw new SchedError("bad_format", "The schedule file has no valid version number.");
  if (ver > VERSION) throw new SchedError("newer_file", "This schedule was saved by a newer version. Update the tool to open it.");
  const p = { format: FORMAT, version: VERSION };
  p.id = check_id(get(obj, "id", "p1"), "project id");
  p.name = clean_text(get(obj, "name"), "project name", 200) || "Untitled project";
  p.label = clean_text(get(obj, "label"), "project label", 300);
  p.start = check_dt(get(obj, "start"), "project start", false);
  p.data_date = check_dt(get(obj, "data_date"), "data date") || p.start;
  p.finish_by = check_dt(get(obj, "finish_by"), "must finish by");

  const st = orNull(get(obj, "settings")) || {};
  _keys(st, Object.keys(SETTINGS).concat(Object.keys(INT_SETTINGS)), "settings");
  p.settings = {};
  for (const k of Object.keys(SETTINGS)) p.settings[k] = check_choice(get(st, k), `settings.${k}`, SETTINGS[k][1], SETTINGS[k][0]);
  for (const k of Object.keys(INT_SETTINGS)) p.settings[k] = check_int(get(st, k, INT_SETTINGS[k]), `settings.${k}`, 0, MAX_MIN);

  const cals = [];
  _list(obj, "calendars", "calendars").forEach((c, i) => {
    _keys(c, ["id", "name", "hpd", "week", "exceptions"], `calendar ${i + 1}`);
    const cid = check_id(get(c, "id"), `calendar ${i + 1} id`);
    const name = clean_text(get(c, "name"), "calendar name", 120) || cid;
    let week = get(c, "week");
    if (!Array.isArray(week) || week.length !== 7) throw new SchedError("bad_calendar", `Calendar "${name}": the work week needs 7 days, Sunday first.`);
    week = [0, 1, 2, 3, 4, 5, 6].map((d) => norm_intervals(week[d], `calendar "${name}" day ${d}`));
    let tot = 0;
    for (const d of week) for (const [s, f] of d) tot += f - s;
    if (tot === 0) throw new SchedError("no_work", `Calendar "${name}" has no working time in its work week.`);
    const excIn = orNull(get(c, "exceptions")) || {};
    if (!isObj(excIn) || Object.keys(excIn).length > LIMITS.exceptions) throw new SchedError("bad_calendar", `Calendar "${name}": exceptions must be a map of at most ${commas(LIMITS.exceptions)} dates.`);
    const exc = {};
    for (const k of sortedKeys(excIn)) {
      const day = parse_day(k, `calendar "${name}" exception`);
      exc[fmt_dt(day * 1440).slice(0, 10)] = norm_intervals(excIn[k], `calendar "${name}" exception ${k}`);
    }
    let hpd = get(c, "hpd");
    if (hpd === null) {
      const days = week.filter((d) => d.length).map((d) => d.reduce((a, [s, f]) => a + f - s, 0));
      hpd = days.length ? Math.max(...days) : 480;
    }
    cals.push({ id: cid, name, hpd: check_int(hpd, `calendar "${name}" minutes per day`, 1, 1440), week, exceptions: exc });
  });
  if (!cals.length) cals.push({ id: "std", name: "Standard", hpd: 480, week: standard_week(), exceptions: {} });
  const calIds = _unique(cals, "calendars");
  p.calendars = cals;
  p.cal = orNull(get(obj, "cal")) || cals[0].id;
  if (!calIds.has(p.cal)) throw new SchedError("bad_ref", `The project calendar "${pySlice(pyStr(p.cal), 0, 64)}" does not exist.`);

  const wbs = [];
  _list(obj, "wbs", "wbs").forEach((w, i) => {
    _keys(w, ["id", "code", "name", "parent"], `WBS ${i + 1}`);
    const wid = check_id(get(w, "id"), `WBS ${i + 1} id`);
    wbs.push({ id: wid, code: clean_text(get(w, "code"), "WBS code", 60) || wid, name: clean_text(get(w, "name"), "WBS name", 200), parent: orNull(get(w, "parent")) });
  });
  const wbsIds = _unique(wbs, "WBS elements");
  const parent = new Map();
  for (const w of wbs) {
    if (w.parent !== null) {
      if (!wbsIds.has(w.parent)) throw new SchedError("bad_ref", `WBS "${w.code}" has a parent that does not exist.`);
      parent.set(w.id, w.parent);
    }
  }
  for (const w of wbs) {
    const seen = new Set();
    let cur = w.id;
    while (parent.has(cur)) {
      if (seen.has(cur)) throw new SchedError("bad_ref", `WBS "${w.code}" is inside itself.`);
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
  p.wbs = wbs;

  const acts = [];
  _list(obj, "activities", "activities").forEach((a, i) => {
    _keys(a, ["id", "code", "name", "wbs", "cal", "type", "od", "rd", "as", "af", "pct_type", "phys", "cstr", "cstr_date", "unit", "notes"], `activity ${i + 1}`);
    const aid = check_id(get(a, "id"), `activity ${i + 1} id`);
    const code = clean_text(get(a, "code"), "activity id", 40) || aid;
    const f = `activity "${code}"`;
    const typ = check_choice(get(a, "type"), f + " type", ACT_TYPES, "task");
    let od = check_int(get(a, "od", 0), f + " original duration", 0, MAX_MIN);
    let rd = check_int(get(a, "rd", od), f + " remaining duration", 0, MAX_MIN);
    if (typ !== "task") { od = 0; rd = 0; }
    const as = check_dt(get(a, "as"), f + " actual start");
    const af = check_dt(get(a, "af"), f + " actual finish");
    if (af && !as) throw new SchedError("bad_progress", `${f} has an actual finish but no actual start.`);
    if (as && af && parse_dt(af) < parse_dt(as)) throw new SchedError("bad_progress", `${f} finishes before it starts.`);
    if (af) rd = 0;
    const cstr = check_choice(get(a, "cstr"), f + " constraint", CSTR_TYPES, "ASAP");
    let cdate = check_dt(get(a, "cstr_date"), f + " constraint date");
    if (cstr !== "ASAP" && cstr !== "ALAP" && !cdate) throw new SchedError("bad_field", `${f}: the ${cstr} constraint needs a date.`);
    if (cstr === "ASAP" || cstr === "ALAP") cdate = null;
    const w = orNull(get(a, "wbs"));
    if (w !== null && !wbsIds.has(w)) throw new SchedError("bad_ref", `${f} points to a WBS element that does not exist.`);
    const c = orNull(get(a, "cal"));
    if (c !== null && !calIds.has(c)) throw new SchedError("bad_ref", `${f} points to a calendar that does not exist.`);
    const phys = get(a, "phys", 0);
    if (typeof phys !== "number" || !Number.isFinite(phys) || !(phys >= 0 && phys <= 100)) throw new SchedError("bad_field", `${f}: physical percent complete is 0 to 100.`);
    acts.push({ id: aid, code, name: clean_text(get(a, "name"), "activity name", 300), wbs: w, cal: c, type: typ, od, rd, as, af,
      pct_type: check_choice(get(a, "pct_type"), f + " percent complete type", PCT_TYPES, "duration"), phys, cstr, cstr_date: cdate,
      unit: check_choice(get(a, "unit"), f + " unit", ["d", "h"], p.settings.unit), notes: clean_text(get(a, "notes"), "notes", 4000, true) });
  });
  const actIds = _unique(acts, "activities");
  p.activities = acts;

  const rels = [];
  const pairs = new Set();
  const codeOf = new Map(acts.map((a) => [a.id, a.code]));
  _list(obj, "rels", "rels").forEach((r, i) => {
    _keys(r, ["id", "pred", "succ", "type", "lag", "elapsed"], `relationship ${i + 1}`);
    const rid = check_id(get(r, "id", `r${i + 1}`), `relationship ${i + 1} id`);
    const pr = get(r, "pred"), su = get(r, "succ");
    if (!actIds.has(pr) || !actIds.has(su)) throw new SchedError("bad_ref", `Relationship ${i + 1} points to an activity that does not exist.`);
    if (pr === su) throw new SchedError("loop", `Activity "${codeOf.get(pr)}" is linked to itself.`);
    const typ = check_choice(get(r, "type"), `relationship ${i + 1} type`, REL_TYPES, "FS");
    const key = pr + "\u0000" + su + "\u0000" + typ;
    if (pairs.has(key)) throw new SchedError("duplicate_rel", `${codeOf.get(pr)} to ${codeOf.get(su)} ${typ} is listed twice.`);
    pairs.add(key);
    const lag = as_int(get(r, "lag", 0));
    if (lag === null || Math.abs(lag) > MAX_MIN) throw new SchedError("bad_field", `Relationship ${codeOf.get(pr)} to ${codeOf.get(su)}: lag is whole working minutes.`);
    rels.push({ id: rid, pred: pr, succ: su, type: typ, lag, elapsed: get(r, "elapsed") === true });
  });
  _unique(rels, "relationships");
  p.rels = rels;

  const rsrcs = [];
  _list(obj, "resources", "resources").forEach((r, i) => {
    _keys(r, ["id", "code", "name", "type", "max_units", "unit"], `resource ${i + 1}`);
    const rid = check_id(get(r, "id"), `resource ${i + 1} id`);
    rsrcs.push({ id: rid, code: clean_text(get(r, "code"), "resource id", 40) || rid, name: clean_text(get(r, "name"), "resource name", 200),
      type: check_choice(get(r, "type"), "resource type", RSRC_TYPES, "labor"), max_units: check_int(get(r, "max_units", 1000), "resource max units", 0, 10 ** 6),
      unit: clean_text(get(r, "unit"), "resource unit", 20) || "h" });
  });
  const rsrcIds = _unique(rsrcs, "resources");
  p.resources = rsrcs;

  const asg = [];
  _list(obj, "assigns", "assigns").forEach((x, i) => {
    _keys(x, ["id", "act", "rsrc", "units", "budget", "actual"], `assignment ${i + 1}`);
    const xid = check_id(get(x, "id", `x${i + 1}`), `assignment ${i + 1} id`);
    if (!actIds.has(get(x, "act")) || !rsrcIds.has(get(x, "rsrc"))) throw new SchedError("bad_ref", `Assignment ${i + 1} points to an activity or resource that does not exist.`);
    asg.push({ id: xid, act: x.act, rsrc: x.rsrc, units: check_int(get(x, "units", 1000), "assignment units per hour", 0, 10 ** 6),
      budget: check_int(get(x, "budget", 0), "assignment budgeted quantity", 0, 10 ** 10), actual: check_int(get(x, "actual", 0), "assignment actual quantity", 0, 10 ** 10) });
  });
  _unique(asg, "assignments");
  p.assigns = asg;

  const bls = [];
  _list(obj, "baselines", "baselines").forEach((b, i) => {
    _keys(b, ["id", "name", "taken", "acts"], `baseline ${i + 1}`);
    const bid = check_id(get(b, "id"), `baseline ${i + 1} id`);
    const rows = orNull(get(b, "acts")) || {};
    if (!isObj(rows) || Object.keys(rows).length > LIMITS.activities) throw new SchedError("bad_field", `Baseline ${i + 1}: activities must be a map.`);
    const out = {};
    for (const k of sortedKeys(rows)) {
      const v = rows[k];
      if (!Array.isArray(v) || v.length !== 3) throw new SchedError("bad_field", `Baseline ${i + 1}: each activity is [start, finish, duration].`);
      out[check_id(k, "baseline activity id")] = [check_dt(v[0], "baseline start"), check_dt(v[1], "baseline finish"), check_int(v[2], "baseline duration", 0, MAX_MIN)];
    }
    bls.push({ id: bid, name: clean_text(get(b, "name"), "baseline name", 120) || bid, taken: check_dt(get(b, "taken"), "baseline date"), acts: out });
  });
  const blIds = _unique(bls, "baselines");
  p.baselines = bls;
  p.baseline = orNull(get(obj, "baseline"));
  if (p.baseline !== null && !blIds.has(p.baseline)) p.baseline = null;
  return p;
}
const new_project = (name = "New project", start = "2026-11-02T08:00") => validate_project({ name, start, data_date: start });
