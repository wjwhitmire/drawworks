// ---------------------------------------------------------------- dialogs: files, options, calendars, resources, WBS, baselines, progress
const MAX_FILE = 64 * 1024 * 1024;

// ---- open any supported file (format detected from its content)
async function importFile(file, chosenId) {
  if (file.size > MAX_FILE) { toast("That file is larger than 64 MB, the limit for this tool.", "bad"); return; }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (e) { toast("Could not read that file.", "bad"); return; }
  let out;
  try {
    out = chosenId ? C.open_file(bytes, chosenId) : C.open_file(bytes);
    // a file from P6 marks the project it was exported for; open that one and say so, and ask only
    // when the file does not say which
    if (!chosenId && out.kind === "xer" && out.projects.length > 1 && out.projects.filter((x) => x.exported).length !== 1) {
      const chosen = await pickXerProject(out.projects, out.project);
      if (chosen === null) return;
      out = C.open_file(bytes, chosen);
    }
  } catch (e) {
    if (e instanceof C.SchedError) { toast(e.message, "bad"); return; }
    throw e;
  }
  const p = out.project;
  let sched = null, fid = null, loop = null;
  try { sched = C.schedule(p); fid = Object.keys(out.stored).length ? C.compare_stored(p, sched, out.stored, out.kind) : null; } catch (e) { if (e instanceof C.SchedError) loop = e; else throw e; }
  await openNewProject(p, `Open ${file.name}`, true);
  const c = out.report.counts;
  logNote(`Opened ${file.name}`, `Detected ${({ xer: "a P6 XER file", mspdi: "a Project XML file", native: "a backup from this tool" })[out.kind]} from its content; ${plural(c.activities, "activity", "activities")}, ${plural(c.rels, "relationship")}, ${plural(c.calendars, "calendar")}.` + (fid ? ` ${fid.agree} of ${fid.checked} stored dates agree.` : ""));
  importReport(file.name, out, fid, loop, file.size, file);
}
function pickXerProject(projects, current) {
  return new Promise((resolve) => {
    let chosen = null;
    const sel = selectEl("xp-pick", projects.map((x) => [x.id, `${x.name || "(no name)"} (${x.id})`]), projects.find((x) => current && ("p" + x.id) === current.id) ? projects.find((x) => ("p" + x.id) === current.id).id : projects[0].id);
    openDialog({ title: "Choose a project", body: [el("p", { text: `This XER file holds ${plural(projects.length, "project")}. Choose the one to open.` }), fld("xp-pick", "Project", sel)],
      actions: [{ label: "Cancel" }, { label: "Open", primary: true, onClick: () => { chosen = sel.value; } }], onClose: () => resolve(chosen) });
  });
}
function importReport(name, out, fid, loop, size, file) {
  const r = out.report;
  const c = r.counts;
  const fmtName = { xer: "P6 XER", mspdi: "Project XML (MSPDI)", native: "Backup from this tool" }[out.kind];
  const body = [];
  const pname = out.kind === "xer" && out.projects && out.projects.length ? (out.projects.find((x) => "p" + x.id === out.project.id) || out.projects[0]).name : out.project.name;
  body.push(el("div", { cls: "row" }, [el("span", { cls: "mono", text: name }), size !== undefined ? el("span", { cls: "muted tnum", text: `${(size / 1024).toFixed(1)} KB, read on this device` }) : null,
    el("span", { cls: "chip info", text: `${fmtName}${r.version ? " " + r.version : ""}, ${r.encoding}` }), pname ? el("span", { cls: "chip info", text: "Project " + pname }) : null]));
  if (out.kind === "xer" && out.projects && out.projects.length > 1 && file) {
    const others = out.projects.filter((x) => "p" + x.id !== out.project.id);
    const marked = out.projects.find((x) => x.exported && "p" + x.id === out.project.id);
    const pick = selectEl("xp-other", others.map((x) => [x.id, `${x.name || "(no name)"} (${x.id})`]), others[0] ? others[0].id : "");
    pick.setAttribute("aria-label", "Another project in this file");
    body.push(el("div", { cls: "note" }, [icon("info"), el("div", null, [
      el("b", { text: `This file holds ${out.projects.length} projects.` }),
      el("span", { text: marked ? " Opened the one the file marks as exported. " : " Opened the one you chose. " }),
      el("div", { cls: "row wrap", style: "margin-top:6px" }, [pick, el("button", { type: "button", cls: "btn", text: "Open this one instead", on: { click: () => { closeDialog(); importFile(file, pick.value); } } })])])]));
  }
  if (fid) body.push(keyCard("Stored dates that agree", `${fid.agree} of ${fid.checked}`, "", "Early, late and float values in the file against this calculation"));
  else if (loop) body.push(keyCard("Stored dates that agree", "Not checked", "", "The schedule cannot be calculated until the loop is broken"));
  else body.push(keyCard("Stored dates that agree", "None stored", "", "The file carries no calculated dates to compare, so the dates here are this tool's own"));
  const stat = (v, one, many) => el("div", { cls: "stat" }, [el("span", { cls: "v", text: String(v) }), el("span", { cls: "l", text: v === 1 ? one : many })]);
  body.push(el("div", { cls: "sumgrid" }, [stat(c.activities, "activity", "activities"), stat(c.rels, "relationship", "relationships"), stat(c.wbs, "WBS element", "WBS elements"),
    stat(c.calendars, "calendar", "calendars"), stat(c.resources, "resource", "resources"), stat(c.assigns, "assignment", "assignments")]));
  if (loop) body.push(el("div", { cls: "banner" }, [icon("alert"), el("strong", { text: "Cannot schedule." }), el("span", { text: loop.message + " The schedule opens; remove one of those links to calculate it." })]));
  if (r.tables && Object.keys(r.tables).length) {
    const unk = new Set(r.unknown_tables || []);
    const used = Object.keys(r.tables).filter((t) => !unk.has(t));
    body.push(el("div", null, [el("h4", { cls: "dsub", text: "Tables read" }), el("div", { cls: "row" }, used.map((t) => el("span", { cls: "chip acc mono", text: `${t} ${r.tables[t]}` }))),
      unk.size ? el("p", { cls: "muted", style: "margin-top:8px;font-size:var(--t-sm)", text: "Kept out of the way, not used here: " + Array.from(unk).join(", ") + "." }) : null]));
  } else if (r.unknown_tables && r.unknown_tables.length) body.push(el("p", { cls: "muted", text: "Kept out of the way, not used here: " + r.unknown_tables.join(", ") + "." }));
  if (r.warnings.length) {
    const ul = el("ul", { style: "margin:6px 0 0;padding-left:18px" });
    for (const w of r.warnings) ul.append(el("li", { text: w }));
    body.push(el("div", { cls: "note" }, [icon("alert"), el("div", null, [el("b", { text: "Notes from the import" }), ul])]));
  }
  const diffBox = el("div", { cls: "stack", hidden: true });
  if (fid && fid.diffs.length) {
    const t = el("table", { cls: "tbl" });
    t.append(el("thead", null, el("tr", null, ["Activity", "Field", "In the file", "Calculated here"].map((x) => el("th", { scope: "col", text: x })))));
    const tb = el("tbody");
    for (const d of fid.diffs.slice(0, 100)) {
      const a = out.project.activities.find((x) => x.id === d.act);
      const show = (v) => (typeof v === "number" ? fmtFloat(v, a) : fmtDate(v));
      tb.append(el("tr", null, [el("td", { cls: "c-code", text: d.code }), el("td", { text: { es: "Early start", ef: "Early finish", ls: "Late start", lf: "Late finish", tf: "Total float", ff: "Free float" }[d.field] }),
        el("td", { cls: "tnum", text: show(d.file) }), el("td", { cls: "tnum", text: show(d.ours) })]));
    }
    t.append(tb);
    diffBox.append(el("div", { cls: "tblwrap" }, t), el("p", { cls: "muted", text: "Differences usually come from scheduling options the file does not carry, level of effort activities, or resource leveling done in the other tool." }));
  }
  body.push(diffBox);
  const nd = fid ? fid.diffs.length : 0;
  openDialog({ title: "File opened", body, actions: [
    { label: nd ? `Show ${plural(nd, "difference")}` : "No differences to show", disabled: !nd, onClick: () => { diffBox.hidden = !diffBox.hidden; return true; } },
    { label: "Open schedule", primary: true }] });
}
// the key answer drawn inside a dialog or card
function keyCard(label, value, small, sub) {
  const k = el("div", { cls: "key in-card", role: "status", "aria-label": `${label}: ${value}` });
  const s = svg("svg", { class: "key-ico", viewBox: "0 0 26 26", "aria-hidden": "true" });
  s.append(svg("path", { d: "M13 1.5L24.5 13 13 24.5 1.5 13z" }));
  k.append(s, el("span", { cls: "key-l", text: label }), el("span", { cls: "key-v" }, [value, small ? el("small", { text: small }) : null]), sub ? el("span", { cls: "key-s", text: sub }) : null);
  return k;
}

