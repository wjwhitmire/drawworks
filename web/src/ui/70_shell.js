// ---------------------------------------------------------------- shell: menus, toolbar, views, keys, status
function renderAll() {
  $("productName").textContent = C.PRODUCT_NAME;
  $("projName").textContent = APP.p.name;
  $("projName").title = APP.p.name;
  const lab = $("projLabel");
  lab.hidden = !APP.p.label;
  lab.title = APP.p.label || "";
  lab.setAttribute("aria-label", APP.p.label || "");
  document.title = APP.p.name + " - " + C.PRODUCT_NAME;
  renderBanner();
  renderToolbar();
  if (APP.view === "acts") { renderSheet(); renderDetails(); actsKey(); }
  else if (APP.view === "net") { renderNetwork(); netKey(); }
  else if (APP.view === "res") renderResources();
  else renderCheck();
  const n = APP.chk ? APP.chk.findings.filter((f) => f.sev !== "info").length : 0;
  const bd = $("checkBadge");
  bd.hidden = !n;
  bd.textContent = n ? String(n) : "";
  bd.setAttribute("aria-label", plural(n, "finding"));
  renderStatus();
}
// exactly one key answer per view, in the flag at the right of the view bar
function setKey(label, value, small, sub) {
  $("keyL").textContent = label;
  clear($("keyV")).append(value);
  if (small) $("keyV").append(el("small", { text: small }));
  $("keyS").textContent = sub || "";
  $("key").setAttribute("aria-label", `${label}: ${value}${small ? " " + small : ""}`);
}
function actsKey() {
  if (!APP.s) { setKey("Project finish", "Not known", "", "The schedule cannot be calculated"); return; }
  const f = APP.s.finish;
  let sub = "No baseline to compare";
  const b = APP.p.baselines.find((x) => x.id === APP.p.baseline);
  if (b) {
    let bf = null;
    for (const k of Object.keys(b.acts)) if (b.acts[k][1] && (!bf || b.acts[k][1] > bf)) bf = b.acts[k][1];
    if (bf) {
      const cal = APP.pcalC, x = C.parse_dt(bf), y = C.parse_dt(f);
      if (x === y) sub = "On baseline: 0d variance";
      else { const w = fmtFloat(y > x ? cal.work_between(x, y) : cal.work_between(y, x), null); sub = y > x ? `${w} later than baseline ${b.name}` : `${w} ahead of baseline ${b.name}`; }
    }
  }
  setKey("Project finish", fmtDate(f, false), f.slice(11, 16), sub);
}
function netKey() {
  if (!APP.s) { setKey("Longest path", "Not known", "", "The schedule cannot be calculated"); return; }
  const lp = APP.p.activities.filter((a) => APP.s.acts[a.id].lp && APP.s.acts[a.id].status !== "complete");
  let last = null;
  for (const a of lp) if (!last || APP.s.acts[a.id].ef > APP.s.acts[last.id].ef) last = a;
  setKey("Longest path", plural(lp.length, "activity", "activities"), "", last ? `Traced back from ${last.code} through driving links` : "Every activity is complete");
}
function renderBanner() {
  const b = clear($("banner"));
  if (!APP.err) { b.hidden = true; return; }
  b.hidden = false;
  b.append(icon("alert"), el("strong", { text: "Cannot schedule." }), el("span", { text: APP.err.message }));
  const cyc = APP.err.cycle;
  if (cyc) {
    for (let i = 0; i + 1 < cyc.length; i++) {
      const r = APP.p.rels.find((x) => x.pred === cyc[i] && x.succ === cyc[i + 1]);
      if (!r) continue;
      const a = APP.byId.get(r.pred), s = APP.byId.get(r.succ);
      b.append(el("button", { type: "button", cls: "btn", text: `Remove ${a.code} to ${s.code}`, on: { click: () => mutate(`Remove link ${a.code} to ${s.code}`, (q) => { q.rels = q.rels.filter((x) => x.id !== r.id); }, { allowLoop: true, why: `${a.code} and ${s.code} were part of a logic loop; removing this link lets the schedule calculate.` }) } }));
    }
  }
}
function renderToolbar() {
  $("tb-undo").disabled = !APP.undo.length;
  $("tb-redo").disabled = !APP.redo.length;
  $("tb-undo").title = APP.undo.length ? "Undo " + APP.undo[APP.undo.length - 1].what + " (Ctrl+Z)" : "Undo (Ctrl+Z)";
  $("tb-redo").title = APP.redo.length ? "Redo " + APP.redo[APP.redo.length - 1].what + " (Ctrl+Y)" : "Redo (Ctrl+Y)";
  const lay = $("tb-layout");
  if (!lay.options.length) for (const k of Object.keys(LAYOUTS)) lay.append(el("option", { value: k, text: LAYOUTS[k][0] }));
  lay.value = APP.layout;
  const fl = clear($("tb-filter"));
  for (const [k, t] of FILTERS) fl.append(el("option", { value: k, text: t }));
  if (APP.p.wbs.length) { const g = el("optgroup", { label: "WBS" }); for (const w of APP.p.wbs) g.append(el("option", { value: "wbs:" + w.id, text: w.code + " " + w.name })); fl.append(g); }
  if (APP.p.resources.length) { const g = el("optgroup", { label: "Resource" }); for (const r of APP.p.resources) g.append(el("option", { value: "rsrc:" + r.id, text: r.code + " " + r.name })); fl.append(g); }
  fl.value = APP.filter;
  if (fl.value !== APP.filter) { APP.filter = "all"; fl.value = "all"; }
}
function renderStatus() {
  if (!APP.p) return;
  const st = showTime() || true;
  clear($("st-dd")).append(icon("datadate"), "Data date ", el("b", { text: fmtDate(APP.p.data_date, st) }));
  clear($("st-finish")).append(...(APP.s ? ["Finish ", el("b", { text: fmtDate(APP.s.finish, st) })] : ["Not scheduled"]));
  const n = $("st-count");
  const shown = APP.rows ? APP.rows.filter((r) => r.kind === "a").length : 0;
  n.textContent = n.dataset.note ? n.dataset.note : `${shown} of ${plural(APP.p.activities.length, "activity", "activities")}, scheduled in ${APP.ms} ms`;
  $("st-crit").textContent = APP.s ? `${Object.values(APP.s.acts).filter((r) => r.crit && r.status !== "complete").length} critical` : "";
  const hc = APP.undo.length + APP.redo.length + APP.notes.length;
  $("histCount").textContent = String(hc);
  $("histCount").hidden = !hc;
  $("st-hist").setAttribute("aria-label", `History, ${plural(hc, "entry", "entries")}`);
}
function showView(v) {
  APP.view = v;
  for (const k of ["acts", "net", "res", "check"]) {
    $("view-" + k).hidden = k !== v;
    $("v-" + k).setAttribute("aria-selected", k === v ? "true" : "false");
  }
  $("paneSwitch").hidden = v !== "acts";
  renderAll();
  kvSet("view", v);
}
function setPane(which) {
  APP.pane = which;
  $("sheet").classList.toggle("show-table", which === "table");
  $("sheet").classList.toggle("show-gantt", which === "gantt");
  $("ps-table").setAttribute("aria-pressed", which === "table" ? "true" : "false");
  $("ps-gantt").setAttribute("aria-pressed", which === "gantt" ? "true" : "false");
  queueSheet();
}
function zoom(d) {
  const z = Math.max(0, Math.min(ZOOMS.length - 1, APP.zoom + d));
  if (z === APP.zoom) return;
  const gs = $("gscroll");
  // keep the selected activity's start in view, otherwise the middle of the chart
  const r = APP.sel && APP.s ? APP.s.acts[APP.sel] : null;
  const anchorDays = r ? (C.parse_dt(r.es) - TL.t0) / 1440 : (gs.scrollLeft + gs.clientWidth / 2) / TL.ppd;
  const offset = r ? Math.min(gs.clientWidth / 3, 160) : gs.clientWidth / 2;
  APP.zoom = z;
  renderSheet();
  gs.scrollLeft = Math.max(0, anchorDays * TL.ppd - offset);
  kvSet("zoom", z);
}
// a freshly opened schedule shows its first rows and the chart with the data date a fifth of the way in
function scrollToStart() {
  $("tscroll").scrollTop = 0;
  const gs = $("gscroll");
  gs.scrollLeft = Math.max(0, XS(APP.p.data_date) - gs.clientWidth * 0.22);
  queueSheet();
}
function scheduleNow() {
  recalc();
  renderAll();
  if (APP.err) toast(APP.err.message, "bad");
  else {
    toast(`Scheduled ${plural(APP.p.activities.length, "activity", "activities")} in ${APP.ms} ms. Finish ${fmtDate(APP.s.finish)}.`);
    const n = APP.chk.findings.length, fx = APP.chk.findings.filter((f) => f.fix).length;
    logNote(`Scheduled: finish ${fmtDate(APP.s.finish)}`, `Forward and backward pass over ${plural(APP.p.activities.length, "activity", "activities")} in ${APP.ms} ms. The check found ${plural(n, "finding")}, ${fx} with a one-click fix. Nothing changed in the schedule.`);
  }
}

