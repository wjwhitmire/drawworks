// ---------------------------------------------------------------- state, recalculation, undo, autosave
const APP = {
  db: null, key: "", projects: [], p: null, s: null, err: null, chk: null, vari: {}, roll: {}, ms: 0,
  undo: [], redo: [], sel: null, view: "acts", dtab: "general", rows: [], collapsed: new Set(),
  filter: "all", search: "", layout: "classic", zoom: 2, links: true, baseline: true, float: true, tw: 560, details: true,
  pane: "table", dirty: false, notes: [], colw: {}, density: "comfortable",
};
const UNDO_MAX = 100;
const UNDO_CHARS = 60 * 1024 * 1024;

function recalc() {
  const t0 = performance.now();
  try {
    APP.s = C.schedule(APP.p);
    APP.err = null;
    APP.chk = C.check(APP.p, APP.s);
    APP.vari = C.variance(APP.p, APP.s);
    APP.roll = C.wbs_rollup(APP.p, APP.s);
  } catch (e) {
    if (!(e instanceof C.SchedError)) throw e;
    APP.s = null; APP.err = e; APP.chk = null; APP.vari = {}; APP.roll = {};
  }
  APP.ms = Math.round(performance.now() - t0);
  APP.pcalC = C.compile_calendar(APP.p.calendars.find((c) => c.id === APP.p.cal));
  APP.byId = new Map(APP.p.activities.map((a) => [a.id, a]));
  APP.codeToId = new Map(APP.p.activities.map((a) => [a.code, a.id]));
  buildRows();
}

// One edit: copy, change, validate, refuse a change that would close a logic loop, then commit.
// opts.why says in one sentence why the change was made (a function is called after fn ran);
// opts.actor is "you" (default), "auto" (the tool did it as part of your action) or "rule".
function mutate(what, fn, opts) {
  const q = JSON.parse(JSON.stringify(APP.p));
  let v;
  try {
    const r = fn(q);
    v = C.validate_project(r || q);
    if (!(opts && opts.allowLoop)) C.topo_order(v.activities, v.rels);
  } catch (e) {
    if (e instanceof C.SchedError) { toast(e.message, "bad"); return false; }
    throw e;
  }
  const o = opts || {};
  commit(v, what, { why: typeof o.why === "function" ? o.why() : o.why || "", actor: o.actor || "you", approved: !!o.approved });
  return true;
}
let histSeq = 0;
const clock = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
function commit(v, what, info) {
  const before = JSON.stringify(APP.p);
  if (before === JSON.stringify(v)) return;
  const finBefore = APP.s ? APP.s.finish : null;
  const e = Object.assign({ what, why: "", actor: "you", approved: false }, info || {}, { p: before, at: clock(), seq: ++histSeq });
  APP.undo.push(e);
  let chars = APP.undo.reduce((t, u) => t + u.p.length, 0);
  while (APP.undo.length > UNDO_MAX || (chars > UNDO_CHARS && APP.undo.length > 1)) chars -= APP.undo.shift().p.length;
  APP.redo = [];
  APP.p = v;
  afterChange(what);
  e.calc = !APP.s ? "The schedule cannot be calculated after this change." :
    !finBefore ? `Recalculated in ${APP.ms} ms; finish ${fmtDate(APP.s.finish)}.` :
    finBefore === APP.s.finish ? `Recalculated in ${APP.ms} ms; the finish did not move.` :
    `Recalculated in ${APP.ms} ms; the finish moved from ${fmtDate(finBefore)} to ${fmtDate(APP.s.finish)}.`;
}
// read-only steps (a file opened, a check run) are logged but have nothing to undo
function logNote(what, why, actor) {
  APP.notes.push({ what, why, actor: actor || "auto", at: clock(), seq: ++histSeq, ro: true });
  if (APP.notes.length > 200) APP.notes.shift();
  renderStatus();
}
function afterChange(what) {
  recalc();
  if (APP.sel && !APP.byId.has(APP.sel)) APP.sel = null;
  renderAll();
  scheduleSave();
  if (what) setStatusNote(what);
  if ($("dlg").open && $("dlg").classList.contains("side")) historyBody();
}
function undo(quiet) {
  const u = APP.undo.pop();
  if (!u) { toast("Nothing to undo."); return; }
  APP.redo.push(Object.assign({}, u, { p: JSON.stringify(APP.p) }));
  APP.p = JSON.parse(u.p);
  afterChange(quiet ? "" : "Undid " + lc1(u.what));
}
function redo() {
  const r = APP.redo.pop();
  if (!r) { toast("Nothing to redo."); return; }
  APP.undo.push(Object.assign({}, r, { p: JSON.stringify(APP.p) }));
  APP.p = JSON.parse(r.p);
  afterChange("Redid " + lc1(r.what));
}
// undo back to and including one History entry, as one step for the person
function undoTo(seq) {
  const i = APP.undo.findIndex((u) => u.seq === seq);
  if (i < 0) return;
  const n = APP.undo.length - i;
  for (let k = 0; k < n; k++) {
    const u = APP.undo.pop();
    APP.redo.push(Object.assign({}, u, { p: JSON.stringify(APP.p) }));
    APP.p = JSON.parse(u.p);
  }
  afterChange(n === 1 ? "Undid 1 change" : `Undid ${n} changes`);
}
const lc1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);
function plural(n, word, many) { return n + " " + (n === 1 ? word : many || word + "s"); }