// ---- projects on this device
async function openNewProject(p, what, quiet) {
  await saveNow();
  APP.key = newKey();
  APP.p = p;
  APP.undo = []; APP.redo = [];
  APP.sel = null;
  APP.collapsed = new Set();
  afterChange(what);
  scrollToStart();
  if (!quiet) logNote("Opened " + p.name, p.label ? "Opened from the list of examples. " + p.label : "A new schedule, started from the New schedule form.");
  await saveNow();
}
async function switchProject(key) {
  await saveNow();
  const p = await dbGet("projects", key);
  if (!p) { toast("That schedule is not on this device any more.", "bad"); return; }
  try { APP.p = C.validate_project(p); } catch (e) { toast("That stored schedule could not be read: " + errText(e), "bad"); return; }
  APP.key = key; APP.undo = []; APP.redo = []; APP.sel = null; APP.collapsed = new Set();
  afterChange("Opened " + APP.p.name);
  scrollToStart();
  logNote("Opened " + APP.p.name, "Reopened from this device's storage, where it was saved after its last change.");
  await kvSet("current", key);
}
function exampleProject(k) { return C.validate_project(JSON.parse(JSON.stringify(EXAMPLES[k]))); }
function projectsDialog() {
  const t = el("table", { cls: "tbl" });
  t.append(el("thead", null, el("tr", null, ["Schedule", "Last saved", "", ""].map((x) => el("th", { scope: "col", text: x })))));
  const tb = el("tbody");
  for (const pr of APP.projects) {
    tb.append(el("tr", null, [el("td", null, [pr.name, pr.label ? el("div", { cls: "small muted", text: pr.label }) : null]), el("td", { cls: "mono small", text: pr.saved || "" }),
      el("td", null, pr.key === APP.key ? el("span", { cls: "chip info", text: "Open" }) : el("button", { type: "button", cls: "btn", text: "Open", on: { click: () => { closeDialog(); switchProject(pr.key); } } })),
      el("td", null, el("button", { type: "button", cls: "btn", text: "Delete", "aria-label": "Delete " + pr.name, on: { click: async () => {
        await dbDel("projects", pr.key);
        APP.projects = APP.projects.filter((x) => x.key !== pr.key);
        await kvSet("projects", APP.projects);
        if (pr.key === APP.key) {
          // detach the deleted schedule first, so the switch does not save it back
          clearTimeout(saveTimer); APP.key = null; APP.dirty = false;
          const next = APP.projects[0];
          if (next) await switchProject(next.key); else await openNewProject(exampleProject("drill"), "Open example");
        }
        closeDialog(); projectsDialog(); toast(`Deleted ${pr.name} from this device.`);
      } } }))]));
  }
  t.append(tb);
  openDialog({ title: "Schedules on this device", wide: true, body: [el("div", { cls: "tblwrap" }, t),
    el("div", { cls: "row wrap" }, [
      el("button", { type: "button", cls: "btn", text: "New blank schedule", on: { click: () => { closeDialog(); newProjectDialog(); } } }),
      el("button", { type: "button", cls: "btn", text: "Example: land well program", on: { click: () => { closeDialog(); openNewProject(exampleProject("drill"), "Open example"); } } }),
      el("button", { type: "button", cls: "btn", text: "Example: commercial building", on: { click: () => { closeDialog(); openNewProject(exampleProject("build"), "Open example"); } } }),
      el("button", { type: "button", cls: "btn", text: "Open a file", on: { click: () => { closeDialog(); $("fileIn").click(); } } }),
    ])] });
}
function newProjectDialog() {
  const name = inputEl("np-name", "New project");
  const start = el("input", { id: "np-start", type: "datetime-local", step: 60, value: C.fmt_dt(Math.floor(Date.now() / 60000 / 1440) * 1440 + 480) });
  const cal = selectEl("np-cal", [["5x8", "Monday to Friday, 08:00 to 16:00"], ["5x10", "Monday to Thursday, 06:00 to 16:00"], ["7x24", "Every day, 24 hours (rig)"], ["7x12", "Every day, 07:00 to 19:00"]], "5x8");
  openDialog({ title: "New schedule", body: [fld("np-name", "Project name", name), fld("np-start", "Project start", start), fld("np-cal", "Project calendar", cal)],
    actions: [{ label: "Cancel" }, { label: "Create", primary: true, onClick: async () => {
      const weeks = { "5x8": [C.standard_week(480, 960), 480], "5x10": [C.standard_week(360, 960, [1, 2, 3, 4]), 600], "7x24": [[0, 1, 2, 3, 4, 5, 6].map(() => [[0, 1440]]), 1440], "7x12": [[0, 1, 2, 3, 4, 5, 6].map(() => [[420, 1140]]), 720] };
      const [week, hpd] = weeks[cal.value];
      try {
        const p = C.validate_project({ name: name.value, start: start.value, data_date: start.value, calendars: [{ id: "c1", name: cal.selectedOptions[0].textContent, week, hpd, exceptions: {} }],
          settings: { unit: hpd === 1440 ? "h" : "d" }, wbs: [{ id: "w1", code: "1", name: "Work" }], activities: [{ id: "a1", code: "A1000", name: "Start", type: "start_ms", wbs: "w1" }] });
        await openNewProject(p, "New schedule");
      } catch (e) { toast(errText(e), "bad"); return true; }
    } }] });
}

