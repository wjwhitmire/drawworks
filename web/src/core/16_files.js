// ---------------------------------------------------------------- opening files, fidelity, CSV
// Mirrors src/fieldsched/files.py.
function detect(text) {
  const head = text.replace(/^[\ufeff \t\r\n]+/, "").slice(0, 4096);
  if (head.startsWith("ERMHDR") || head.startsWith("%T")) return "xer";
  if (head.startsWith("<")) return "mspdi";
  if (head.startsWith("{")) return "native";
  throw new SchedError("unknown_format", "This file is not an XER file, a Project XML file or a schedule saved by this tool.");
}
function parse_json(text) {
  if (text.length > 64 * 1024 * 1024) throw new SchedError("too_big", "The file is larger than 64 MB.");
  try { return JSON.parse(text); } catch (e) {
    let line = 1;
    const m = /position (\d+)/.exec(String(e && e.message));
    if (m) { const upto = text.slice(0, +m[1]); line = upto.split("\n").length; }
    throw new SchedError("bad_json", `The file is not valid JSON (near line ${line}).`);
  }
}
function open_file(data, projectId) {
  let text, enc;
  if (typeof data === "string") { text = data; enc = "text"; } else [text, enc] = decode_bytes(data);
  const kind = detect(text);
  let out;
  if (kind === "xer") { out = read_xer(text, projectId); out.report.encoding = enc; }
  else if (kind === "mspdi") { out = read_mspdi(text); out.report.encoding = enc; }
  else {
    const proj = validate_project(parse_json(text));
    out = { project: proj, report: { format: "native", encoding: enc, warnings: [], counts: { activities: proj.activities.length, rels: proj.rels.length, wbs: proj.wbs.length,
      calendars: proj.calendars.length, resources: proj.resources.length, assigns: proj.assigns.length }, tables: {}, unknown_tables: [] }, stored: {}, projects: [] };
  }
  out.kind = kind;
  return out;
}
function compare_stored(p, sched, stored, kind = "xer") {
  const ctx = new Ctx(p);
  let checked = 0, agree = 0;
  const diffs = [];
  for (const a of p.activities) {
    const s = has(stored, a.id) ? stored[a.id] : null;
    if (!truthy(s)) continue;
    const rec = sched.acts[a.id], C = ctx.cal.get(a.id);
    if (rec.status === "complete") continue;
    for (const f of ["es", "ef", "ls", "lf"]) {
      if (!get(s, f) || !rec[f]) continue;
      if (rec.status === "active" && (f === "ls" || (f === "es" && kind !== "xer"))) continue;
      const ours = f === "es" && rec.status === "active" ? rec.res : rec[f];
      checked++;
      const gap = C.work_between(parse_dt(s[f]), parse_dt(ours));
      if (gap === 0) agree++;
      else if (diffs.length < 500) diffs.push({ act: a.id, code: a.code, field: f, file: s[f], ours, gap });
    }
    for (const f of ["tf", "ff"]) {
      if (get(s, f) === null || rec[f] === null) continue;
      checked++;
      if (s[f] === rec[f]) agree++;
      else if (diffs.length < 500) diffs.push({ act: a.id, code: a.code, field: f, file: s[f], ours: rec[f], gap: rec[f] - s[f] });
    }
  }
  return { checked, agree, diffs };
}
const CSV_COLS = ["Activity ID", "Activity Name", "WBS", "Type", "Calendar", "Original Duration", "Remaining Duration", "Unit", "Start", "Finish", "Early Start", "Early Finish",
  "Late Start", "Late Finish", "Total Float", "Free Float", "Critical Activity", "Status", "Actual Start", "Actual Finish", "Percent Complete", "Predecessors", "Constraint",
  "Constraint Date", "BL Start", "BL Finish", "BL Finish Variance", "Resources"];
// Text a spreadsheet could run as a formula gets a leading apostrophe; a plain number such as a
// negative float stays a number.
function _cell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (["=", "+", "-", "@", "\t", "\r"].includes(s.slice(0, 1)) && !/^[+-]?[0-9]+(\.[0-9]+)?$/.test(s)) s = "'" + s;
  if (/[,"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const _fd = (t) => (t ? t.replace("T", " ") : "");
function export_csv(p, sched, vari) {
  const cal = new Map(p.calendars.map((c) => [c.id, c]));
  const wbs = new Map(p.wbs.map((w) => [w.id, w]));
  const code = new Map(p.activities.map((a) => [a.id, a.code]));
  const rname = new Map(p.resources.map((r) => [r.id, r.code]));
  const preds = new Map();
  for (const r of p.rels) {
    let lag = "";
    if (r.lag) lag = (r.lag > 0 ? "+" : "-") + fmt_fixed(Math.abs(r.lag), cal.get(p.cal).hpd, 2) + "d";
    if (!preds.has(r.succ)) preds.set(r.succ, []);
    preds.get(r.succ).push(`${code.get(r.pred)} ${r.type}${lag}`);
  }
  const rs = new Map();
  for (const x of p.assigns) { if (!rs.has(x.act)) rs.set(x.act, []); rs.get(x.act).push(rname.get(x.rsrc)); }
  vari = vari || {};
  const lines = [CSV_COLS.join(",")];
  for (const a of p.activities) {
    const rec = sched.acts[a.id], c = cal.get(a.cal || p.cal);
    const div = a.unit === "h" ? 60 : c.hpd;
    const n = (m) => (m === null || m === undefined ? "" : fmt_fixed(m, div, 2));
    const v = has(vari, a.id) ? vari[a.id] : {};
    const row = [a.code, a.name, a.wbs ? wbs.get(a.wbs).code : "", a.type, c.name, n(a.od), n(a.rd), a.unit, _fd(a.as || rec.es), _fd(a.af || rec.ef), _fd(rec.es), _fd(rec.ef),
      _fd(rec.ls), _fd(rec.lf), n(rec.tf), n(rec.ff), rec.crit ? "Yes" : "No", rec.status, _fd(a.as), _fd(a.af), fmt_fixed(rec.pct, 10, 1), (preds.get(a.id) || []).join("; "),
      a.cstr !== "ASAP" ? a.cstr : "", _fd(a.cstr_date), _fd(get(v, "bs")), _fd(get(v, "bf")), n(get(v, "fv")), (rs.get(a.id) || []).join("; ")];
    lines.push(row.map(_cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
function open_and_schedule(data) {
  const out = open_file(data);
  const sched = schedule(out.project);
  out.sched = sched;
  out.fidelity = truthy(out.stored) ? compare_stored(out.project, sched, out.stored, out.kind) : null;
  return out;
}