// ---- autosave to IndexedDB, a moment after the last change
let saveTimer = 0;
function scheduleSave() {
  APP.dirty = true;
  $("st-save").textContent = "Saving...";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!APP.key || !APP.p) return;
  try {
    await dbPut("projects", APP.key, APP.p);
    const row = { key: APP.key, name: APP.p.name, label: APP.p.label, saved: new Date().toISOString().slice(0, 16).replace("T", " ") };
    const i = APP.projects.findIndex((x) => x.key === APP.key);
    if (i < 0) APP.projects.push(row); else APP.projects[i] = row;
    await kvSet("projects", APP.projects);
    await kvSet("current", APP.key);
    APP.dirty = false;
    $("st-save").textContent = APP.db ? "Saved on this device" : "Not saved (storage unavailable)";
  } catch (e) {
    $("st-save").textContent = "Not saved: " + errText(e);
  }
}
let noteTimer = 0;
function setStatusNote(text) {
  const n = $("st-count");
  n.dataset.note = text;
  renderStatus();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { delete n.dataset.note; renderStatus(); }, 4000);
}
const newKey = () => "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

// ---- ids and codes for new records
function nextId(rows, prefix) {
  const used = new Set(rows.map((r) => r.id));
  let n = rows.length + 1;
  while (used.has(prefix + n)) n++;
  return prefix + n;
}
// Activity IDs count up by 10 from the highest numbered code with the same prefix (A1000, A1010, ...).
function nextCode() {
  let best = null;
  for (const a of APP.p.activities) {
    const m = /^(.*?)(\d+)$/.exec(a.code);
    if (m && (!best || +m[2] > best.n)) best = { pre: m[1], n: +m[2], w: m[2].length };
  }
  if (!best) return "A1000";
  const used = new Set(APP.p.activities.map((a) => a.code));
  let n = best.n + 10;
  while (used.has(best.pre + String(n).padStart(best.w, "0"))) n += 10;
  return best.pre + String(n).padStart(best.w, "0");
}

// ---- display rows: WBS bands and activities, filtered, collapsed groups hidden
const FILTERS = [
  ["all", "All activities"], ["crit", "Critical activities"], ["near", "Critical and near critical"], ["open", "Not complete"],
  ["started", "In progress"], ["neg", "Negative float"], ["lp", "Longest path"],
];
function actPasses(a) {
  const rec = APP.s ? APP.s.acts[a.id] : null;
  const f = APP.filter;
  if (f === "crit" && !(rec && rec.crit)) return false;
  if (f === "near" && !(rec && (rec.crit || rec.near))) return false;
  if (f === "open" && a.af) return false;
  if (f === "started" && !(a.as && !a.af)) return false;
  if (f === "neg" && !(rec && rec.tf !== null && rec.tf < 0)) return false;
  if (f === "lp" && !(rec && rec.lp)) return false;
  if (f.startsWith("wbs:")) {
    const target = f.slice(4);
    let w = a.wbs, ok = false;
    const parent = new Map(APP.p.wbs.map((x) => [x.id, x.parent]));
    while (w) { if (w === target) { ok = true; break; } w = parent.get(w); }
    if (!ok) return false;
  }
  if (f.startsWith("rsrc:") && !APP.p.assigns.some((x) => x.act === a.id && x.rsrc === f.slice(5))) return false;
  if (APP.search) {
    const q = APP.search.toLowerCase();
    if (!a.code.toLowerCase().includes(q) && !a.name.toLowerCase().includes(q)) return false;
  }
  return true;
}
function buildRows() {
  const tree = C.tree_rows(APP.p);
  const visible = new Set(APP.p.activities.filter(actPasses).map((a) => a.id));
  const parent = new Map(APP.p.wbs.map((w) => [w.id, w.parent]));
  const live = new Set();
  for (const a of APP.p.activities) if (visible.has(a.id)) { let w = a.wbs; while (w) { live.add(w); w = parent.get(w); } }
  const rows = [];
  const hiddenUnder = (w) => { while (w) { if (APP.collapsed.has(w)) return true; w = parent.get(w); } return false; };
  for (const [kind, x, level] of tree) {
    if (kind === "w") {
      if (!live.has(x.id) || hiddenUnder(x.parent)) continue;
      rows.push({ kind, id: x.id, w: x, depth: level - 1 });
    } else {
      if (!visible.has(x.id) || hiddenUnder(x.wbs)) continue;
      rows.push({ kind, id: x.id, a: x, depth: level - 1 });
    }
  }
  APP.rows = rows;
  APP.rowIndex = new Map();
  rows.forEach((r, i) => { if (r.kind === "a") APP.rowIndex.set(r.id, i); });
}
