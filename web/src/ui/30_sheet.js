// ---------------------------------------------------------------- activity table and Gantt chart
// The table and the chart share one row list and one vertical scroll position. Only the rows in
// view (plus a margin) are drawn, so imported schedules with thousands of activities stay quick.
// Row height comes from the stylesheet (--rh, set by the density mode), so both panes stay aligned.
let RH = 44;
const OVERSCAN = 25;
const HEAD_TIER = 22, HEAD_FLAG = 18, HEAD_H = 2 * HEAD_TIER + HEAD_FLAG;
function readRH() {
  const v = parseFloat(getComputedStyle($("app")).getPropertyValue("--rh"));
  RH = v > 0 ? v : 44;
  return RH;
}
const ZOOMS = [
  { name: "Quarters", ppd: 1.5 }, { name: "Months", ppd: 4 }, { name: "Weeks", ppd: 12 },
  { name: "Days", ppd: 36 }, { name: "Days and hours", ppd: 110 }, { name: "Hours", ppd: 400 },
];
const rec = (a) => (APP.s ? APP.s.acts[a.id] : null);
const showTime = () => APP.p.settings.unit === "h";
const dcell = (s, actual) => (s ? [fmtDate(s, showTime()), actual ? el("span", { cls: "act-a", title: "Actual", text: "A" }) : null] : "");
const COLS = {
  code: { h: "Activity ID", w: 76, edit: "code", cls: "c-code", get: (a) => a.code },
  name: { h: "Activity Name", w: 190, edit: "name", get: (a) => a.name },
  type: { h: "Type", w: 120, get: (a) => ({ task: "Task", start_ms: "Start milestone", finish_ms: "Finish milestone" })[a.type] },
  od: { h: "Original Duration", w: 80, n: true, edit: "od", get: (a) => fmtDur(a.od, a) },
  rd: { h: "Remaining Duration", w: 80, n: true, edit: "rd", get: (a) => fmtDur(a.rd, a) },
  pct: { h: "% Complete", w: 72, n: true, edit: "pct", get: (a, r) => (r ? pctText(r.pct) : "") },
  start: { h: "Start", w: 110, d: true, edit: "start", get: (a, r) => (a.as ? fmtDate(a.as, showTime()) + " A" : r ? fmtDate(r.es, showTime()) : ""), html: (a, r) => (a.as ? dcell(a.as, true) : r ? dcell(r.es) : "") },
  finish: { h: "Finish", w: 110, d: true, edit: "finish", get: (a, r) => (a.af ? fmtDate(a.af, showTime()) + " A" : r ? fmtDate(r.ef, showTime()) : ""), html: (a, r) => (a.af ? dcell(a.af, true) : r ? dcell(r.ef) : "") },
  es: { h: "Early Start", w: 110, d: true, get: (a, r) => (r ? fmtDate(r.status === "active" ? r.res : r.es, showTime()) : "") },
  ef: { h: "Early Finish", w: 110, d: true, get: (a, r) => (r ? fmtDate(r.ef, showTime()) : "") },
  ls: { h: "Late Start", w: 110, d: true, get: (a, r) => (r ? fmtDate(r.ls, showTime()) : "") },
  lf: { h: "Late Finish", w: 110, d: true, get: (a, r) => (r ? fmtDate(r.lf, showTime()) : "") },
  tf: { h: "Total Float", w: 64, n: true, get: (a, r) => (r ? fmtFloat(r.tf, a) : ""), neg: (a, r) => r && r.tf !== null && r.tf < 0 },
  ff: { h: "Free Float", w: 64, n: true, get: (a, r) => (r ? fmtFloat(r.ff, a) : "") },
  preds: { h: "Predecessors", w: 170, edit: "preds", get: (a) => predText(a.id) },
  succs: { h: "Successors", w: 170, get: (a) => succText(a.id) },
  cal: { h: "Calendar", w: 150, get: (a) => calName(a.cal || APP.p.cal) },
  cstr: { h: "Primary Constraint", w: 140, get: (a) => (a.cstr === "ASAP" ? "" : CSTR_LABEL[a.cstr]) },
  cdate: { h: "Constraint Date", w: 110, d: true, get: (a) => fmtDate(a.cstr_date, showTime()) },
  as: { h: "Actual Start", w: 110, d: true, edit: "as", get: (a) => fmtDate(a.as, showTime()) },
  af: { h: "Actual Finish", w: 110, d: true, edit: "af", get: (a) => fmtDate(a.af, showTime()) },
  status: { h: "Status", w: 100, get: (a) => (a.af ? "Complete" : a.as ? "In progress" : "Not started") },
  bs: { h: "BL Start", w: 110, d: true, get: (a) => fmtDate(blRow(a.id, 0), showTime()) },
  bf: { h: "BL Finish", w: 110, d: true, get: (a) => fmtDate(blRow(a.id, 1), showTime()) },
  fv: { h: "BL Finish Variance", w: 84, n: true, get: (a) => (APP.vari[a.id] ? fmtFloat(APP.vari[a.id].fv, a) : ""), neg: (a) => APP.vari[a.id] && APP.vari[a.id].fv < 0 },
  rsrc: { h: "Resources", w: 160, get: (a) => APP.p.assigns.filter((x) => x.act === a.id).map((x) => rsrcCode(x.rsrc)).join(", ") },
  wbs: { h: "WBS", w: 90, get: (a) => (a.wbs ? wbsById(a.wbs).code : "") },
};
const LAYOUTS = {
  classic: ["Classic schedule", ["code", "name", "od", "rd", "start", "finish", "tf"]],
  progress: ["Progress", ["code", "name", "status", "pct", "rd", "as", "af", "finish"]],
  baseline: ["Baseline variance", ["code", "name", "start", "finish", "bs", "bf", "fv"]],
  logic: ["Logic", ["code", "name", "preds", "succs", "tf", "ff"]],
  float: ["Early, late and float", ["code", "name", "es", "ef", "ls", "lf", "tf", "ff"]],
  resources: ["Resources", ["code", "name", "rsrc", "od", "start", "finish"]],
  constraints: ["Constraints and calendars", ["code", "name", "cal", "cstr", "cdate", "start", "finish", "tf"]],
};
const CSTR_LABEL = { ASAP: "As soon as possible", ALAP: "As late as possible", SNET: "Start on or after", SNLT: "Start on or before", FNET: "Finish on or after",
  FNLT: "Finish on or before", MSO: "Start on", MFO: "Finish on", MS_MAND: "Mandatory start", MF_MAND: "Mandatory finish" };