// ---- export
function exportMenuItems() {
  const ok = !!APP.s;
  const why = "Fix the logic loop first.";
  return [
    ["P6 XER", () => ok ? exportXer() : toast(why, "bad"), null, false, "export"],
    ["Project XML (MSPDI)", () => ok ? saveFile(safeName(APP.p.name) + ".xml", C.write_mspdi(APP.p, APP.s), "application/xml", ".xml", "Project XML") : toast(why, "bad"), null, false, "export"],
    ["CSV activity table", () => ok ? saveFile(safeName(APP.p.name) + ".csv", C.export_csv(APP.p, APP.s, APP.vari), "text/csv", ".csv", "CSV") : toast(why, "bad"), null, false, "table"],
    ["Copy activity table as CSV", () => ok ? copyText(C.export_csv(APP.p, APP.s, APP.vari)) : toast(why, "bad"), null, false, "table"],
    ["Gantt chart PDF", () => ok ? pdfDialog() : toast(why, "bad"), "Ctrl+P", false, "print"],
    ["JSON backup", () => saveFile(safeName(APP.p.name) + ".json", JSON.stringify(APP.p, null, 1), "application/json", ".json", "Schedule backup"), null, false, "file"],
  ];
}
// XER files are Windows-1252, the code page P6 writes; characters outside it are written as "?" and
// the person is told how many
async function exportXer() {
  const text = C.write_xer(APP.p, APP.s, APP.p.data_date);
  const bytes = C.encode_cp1252(text);
  let lost = 0;
  for (const b of bytes) if (b === 0x3F) lost++;
  for (const ch of text) if (ch === "?") lost--;
  await saveFile(safeName(APP.p.name) + ".xer", bytes, "application/octet-stream", ".xer", "XER file");
  if (lost > 0) toast(`${plural(lost, "character")} outside the Windows-1252 code page ${lost === 1 ? "was" : "were"} written as "?" (XER files use that code page).`, "bad");
}
function pdfDialog() {
  const page = selectEl("pdf-page", [["tabloid", "Tabloid landscape (17 x 11 in)"], ["letter", "Letter landscape"], ["a3", "A3 landscape"], ["a4", "A4 landscape"]], "tabloid");
  const bl = el("input", { type: "checkbox", id: "pdf-bl", checked: true });
  const filt = el("input", { type: "checkbox", id: "pdf-filter", checked: APP.filter !== "all" || !!APP.search });
  const links = el("input", { type: "checkbox", id: "pdf-links", checked: true });
  const opt = (inp, text) => el("label", { for: inp.id, cls: "row", style: "min-height:44px" }, [el("span", { cls: "chk", style: "width:auto" }, inp), text]);
  openDialog({ title: "Gantt chart PDF", body: [fld("pdf-page", "Page size", page), opt(bl, "Show the active baseline"), opt(links, "Draw driving relationship lines"),
    opt(filt, "Only the activities the current filter shows"),
    el("p", { cls: "muted", text: "Vector PDF on white paper: title and finish at the top, the activity table and chart on one row grid, a legend and a title block across the bottom. Every bar state keeps its pen pattern in gray print." })],
  actions: [{ label: "Cancel" }, { label: "Write PDF on this device", icon: "print", primary: true, onClick: () => {
    let p = APP.p, s = APP.s;
    if (filt.checked) {
      const keep = new Set(APP.p.activities.filter(actPasses).map((a) => a.id));
      p = Object.assign({}, APP.p, { activities: APP.p.activities.filter((a) => keep.has(a.id)), label: APP.p.label });
    }
    const lay = (LAYOUTS[APP.layout] || LAYOUTS.classic)[0];
    const flt = filt.checked ? (FILTERS.find((f) => f[0] === APP.filter) || [0, "Filtered"])[1] + (APP.search ? `, matching "${APP.search}"` : "") : "All activities";
    saveFile(safeName(APP.p.name) + ".pdf", C.render_pdf(p, s, page.value, bl.checked, C.PRODUCT_NAME, { links: links.checked, layout: lay, filter: flt }), "application/pdf", ".pdf", "PDF");
  } }] });
}

