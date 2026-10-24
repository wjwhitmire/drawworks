// ---------------------------------------------------------------- network, resources, check views
const NET_MAX = 600;
const NBW = 196, NBH = 112, NGX = 44, NGY = 22;
function netDate(s, a) { if (!s) return ""; return (a && a.unit === "h") || showTime() ? `${s.slice(8, 10)}-${MON[+s.slice(5, 7) - 1]} ${s.slice(11, 16)}` : fmtDate(s, false); }
function renderNetwork() {
  const s = clear($("netsvg"));
  const note = $("netNote");
  if (!APP.s) { note.textContent = "Fix the logic loop to see the network."; return; }
  const acts = APP.p.activities.filter(actPasses);
  if (acts.length > NET_MAX) { note.textContent = `The filter shows ${acts.length} activities. Filter to ${NET_MAX} or fewer (for example Critical activities) to draw the network.`; return; }
  note.textContent = "Each box: ID and duration, name, early start and finish, late start and finish, total and free float. The strip on top is the bar's pen pattern. Driving links on the critical path are heavy. Enter on a box opens it in Activities.";
  const ids = new Set(acts.map((a) => a.id));
  // columns by longest chain of links among the shown activities, critical first in each column
  const predsOf = new Map();
  for (const r of APP.p.rels) if (ids.has(r.succ) && ids.has(r.pred)) { if (!predsOf.has(r.succ)) predsOf.set(r.succ, []); predsOf.get(r.succ).push(r.pred); }
  const col = new Map();
  for (const id of APP.s.order) {
    if (!ids.has(id)) continue;
    let c = 0;
    for (const pr of predsOf.get(id) || []) c = Math.max(c, (col.get(pr) || 0) + 1);
    col.set(id, c);
  }
  const byCol = new Map();
  for (const a of acts) { const c = col.get(a.id) || 0; if (!byCol.has(c)) byCol.set(c, []); byCol.get(c).push(a); }
  const pos = new Map();
  let maxRow = 0;
  const R = (a) => APP.s.acts[a.id];
  for (const [c, list] of byCol) {
    list.sort((x, y) => (R(x).crit !== R(y).crit ? (R(x).crit ? -1 : 1) : R(x).es < R(y).es ? -1 : R(x).es > R(y).es ? 1 : x.code < y.code ? -1 : 1));
    list.forEach((a, i) => { pos.set(a.id, { x: 14 + c * (NBW + NGX), y: 14 + i * (NBH + NGY) }); maxRow = Math.max(maxRow, i); });
  }
  const W = 28 + (Math.max(0, ...byCol.keys()) + 1) * (NBW + NGX) - NGX, H = 28 + (maxRow + 1) * (NBH + NGY) - NGY;
  s.setAttribute("width", W); s.setAttribute("height", H); s.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const defs = svg("defs");
  const pat = svg("pattern", { id: "n-near", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pat.append(svg("rect", { width: 6, height: 6, class: "pf-near" }), svg("path", { d: "M0 0v6", class: "ps-near" }));
  defs.append(pat);
  s.append(defs);
  for (const r of APP.p.rels) {
    const p = pos.get(r.pred), q = pos.get(r.succ);
    if (!p || !q) continue;
    const x1 = p.x + NBW, y1 = p.y + NBH / 2, x2 = q.x, y2 = q.y + NBH / 2, mx = (x1 + x2) / 2;
    const drv = APP.s.rels[r.id] && APP.s.rels[r.id].driving && APP.s.acts[r.succ].crit;
    const c = drv ? " drv" : "";
    s.append(svg("path", { d: x2 > x1 ? `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2 - 6} ${y2}` : `M${x1} ${y1}C${x1 + 40} ${y1} ${x2 - 40} ${y2} ${x2 - 6} ${y2}`, class: "g-link" + c }));
    s.append(svg("path", { d: `M${x2} ${y2}l-7 -4v8z`, class: "g-arrow" + c }));
    if (r.type !== "FS" || r.lag) s.append(svg("text", { x: mx - 12, y: (y1 + y2) / 2 - 5, class: "n-lag" }, r.type + lagText(r.lag, APP.byId.get(r.succ))));
  }
  for (const a of acts) {
    const p = pos.get(a.id), r = R(a), st = penState(r), x = p.x, y = p.y;
    const g = svg("g", { "data-id": a.id, tabindex: 0, role: "button", class: "n-node", "aria-label": `${a.code} ${a.name}, ${PEN_LABEL[st].toLowerCase()}` });
    g.append(svg("rect", { x, y, width: NBW, height: NBH, rx: 4, class: `n-box ${st}` + (APP.sel === a.id ? " sel" : "") }));
    g.append(svg("rect", { x, y, width: NBW, height: 7, rx: 2, class: `n-strip ${st}`, style: st === "near" ? "fill:url(#n-near)" : null }));
    const name = a.name.length > 26 ? a.name.slice(0, 25).trimEnd() + "..." : a.name;
    g.append(svg("text", { x: x + 8, y: y + 24, class: "n-hd" }, a.code));
    g.append(svg("text", { x: x + NBW - 8, y: y + 24, class: "n-hd n-r" }, fmtDur(a.type === "task" ? a.od : 0, a)));
    g.append(svg("text", { x: x + 8, y: y + 42, class: "n-nm" }, name));
    g.append(svg("path", { d: `M${x + 8} ${y + 50}H${x + NBW - 8}`, class: "n-rule" }));
    g.append(svg("text", { x: x + 8, y: y + 66, class: "n-tx" }, netDate(r.status === "active" || r.status === "complete" ? a.as || r.es : r.es, a)));
    g.append(svg("text", { x: x + NBW - 8, y: y + 66, class: "n-tx n-r" }, netDate(a.af || r.ef, a)));
    g.append(svg("text", { x: x + 8, y: y + 84, class: "n-tx" }, r.ls ? netDate(r.ls, a) : "Complete"));
    g.append(svg("text", { x: x + NBW - 8, y: y + 84, class: "n-tx n-r" }, r.lf ? netDate(r.lf, a) : ""));
    g.append(svg("text", { x: x + 8, y: y + 102, class: "n-tx n-f" }, "TF " + (r.tf === null ? "None" : fmtFloat(r.tf, a))));
    g.append(svg("text", { x: x + NBW - 8, y: y + 102, class: "n-tx n-r n-f" }, "FF " + (r.ff === null ? "None" : fmtFloat(r.ff, a))));
    s.append(g);
  }
}

// ---- resources: histogram and the leveling suggestion with a preview
const levCals = new Map();
function calFor(a) {
  const id = a.cal || APP.p.cal;
  const c = APP.p.calendars.find((x) => x.id === id);
  const key = id + ":" + JSON.stringify(c);
  if (!levCals.has(key)) { if (levCals.size > 20) levCals.clear(); levCals.set(key, C.compile_calendar(c)); }
  return levCals.get(key);
}
function niceStep(max) {
  const raw = max / 6, p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
function unitsText(m) { const t = trimNum(C.fmt_fixed(m, 1000, 3)); return t + (t === "1" ? " unit" : " units"); }
function setSeg(on, off) { $(on).setAttribute("aria-pressed", "true"); $(off).setAttribute("aria-pressed", "false"); }
function renderResources() {
  const pick = $("r-rsrc");
  const cur = pick.value;
  clear(pick);
  for (const r of APP.p.resources) pick.append(el("option", { value: r.id, text: r.code + " " + r.name, selected: r.id === cur }));
  if ($("r-which").value === "late") setSeg("r-late", "r-early"); else setSeg("r-early", "r-late");
  if ($("r-bucket").value === "week") setSeg("r-week", "r-day"); else setSeg("r-day", "r-week");
  const s = clear($("histsvg"));
  const foot = clear($("histfoot"));
  const box = clear($("levelbox"));
  s.removeAttribute("width");
  if (!APP.p.resources.length) {
    foot.append(el("span", { text: "No resources yet. Add one here, then assign it on an activity's Resources tab. " }),
      el("button", { type: "button", cls: "btn", id: "r-add-first", on: { click: () => { const id = nextId(APP.p.resources, "R"); if (mutate("Add resource", (q) => { q.resources.push({ id, code: id, name: "New resource", type: "labor", max_units: 1000 }); })) resourcesDialog(); } } }, [icon("add"), "Add a resource"]));
    setKey("Over the limit", "None", "", "No resources in this schedule"); return;
  }
  if (!APP.s) { foot.append("Fix the logic loop to see resource loading."); setKey("Over the limit", "Not known", "", "The schedule cannot be calculated"); return; }
  const r = APP.p.resources.find((x) => x.id === pick.value) || APP.p.resources[0];
  pick.value = r.id;
  const h = C.histogram(APP.p, APP.s, r.id, $("r-which").value, $("r-bucket").value);
  const rows = h.rows;
  const word = h.bucket === "week" ? "week" : "day";
  const over = rows.filter((x) => x.over);
  const q = (v) => trimNum(C.fmt_fixed(v, 1000, 1));
  const dm = (d) => `${d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
  setKey("Over the limit", plural(over.length, word), "", over.length ? (h.bucket === "week" ? "Weeks of " : "Days ") + over.slice(0, 3).map((x) => dm(x.date)).join(", ").replace(/, ([^,]*)$/, " and $1") + (over.length > 3 ? ", and more" : "") : `${r.code} stays within ${unitsText(r.max_units)} at every moment`);
  if (!rows.length) foot.append("This resource has no work in the schedule.");
  else {
    const bw = h.bucket === "week" ? 64 : 30, PADL = 52, PADB = 40, PADT = 18, Hh = 300;
    const W = PADL + rows.length * bw + 16;
    const max = Math.max(1, ...rows.map((x) => Math.max(x.actual + x.remaining, x.limit))) / 1000;
    const step = niceStep(max), top = Math.ceil(max / step) * step;
    const Y = (v) => PADT + (Hh - PADT - PADB) * (1 - v / top);
    s.setAttribute("width", W); s.setAttribute("height", Hh); s.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
    s.setAttribute("aria-label", `${r.name}, ${r.unit} per ${word} against available ${r.unit}`);
    const defs = svg("defs");
    const pat = svg("pattern", { id: "hx-over", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(-45)" });
    pat.append(svg("rect", { width: 6, height: 6, class: "pf-over" }), svg("path", { d: "M0 0v6", class: "ps-over" }));
    defs.append(pat);
    s.append(defs);
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = Y(v);
      s.append(svg("path", { d: `M${PADL} ${y}H${W - 8}`, class: "h-grid" }));
      s.append(svg("text", { x: PADL - 8, y: y + 4, "text-anchor": "end", class: "h-lab" }, trimNum(v.toFixed(1))));
    }
    const every = bw >= 56 ? 1 : 7;
    rows.forEach((x, i) => {
      const xx = PADL + i * bw, a = x.actual / 1000, rm = x.remaining / 1000;
      const pad = bw >= 56 ? 6 : 3;
      if (a) s.append(svg("rect", { x: xx + pad, y: Y(a), width: bw - 2 * pad, height: Y(0) - Y(a), class: "h-act" }));
      if (rm) {
        s.append(svg("rect", { x: xx + pad, y: Y(a + rm), width: bw - 2 * pad, height: Y(a) - Y(a + rm), class: x.over ? "h-over" : "h-rem" }));
        if (bw >= 56) s.append(svg("text", { x: xx + bw / 2, y: Y(a + rm) - 6, "text-anchor": "middle", class: "h-lab" }, q(x.remaining + x.actual)));
      }
      if (i % every === 0) s.append(svg("text", { x: every === 1 ? xx + bw / 2 : xx, y: Hh - 20, "text-anchor": every === 1 ? "middle" : "start", class: "h-cap" }, dm(x.date)));
    });
    let d = "";
    rows.forEach((x, i) => { d += (i ? "L" : "M") + (PADL + i * bw) + " " + Y(x.limit / 1000) + "H" + (PADL + (i + 1) * bw); });
    s.append(svg("path", { d, class: "h-lim" }));
    s.append(svg("text", { x: PADL, y: Hh - 4, class: "h-lab" }, h.bucket === "week" ? "Week starting" : "Day"));
    const sw = (style) => el("i", { style });
    foot.append(
      el("span", null, [sw("background:var(--chart-1)"), `Remaining, ${h.which} dates`]),
      el("span", null, [sw("background:var(--chart-3)"), "Actual"]),
      el("span", null, [sw("background:repeating-linear-gradient(-45deg,var(--bad) 0 2px,var(--tint-bad) 2px 6px);outline:1.5px solid var(--bad)"), `Over ${unitsText(r.max_units)} at the same moment`]),
      el("span", null, [sw("background:none;border-top:2px dashed var(--fg);height:0;border-radius:0"), `Available quantity (${r.unit})`]));
  }
  renderLeveling(box);
}
function renderLeveling(box) {
  let lv;
  try { lv = C.leveling_suggestions(APP.p, APP.s); } catch (e) { if (e instanceof C.SchedError) { box.append(el("p", { text: e.message })); return; } throw e; }
  const n = lv.suggestions.length;
  const checks = [];
  const applyBtn = el("button", { type: "button", cls: "btn primary", id: "lv-apply", disabled: !n }, [icon("level"), `Apply ${n} ticked`]);
  box.append(el("div", { cls: "row" }, [el("h3", { text: "Leveling suggestion" }), el("span", { cls: "tabs-fill" }), n ? applyBtn : null]));
  if (!n) { box.append(el("p", { cls: "muted", text: "No activity needs to move: every resource stays within its maximum units on early dates." })); return; }
  box.append(el("p", null, [`Delaying ${n === 1 ? "this activity" : `these ${n} activities`} keeps every resource within its maximum. Project finish would be `, el("b", { cls: "tnum", text: fmtDate(lv.finish, showTime()) }),
    ` (now ${fmtDate(APP.s.finish, showTime())}). Each ticked row gets a start on or after constraint; one undo removes them all.`]));
  const prev = el("div", { cls: "levprev" });
  box.append(el("h4", { cls: "dsub", text: "Preview: current bars, leveled position as a dashed outline" }), prev);
  const t = el("table", { cls: "tbl t-lev" });
  t.append(el("thead", null, el("tr", null, [el("th", null, el("span", { cls: "sr", text: "Apply" })), el("th", { text: "Activity" }), el("th", { text: "From" }), el("th", { text: "To" }), el("th", { cls: "n", text: "Delay" }), el("th", { text: "Within float" }), el("th", { text: "Why" })])));
  const tb = el("tbody");
  for (const sg of lv.suggestions) {
    const a = APP.byId.get(sg.act);
    const cb = el("input", { type: "checkbox", checked: true, id: "lv-" + sg.act, "aria-label": "Apply to " + sg.code });
    checks.push([cb, sg]);
    const tr = el("tr", null, [el("td", { style: "width:44px;padding:0" }, el("label", { cls: "chk" }, cb)), el("td", null, [el("span", { cls: "c-code mono", text: sg.code }), " " + a.name]),
      el("td", { cls: "tnum", text: fmtDate(sg.from, showTime()) }), el("td", { cls: "tnum", text: fmtDate(sg.to, showTime()) }),
      el("td", { cls: "n", text: fmtFloat(sg.delay, a) }), el("td", null, el("span", { cls: "chip " + (sg.within_float ? "good" : "warn"), text: sg.within_float ? "Yes" : "No, moves finish" })), el("td", { cls: "why", text: sg.why })]);
    cb.addEventListener("change", () => { tr.classList.toggle("off", !cb.checked); sync(); });
    tb.append(tr);
  }
  t.append(tb);
  box.append(el("div", { cls: "tblwrap" }, t));
  const sync = () => {
    const k = checks.filter(([cb]) => cb.checked).length;
    clear(applyBtn).append(icon("level"), `Apply ${k} ticked`);
    applyBtn.disabled = !k;
    drawLevelPreview(prev, checks);
  };
  sync();
  applyBtn.addEventListener("click", () => {
    const pick = checks.filter(([cb]) => cb.checked).map(([, sg]) => sg);
    if (!pick.length) return;
    try {
      const v = C.apply_leveling(APP.p, pick);
      commit(v, `Level ${plural(pick.length, "activity", "activities")}`, { actor: "auto", approved: true,
        why: `Over-allocated ${Array.from(new Set(pick.flatMap((x) => x.rsrc))).map(rsrcCode).join(", ")}; each delayed activity got a start on or after constraint at its leveled date.` });
      toast(`Added start on or after constraints to ${plural(pick.length, "activity", "activities")}.`, null, true);
    } catch (e) { toast(errText(e), "bad"); }
  });
}
// a small Gantt of the suggested activities: the bar where it is now, the leveled bar as a dashed outline
function drawLevelPreview(box, checks) {
  clear(box);
  const items = checks.map(([cb, sg]) => {
    const a = APP.byId.get(sg.act), r = APP.s.acts[sg.act];
    const t0 = C.parse_dt(r.es), t1 = C.parse_dt(r.ef), n0 = C.parse_dt(sg.to);
    const work = calFor(a).work_between(t0, t1);
    return { a, r, on: cb.checked, t0, t1, n0, n1: calFor(a).add_work(n0, work) };
  });
  const lo = Math.min(...items.map((x) => x.t0)), hi = Math.max(...items.map((x) => x.n1));
  const rh = 30, labW = 64, W = Math.max(300, Math.min(1400, (box.clientWidth || 600) - 18, labW + 40 + Math.ceil((hi - lo) / 1440) * 14));
  const sx = (t) => labW + 8 + ((t - lo) / Math.max(1, hi - lo)) * (W - labW - 24);
  const H = items.length * rh + 8;
  const s = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Leveling preview" });
  const defs = svg("defs");
  const pat = svg("pattern", { id: "lv-near", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
  pat.append(svg("rect", { width: 6, height: 6, class: "pf-near" }), svg("path", { d: "M0 0v6", class: "ps-near" }));
  defs.append(pat);
  s.append(defs);
  items.forEach((x, i) => {
    const y = 4 + i * rh, st = penState(x.r);
    s.append(svg("text", { x: 0, y: y + 19, class: "n-hd" }, x.a.code));
    s.append(svg("rect", { x: sx(x.t0), y: y + 8, width: Math.max(2, sx(x.t1) - sx(x.t0)), height: 12, class: { done: "g-bar done", crit: "g-bar crit", near: "g-bar near", norm: "g-bar" }[st], style: st === "near" ? "fill:url(#lv-near)" : null, opacity: x.on ? 0.45 : 1 }));
    if (x.on) {
      s.append(svg("path", { d: `M${sx(x.t1)} ${y + 14}H${sx(x.n0) - 2}`, class: "g-link" }));
      s.append(svg("rect", { x: sx(x.n0), y: y + 7, width: Math.max(2, sx(x.n1) - sx(x.n0)), height: 14, class: "lev-prev" }));
    }
  });
  box.append(el("div", { cls: "tblwrap" }, s));
}

// ---- check: metrics against limits, findings with one-click fixes that say what they change
function fixDesc(f) {
  const x = f.fix;
  if (!x) return "";
  const code = (id) => (APP.byId.get(id) || {}).code;
  if (x.kind === "add_rel") return `Adds ${code(x.pred)} to ${code(x.succ)}, finish to start. An open end lets float run to the project end and hides delay.`;
  if (x.kind === "set_rel") { const r = APP.p.rels.find((y) => y.id === x.rel); return `Turns the lead from ${code(r.pred)} to ${code(r.succ)} into a start-to-start link with a positive lag, so the overlap is stated the way it happens.`; }
  if (x.kind === "set_deadline") return `Moves ${fmtDate(x.date, showTime())} from a finish on or before constraint to the project's must finish by date, so logic drives the dates and the deadline still shows as float.`;
  if (x.kind === "set_cstr") return `Changes the hard constraint to ${CSTR_LABEL[x.cstr].toLowerCase()} ${fmtDate(x.date, showTime())}, so logic can still push the dates later.`;
  return "";
}
function renderCheck() {
  const w = clear($("checkwrap"));
  if (!APP.chk) { w.append(el("div", { cls: "sect" }, el("p", { text: APP.err ? APP.err.message : "Schedule the project first." }))); setKey("Checks passing", "Not known", "", "The schedule cannot be calculated"); return; }
  const res = APP.chk;
  const graded = res.metrics.filter((m) => m.pass !== null);
  const pass = graded.filter((m) => m.pass).length;
  const fixable = res.findings.filter((f) => f.fix);
  setKey("Checks passing", `${pass} of ${graded.length}`, "", `${plural(res.findings.length, "finding")}, ${fixable.length} with a one-click fix`);
  w.append(el("div", { cls: "vhead" }, el("span", { cls: "muted", text: "Runs after every recalculation. The fourteen metrics and their limits are the DCMA 14-point schedule assessment; the 44 day float and duration limits are under Project, Schedule options." })));
  const ms = el("div", { cls: "sect", style: "border-top:0" }, el("h3", { text: "Schedule quality metrics" }));
  const mt = el("table", { cls: "tbl t-met" });
  mt.append(el("thead", null, el("tr", null, ["Check", "Count", "Of", "Result against limit", "Limit", "Result"].map((x, i) => el("th", { scope: "col", cls: i === 1 || i === 2 || i === 4 ? "n" : null, text: x })))));
  const mb = el("tbody");
  const pc = (v) => C.fmt_fixed(v, 10, 1) + "%";
  const hpd = (APP.p.calendars.find((c) => c.id === APP.p.cal) || { hpd: 480 }).hpd;
  const qty = (m, v) => (m.unit === "min" ? trimNum(C.fmt_fixed(v, hpd, 1)) + "d" : String(v));
  const idx = (v) => C.fmt_fixed(v, 1000, 2);
  for (const m of res.metrics) {
    let value, limit;
    if (m.kind === "test") {
      value = m.pass === null ? el("span", { cls: "muted", text: "No open activities" })
        : el("span", { text: m.pass ? "Unbroken back to the data date" : `${plural(m.count, "path start")} held later than the data date` });
      limit = "Unbroken";
    } else if (m.permille === null) {
      value = el("span", { cls: "muted", text: m.dcma === 13 ? "Needs a baseline or a must finish by date" : "Needs a baseline with finishes before the data date" });
      limit = m.kind === "index" ? "0.95 or more" : trimNum(pc(m.limit).slice(0, -1)) + "%";
    } else if (m.kind === "index") {
      const v = m.permille / 1000, scale = Math.max(1.2, v * 1.1);
      limit = "0.95 or more";
      value = el("span", { cls: "meter" }, [el("span", { cls: "tr2", "aria-hidden": "true" }, [el("span", { cls: "fl" + (m.pass ? "" : " over"), style: `width:${(Math.max(0, v) / scale * 100).toFixed(1)}%` }), el("span", { cls: "lim", style: `left:${(0.95 / scale * 100).toFixed(1)}%` })]),
        el("span", { cls: "tnum" }, [idx(m.permille), el("span", { cls: "ph-only", text: `, limit ${limit}` })])]);
    } else {
      const share = m.permille / 10, lim = m.limit === null ? null : m.limit / 10, scale = Math.max(20, share * 1.1);
      limit = lim === null ? "Reported" : trimNum(pc(m.limit).slice(0, -1)) + "%";
      value = el("span", { cls: "meter" }, [el("span", { cls: "tr2", "aria-hidden": "true" }, [el("span", { cls: "fl" + (m.pass === false ? " over" : ""), style: `width:${(share / scale * 100).toFixed(1)}%` }), lim === null ? null : el("span", { cls: "lim", style: `left:${(lim / scale * 100).toFixed(1)}%` })]),
        el("span", { cls: "tnum" }, [pc(m.permille), el("span", { cls: "ph-only", text: ` of ${m.of}, ${lim === null ? "no limit" : "limit " + limit}` })])]);
    }
    const chip = m.pass === true ? ["good", "tick", "Pass"] : m.pass === false ? ["bad", "alert", "Review"] : m.limit === null && m.kind === "share" ? ["info", "info", "Reported"] : ["info", "info", "Not applicable"];
    mb.append(el("tr", null, [el("td", null, [m.dcma ? el("span", { cls: "mono muted small", text: `DCMA ${String(m.dcma).padStart(2, "0")} ` }) : null, m.name]),
      el("td", { cls: "n", text: m.of ? qty(m, m.count) : "" }), el("td", { cls: "n", text: m.of ? qty(m, m.of) : "" }), el("td", null, value),
      el("td", { cls: "n", text: limit }), el("td", null, el("span", { cls: "chip " + chip[0] }, [icon(chip[1]), chip[2]]))]));
  }
  mt.append(mb);
  ms.append(el("div", { cls: "tblwrap" }, mt));
  w.append(ms);
  const fs = el("div", { cls: "sect" });
  const head = el("div", { cls: "row" }, [el("h3", { text: `Findings (${res.findings.length})` }), el("span", { cls: "tabs-fill" })]);
  if (fixable.length) head.append(el("button", { type: "button", cls: "btn primary", on: { click: () => applyFixes(fixable) } }, [icon("fix"), fixable.length === 1 ? "Apply the suggested fix" : `Apply all ${fixable.length} suggested fixes`]));
  fs.append(head);
  w.append(fs);
  if (!res.findings.length) { fs.append(el("p", { text: "No findings. The logic is closed and nothing is held by hard constraints." })); return; }
  const t = el("table", { cls: "tbl t-find" });
  t.append(el("thead", null, el("tr", null, [el("th", { text: "Severity" }), el("th", { text: "Finding" }), el("th", { text: "Suggested fix" }), el("th", null, el("span", { cls: "sr", text: "Go to" }))])));
  const tb = el("tbody");
  const sevChip = { error: ["bad", "Error", "alert"], warn: ["warn", "Warning", "alert"], info: ["info", "Note", "info"] };
  for (const f of res.findings.slice(0, 2000)) {
    const target = f.act || (f.rel ? APP.p.rels.find((r) => r.id === f.rel).succ : null);
    const sc = sevChip[f.sev];
    tb.append(el("tr", null, [el("td", null, el("span", { cls: "sev " + sc[0] }, [icon(sc[2]), sc[1]])), el("td", { style: "min-width:260px;white-space:normal", text: f.msg }),
      el("td", null, el("div", { cls: "fixcell" }, f.fix ? [el("button", { type: "button", cls: "btn", on: { click: () => applyFixes([f]) } }, [icon("fix"), f.fix_label]), el("small", { text: fixDesc(f) })] : el("span", { cls: "muted", text: "Review by hand" }))),
      el("td", null, target ? el("button", { type: "button", cls: "btn link", text: "Go to", on: { click: () => { showView("acts"); selectAct(target, "gantt"); } } }) : null)]));
  }
  t.append(tb);
  fs.append(el("div", { cls: "tblwrap" }, t));
  if (res.findings.length > 2000) fs.append(el("p", { cls: "muted", text: `${res.findings.length - 2000} more findings are not listed.` }));
}
function applyFixes(list) {
  let p = APP.p, n = 0;
  const done = [];
  for (const f of list) {
    try { const q = C.apply_fix(p, f.fix); C.topo_order(q.activities, q.rels); p = q; n++; done.push(f); } catch (e) { if (!(e instanceof C.SchedError)) throw e; }
  }
  if (!n) { toast("None of those fixes could be applied.", "bad"); return; }
  const what = n === 1 ? "Applied fix: " + lc1(done[0].fix_label) : `Applied ${n} suggested fixes`;
  commit(p, what, { actor: "you", why: n === 1 ? done[0].msg + " " + fixDesc(done[0]) : done.slice(0, 3).map((f) => f.msg).join(" ") + (n > 3 ? ` And ${plural(n - 3, "more")}.` : "") });
  toast(n === 1 ? `Applied the fix: ${lc1(done[0].fix_label)}.` : `Applied ${n} fixes.`, null, true);
}