function calName(id) { const c = APP.p.calendars.find((x) => x.id === id); return c ? c.name : ""; }
function rsrcCode(id) { const r = APP.p.resources.find((x) => x.id === id); return r ? r.code : id; }
function wbsById(id) { return APP.p.wbs.find((w) => w.id === id) || { code: "", name: "" }; }
function blRow(id, i) { const b = APP.p.baselines.find((x) => x.id === APP.p.baseline); return b && b.acts[id] ? b.acts[id][i] : null; }
function lagText(lag, a) { return lag ? (lag > 0 ? "+" : "-") + fmtDur(Math.abs(lag), a) : ""; }
function predText(id) {
  return APP.p.rels.filter((r) => r.succ === id).map((r) => {
    const p = APP.byId.get(r.pred);
    return p.code + (r.type !== "FS" || r.lag ? r.type : "") + lagText(r.lag, APP.byId.get(id));
  }).join(", ");
}
function succText(id) {
  return APP.p.rels.filter((r) => r.pred === id).map((r) => APP.byId.get(r.succ).code + (r.type !== "FS" || r.lag ? r.type : "") + lagText(r.lag, APP.byId.get(r.succ))).join(", ");
}
// column widths: the layout's defaults, widened for dates with times, then any width the person set
function colWidth(k) {
  const w = APP.colw && APP.colw[k];
  if (w) return w;
  const c = COLS[k];
  return c.d && showTime() ? c.w + 50 : c.w;
}
function cols() { return (LAYOUTS[APP.layout] || LAYOUTS.classic)[1].map((k) => Object.assign({ key: k }, COLS[k], { w: colWidth(k) })); }
const PC_W = 28;

// ---- pen code: one state per activity, the same shape on the bar, the chip and the network box
function penState(r) {
  if (!r) return "norm";
  if (r.status === "complete") return "done";
  if (r.crit) return "crit";
  if (r.near) return "near";
  return "norm";
}
const PEN_LABEL = { done: "Complete", crit: "Critical", near: "Near critical", norm: "Not critical" };
function penChip(a, r) {
  const st = penState(r);
  const ms = a.type !== "task";
  let lab = PEN_LABEL[st];
  if (r && r.status === "active") lab = "In progress, " + lab.toLowerCase();
  const s = svg("svg", { class: "pen", viewBox: "0 0 20 12", role: "img", "aria-label": lab });
  s.append(svg("use", { href: `#pen-${ms ? "ms-" : ""}${st}${r && r.status === "active" && !ms && st !== "done" ? "-act" : ""}` }));
  return s;
}

// ---- timeline geometry
let TL = { t0: 0, t1: 1, ppd: 36 };
function timeline() {
  let lo = C.parse_dt(APP.p.data_date), hi = lo;
  const see = (s) => { if (s) { const t = C.parse_dt(s); if (t < lo) lo = t; if (t > hi) hi = t; } };
  see(APP.p.start);
  if (APP.s) { for (const a of APP.p.activities) { const r = APP.s.acts[a.id]; see(r.es); see(r.ef); see(r.lf); see(a.as); } see(APP.s.finish); }
  const b = APP.p.baselines.find((x) => x.id === APP.p.baseline);
  if (b && APP.baseline) for (const k of Object.keys(b.acts)) { see(b.acts[k][0]); see(b.acts[k][1]); }
  let ppd = ZOOMS[APP.zoom].ppd;
  const t0 = (Math.floor(lo / 1440) - 3) * 1440, t1 = (Math.floor(hi / 1440) + 10) * 1440;
  while ((t1 - t0) / 1440 * ppd > 400000 && APP.zoom > 0) { APP.zoom--; ppd = ZOOMS[APP.zoom].ppd; }
  // the chart always fills the pane, so the rows and bands run to its right edge
  const vw = ($("gscroll") && $("gscroll").clientWidth) || 0;
  const t1f = Math.max(t1, t0 + Math.ceil(vw / ppd + 1) * 1440);
  TL = { t0, t1: t1f, ppd };
}
const X = (t) => Math.round(((t - TL.t0) / 1440) * TL.ppd * 10) / 10;
const XS = (s) => X(C.parse_dt(s));
const tlWidth = () => Math.ceil(X(TL.t1)) + 1;