// ---- schedule options and project information
function settingsDialog() {
  const p = APP.p, S = p.settings;
  const hpd = hpdOf(null);
  const days = (m) => trimNum(C.fmt_fixed(m, hpd, 2));
  const f = {
    name: inputEl("o-name", p.name), start: el("input", { id: "o-start", type: "datetime-local", step: 60, value: p.start }),
    dd: el("input", { id: "o-dd", type: "datetime-local", step: 60, value: p.data_date }), fb: el("input", { id: "o-fb", type: "datetime-local", step: 60, value: p.finish_by || "" }),
    cal: selectEl("o-cal", p.calendars.map((c) => [c.id, c.name]), p.cal),
    oos: selectEl("o-oos", [["retained", "Retained logic"], ["override", "Progress override"]], S.oos),
    crit: selectEl("o-crit", [["tf", "Total float at or below the threshold"], ["longest", "Longest path"]], S.crit),
    ctf: inputEl("o-ctf", days(S.crit_tf)), ntf: inputEl("o-ntf", days(S.near_tf)),
    flt: selectEl("o-flt", [["finish", "Finish float (late finish minus early finish)"], ["start", "Start float (late start minus early start)"], ["min", "Smaller of start and finish float"]], S.float),
    lag: selectEl("o-lag", [["pred", "Predecessor's calendar"], ["succ", "Successor's calendar"], ["24h", "24 hour calendar"], ["project", "Project calendar"]], S.lag_cal),
    unit: selectEl("o-unit", [["d", "Days"], ["h", "Hours"]], S.unit),
    ll: inputEl("o-ll", days(S.long_lag)), hf: inputEl("o-hf", days(S.high_float)), hd: inputEl("o-hd", days(S.high_dur)),
  };
  openDialog({ title: "Project and schedule options", wide: true, body: [
    el("div", { cls: "form" }, [fld("o-name", "Project name", f.name), fld("o-start", "Project planned start", f.start), fld("o-dd", "Data date", f.dd),
      fld("o-fb", "Must finish by (optional)", f.fb), fld("o-cal", "Project calendar", f.cal), fld("o-unit", "Default duration unit", f.unit)]),
    el("h3", { cls: "small", text: "Scheduling" }),
    el("div", { cls: "form" }, [fld("o-oos", "Out-of-sequence progress", f.oos), fld("o-crit", "Critical activities are", f.crit), fld("o-ctf", "Critical float threshold (days)", f.ctf),
      fld("o-ntf", "Near critical up to (days of float)", f.ntf), fld("o-flt", "Total float is", f.flt), fld("o-lag", "Lags are counted on", f.lag)]),
    el("h3", { cls: "small", text: "Schedule check thresholds" }),
    el("div", { cls: "form" }, [fld("o-ll", "Long lag over (days)", f.ll), fld("o-hf", "High float over (days)", f.hf), fld("o-hd", "High duration over (days)", f.hd)]),
  ], actions: [{ label: "Cancel" }, { label: "Apply", primary: true, onClick: () => {
    const toMin = (v, label) => { const n = parseFloat(v); if (!(n >= 0)) throw new C.SchedError("bad_field", label + " must be a number of days."); return Math.round(n * hpd); };
    try {
      const st = { oos: f.oos.value, crit: f.crit.value, float: f.flt.value, lag_cal: f.lag.value, unit: f.unit.value, crit_tf: toMin(f.ctf.value, "Critical float threshold"),
        near_tf: toMin(f.ntf.value, "Near critical"), long_lag: toMin(f.ll.value, "Long lag"), high_float: toMin(f.hf.value, "High float"), high_dur: toMin(f.hd.value, "High duration") };
      return !mutate("Change schedule options", (q) => { q.name = f.name.value; q.start = f.start.value; q.data_date = f.dd.value || f.start.value; q.finish_by = f.fb.value || null; q.cal = f.cal.value; q.settings = st; });
    } catch (e) { toast(errText(e), "bad"); return true; }
  } }] });
}