// ---- menus: [label, action, shortcut, disabled, icon, class]; {h: "Group"} starts a labeled group
const DENSITY = [["comfortable", "Comfortable rows (44 px)"], ["standard", "Standard rows (32 px)"], ["dense", "Dense rows (24 px)"]];
const isTouch = () => window.matchMedia && window.matchMedia("(pointer:coarse)").matches;
function setDensity(d) {
  APP.density = d;
  $("app").dataset.density = d;
  kvSet("density", d);
  renderAll();
  if (isTouch() && d !== "comfortable") toast("On a touch screen rows stay 44 px tall so they are easy to tap.");
}
const MENUS = {
  "m-file": () => [["Schedules on this device", projectsDialog, "Ctrl+O", false, "device"], ["Open a file (XER, Project XML, JSON)", () => $("fileIn").click(), null, false, "file"],
    ["New schedule", newProjectDialog, null, false, "add"], null, { h: "Export" },
    ...exportMenuItems(), null, ["Delete all data on this device", deleteAllDialog, null, false, "delete", "danger"]],
  "m-edit": () => [["Undo" + (APP.undo.length ? ": " + lc1(APP.undo[APP.undo.length - 1].what) : ""), () => undo(), "Ctrl+Z", !APP.undo.length, "undo"], ["Redo", redo, "Ctrl+Y", !APP.redo.length, "redo"],
    ["History", openHistory, null, false, "history"], null,
    ["Add activity", addActivity, "Insert", false, "add"], ["Delete activity", deleteActivity, "Delete", !APP.sel, "delete"], ["Find activity", findActivity, "Ctrl+F", false, "search"]],
  "m-view": () => [["Activities", () => showView("acts"), null, false, "gantt"], ["Network", () => showView("net"), null, false, "network"], ["Resource histogram", () => showView("res"), null, false, "histogram"], ["Schedule check", () => showView("check"), null, false, "check"], null,
    { h: "Rows" }, ...DENSITY.map(([k, t]) => [t, () => setDensity(k), null, false, APP.density === k ? "tick" : "density"]), null,
    { h: "Chart" },
    [(APP.links ? "Hide" : "Show") + " relationship lines", () => { APP.links = !APP.links; kvSet("links", APP.links); renderAll(); }, null, false, "link"],
    [(APP.float ? "Hide" : "Show") + " float bars", () => { APP.float = !APP.float; kvSet("float", APP.float); renderAll(); }, null, false, "float"],
    [(APP.baseline ? "Hide" : "Show") + " baseline bars", () => { APP.baseline = !APP.baseline; kvSet("baseline", APP.baseline); renderAll(); }, null, false, "baseline"],
    [(APP.details ? "Hide" : "Show") + " activity details", () => { APP.details = !APP.details; kvSet("details", APP.details); renderAll(); }, null, false, "info"],
    ["Expand all WBS", () => { APP.collapsed.clear(); buildRows(); renderAll(); }, null, false, "wbs"], ["Collapse all WBS", () => { APP.collapsed = new Set(APP.p.wbs.map((w) => w.id)); buildRows(); renderAll(); }, null, false, "wbs"],
    ["Fit all columns", () => { APP.colw = {}; kvSet("colw", APP.colw); cols().forEach((c) => fitColumn(c.key)); }, null, false, "table"],
    ["Zoom in", () => zoom(1), "Ctrl+=", false, "zoom-in"], ["Zoom out", () => zoom(-1), "Ctrl+-", false, "zoom-out"],
    ["Theme: " + ({ "": "follow device", light: "light", dark: "dark" })[document.documentElement.dataset.theme || ""], cycleTheme, null, false, "moon"]],
  "m-project": () => [["Schedule", scheduleNow, "F9", false, "schedule"], ["Project and schedule options", settingsDialog, null, false, "layout"], ["Calendars", () => calendarsDialog(), null, false, "calendar"], ["WBS", wbsDialog, null, false, "wbs"], ["Resources", resourcesDialog, null, false, "resource"], ["Baselines", baselineDialog, null, false, "baseline"]],
  "m-tools": () => [["Update progress", updateDialog, null, false, "update"], ["Resource leveling suggestion", () => showView("res"), null, false, "level"], ["Schedule check", () => showView("check"), null, false, "check"],
    ["Apply all suggested fixes", () => { const f = APP.chk ? APP.chk.findings.filter((x) => x.fix) : []; if (f.length) applyFixes(f); else toast("No suggested fixes right now."); }, null, false, "fix"]],
  "m-help": () => [["Keyboard shortcuts", shortcutsDialog, null, false, "help"], ["Method and limits", () => { $("method").open = true; $("method").scrollIntoView(); }, null, false, "info"], ["Network use", networkDialog, null, false, "lock"]],
};
// tools the toolbar folds away on a phone
function moreItems() {
  return [["Redo", redo, "Ctrl+Y", !APP.redo.length, "redo"], ["Baselines", baselineDialog, null, false, "baseline"], ["Resource leveling suggestion", () => showView("res"), null, false, "level"], null,
    ["Find activity", findActivity, null, false, "search"], { h: "Layout" }, ...Object.keys(LAYOUTS).map((k) => [LAYOUTS[k][0], () => { APP.layout = k; kvSet("layout", k); renderAll(); }, null, false, APP.layout === k ? "tick" : "layout"]),
    { h: "Filter" }, ...FILTERS.map(([k, t]) => [t, () => { APP.filter = k; buildRows(); renderAll(); }, null, false, APP.filter === k ? "tick" : "filter"]), null,
    ["Zoom in", () => zoom(1), null, false, "zoom-in"], ["Zoom out", () => zoom(-1), null, false, "zoom-out"]];
}
function phoneMenu() {
  const names = { "m-file": "File", "m-edit": "Edit", "m-view": "View", "m-project": "Project", "m-tools": "Tools", "m-help": "Help" };
  const out = [];
  for (const id of Object.keys(MENUS)) { out.push({ h: names[id] }); out.push(...MENUS[id]().filter((x) => x && !x.h)); }
  return out;
}
function findActivity() {
  if (window.matchMedia("(min-width:761px)").matches) { $("tb-search").focus(); return; }
  const inp = el("input", { id: "find-q", type: "search", value: APP.search, placeholder: "Find ID or name", autocomplete: "off" });
  openDialog({ title: "Find activity", body: [fld("find-q", "Activity ID or name", inp)], actions: [{ label: "Clear", onClick: () => { APP.search = ""; $("tb-search").value = ""; buildRows(); renderAll(); } },
    { label: "Find", primary: true, onClick: () => { APP.search = inp.value.trim(); $("tb-search").value = APP.search; buildRows(); renderAll(); } }] });
}
let menuOwner = null;
function openMenu(btn, items) {
  const m = clear($("menu"));
  m.setAttribute("aria-label", btn.getAttribute("aria-label") || btn.textContent);
  for (const it of items) {
    if (!it) { m.append(el("hr")); continue; }
    if (it.h) { m.append(el("div", { cls: "mh", text: it.h })); continue; }
    const [label, fn, kbd, disabled, ic, cls] = it;
    const b = el("button", { type: "button", role: "menuitem", disabled: !!disabled, cls: cls || null }, [ic ? icon(ic) : null, el("span", { text: label }), kbd ? el("span", { cls: "kbd", text: kbd }) : null]);
    b.addEventListener("click", () => { closeMenu(); fn(); });
    m.append(b);
  }
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.maxHeight = Math.max(200, window.innerHeight - r.bottom - 16) + "px";
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = r.bottom + 4 + "px";
  if (menuOwner) menuOwner.setAttribute("aria-expanded", "false");
  menuOwner = btn;
  btn.setAttribute("aria-expanded", "true");
  const first = m.querySelector("button:not([disabled])");
  if (first) first.focus();
}
function closeMenu() {
  $("menu").hidden = true;
  if (menuOwner) { menuOwner.setAttribute("aria-expanded", "false"); menuOwner = null; }
}
function themeIcon() {
  const t = document.documentElement.dataset.theme || "";
  const dark = t === "dark" || (!t && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  clear($("themeBtn")).append(icon(dark ? "sun" : "moon"));
  const lab = "Theme: " + ({ "": "follow device", light: "light", dark: "dark" })[t] + ". Switch theme";
  $("themeBtn").setAttribute("aria-label", lab);
  $("themeBtn").title = lab;
}
function cycleTheme() {
  const cur = document.documentElement.dataset.theme || "";
  const next = cur === "" ? "light" : cur === "light" ? "dark" : "";
  if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
  kvSet("theme", next);
  themeIcon();
  renderAll();
}

// ---- History: every change, who or what made it, why, and undo back to any point
let histShow = "all";
function openHistory() {
  openDialog({ title: "History", side: true, body: [] });
  historyBody();
}
function historyBody() {
  const body = clear($("dlgBody"));
  const seg = el("span", { cls: "seg", role: "group", "aria-label": "Show" });
  for (const [k, t] of [["all", "All"], ["auto", "Automatic"], ["you", "Mine"]]) {
    seg.append(el("button", { type: "button", "aria-pressed": histShow === k ? "true" : "false", text: t, on: { click: () => { histShow = k; historyBody(); } } }));
  }
  body.append(el("div", { cls: "vhead" }, [el("span", { cls: "muted", text: "Newest first. Undo to here reverses that change and everything after it." }), el("span", { cls: "tabs-fill" }), seg]));
  const live = APP.undo.map((e) => Object.assign({ state: "on" }, e));
  const gone = APP.redo.map((e) => Object.assign({ state: "undone" }, e));
  const all = live.concat(gone, APP.notes.map((e) => Object.assign({ state: "ro" }, e))).sort((x, y) => y.seq - x.seq)
    .filter((e) => histShow === "all" || (histShow === "auto" ? e.actor !== "you" : e.actor === "you"));
  const top = APP.undo.length ? APP.undo[APP.undo.length - 1].seq : null;
  const redoTop = APP.redo.length ? APP.redo[APP.redo.length - 1].seq : null;
  const list = el("div", { cls: "hist" });
  if (!all.length) list.append(el("p", { cls: "muted", style: "padding:16px", text: "Nothing yet. Every change you make, and every step the tool takes for you, is listed here with the reason." }));
  for (const e of all) {
    const who = e.actor === "you" ? "you" : "auto";
    const meta = (e.actor === "you" ? "You" : e.actor === "rule" ? "Rule" : e.approved ? "You approved" : "Automatic") + " / " + e.at + (e.state === "undone" ? " / undone" : "");
    let btn = el("span");
    if (e.state === "on") btn = el("button", { type: "button", cls: "btn", on: { click: () => { undoTo(e.seq); } } }, [icon("undo"), e.seq === top ? "Undo" : "Undo to here"]);
    else if (e.state === "undone" && e.seq === redoTop) btn = el("button", { type: "button", cls: "btn", on: { click: () => redo() } }, [icon("redo"), "Redo"]);
    const why = [e.why, e.calc].filter(Boolean).join(" ");
    list.append(el("div", { cls: "hist-e" + (e.seq === top ? " now" : "") + (e.state === "undone" ? " undone" : "") }, [
      el("span", { cls: "who " + who }, icon(who === "auto" ? "auto" : "tick")),
      el("div", null, [el("h4", { text: e.what }), why ? el("p", { cls: "why", text: why }) : null, el("p", { cls: "meta", text: meta })]), btn]));
  }
  body.append(list);
}

function wireShell() {
  for (const id of Object.keys(MENUS)) $(id).addEventListener("click", (ev) => { ev.stopPropagation(); if (menuOwner === $(id)) closeMenu(); else openMenu($(id), MENUS[id]()); });
  document.addEventListener("click", (ev) => { if (!$("menu").contains(ev.target)) closeMenu(); });
  $("menu").addEventListener("keydown", (ev) => {
    const items = Array.from($("menu").querySelectorAll("button:not([disabled])"));
    const i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (ev.key === "Escape") { const o = menuOwner; closeMenu(); if (o) o.focus(); }
  });
  $("tb-schedule").addEventListener("click", scheduleNow);
  $("tb-add").addEventListener("click", addActivity);
  $("tb-del").addEventListener("click", deleteActivity);
  $("tb-undo").addEventListener("click", () => undo());
  $("tb-redo").addEventListener("click", () => redo());
  $("tb-update").addEventListener("click", updateDialog);
  $("tb-baseline").addEventListener("click", baselineDialog);
  $("tb-level").addEventListener("click", () => showView("res"));
  $("tb-zoomin").addEventListener("click", () => zoom(1));
  $("tb-zoomout").addEventListener("click", () => zoom(-1));
  $("tb-export").addEventListener("click", (ev) => { ev.stopPropagation(); if (menuOwner === $("tb-export")) closeMenu(); else openMenu($("tb-export"), exportMenuItems()); });
  $("tb-more").addEventListener("click", (ev) => { ev.stopPropagation(); if (menuOwner === $("tb-more")) closeMenu(); else openMenu($("tb-more"), moreItems()); });
  $("menuBtn").addEventListener("click", (ev) => { ev.stopPropagation(); if (menuOwner === $("menuBtn")) closeMenu(); else openMenu($("menuBtn"), phoneMenu()); });
  $("themeBtn").addEventListener("click", cycleTheme);
  $("st-hist").addEventListener("click", openHistory);
  $("toastUndo").addEventListener("click", () => { $("toast").hidden = true; undo(); });
  $("dlgX").addEventListener("click", () => closeDialog());
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { themeIcon(); renderAll(); });
  const segPick = (sel, val) => { $(sel).value = val; renderResources(); };
  $("r-early").addEventListener("click", () => segPick("r-which", "early"));
  $("r-late").addEventListener("click", () => segPick("r-which", "late"));
  $("r-day").addEventListener("click", () => segPick("r-bucket", "day"));
  $("r-week").addEventListener("click", () => segPick("r-bucket", "week"));
  // column edges: drag to resize, double-click to fit the content
  $("thead").addEventListener("dblclick", (ev) => { const g = ev.target.closest(".grip"); if (g) { ev.preventDefault(); fitColumn(g.dataset.k); } });
  $("thead").addEventListener("pointerdown", (ev) => {
    const g = ev.target.closest(".grip");
    if (!g) return;
    ev.preventDefault();
    const k = g.dataset.k, x0 = ev.clientX, w0 = colWidth(k);
    g.setPointerCapture(ev.pointerId);
    const move = (e) => { APP.colw = Object.assign({}, APP.colw, { [k]: Math.max(40, Math.min(600, Math.round(w0 + e.clientX - x0))) }); renderSheet(); };
    const up = () => { g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); kvSet("colw", APP.colw); };
    g.addEventListener("pointermove", move); g.addEventListener("pointerup", up);
  });
  $("tb-layout").addEventListener("change", (ev) => { APP.layout = ev.target.value; kvSet("layout", APP.layout); renderAll(); });
  $("tb-filter").addEventListener("change", (ev) => { APP.filter = ev.target.value; buildRows(); renderAll(); });
  let st = 0;
  $("tb-search").addEventListener("input", (ev) => { clearTimeout(st); st = setTimeout(() => { APP.search = ev.target.value.trim(); buildRows(); renderAll(); }, 150); });
  for (const v of ["acts", "net", "res", "check"]) $("v-" + v).addEventListener("click", () => showView(v));
  for (const t of ["general", "status", "rels", "rsrc", "notes"]) $("d-" + t).addEventListener("click", () => { APP.dtab = t; APP.details = true; renderDetails(); });
  $("d-toggle").addEventListener("click", () => { APP.details = !APP.details; kvSet("details", APP.details); renderDetails(); });
  $("ps-table").addEventListener("click", () => setPane("table"));
  $("ps-gantt").addEventListener("click", () => setPane("gantt"));
  for (const id of ["r-rsrc", "r-which", "r-bucket"]) $(id).addEventListener("change", renderResources);
  $("tb-search").addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.target.value = ""; APP.search = ""; buildRows(); renderAll(); } });
  $("r-manage").addEventListener("click", resourcesDialog);
  $("dlg").addEventListener("close", dialogClosed);
  $("fileIn").addEventListener("change", async (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ""; if (f) await importFile(f); });
  // shared vertical scroll between table and chart
  let lock = false;
  const sync = (from, to) => () => { if (lock) return; lock = true; to.scrollTop = from.scrollTop; lock = false; queueSheet(); };
  $("tscroll").addEventListener("scroll", sync($("tscroll"), $("gscroll")));
  $("gscroll").addEventListener("scroll", () => { syncScaleScroll(); sync($("gscroll"), $("tscroll"))(); });
  $("tscroll").addEventListener("scroll", () => { $("thead").scrollLeft = $("tscroll").scrollLeft; $("thead").style.transform = `translateX(${-$("tscroll").scrollLeft}px)`; });
  // table: click selects, double click edits
  $("trows").addEventListener("click", (ev) => {
    const line = ev.target.closest(".tr");
    if (!line || editing) return;
    const i = +line.dataset.i;
    const cell = ev.target.closest(".tc");
    cursor = { i, ci: cell ? +cell.dataset.c || 0 : 0 };
    if (line.dataset.id) selectAct(line.dataset.id, false);
    $("tscroll").focus({ preventScroll: true });
  });
  $("trows").addEventListener("dblclick", (ev) => {
    const line = ev.target.closest(".tr"), cell = ev.target.closest(".tc");
    if (line && cell && line.dataset.id) { cursor = { i: +line.dataset.i, ci: +cell.dataset.c }; startEdit(cursor.i, cursor.ci); }
  });
  $("gsvg").addEventListener("click", (ev) => { const id = ev.target.dataset && ev.target.dataset.id; const hit = ev.target.closest("[data-id]"); const aid = id || (hit && hit.dataset.id); if (aid) { cursor.i = APP.rowIndex.get(aid) || 0; selectAct(aid, false); } });
  $("netsvg").addEventListener("click", (ev) => { const g = ev.target.closest("[data-id]"); if (g) { APP.sel = g.dataset.id; renderNetwork(); } });
  $("netsvg").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { const g = ev.target.closest("[data-id]"); if (g) { showView("acts"); selectAct(g.dataset.id, "gantt"); } } });
  $("tscroll").addEventListener("keydown", (ev) => {
    if (editing) return;
    const k = ev.key;
    if (k === "ArrowDown") { ev.preventDefault(); moveCell(1, 0); }
    else if (k === "ArrowUp") { ev.preventDefault(); moveCell(-1, 0); }
    else if (k === "ArrowRight" || (k === "Tab" && !ev.shiftKey)) { ev.preventDefault(); moveCell(0, 1); }
    else if (k === "ArrowLeft" || (k === "Tab" && ev.shiftKey)) { ev.preventDefault(); moveCell(0, -1); }
    else if (k === "PageDown") { ev.preventDefault(); moveCell(Math.floor($("tscroll").clientHeight / RH), 0); }
    else if (k === "PageUp") { ev.preventDefault(); moveCell(-Math.floor($("tscroll").clientHeight / RH), 0); }
    else if (k === "Enter" || k === "F2") { ev.preventDefault(); startEdit(cursor.i, cursor.ci); }
    else if (k === "Delete") { ev.preventDefault(); deleteActivity(); }
    else if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { const c = cols()[cursor.ci]; if (c && c.edit) { ev.preventDefault(); startEdit(cursor.i, cursor.ci, k); } }
  });
  // splitter
  const sp = $("split");
  sp.addEventListener("pointerdown", (ev) => {
    sp.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX, w0 = APP.tw;
    const move = (e) => { APP.tw = Math.max(160, Math.min(window.innerWidth - 200, w0 + e.clientX - x0)); $("tpane").style.setProperty("--tw", APP.tw + "px"); };
    const up = () => { sp.removeEventListener("pointermove", move); sp.removeEventListener("pointerup", up); kvSet("tw", APP.tw); queueSheet(); };
    sp.addEventListener("pointermove", move); sp.addEventListener("pointerup", up);
  });
  sp.addEventListener("keydown", (ev) => { if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { APP.tw = Math.max(160, APP.tw + (ev.key === "ArrowLeft" ? -24 : 24)); $("tpane").style.setProperty("--tw", APP.tw + "px"); kvSet("tw", APP.tw); } });
  // global keys, the way desktop schedulers use them
  document.addEventListener("keydown", (ev) => {
    const typing = ev.target.matches && ev.target.matches("input, textarea, select") && ev.target.id !== "tscroll";
    if ($("dlg").open) return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ev.key === "F9") { ev.preventDefault(); scheduleNow(); }
    else if (ctrl && (ev.key === "z" || ev.key === "Z") && !ev.shiftKey && !typing) { ev.preventDefault(); undo(); }
    else if (ctrl && (ev.key === "y" || ((ev.key === "z" || ev.key === "Z") && ev.shiftKey)) && !typing) { ev.preventDefault(); redo(); }
    else if (ctrl && (ev.key === "=" || ev.key === "+")) { ev.preventDefault(); zoom(1); }
    else if (ctrl && ev.key === "-") { ev.preventDefault(); zoom(-1); }
    else if (ctrl && (ev.key === "o" || ev.key === "O")) { ev.preventDefault(); projectsDialog(); }
    else if (ctrl && (ev.key === "f" || ev.key === "F") && APP.view === "acts") { ev.preventDefault(); findActivity(); }
    else if (ctrl && (ev.key === "p" || ev.key === "P")) { ev.preventDefault(); if (APP.s) pdfDialog(); }
    else if (ev.key === "Insert" && !typing) { ev.preventDefault(); addActivity(); }
    else if (ev.key === "Escape") closeMenu();
  });
  let lastRH = RH;
  window.addEventListener("resize", () => { if (readRH() !== lastRH) { lastRH = RH; renderSheet(); } else queueSheet(); });
  window.addEventListener("beforeunload", () => { if (APP.dirty) saveNow(); });
}