// ---- rendering
let renderQueued = false;
function queueSheet() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (!editing) drawSheetRows(); });
}
function renderSheet() {
  readRH();
  timeline();
  const cs = cols();
  const th = clear($("thead"));
  th.append(el("div", { cls: "hc pc", role: "columnheader" }, el("span", { cls: "sr", text: "State" })));
  let tw = PC_W;
  cs.forEach((c) => {
    const grip = el("span", { cls: "grip", title: "Drag to resize, double-click to fit", "aria-hidden": "true", "data-k": c.key });
    th.append(el("div", { cls: "hc" + (c.n ? " n" : ""), style: `width:${c.w}px`, role: "columnheader", "data-k": c.key }, [c.h, grip]));
    tw += c.w;
  });
  th.style.width = tw + "px";
  $("tspacer").style.width = tw + "px";
  $("tspacer").style.height = APP.rows.length * RH + "px";
  $("gspacer").style.height = APP.rows.length * RH + "px";
  $("gspacer").style.width = tlWidth() + "px";
  $("tpane").style.setProperty("--tw", APP.tw + "px");
  drawScale();
  drawSheetRows();
  $("tb-zoom").textContent = ZOOMS[APP.zoom].name;
  $("tscroll").setAttribute("aria-rowcount", String(APP.rows.length));
}
function visRange() {
  const sc = $("tscroll");
  const top = Math.max(0, Math.floor(sc.scrollTop / RH) - OVERSCAN);
  const n = Math.ceil((sc.clientHeight || 600) / RH) + 2 * OVERSCAN;
  return [top, Math.min(APP.rows.length, top + n)];
}
const chev = (open) => { const s = svg("svg", { class: "i", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }); s.append(svg("path", { d: open ? "M6.5 9.5l5.5 5.5 5.5-5.5" : "M9.5 6l6 6-6 6" })); return s; };
let drawing = false;
function drawSheetRows() {
  const [a0, a1] = visRange();
  const cs = cols();
  const tw = PC_W + cs.reduce((t, c) => t + c.w, 0);
  drawing = true;
  let box;
  try { box = clear($("trows")); } finally { drawing = false; }
  box.style.width = tw + "px";
  for (let i = a0; i < a1; i++) {
    const row = APP.rows[i];
    if (row.kind === "w") {
      const r = APP.roll[row.id] || {};
      const open = !APP.collapsed.has(row.id);
      const twb = el("button", { type: "button", cls: "tw", "aria-label": (open ? "Collapse " : "Expand ") + row.w.code, "aria-expanded": open ? "true" : "false" }, chev(open));
      twb.addEventListener("click", (ev) => { ev.stopPropagation(); toggleGroup(row.id); });
      const lvl = Math.min(3, row.depth + 1);
      const line = el("div", { cls: "tr grp l" + lvl, role: "row", "aria-level": lvl, style: `top:${i * RH}px;width:${tw}px`, "data-i": i });
      line.append(el("div", { cls: "tc pc" }));
      const w01 = cs[0].w + (cs[1] ? cs[1].w : 0);
      line.append(el("div", { cls: "tc wcell", role: "gridcell", style: `width:${w01}px;padding-left:${row.depth * 14}px` }, [twb, el("span", { cls: "wcode", text: row.w.code }), el("span", { cls: "wname", text: row.w.name })]));
      cs.slice(2).forEach((c) => {
        let content = "";
        if ((c.key === "start" || c.key === "es") && r.es) content = fmtDate(r.es, showTime());
        else if ((c.key === "finish" || c.key === "ef") && r.ef) content = fmtDate(r.ef, showTime());
        else if (c.key === "tf" && r.tf !== null && r.tf !== undefined) content = fmtFloat(r.tf, { unit: APP.p.settings.unit, cal: null });
        line.append(el("div", { cls: "tc" + (c.n ? " n" : c.d ? " d" : ""), style: `width:${c.w}px`, role: "gridcell", text: content }));
      });
      box.append(line);
      continue;
    }
    const a = row.a, r = rec(a);
    const st = r ? r.status : "planned";
    const line = el("div", { cls: "tr" + (APP.sel === a.id ? " sel" : "") + (r && r.crit && st !== "complete" ? " crit" : "") + (st === "complete" ? " done" : ""),
      role: "row", style: `top:${i * RH}px;width:${tw}px`, "data-i": i, "data-id": a.id, "aria-selected": APP.sel === a.id ? "true" : "false" });
    line.append(el("div", { cls: "tc pc", role: "rowheader" }, penChip(a, r)));
    cs.forEach((c, ci) => {
      const v = c.get(a, r) || "";
      const cell = el("div", { cls: "tc" + (c.n ? " n" : c.d ? " d" : "") + (c.cls ? " " + c.cls : "") + (c.edit ? " ed" : "") + (c.neg && c.neg(a, r) ? " neg" : ""),
        style: `width:${c.w}px;${c.key === "name" ? `padding-left:${8 + row.depth * 12}px` : ""}`, role: "gridcell", "data-c": ci, title: v.length > 16 ? v : null },
      c.html ? c.html(a, r) : v);
      line.append(cell);
    });
    box.append(line);
  }
  drawGantt(a0, a1);
}
function toggleGroup(id) {
  if (APP.collapsed.has(id)) APP.collapsed.delete(id); else APP.collapsed.add(id);
  buildRows();
  renderSheet();
}
// double-click a column edge to fit its content, as both desktop tools do; drag it to resize
function fitColumn(k) {
  const c = COLS[k];
  const probe = el("span", { style: "position:absolute;visibility:hidden;white-space:nowrap;font:" + getComputedStyle($("trows")).font });
  document.body.append(probe);
  let w = 0;
  const measure = (t) => { probe.textContent = t; w = Math.max(w, probe.getBoundingClientRect().width); };
  for (const a of APP.p.activities.slice(0, 3000)) measure((c.get(a, rec(a)) || "") + (c.d ? "  A" : ""));
  probe.style.font = "600 13px " + getComputedStyle(document.body).fontFamily;
  measure(c.h.length > 12 ? c.h.split(" ").reduce((m, x) => (x.length > m.length ? x : m), "") : c.h);
  probe.remove();
  const ind = k === "name" ? 12 * 4 : 0;
  APP.colw = Object.assign({}, APP.colw, { [k]: Math.min(600, Math.max(48, Math.ceil(w) + 22 + ind)) });
  kvSet("colw", APP.colw);
  renderSheet();
}