// ---- calendars
function ivText(ivs) { return ivs.map(([s, f]) => C.fmt_hm(s) + "-" + C.fmt_hm(f)).join(", "); }
function parseIvs(text) {
  const t = text.trim().toLowerCase();
  if (!t || t === "off" || t === "none" || t === "holiday") return [];
  return t.split(/[,;]+/).map((part) => {
    const m = /^\s*(\d{1,2}):?(\d{2})?\s*-\s*(\d{1,2}):?(\d{2})?\s*$/.exec(part);
    if (!m) throw new C.SchedError("bad_calendar", `"${part.trim()}" is not a work period. Use 08:00-12:00, 13:00-17:00.`);
    return [+m[1] * 60 + +(m[2] || 0), +m[3] * 60 + +(m[4] || 0)];
  });
}
function calendarsDialog(selId) {
  const p = APP.p;
  const cur = p.calendars.find((c) => c.id === selId) || p.calendars.find((c) => c.id === p.cal);
  const pick = selectEl("cal-pick", p.calendars.map((c) => [c.id, c.name]), cur.id, (v) => { closeDialog(); calendarsDialog(v); });
  const name = inputEl("cal-name", cur.name);
  const hpd = inputEl("cal-hpd", trimNum(C.fmt_fixed(cur.hpd, 60, 2)));
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const wk = days.map((d, i) => inputEl("cal-d" + i, ivText(cur.week[i]) || "off", null, { "aria-label": d + " work periods" }));
  const grid = el("div", { cls: "weekgrid" });
  days.forEach((d, i) => grid.append(el("label", { for: "cal-d" + i, text: d }), wk[i]));
  const exc = el("textarea", { id: "cal-exc", rows: 6, "aria-label": "Exceptions" });
  exc.value = Object.keys(cur.exceptions).sort().map((k) => k + (cur.exceptions[k].length ? " " + ivText(cur.exceptions[k]) : " off")).join("\n");
  const used = p.activities.filter((a) => a.cal === cur.id).length;
  openDialog({ title: "Calendars", wide: true, body: [
    el("div", { cls: "row wrap" }, [fld("cal-pick", "Calendar", pick),
      el("button", { type: "button", cls: "btn", text: "New calendar", on: { click: () => { const id = nextId(p.calendars, "cal"); if (mutate("Add calendar", (q) => { q.calendars.push({ id, name: "New calendar", hpd: 480, week: C.standard_week(), exceptions: {} }); })) { closeDialog(); calendarsDialog(id); } } } }),
      el("button", { type: "button", cls: "btn", text: "Delete this calendar", disabled: cur.id === p.cal || used > 0, title: used ? `${plural(used, "activity uses", "activities use")} it` : null,
        on: { click: () => { if (mutate("Delete calendar " + cur.name, (q) => { q.calendars = q.calendars.filter((c) => c.id !== cur.id); })) { closeDialog(); calendarsDialog(); } } } })]),
    el("div", { cls: "form" }, [fld("cal-name", "Name", name), fld("cal-hpd", "Hours per day (for showing days)", hpd)]),
    el("p", { cls: "muted small", text: "Work periods per day, for example 08:00-12:00, 13:00-17:00. Type off for a non-working day. 24 hours is 00:00-24:00." }),
    grid,
    fld("cal-exc", "Exceptions, one per line: a date, then off or the work periods (2026-11-26 off, 2026-11-28 08:00-12:00)", exc),
    el("p", { cls: "muted", text: `${plural(used, "activity uses", "activities use")} this calendar${cur.id === p.cal ? ", and it is the project calendar" : ""}.` }),
  ], actions: [{ label: "Cancel" }, { label: "Apply", primary: true, onClick: () => {
    try {
      const week = wk.map((w) => parseIvs(w.value));
      const exceptions = {};
      for (const line of exc.value.split("\n").map((x) => x.trim()).filter(Boolean)) {
        const m = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(line);
        if (!m) throw new C.SchedError("bad_calendar", `"${line.slice(0, 30)}" does not start with a date (YYYY-MM-DD).`);
        exceptions[m[1]] = parseIvs(m[2] || "off");
      }
      const h = Math.round(parseFloat(hpd.value) * 60);
      return !mutate("Edit calendar " + name.value, (q) => { const c = q.calendars.find((x) => x.id === cur.id); c.name = name.value; c.week = week; c.exceptions = exceptions; c.hpd = h; });
    } catch (e) { toast(errText(e), "bad"); return true; }
  } }] });
}

