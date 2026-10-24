// ---------------------------------------------------------------- activity details (bottom pane)
function fld(id, label, control) { return el("div", { cls: "fld" }, [el("label", { for: id, text: label }), control]); }
function ro(label, text) { return el("div", { cls: "fld" }, [el("span", { cls: "lab", text: label }), el("span", { cls: "ro", text: text || "None" })]); }
function selectEl(id, options, value, onChange) {
  const s = el("select", { id });
  for (const [v, t] of options) s.append(el("option", { value: v, text: t, selected: v === value }));
  if (onChange) s.addEventListener("change", () => onChange(s.value));
  return s;
}
function inputEl(id, value, onChange, attrs) {
  const i = el("input", Object.assign({ id, type: "text", value: value === null || value === undefined ? "" : value }, attrs || {}));
  if (onChange) i.addEventListener("change", () => onChange(i.value));
  return i;
}
const dtVal = (s) => (s ? s : "");
function editAct(id, what, fn) { return mutate(what, (q) => { fn(q.activities.find((x) => x.id === id), q); }); }

function stateChips(a, r) {
  const out = [];
  if (!r) return out;
  if (r.status === "complete") out.push(el("span", { cls: "chip info" }, [icon("tick"), "Complete"]));
  else {
    if (r.status === "active") out.push(el("span", { cls: "chip acc" }, [icon("update"), "In progress"]));
    if (r.crit) out.push(el("span", { cls: "chip bad" }, [icon("critical"), r.lp ? "Critical, longest path" : "Critical"]));
    else if (r.near) out.push(el("span", { cls: "chip warn" }, [icon("float"), "Near critical"]));
    else if (r.lp) out.push(el("span", { cls: "chip bad" }, [icon("critical"), "Longest path"]));
  }
  if (a.cstr !== "ASAP") out.push(el("span", { cls: "chip info" }, [icon("constraint"), CSTR_LABEL[a.cstr]]));
  return out;
}
// Under the longest path definition an activity can drive the finish and still show float, for
// example when a successor on another calendar cannot start until after a holiday. Say where it comes from.
function lpFloatNote(a, r) {
  if (!r || !r.lp || !(r.tf > 0) || r.status === "complete") return null;
  const mine = a.cal || APP.p.cal;
  const out = APP.p.rels.filter((x) => x.pred === a.id && APP.s.rels[x.id] && APP.s.rels[x.id].driving);
  let why = "nonworking time or a constraint on the path after it, so it can slip that much before its successors move, yet it still drives the finish through the longest path";
  for (const x of out) {
    const sa = APP.byId.get(x.succ);
    const sc = sa.cal || APP.p.cal;
    if (sc !== mine) { why = `${sa.code} ${sa.name}, its driving successor, working on ${calName(sc)} while this activity works on ${calName(mine)}; the gap between the two calendars shows as float, yet it still drives the finish`; break; }
  }
  return el("dd", { cls: "note" }, `On the longest path with ${fmtFloat(r.tf, a)} of total float. The float comes from ${why}.`);
}
function drivingPred(a) {
  if (!APP.s) return null;
  const d = APP.p.rels.find((x) => x.succ === a.id && APP.s.rels[x.id] && APP.s.rels[x.id].driving);
  if (!d) return null;
  const p = APP.byId.get(d.pred);
  return [el("span", { cls: "mono", text: p.code }), " " + p.name + ", " + d.type + (d.lag ? " " + lagText(d.lag, a) : "")];
}
function renderDetails() {
  const body = clear($("dbody"));
  const head = clear($("dhead"));
  body.classList.remove("split2");
  for (const t of ["general", "status", "rels", "rsrc", "notes"]) $("d-" + t).setAttribute("aria-selected", APP.dtab === t ? "true" : "false");
  $("details").classList.toggle("closed", !APP.details);
  $("d-toggle").setAttribute("aria-label", APP.details ? "Hide details" : "Show details");
  $("d-toggle").title = APP.details ? "Hide details" : "Show details";
  clear($("d-toggle")).append(icon(APP.details ? "chev-d" : "chev-u"));
  if (!APP.details) return;
  const a = APP.sel ? APP.byId.get(APP.sel) : null;
  if (!a) { body.append(el("p", { cls: "muted", text: "Select an activity to see and edit its details. Insert adds an activity, F9 schedules, Ctrl+Z undoes." })); return; }
  const r = rec(a);
  const id = a.id;
  head.append(el("span", { cls: "c-code", text: a.code }), el("strong", { text: a.name }), ...stateChips(a, r));
  if (APP.dtab === "general") {
    body.classList.add("split2");
    const st = showTime();
    const span = (x, y) => (x ? fmtDate(x, st) + " to " + fmtDate(y, st) : "");
    const bl = blRow(a.id, 0) ? span(blRow(a.id, 0), blRow(a.id, 1)) : "";
    const facts = el("dl", { cls: "facts" });
    const fact = (k, v, cls) => facts.append(el("dt", { text: k }), el("dd", { cls }, v || "None"));
    fact("Early start, finish", r ? span(r.status === "active" ? a.as : r.es, r.ef) : "");
    fact("Late start, finish", r && r.ls ? span(r.ls, r.lf) : "");
    if (APP.p.baseline) fact("Baseline start, finish", bl);
    fact("Total float, free float", r && r.tf !== null ? fmtFloat(r.tf, a) + ", " + fmtFloat(r.ff, a) : "", r && r.crit && r.status !== "complete" ? "crit" : r && r.tf < 0 ? "crit" : null);
    fact("Driving predecessor", drivingPred(a));
    const note = lpFloatNote(a, r);
    if (note) facts.append(note);
    body.append(el("div", { cls: "form" }, [
      fld("g-code", "Activity ID", inputEl("g-code", a.code, (v) => applyCellEdit(id, "code", v))),
      el("div", { cls: "fld", style: "grid-column:span 2" }, [el("label", { for: "g-name", text: "Activity name" }), inputEl("g-name", a.name, (v) => applyCellEdit(id, "name", v))]),
      fld("g-type", "Activity type", selectEl("g-type", [["task", "Task"], ["start_ms", "Start milestone"], ["finish_ms", "Finish milestone"]], a.type,
        (v) => editAct(id, `Change type of ${a.code}`, (x) => { x.type = v; if (v !== "task") { x.od = 0; x.rd = 0; } else if (!x.od) { x.od = hpdOf(x); x.rd = x.od; } }))),
      fld("g-wbs", "WBS", selectEl("g-wbs", [["", "(none)"]].concat(C.tree_rows(Object.assign({}, APP.p, { activities: [] })).map(([, w, lvl]) => [w.id, " ".repeat((lvl - 1) * 2) + w.code + " " + w.name])), a.wbs || "",
        (v) => editAct(id, `Move ${a.code} to another WBS`, (x) => { x.wbs = v || null; }))),
      fld("g-cal", "Calendar", selectEl("g-cal", APP.p.calendars.map((c) => [c.id, c.name + (c.id === APP.p.cal ? " (project)" : "")]), a.cal || APP.p.cal,
        (v) => editAct(id, `Change calendar of ${a.code}`, (x) => { x.cal = v === APP.p.cal ? null : v; }))),
      fld("g-od", "Original duration", inputEl("g-od", fmtDur(a.od, a), (v) => applyCellEdit(id, "od", v), { inputmode: "decimal", cls: "tnum" })),
      fld("g-unit", "Duration unit", selectEl("g-unit", [["d", "Days"], ["h", "Hours"]], a.unit, (v) => editAct(id, `Show ${a.code} in ${v === "h" ? "hours" : "days"}`, (x) => { x.unit = v; }))),
      fld("g-cstr", "Primary constraint", selectEl("g-cstr", C.CSTR_TYPES.map((k) => [k, CSTR_LABEL[k]]), a.cstr, (v) => editAct(id, `Set constraint on ${a.code}`, (x) => {
        x.cstr = v;
        if (v === "ASAP" || v === "ALAP") x.cstr_date = null; else if (!x.cstr_date) x.cstr_date = /^F|MFO|MF_MAND/.test(v) ? (r ? r.ef : APP.p.start) : (r ? r.es : APP.p.start);
      }))),
      fld("g-cdate", "Constraint date", el("input", { id: "g-cdate", type: "datetime-local", step: 60, value: dtVal(a.cstr_date), disabled: a.cstr === "ASAP" || a.cstr === "ALAP",
        on: { change: (ev) => editAct(id, `Set constraint date on ${a.code}`, (x) => { x.cstr_date = ev.target.value || null; if (!x.cstr_date) x.cstr = "ASAP"; }) } })),
    ]), facts);
  } else if (APP.dtab === "status") {
    const st = a.af ? "Complete" : a.as ? "In progress" : "Not started";
    body.append(el("div", { cls: "form" }, [
      ro("Status", st),
      fld("s-as", "Actual start", el("input", { id: "s-as", type: "datetime-local", step: 60, value: dtVal(a.as), on: { change: (ev) => applyCellEdit(id, "as", ev.target.value) } })),
      fld("s-af", "Actual finish", el("input", { id: "s-af", type: "datetime-local", step: 60, value: dtVal(a.af), on: { change: (ev) => applyCellEdit(id, "af", ev.target.value) } })),
      fld("s-rd", "Remaining duration", inputEl("s-rd", fmtDur(a.rd, a), (v) => applyCellEdit(id, "rd", v), { disabled: !!a.af })),
      fld("s-pt", "Percent complete type", selectEl("s-pt", [["duration", "Duration"], ["physical", "Physical"], ["units", "Units"]], a.pct_type,
        (v) => editAct(id, `Set percent complete type of ${a.code}`, (x) => { x.pct_type = v; }))),
      fld("s-pct", "Percent complete", inputEl("s-pct", r ? C.fmt_fixed(r.pct, 10, 1) : "0", (v) => setPercent(a, parseFloat(v)))),
      ro("Remaining early start", r && r.status === "active" ? fmtDate(r.res) : ""),
      ro("Data date", fmtDate(APP.p.data_date)),
    ]));
    const row = el("div", { cls: "row wrap", style: "margin-top:8px" });
    if (!a.as) row.append(el("button", { type: "button", cls: "btn", text: "Started on its planned start", on: { click: () => setPercent(a, 0.0001) } }));
    if (!a.af) row.append(el("button", { type: "button", cls: "btn", text: "Finished as planned", on: { click: () => setPercent(a, 100) } }));
    if (a.as) row.append(el("button", { type: "button", cls: "btn", text: "Clear progress", on: { click: () => editAct(id, `Clear progress of ${a.code}`, (x) => { x.as = null; x.af = null; x.rd = x.od; x.phys = 0; }) } }));
    body.append(row);
  } else if (APP.dtab === "rels") {
    body.append(relTable(a, "pred"), relTable(a, "succ"));
  } else if (APP.dtab === "rsrc") {
    body.append(rsrcTable(a));
  } else {
    const ta = el("textarea", { id: "n-notes", rows: 5, "aria-label": "Notes for " + a.code });
    ta.value = a.notes;
    ta.addEventListener("change", () => editAct(id, `Edit notes of ${a.code}`, (x) => { x.notes = ta.value; }));
    body.append(fld("n-notes", "Notes", ta));
  }
}
function relTable(a, side) {
  const mine = APP.p.rels.filter((r) => (side === "pred" ? r.succ : r.pred) === a.id);
  const t = el("table", { cls: "tbl" });
  t.append(el("caption", { cls: "sr", text: side === "pred" ? "Predecessors" : "Successors" }));
  t.append(el("thead", null, el("tr", null, ["Activity ID", "Activity name", "Type", "Lag", "Driving", ""].map((h, i) => el("th", { scope: "col", cls: i === 3 ? "n" : null, text: h })))));
  const tb = el("tbody");
  for (const r of mine) {
    const o = APP.byId.get(side === "pred" ? r.pred : r.succ);
    const rs = APP.s ? APP.s.rels[r.id] : null;
    const typ = selectEl("rt-" + r.id, C.REL_TYPES.map((x) => [x, x]), r.type, (v) => mutate(`Change link ${o.code} ${a.code}`, (q) => { q.rels.find((x) => x.id === r.id).type = v; }));
    typ.setAttribute("aria-label", "Relationship type");
    const lag = inputEl("rl-" + r.id, lagText(r.lag, a) || "0", (v) => {
      try { const m = parseDur(v.replace(/^\+/, ""), a); mutate(`Change lag ${o.code} ${a.code}`, (q) => { q.rels.find((x) => x.id === r.id).lag = m; }); } catch (e) { toast(errText(e), "bad"); }
    }, { size: 6, "aria-label": "Lag" });
    tb.append(el("tr", null, [
      el("td", null, el("button", { type: "button", cls: "btn link", text: o.code, on: { click: () => selectAct(o.id, "gantt") } })),
      el("td", { cls: "nm", text: o.name, title: o.name }), el("td", null, typ), el("td", { cls: "n" }, lag), el("td", null, rs && rs.driving ? el("span", { cls: "chip bad" }, "Driving") : "No"),
      el("td", null, el("button", { type: "button", cls: "btn", text: "Remove", on: { click: () => mutate(`Remove link ${o.code} ${a.code}`, (q) => { q.rels = q.rels.filter((x) => x.id !== r.id); }) } })),
    ]));
  }
  t.append(tb);
  const pick = el("input", { id: "ra-" + side, type: "text", list: "codeList", placeholder: "Activity ID", size: 10, "aria-label": "Activity ID to link" });
  const typ = selectEl("rat-" + side, C.REL_TYPES.map((x) => [x, x]), "FS");
  typ.setAttribute("aria-label", "Relationship type");
  const lag = el("input", { id: "ral-" + side, type: "text", value: "0", size: 6, "aria-label": "Lag" });
  const addBtn = el("button", { type: "button", cls: "btn", text: side === "pred" ? "Assign predecessor" : "Assign successor", on: { click: () => {
    const oid = APP.codeToId.get(pick.value.trim());
    if (!oid) { toast(`There is no activity ${pick.value.trim() || "with that ID"}.`, "bad"); return; }
    let m;
    try { m = parseDur(lag.value.replace(/^\+/, ""), a); } catch (e) { toast(errText(e), "bad"); return; }
    const pr = side === "pred" ? oid : a.id, su = side === "pred" ? a.id : oid;
    mutate(`Link ${APP.byId.get(pr).code} to ${APP.byId.get(su).code}`, (q) => { q.rels.push({ id: nextId(q.rels, "r"), pred: pr, succ: su, type: typ.value, lag: m }); });
  } } });
  const dl = el("datalist", { id: "codeList" });
  for (const x of APP.p.activities.slice(0, 5000)) if (x.id !== a.id) dl.append(el("option", { value: x.code, text: x.name }));
  return el("div", { cls: "stack", style: "margin-bottom:12px" }, [el("h3", { cls: "dsub", text: side === "pred" ? "Predecessors" : "Successors" }), el("div", { cls: "tblwrap" }, t),
    el("div", { cls: "row wrap" }, [pick, typ, lag, addBtn, dl])]);
}
function rsrcTable(a) {
  const mine = APP.p.assigns.filter((x) => x.act === a.id);
  const t = el("table", { cls: "tbl" });
  t.append(el("caption", { cls: "sr", text: "Resource assignments" }));
  t.append(el("thead", null, el("tr", null, ["Resource", "Units per hour", "Budgeted", "Actual", ""].map((h, i) => el("th", { scope: "col", cls: i && i < 4 ? "n" : null, text: h })))));
  const tb = el("tbody");
  const q3 = (v) => trimNum(C.fmt_fixed(v, 1000, 3));
  for (const x of mine) {
    const num = (key, label) => inputEl(`as-${key}-${x.id}`, q3(x[key]), (v) => {
      const n = parseFloat(v);
      if (!(n >= 0)) { toast("Enter a number of zero or more.", "bad"); return; }
      mutate(`Edit ${label} of ${rsrcCode(x.rsrc)} on ${a.code}`, (q) => {
        const y = q.assigns.find((z) => z.id === x.id);
        y[key] = Math.round(n * 1000);
        if (key === "units") y.budget = Math.round(y.units * a.od / 60);
      });
    }, { size: 7, "aria-label": label });
    tb.append(el("tr", null, [el("td", { text: rsrcCode(x.rsrc) + " " + (APP.p.resources.find((r) => r.id === x.rsrc) || {}).name }), el("td", { cls: "n" }, num("units", "units per hour")),
      el("td", { cls: "n" }, num("budget", "budgeted quantity")), el("td", { cls: "n" }, num("actual", "actual quantity")),
      el("td", null, el("button", { type: "button", cls: "btn", text: "Remove", on: { click: () => mutate(`Remove ${rsrcCode(x.rsrc)} from ${a.code}`, (q) => { q.assigns = q.assigns.filter((y) => y.id !== x.id); }) } }))]));
  }
  t.append(tb);
  const free = APP.p.resources.filter((r) => !mine.some((x) => x.rsrc === r.id));
  const pick = selectEl("ar-pick", free.map((r) => [r.id, r.code + " " + r.name]), free[0] ? free[0].id : "");
  pick.setAttribute("aria-label", "Resource to assign");
  const units = el("input", { id: "ar-units", type: "text", value: "1", size: 5, "aria-label": "Units per hour" });
  return el("div", { cls: "stack" }, [el("div", { cls: "tblwrap" }, t), el("div", { cls: "row wrap" }, [
    pick, units,
    el("button", { type: "button", cls: "btn", text: "Assign", disabled: !free.length, on: { click: () => {
      const u = Math.round(parseFloat(units.value) * 1000);
      if (!(u >= 0)) { toast("Units per hour must be a number.", "bad"); return; }
      mutate(`Assign ${rsrcCode(pick.value)} to ${a.code}`, (q) => { q.assigns.push({ id: nextId(q.assigns, "x"), act: a.id, rsrc: pick.value, units: u, budget: Math.round(u * a.od / 60), actual: 0 }); });
    } } }),
    el("button", { type: "button", cls: "btn", text: "Manage resources", on: { click: () => resourcesDialog() } }),
  ])]);
}