// ---- timescale: two tiers and the flag lane (data date, and the finish as the key answer)
function drawScale() {
  const s = clear($("gscale"));
  const W = tlWidth();
  s.setAttribute("width", W);
  s.setAttribute("height", HEAD_H);
  s.append(svg("rect", { width: W, height: HEAD_H, class: "g-headbg" }));
  const ppd = TL.ppd;
  const d0 = Math.floor(TL.t0 / 1440), d1 = Math.floor(TL.t1 / 1440);
  const tops = [], bots = [];
  let prevTop = null, prevBot = null;
  for (let d = d0; d <= d1; d++) {
    const [y, m, dd] = C.civil_from_days(d);
    const wd = C.weekday(d);
    const x = X(d * 1440);
    const p2 = String(dd).padStart(2, "0");
    let topKey, topLabel, botKey, botLabel;
    if (ppd < 3) { topKey = y; topLabel = String(y); botKey = y * 4 + Math.floor((m - 1) / 3); botLabel = "Q" + (Math.floor((m - 1) / 3) + 1); }
    else if (ppd < 10) { topKey = y; topLabel = String(y); botKey = y * 12 + m; botLabel = MON[m - 1]; }
    else if (ppd < 30) { topKey = y * 12 + m; topLabel = MON[m - 1] + " " + y; botKey = Math.floor((d + 3) / 7); botLabel = p2; }
    else if (ppd < 100) { topKey = Math.floor((d + 3) / 7); topLabel = `Week of ${p2} ${MON[m - 1]} ${y}`; botKey = d; botLabel = ppd < 50 ? "SMTWTFS"[wd] : p2; }
    else { topKey = d; topLabel = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wd]} ${p2} ${MON[m - 1]}`; botKey = null; }
    if (topKey !== prevTop) { tops.push([x, topLabel]); prevTop = topKey; }
    if (botKey !== null && botKey !== prevBot) { bots.push([x, botLabel]); prevBot = botKey; }
    if (botKey === null) for (const h of [0, 6, 12, 18]) bots.push([X(d * 1440 + h * 60), String(h).padStart(2, "0")]);
  }
  const tier = (list, y0) => list.forEach(([x, label], i) => {
    const next = i + 1 < list.length ? list[i + 1][0] : W;
    s.append(svg("path", { d: `M${x} ${y0}v${HEAD_TIER}`, class: "g-tick" }));
    if (next - x >= label.length * 7.4 + 6) s.append(svg("text", { x: x + 4, y: y0 + 15, class: "g-label" }, label));
  });
  tier(tops, 0);
  tier(bots, HEAD_TIER);
  s.append(svg("path", { d: `M0 ${HEAD_TIER}H${W}M0 ${2 * HEAD_TIER}H${W}`, class: "g-tick" }));
  const flagRect = (t, label) => { const x = X(t), w = label.length * 6.9 + 26; return { x, w, bx: x + w <= W - 2 ? x : x - w }; };
  const flag = (kind, f, label) => {
    const bx = f.bx, w = f.w, y = 2 * HEAD_TIER;
    const g = svg("g", { class: kind === "dd" ? "g-flag-dd" : "g-flag-fin" });
    g.append(svg("rect", { x: bx, y: y + 1, width: w, height: HEAD_FLAG - 2, rx: 3 }));
    if (kind === "fin") g.append(svg("path", { d: `M${bx + 10} ${y + 4}l5 5-5 5-5-5z`, class: "g-flag-ico" }));
    else g.append(svg("path", { d: `M${bx + 10} ${y + 4}v11`, class: "g-flag-ico", "stroke-dasharray": "2 1.5" }));
    g.append(svg("text", { x: bx + 20, y: y + 13, class: "g-flag-tx" }, label));
    s.append(g);
  };
  const ddLab = "DATA DATE " + fmtDate(APP.p.data_date, showTime());
  const dd = flagRect(C.parse_dt(APP.p.data_date), ddLab);
  if (APP.s) {
    const finLab = "FINISH " + fmtDate(APP.s.finish, showTime());
    const fin = flagRect(C.parse_dt(APP.s.finish), finLab);
    // when the two flags would overlap, the data date flag hangs to the left of its line
    if (dd.bx < fin.bx + fin.w && fin.bx < dd.bx + dd.w) dd.bx = Math.max(0, Math.min(dd.x - dd.w, fin.bx - dd.w - 2));
    flag("dd", dd, ddLab);
    flag("fin", fin, finLab);
  } else flag("dd", dd, ddLab);
  syncScaleScroll();
}
function syncScaleScroll() { $("gscale").style.transform = `translateX(${-$("gscroll").scrollLeft}px)`; }

// ---- Gantt body: rows, links, bars, data date, finish line (in that order)
function drawGantt(a0, a1) {
  const g = clear($("gsvg"));
  const W = tlWidth(), H = APP.rows.length * RH;
  g.setAttribute("width", W);
  g.setAttribute("height", Math.max(H, 1));
  const defs = svg("defs");
  const pat = svg("pattern", { id: "g-near", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pat.append(svg("rect", { width: 6, height: 6, class: "pf-near" }), svg("path", { d: "M0 0v6", class: "ps-near" }));
  defs.append(pat);
  g.append(defs);
  const gs = $("gscroll");
  const vx0 = Math.max(0, gs.scrollLeft - 400), vx1 = gs.scrollLeft + (gs.clientWidth || 1200) + 400;
  const y0 = a0 * RH, y1 = a1 * RH;
  const gBack = svg("g"), gRows = svg("g"), gLinks = svg("g", { class: "g-links" }), gBars = svg("g");
  g.append(gBack, gRows, gLinks, gBars);
  // non-working time of the project calendar, from the Weeks zoom up; a 24 hour calendar has none
  if (TL.ppd >= 12) {
    const cal = APP.pcalC;
    const dStart = Math.floor(vx0 / TL.ppd + TL.t0 / 1440), dEnd = Math.ceil(vx1 / TL.ppd + TL.t0 / 1440);
    for (let d = dStart; d <= dEnd; d++) if (cal.day_work(d) === 0) gBack.append(svg("rect", { x: X(d * 1440), y: y0, width: TL.ppd, height: y1 - y0, class: "g-nonwork" }));
  }
  // gridlines on the top tier boundaries
  {
    const dStart = Math.floor(vx0 / TL.ppd + TL.t0 / 1440), dEnd = Math.ceil(vx1 / TL.ppd + TL.t0 / 1440);
    let prev = null;
    for (let d = dStart; d <= dEnd; d++) {
      const [yy, mm] = C.civil_from_days(d);
      const k = TL.ppd < 30 ? yy * 12 + mm : TL.ppd < 100 ? Math.floor((d + 3) / 7) : d;
      if (prev !== null && k !== prev) gBack.append(svg("path", { d: `M${X(d * 1440)} ${y0}V${y1}`, class: "g-grid" }));
      prev = k;
    }
  }
  const b = APP.baseline ? APP.p.baselines.find((x) => x.id === APP.p.baseline) : null;
  const bh = Math.max(8, Math.round(RH * 0.4)), blH = RH < 40 ? 3 : 4;
  const pos = new Map();
  for (let i = a0; i < a1; i++) {
    const row = APP.rows[i], y = i * RH;
    if (row.kind === "w") {
      gRows.append(svg("rect", { x: 0, y, width: W, height: RH, class: "g-band l" + Math.min(3, row.depth + 1) }));
      const r = APP.roll[row.id];
      if (r && r.es) {
        const x1 = XS(r.es), x2 = Math.max(XS(r.ef), x1 + 10), cy = y + RH / 2 - 3;
        gBars.append(svg("path", { d: `M${x1} ${cy - 2}H${x2}v10l-5-5H${x1 + 5}l-5 5z`, class: "g-sum" }));
      }
      continue;
    }
    const a = row.a, r = rec(a);
    if (APP.sel === a.id) gRows.append(svg("rect", { x: 0, y, width: W, height: RH, class: "g-row sel" }));
    gRows.append(svg("rect", { x: 0, y, width: W, height: RH, class: "g-row", "data-id": a.id, style: "fill:transparent" }));
    if (!r) continue;
    const st = penState(r);
    const hasBl = !!(b && b.acts[a.id] && a.type === "task");
    const by = y + (RH - bh) / 2 - (hasBl ? blH / 2 + 1 : 0);
    const cy = by + bh / 2;
    if (hasBl) {
      const bx1 = XS(b.acts[a.id][0]), bx2 = XS(b.acts[a.id][1]);
      gBars.append(svg("rect", { x: bx1, y: by + bh + 2, width: Math.max(2, bx2 - bx1), height: blH, class: "g-bl" }));
    }
    const es = XS(r.es), ef = XS(r.ef);
    const cls = { done: "g-bar done", crit: "g-bar crit", near: "g-bar near", norm: "g-bar" }[st];
    const nearFill = st === "near" ? "fill:url(#g-near)" : null;
    let x0 = es, x1 = ef;
    if (a.type !== "task" || (a.od === 0 && r.status !== "active")) {
      const s = bh / 2 + 2;
      gBars.append(svg("path", { d: `M${es} ${cy - s}l${s} ${s}-${s} ${s}-${s}-${s}z`, class: { done: "g-ms done", crit: "g-ms crit", near: "g-ms near", norm: "g-ms" }[st], style: nearFill }));
      x0 = es - s; x1 = es + s;
    } else if (r.status === "active") {
      // actual work in ink up to the data date, a 1 px paper gap, then the remaining state
      const xa = XS(a.as), xd = Math.min(X(C.parse_dt(APP.p.data_date)), ef);
      gBars.append(svg("rect", { x: xa, y: by, width: Math.max(1, xd - xa - 1), height: bh, class: "g-act" }));
      const xr = XS(r.res);
      gBars.append(svg("rect", { x: xr, y: by, width: Math.max(1, ef - xr), height: bh, class: cls, style: nearFill }));
      x0 = xa;
    } else {
      gBars.append(svg("rect", { x: es, y: by, width: Math.max(1, ef - es), height: bh, class: cls, style: nearFill }));
    }
    let tail = x1;
    if (APP.float && r.lf && r.tf > 0 && r.status !== "complete") {
      const xl = XS(r.lf);
      if (xl > ef + 1) { gBars.append(svg("path", { d: `M${ef} ${cy}H${xl}M${xl} ${cy - bh / 2 + 1}v${bh - 2}`, class: "g-float" })); tail = Math.max(tail, xl); }
    }
    if (TL.ppd >= 4) gBars.append(svg("text", { x: tail + 6, y: cy + 4.5, class: "g-text" }, a.name.length > 60 ? a.name.slice(0, 57) + "..." : a.name));
    pos.set(a.id, { y: cy, s: x0, f: x1 });
  }
  if (APP.links && APP.s) {
    for (const r of APP.p.rels) {
      const p = pos.get(r.pred), q = pos.get(r.succ);
      if (!p || !q) continue;
      const t = r.type;
      const xa = t === "FS" || t === "FF" ? p.f : p.s;
      const toFin = t === "FF" || t === "SF";
      const xb = toFin ? q.f : q.s;
      const drv = APP.s.rels[r.id] && APP.s.rels[r.id].driving && APP.s.acts[r.succ].crit;
      const dr = toFin ? -1 : 1;
      let d;
      if (!toFin && xb - 8 >= xa + 4) d = `M${xa} ${p.y}H${xb - 8 > xa + 6 ? xa + 6 : xb - 8}V${q.y}H${xb - 1}`;
      else {
        const mid = q.y > p.y ? q.y - RH / 2 : q.y + RH / 2;
        const out = t === "FS" || t === "FF" ? xa + 6 : xa - 6;
        const into = toFin ? xb + 8 : xb - 8;
        d = `M${xa} ${p.y}H${out}V${mid}H${into}V${q.y}H${xb - dr}`;
      }
      const c = drv ? " drv" : "";
      gLinks.append(svg("path", { d, class: "g-link" + c }));
      gLinks.append(svg("path", { d: `M${xb} ${q.y}l${-5 * dr} -3v6z`, class: "g-arrow" + c }));
    }
  }
  const xdd = XS(APP.p.data_date);
  g.append(svg("path", { d: `M${xdd} ${y0}V${Math.max(y1, 1)}`, class: "g-dd" }));
  if (APP.s) { const xf = XS(APP.s.finish); g.append(svg("path", { d: `M${xf} ${y0}V${Math.max(y1, 1)}`, class: "g-fin" })); }
}

// ---- selection, scrolling, editing
function selectAct(id, scroll) {
  APP.sel = id;
  if (scroll && APP.rowIndex.has(id)) {
    const i = APP.rowIndex.get(id), sc = $("tscroll");
    if (i * RH < sc.scrollTop || (i + 1) * RH > sc.scrollTop + sc.clientHeight) sc.scrollTop = Math.max(0, i * RH - sc.clientHeight / 3);
    const r = rec(APP.byId.get(id));
    if (r && scroll === "gantt") { const gs = $("gscroll"); const x = XS(r.es); if (x < gs.scrollLeft || x > gs.scrollLeft + gs.clientWidth - 80) gs.scrollLeft = Math.max(0, x - 120); }
  }
  // update the highlight in place so a double click lands on the same row element
  for (const line of $("trows").querySelectorAll(".tr[data-id]")) {
    const on = line.dataset.id === id;
    line.classList.toggle("sel", on);
    line.setAttribute("aria-selected", on ? "true" : "false");
  }
  if (scroll) drawSheetRows(); else { const [a0, a1] = visRange(); drawGantt(a0, a1); }
  renderDetails();
}
let editing = null;
function startEdit(i, ci, initial) {
  const row = APP.rows[i];
  if (!row || row.kind !== "a") return;
  const c = cols()[ci];
  if (!c || !c.edit) return;
  const line = $("trows").querySelector(`.tr[data-i="${i}"]`);
  if (!line) return;
  const cell = line.querySelector(`.tc[data-c="${ci}"]`);
  const a = row.a;
  const val = c.edit === "start" ? (a.as || (a.cstr === "SNET" ? a.cstr_date : rec(a) && rec(a).es)) : c.edit === "finish" ? (a.af || (rec(a) && rec(a).ef)) : null;
  const inp = el("input", { type: "text", cls: "cell", "aria-label": c.h + " for " + a.code, value: initial !== undefined ? initial : val ? val.replace("T", " ") : c.get(a, rec(a)) });
  clear(cell).append(inp);
  editing = { i, ci, id: a.id, key: c.edit };
  inp.focus();
  if (initial === undefined) inp.select();
  let done = false;
  const finish = (save, move) => {
    if (done) return;
    done = true;
    const text = inp.value;
    editing = null;
    if (save) applyCellEdit(a.id, c.edit, text);
    else drawSheetRows();
    if (move) moveCell(move[0], move[1]);
    $("tscroll").focus({ preventScroll: true });
  };
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true, [1, 0]); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    else if (ev.key === "Tab") { ev.preventDefault(); finish(true, [0, ev.shiftKey ? -1 : 1]); }
    ev.stopPropagation();
  });
  // a blur that comes from the rows being redrawn finishes after the redraw, not inside it
  inp.addEventListener("blur", () => { if (drawing) setTimeout(() => finish(true), 0); else finish(true); });
}
let cursor = { i: 0, ci: 0 };
function moveCell(di, dci) {
  const n = APP.rows.length;
  if (!n) return;
  cursor.i = Math.max(0, Math.min(n - 1, cursor.i + di));
  cursor.ci = Math.max(0, Math.min(cols().length - 1, cursor.ci + dci));
  const row = APP.rows[cursor.i];
  if (row.kind === "a") selectAct(row.id, true);
  else { const sc = $("tscroll"); if (cursor.i * RH < sc.scrollTop || (cursor.i + 1) * RH > sc.scrollTop + sc.clientHeight) sc.scrollTop = cursor.i * RH - sc.clientHeight / 3; }
}

// one cell edit becomes one undoable change
function applyCellEdit(id, key, text) {
  const a = APP.byId.get(id), r = rec(a);
  const t = text.trim();
  try {
    if (key === "code") {
      if (!t) throw new C.SchedError("bad_field", "Activity ID cannot be blank.");
      if (t !== a.code && APP.codeToId.has(t)) throw new C.SchedError("duplicate_id", `Activity ID ${t} is already used.`);
      mutate(`Rename ${a.code} to ${t}`, (q) => { q.activities.find((x) => x.id === id).code = t; });
    } else if (key === "name") mutate(`Edit name of ${a.code}`, (q) => { q.activities.find((x) => x.id === id).name = t; });
    else if (key === "od") {
      const m = parseDur(t, a);
      if (m < 0) throw new C.SchedError("bad_field", "A duration cannot be negative.");
      mutate(`Set duration of ${a.code}`, (q) => {
        const x = q.activities.find((y) => y.id === id);
        if (x.type !== "task") { if (m > 0) { x.type = "task"; } }
        x.od = m;
        if (!x.as) x.rd = m;
      });
    } else if (key === "rd") {
      const m = parseDur(t, a);
      mutate(`Set remaining duration of ${a.code}`, (q) => { const x = q.activities.find((y) => y.id === id); if (!x.af) x.rd = Math.max(0, m); });
    } else if (key === "pct") setPercent(a, parseFloat(t.replace("%", "")));
    else if (key === "start") {
      const d = parseDateInput(t, false);
      if (a.as) mutate(`Set actual start of ${a.code}`, (q) => { q.activities.find((x) => x.id === id).as = d; });
      else if (!d) mutate(`Clear start constraint on ${a.code}`, (q) => { const x = q.activities.find((y) => y.id === id); if (x.cstr === "SNET") { x.cstr = "ASAP"; x.cstr_date = null; } });
      else { mutate(`Start ${a.code} on or after ${fmtDate(d)}`, (q) => { const x = q.activities.find((y) => y.id === id); x.cstr = "SNET"; x.cstr_date = d; }); toast(`Set a start on or after constraint on ${a.code}. Undo to remove it.`); }
    } else if (key === "finish") {
      const d = parseDateInput(t, true);
      if (a.af) mutate(`Set actual finish of ${a.code}`, (q) => { q.activities.find((x) => x.id === id).af = d; });
      else if (d) { mutate(`Finish ${a.code} on or after ${fmtDate(d)}`, (q) => { const x = q.activities.find((y) => y.id === id); x.cstr = "FNET"; x.cstr_date = d; }); toast(`Set a finish on or after constraint on ${a.code}. Undo to remove it.`); }
    } else if (key === "as") {
      const d = parseDateInput(t, false);
      mutate(d ? `Set actual start of ${a.code}` : `Clear actual start of ${a.code}`, (q) => { const x = q.activities.find((y) => y.id === id); x.as = d; if (!d) { x.af = null; x.rd = x.od; } });
    } else if (key === "af") {
      const d = parseDateInput(t, true);
      mutate(d ? `Set actual finish of ${a.code}` : `Clear actual finish of ${a.code}`, (q) => {
        const x = q.activities.find((y) => y.id === id);
        if (d && !x.as) x.as = r ? (r.es < d ? r.es : d) : d;
        x.af = d;
        if (d) x.rd = 0; else if (!x.rd) x.rd = x.od;
      });
    } else if (key === "preds") setPredsFromText(a, t);
  } catch (e) {
    if (e instanceof C.SchedError) { toast(e.message, "bad"); drawSheetRows(); } else throw e;
  }
}
// percent complete the way desktop schedulers take it: actual start from the plan when missing,
// remaining duration from the percent (duration type), or the physical percent as typed
function setPercent(a, v) {
  if (!(v >= 0 && v <= 100)) { toast("Percent complete is 0 to 100.", "bad"); drawSheetRows(); return; }
  const r = rec(a), dd = APP.p.data_date;
  mutate(`Set ${a.code} to ${v}% complete`, (q) => {
    const x = q.activities.find((y) => y.id === a.id);
    if (v > 0 && !x.as) x.as = r && r.es < dd ? r.es : dd;
    if (x.pct_type === "physical") x.phys = v;
    if (v >= 100) { x.af = r && r.ef < dd && r.ef >= x.as ? r.ef : dd < x.as ? x.as : dd; x.rd = 0; }
    else {
      x.af = null;
      if (x.pct_type !== "physical") x.rd = Math.round(x.od * (100 - v) / 100);
      if (v === 0 && x.pct_type !== "physical") { x.as = null; x.rd = x.od; }
    }
  });
}
// "A1000, A1010SS+2d, A1020 FF-4h" replaces the activity's predecessors
function setPredsFromText(a, text) {
  const items = text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const rels = [];
  for (const it of items) {
    const m = /^(.+?)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+(?:\.\d+)?\s*[a-z]*)?$/i.exec(it);
    let code = m ? m[1].trim() : it, type = m && m[2] ? m[2].toUpperCase() : "FS", lag = 0;
    if (!APP.codeToId.has(code) && m && !m[2]) {
      const m2 = /^(.+?)(FS|SS|FF|SF)$/i.exec(code);
      if (m2 && APP.codeToId.has(m2[1])) { code = m2[1]; type = m2[2].toUpperCase(); }
    }
    if (!APP.codeToId.has(code)) throw new C.SchedError("bad_ref", `There is no activity ${code}.`);
    if (m && m[3]) lag = parseDur(m[3].replace(/\s+/g, "").replace(/^\+/, ""), a);
    rels.push({ pred: APP.codeToId.get(code), type, lag });
  }
  mutate(`Set predecessors of ${a.code}`, (q) => {
    const keep = q.rels.filter((r) => r.succ !== a.id);
    for (const r of rels) {
      const old = q.rels.find((x) => x.succ === a.id && x.pred === r.pred && x.type === r.type);
      keep.push(old ? Object.assign(old, { lag: r.lag }) : { id: nextId(q.rels.concat(keep), "r"), pred: r.pred, succ: a.id, type: r.type, lag: r.lag });
    }
    q.rels = keep;
  });
}

// ---- add and delete with automatic links (shown in the message, undoable)
function addActivity() {
  const after = APP.sel ? APP.byId.get(APP.sel) : null;
  const code = nextCode();
  let newId;
  const linked = after && !after.af;
  const ok = mutate(`Add ${code}`, (q) => {
    newId = nextId(q.activities, "a");
    const a = { id: newId, code, name: "New activity", wbs: after ? after.wbs : (q.wbs[0] ? q.wbs[0].id : null), od: hpdOf(after), rd: hpdOf(after), unit: after ? after.unit : q.settings.unit };
    if (after && after.cal) a.cal = after.cal;
    const i = after ? q.activities.findIndex((x) => x.id === after.id) : q.activities.length - 1;
    q.activities.splice(i + 1, 0, a);
    if (after && !after.af) q.rels.push({ id: nextId(q.rels, "r"), pred: after.id, succ: newId, type: "FS", lag: 0 });
  }, linked ? { actor: "auto", why: `${code} went in after ${after.code}, the selected activity, with a finish-to-start link so it is not an open end.` } : { why: `${code} was added at the end of the list.` });
  if (!ok) return;
  toast(linked ? `Added ${code} after ${after.code} with a finish-to-start link.` : `Added ${code}.`, null, true);
  APP.sel = newId;
  selectAct(newId, true);
  const i = APP.rowIndex.get(newId);
  const ci = cols().findIndex((c) => c.key === "name");
  if (i !== undefined && ci >= 0) { cursor = { i, ci }; setTimeout(() => startEdit(i, ci), 30); }
}
function deleteActivity() {
  if (!APP.sel) { toast("Select an activity first."); return; }
  const a = APP.byId.get(APP.sel);
  let bridged = 0;
  const ok = mutate(`Delete ${a.code}`, (q) => {
    const preds = q.rels.filter((r) => r.succ === a.id && (r.type === "FS" || r.type === "SS"));
    const succs = q.rels.filter((r) => r.pred === a.id && (r.type === "FS" || r.type === "SS"));
    q.rels = q.rels.filter((r) => r.pred !== a.id && r.succ !== a.id);
    for (const p of preds) for (const s of succs) {
      if (!q.rels.some((r) => r.pred === p.pred && r.succ === s.succ)) { q.rels.push({ id: nextId(q.rels, "r"), pred: p.pred, succ: s.succ, type: "FS", lag: 0 }); bridged++; }
    }
    q.activities = q.activities.filter((x) => x.id !== a.id);
    q.assigns = q.assigns.filter((x) => x.act !== a.id);
  }, { actor: "auto", why: () => (bridged ? `${a.code} was deleted; its predecessors were linked to its successors (${plural(bridged, "new link")}) so the logic stays closed.` : `${a.code} was deleted.`) });
  if (ok) toast(bridged ? `Deleted ${a.code} and linked its predecessors to its successors (${plural(bridged, "new link")}) so the logic stays closed.` : `Deleted ${a.code}.`, null, true);
}