// ---- resources
function resourcesDialog() {
  const p = APP.p;
  const t = el("table", { cls: "tbl" });
  t.append(el("thead", null, el("tr", null, ["Resource ID", "Name", "Type", "Max units per hour", "Unit", ""].map((x) => el("th", { scope: "col", text: x })))));
  const tb = el("tbody");
  const rows = [];
  for (const r of p.resources) {
    const f = { code: inputEl("rs-c-" + r.id, r.code, null, { size: 8, "aria-label": "Resource ID" }), name: inputEl("rs-n-" + r.id, r.name, null, { "aria-label": "Name" }),
      type: selectEl("rs-t-" + r.id, [["labor", "Labor"], ["nonlabor", "Equipment"], ["material", "Material"]], r.type),
      max: inputEl("rs-m-" + r.id, trimNum(C.fmt_fixed(r.max_units, 1000, 3)), null, { size: 6, "aria-label": "Max units" }), unit: inputEl("rs-u-" + r.id, r.unit, null, { size: 5, "aria-label": "Unit" }) };
    f.type.setAttribute("aria-label", "Type");
    rows.push([r, f]);
    const n = p.assigns.filter((x) => x.rsrc === r.id).length;
    tb.append(el("tr", null, [el("td", null, f.code), el("td", null, f.name), el("td", null, f.type), el("td", null, f.max), el("td", null, f.unit),
      el("td", null, el("button", { type: "button", cls: "btn", text: n ? `Remove (${plural(n, "assignment")})` : "Remove", on: { click: () => { if (mutate("Remove resource " + r.code, (q) => { q.resources = q.resources.filter((x) => x.id !== r.id); q.assigns = q.assigns.filter((x) => x.rsrc !== r.id); })) { closeDialog(); resourcesDialog(); } } } }))]));
  }
  t.append(tb);
  openDialog({ title: "Resources", wide: true, body: [el("div", { cls: "tblwrap" }, t),
    el("button", { type: "button", cls: "btn", text: "Add resource", on: { click: () => { const id = nextId(p.resources, "R"); if (mutate("Add resource", (q) => { q.resources.push({ id, code: id, name: "New resource", type: "labor", max_units: 1000 }); })) { closeDialog(); resourcesDialog(); } } } })],
  actions: [{ label: "Cancel" }, { label: "Apply", primary: true, onClick: () => {
    try {
      const vals = rows.map(([r, f]) => { const m = parseFloat(f.max.value); if (!(m >= 0)) throw new C.SchedError("bad_field", "Max units must be a number."); return [r.id, { code: f.code.value, name: f.name.value, type: f.type.value, max_units: Math.round(m * 1000), unit: f.unit.value }]; });
      return !mutate("Edit resources", (q) => { for (const [id, v] of vals) Object.assign(q.resources.find((x) => x.id === id), v); });
    } catch (e) { toast(errText(e), "bad"); return true; }
  } }] });
}

// ---- WBS
function wbsDialog() {
  const p = APP.p;
  const t = el("table", { cls: "tbl" });
  t.append(el("thead", null, el("tr", null, ["Code", "Name", "Parent", "", ""].map((x) => el("th", { scope: "col", text: x })))));
  const tb = el("tbody");
  const rows = [];
  const opts = (self) => [["", "(top level)"]].concat(p.wbs.filter((w) => w.id !== self).map((w) => [w.id, w.code + " " + w.name]));
  for (const [, w, lvl] of C.tree_rows(Object.assign({}, p, { activities: [] }))) {
    const f = { code: inputEl("wb-c-" + w.id, w.code, null, { size: 10, "aria-label": "WBS code" }), name: inputEl("wb-n-" + w.id, w.name, null, { "aria-label": "WBS name" }), parent: selectEl("wb-p-" + w.id, opts(w.id), w.parent || "") };
    f.parent.setAttribute("aria-label", "Parent");
    rows.push([w, f]);
    const n = p.activities.filter((a) => a.wbs === w.id).length;
    tb.append(el("tr", null, [el("td", { style: `padding-left:${6 + (lvl - 1) * 14}px` }, f.code), el("td", null, f.name), el("td", null, f.parent),
      el("td", { cls: "muted", text: plural(n, "activity", "activities") }),
      el("td", null, el("button", { type: "button", cls: "btn", text: "Remove", on: { click: () => { if (mutate("Remove WBS " + w.code, (q) => {
        q.wbs = q.wbs.filter((x) => x.id !== w.id).map((x) => (x.parent === w.id ? Object.assign(x, { parent: w.parent }) : x));
        for (const a of q.activities) if (a.wbs === w.id) a.wbs = w.parent;
      })) { closeDialog(); wbsDialog(); } } } }))]));
  }
  t.append(tb);
  openDialog({ title: "Work breakdown structure", wide: true, body: [el("p", { cls: "muted small", text: "Removing an element moves its activities and children up one level." }), el("div", { cls: "tblwrap" }, t),
    el("button", { type: "button", cls: "btn", text: "Add WBS element", on: { click: () => { const id = nextId(p.wbs, "w"); if (mutate("Add WBS element", (q) => { q.wbs.push({ id, code: String(q.wbs.length + 1), name: "New element", parent: null }); })) { closeDialog(); wbsDialog(); } } } })],
  actions: [{ label: "Cancel" }, { label: "Apply", primary: true, onClick: () => !mutate("Edit WBS", (q) => {
    for (const [w, f] of rows) Object.assign(q.wbs.find((x) => x.id === w.id), { code: f.code.value, name: f.name.value, parent: f.parent.value || null });
  }) }] });
}

// ---- baselines
function baselineDialog() {
  const p = APP.p;
  const t = el("table", { cls: "tbl" });
  t.append(el("thead", null, el("tr", null, ["Baseline", "Taken at data date", "Activities", "", ""].map((x) => el("th", { scope: "col", text: x })))));
  const tb = el("tbody");
  for (const b of p.baselines) {
    tb.append(el("tr", null, [el("td", { text: b.name }), el("td", { cls: "mono", text: fmtDate(b.taken) }), el("td", { cls: "n", text: String(Object.keys(b.acts).length) }),
      el("td", null, b.id === p.baseline ? el("span", { cls: "chip good", text: "Active" }) : el("button", { type: "button", cls: "btn", text: "Make active", on: { click: () => { mutate("Make " + b.name + " the active baseline", (q) => { q.baseline = b.id; }); closeDialog(); baselineDialog(); } } })),
      el("td", null, el("button", { type: "button", cls: "btn", text: "Delete", on: { click: () => { mutate("Delete baseline " + b.name, (q) => { q.baselines = q.baselines.filter((x) => x.id !== b.id); if (q.baseline === b.id) q.baseline = null; }); closeDialog(); baselineDialog(); } } }))]));
  }
  t.append(tb);
  const name = inputEl("bl-name", "Baseline " + (p.baselines.length + 1) + " at " + fmtDate(p.data_date, false));
  openDialog({ title: "Baselines", wide: true, body: [
    p.baselines.length ? el("div", { cls: "tblwrap" }, t) : el("p", { cls: "muted", text: "No baselines yet." }),
    el("div", { cls: "row wrap" }, [fld("bl-name", "New baseline name", name), el("button", { type: "button", cls: "btn primary", text: "Save current dates as a baseline", disabled: !APP.s, on: { click: () => {
      try { const v = C.take_baseline(APP.p, APP.s, nextId(APP.p.baselines, "bl"), name.value || "Baseline", APP.p.data_date); commit(v, "Baseline " + (name.value || "Baseline") + " saved", { why: `Start, finish and duration of ${plural(APP.p.activities.length, "activity", "activities")} stored and made the active baseline.` }); closeDialog(); toast("Baseline saved and made active. Variance columns are in the Baseline variance layout.", null, true); }
      catch (e) { toast(errText(e), "bad"); }
    } } })]),
    el("p", { cls: "muted small", text: "Variance is baseline minus current, in working days: a negative finish variance means the activity is late." }),
  ] });
}

// ---- Update progress
// the proposals' reasons carry plain ISO dates; show them the way the rest of the screen does
const isoDates = (s) => s.replace(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/g, (m, y, mo, dd, hm) => `${dd}-${MON[+mo - 1]}-${y.slice(2)} ${hm}`);
function updateDialog() {
  if (!APP.s) { toast("Fix the logic loop first.", "bad"); return; }
  const dd0 = C.parse_dt(APP.p.data_date);
  const st = showTime();
  const cur = el("input", { id: "up-from", type: "text", value: fmtDate(APP.p.data_date), disabled: true, cls: "tnum", style: "width:180px" });
  // the new data date is normally today; when today is not after the current data date, a week on
  const now = new Date();
  const today = APP.pcalC.snap_fwd(C.days_from_civil(now.getFullYear(), now.getMonth() + 1, now.getDate()) * 1440);
  const useToday = today > dd0;
  const nd = el("input", { id: "up-dd", type: "datetime-local", step: 60, value: C.fmt_dt(useToday ? today : dd0 + 7 * 1440), cls: "tnum" });
  const ndWhy = el("small", { cls: "muted", id: "up-why", text: useToday ? "Today, the start of its first working hour. Change it if you are updating to another date." : "A week after the current data date (today is not later). Change it to the date of your update." });
  const holder = el("div", { cls: "stack" });
  const keyBox = el("div", { style: "margin-left:auto" });
  let props = [];
  const boxes = [];
  const finishText = () => {
    clear(keyBox);
    let fin = null;
    try {
      const accepted = boxes.filter(([cb]) => cb.checked).map(([, pr]) => pr);
      fin = C.schedule(C.apply_update(APP.p, accepted, nd.value)).finish;
    } catch (e) { if (!(e instanceof C.SchedError)) throw e; }
    if (!fin) { keyBox.append(keyCard("Finish after update", "Not known", "", "Pick a valid data date")); return; }
    const now = APP.s.finish;
    let sub = "Unchanged from the current finish";
    if (fin !== now) {
      const cal = APP.pcalC, a = C.parse_dt(now), b = C.parse_dt(fin);
      const w = fmtFloat(b > a ? cal.work_between(a, b) : cal.work_between(b, a), null);
      sub = `${w} ${b > a ? "later" : "earlier"} than the current ${fmtDate(now, st)}`;
    }
    keyBox.append(keyCard("Finish after update", fmtDate(fin, false), st ? fin.slice(11, 16) : "", sub));
  };
  const left = el("span", { id: "up-left" });
  const note = el("div");
  const sync = () => {
    const on = boxes.filter(([cb]) => cb.checked);
    left.textContent = boxes.length ? `${on.length} of ${boxes.length} ticked` : "";
    const ap = $("up-apply");
    if (ap) { clear(ap).append(icon("update"), on.length ? `Apply ${on.length} and move the data date` : "Move the data date only"); }
    clear(note);
    const off = boxes.filter(([cb]) => !cb.checked).map(([, pr]) => APP.byId.get(pr.act));
    if (off.length) note.append(el("div", { cls: "note" }, [icon("info"), el("span", null, [el("b", { text: off.length === 1 ? `${off[0].code} ${off[0].name} is unticked.` : `${plural(off.length, "activity", "activities")} unticked.` }),
      " Unticked activities stay as planned and their remaining work is rescheduled from the new data date; set their actual dates on the Status tab after applying."])]));
    finishText();
  };
  const build = () => {
    clear(holder); boxes.length = 0;
    try { props = C.propose_update(APP.p, APP.s, nd.value); } catch (e) { holder.append(el("p", { cls: "neg", text: errText(e) })); props = []; sync(); return; }
    if (!props.length) { holder.append(el("p", { cls: "muted", text: "Nothing was planned to start or progress before that data date." })); sync(); return; }
    const t = el("table", { cls: "tbl t-prog" });
    t.append(el("thead", null, el("tr", null, [el("th", null, el("span", { cls: "sr", text: "Apply" })), el("th", { text: "ID" }), el("th", { text: "Activity" }), el("th", { text: "Actual start" }), el("th", { text: "Proposal" }), el("th", { text: "Why" })])));
    const tb = el("tbody");
    for (const pr of props) {
      const a = APP.byId.get(pr.act);
      const cb = el("input", { type: "checkbox", checked: true, id: "up-" + pr.act, "aria-label": "Apply to " + pr.code });
      boxes.push([cb, pr]);
      const prop = pr.af ? ["Finished ", el("span", { cls: "tnum", text: fmtDate(pr.af) })] : ["Started ", el("span", { cls: "tnum", text: fmtDate(pr.as) }), `, ${fmtDur(pr.rd, a)} left`];
      const tr = el("tr", null, [el("td", { style: "width:44px;padding:0" }, el("label", { cls: "chk" }, cb)), el("td", { cls: "c-code mono", text: pr.code }), el("td", { text: a.name }),
        el("td", null, el("span", { cls: "tnum", text: fmtDate(pr.as) })), el("td", null, prop), el("td", { cls: "why", text: isoDates(pr.why) })]);
      cb.addEventListener("change", () => { tr.classList.toggle("off", !cb.checked); sync(); });
      tb.append(tr);
    }
    t.append(tb);
    holder.append(el("div", { cls: "tblwrap" }, t));
    sync();
  };
  nd.addEventListener("change", () => { ndWhy.textContent = "Your date."; build(); });
  const again = el("button", { type: "button", cls: "btn", on: { click: build } }, [icon("schedule"), "Propose again"]);
  openDialog({ title: "Update progress", wide: true, left, body: [
    el("p", { cls: "muted", text: "Pick the new data date. Every activity planned to start or finish before it is proposed with the dates the plan implied, each with its reason. Untick what did not happen, then apply. The whole update is one undo step." }),
    el("div", { cls: "row", style: "align-items:flex-end" }, [fld("up-from", "Current data date", cur), el("div", { cls: "stack" }, [fld("up-dd", "New data date", nd), ndWhy]), again, keyBox]),
    holder, note,
  ], actions: [{ label: "Cancel" }, { label: "Apply and move the data date", icon: "update", id: "up-apply", primary: true, onClick: () => {
    try {
      const accepted = boxes.filter(([cb]) => cb.checked).map(([, pr]) => pr);
      const nfin = accepted.filter((x) => x.af).length;
      commit(C.apply_update(APP.p, accepted, nd.value), `Progress update to ${fmtDate(C.fmt_dt(C.parse_dt(nd.value)))}`, { actor: "auto", approved: true,
        why: `${plural(nfin, "activity", "activities")} proposed complete and ${accepted.length - nfin} in progress from their planned dates. You unticked ${boxes.length - accepted.length ? plural(boxes.length - accepted.length, "proposal") : "none"}.` });
      toast(`Data date moved; ${plural(accepted.length, "activity", "activities")} updated.`, null, true);
    } catch (e) { toast(errText(e), "bad"); return true; }
  } }] });
  build();
}

// ---- local data and the network switch list
function deleteAllDialog() {
  openDialog({ title: "Delete all data on this device", body: [el("p", { text: "This removes every schedule and preference this tool stored in this browser. Export anything you want to keep first. It cannot be undone." })],
    actions: [{ label: "Cancel", primary: true }, { label: "Delete everything", onClick: async () => {
      // detach the open schedule first, so no pending or switching save writes it back
      clearTimeout(saveTimer);
      APP.key = null; APP.dirty = false; APP.projects = [];
      await dbClear("projects"); await dbClear("kv");
      await openNewProject(exampleProject("drill"), "Deleted all data");
      toast("All stored schedules were deleted. The example is open again.");
    } }] });
}
function shortcutsDialog() {
  const rows = [["F9", "Schedule (the schedule also recalculates after every change)"], ["Insert", "Add an activity after the selected one, linked finish to start"], ["Delete", "Delete the selected activity, keeping its logic connected"],
    ["F2 or Enter", "Edit the selected cell (or just start typing)"], ["Arrow keys, Tab, Shift+Tab", "Move between cells"], ["Page Up / Page Down", "Move a screen of rows"], ["Esc", "Cancel an edit, close a menu or clear the search box"],
    ["Ctrl+Z", "Undo"], ["Ctrl+Y or Ctrl+Shift+Z", "Redo"], ["Ctrl+= / Ctrl+-", "Zoom the timescale"],
    ["Ctrl+O", "Schedules on this device and opening a file"], ["Ctrl+F", "Find an activity"], ["Ctrl+P", "Gantt chart PDF"]];
  const t = el("table", { cls: "tbl" });
  t.append(el("tbody", null, rows.map(([k, v]) => el("tr", null, [el("td", { cls: "mono", text: k }), el("td", { text: v })]))));
  openDialog({ title: "Keyboard shortcuts", body: [t] });
}
function networkDialog() {
  openDialog({ title: "Network use", body: [
    el("p", { text: "This tool makes no network requests. Files open from your device, schedules are stored in this browser's IndexedDB, and every export is written on your device." }),
    el("p", { cls: "muted small", text: "There are no network features to switch on. Any future one will sit behind a switch here, off by default, and pass through a single checked gate." }),
  ] });
}
