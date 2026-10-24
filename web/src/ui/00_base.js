// ---------------------------------------------------------------- base: DOM helpers, formats, dialogs
// User text reaches the page only through textContent and attribute values, never innerHTML. The
// only markup parsed here is the fixed icon set below.
const C = CORE;
const ICONS = /*ICONS*/;
const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "cls") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "on") { for (const ev of Object.keys(v)) e.addEventListener(ev, v[ev]); }
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else if (k === "selected") e.selected = !!v;
    else if (k === "disabled") e.disabled = !!v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  if (kids !== undefined && kids !== null) add(e, kids);
  return e;
}
function add(parent, kids) {
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) add(parent, k);
    else parent.append(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
  }
  return parent;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
function svg(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, String(attrs[k]));
  if (text !== undefined) e.textContent = text;
  return e;
}
const ICON_CACHE = new Map();
function icon(name) {
  let t = ICON_CACHE.get(name);
  if (!t) {
    t = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + (ICONS[name] || "") + "</svg>", "image/svg+xml").documentElement;
    ICON_CACHE.set(name, t);
  }
  const s = svg("svg", { class: "i", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  for (const n of t.childNodes) s.append(document.importNode(n, true));
  return s;
}

// ---- toast: one line, with Undo for six seconds when the change can be undone
let toastTimer = 0;
function toast(msg, kind, undoable) {
  const t = $("toast");
  $("toastMsg").textContent = msg;
  t.hidden = false;
  t.classList.toggle("bad", kind === "bad");
  $("toastUndo").hidden = !undoable;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === "bad" || undoable ? 6000 : 3200);
}
// ---- dialogs: one <dialog>, body and actions rebuilt each time
let dlgClose = null;
function openDialog({ title, body, actions, wide, side, onClose, left }) {
  const d = $("dlg");
  d.classList.toggle("side", !!side);
  $("dlgTitle").textContent = title;
  clear($("dlgBody"));
  add($("dlgBody"), body);
  const act = clear($("dlgAct"));
  act.hidden = !!side && !actions;
  if (left) act.append(el("span", { cls: "left", id: "dlgLeft" }, left));
  for (const a of actions || (side ? [] : [{ label: "Close", primary: true }])) {
    const b = el("button", { type: a.submit ? "submit" : "button", cls: "btn" + (a.primary ? " primary" : ""), id: a.id || null, disabled: a.disabled }, [a.icon ? icon(a.icon) : null, a.label]);
    b.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (a.onClick) { const keep = await a.onClick(); if (keep === true) return; }
      closeDialog();
    });
    act.append(b);
  }
  d.style.width = wide ? "min(1100px, calc(100vw - 24px))" : "";
  dlgClose = onClose || null;
  if (!d.open) d.showModal();
  const first = d.querySelector(".dlgbody input, .dlgbody select, .dlgbody textarea, .dlgbody button, .dlgact button");
  if (first) first.focus();
}
function closeDialog() {
  const d = $("dlg");
  if (d.open) d.close();
}
function dialogClosed() { if (dlgClose) { const f = dlgClose; dlgClose = null; f(); } }

// ---- formats
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(s, withTime = true) {
  if (!s) return "";
  const y = s.slice(0, 4), m = +s.slice(5, 7), d = s.slice(8, 10);
  return `${d}-${MON[m - 1]}-${y.slice(2)}` + (withTime ? " " + s.slice(11, 16) : "");
}
function hpdOf(a) { const c = APP.p.calendars.find((x) => x.id === (a && a.cal ? a.cal : APP.p.cal)); return c ? c.hpd : 480; }
function trimNum(s) { return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
function fmtDur(min, a, unit) {
  if (min === null || min === undefined) return "";
  const u = unit || (a ? a.unit : APP.p.settings.unit);
  if (u === "h") return trimNum(C.fmt_fixed(min, 60, 2)) + "h";
  return trimNum(C.fmt_fixed(min, hpdOf(a), 2)) + "d";
}
function fmtFloat(min, a) {
  if (min === null || min === undefined) return "";
  return trimNum(C.fmt_fixed(min, a && a.unit === "h" ? 60 : hpdOf(a), 1)) + (a && a.unit === "h" ? "h" : "d");
}
// "5", "5d", "1.5d", "12h", "30m", "2w" -> working minutes on the activity's calendar
function parseDur(text, a) {
  const t = String(text || "").trim().toLowerCase();
  const m = /^(-?\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|w|wk|wks|week|weeks)?$/.exec(t);
  if (!m) throw new C.SchedError("bad_field", `"${String(text).slice(0, 20)}" is not a duration. Use 5d, 12h or 30m.`);
  const v = parseFloat(m[1]);
  let u = m[2] || (a ? a.unit : APP.p.settings.unit);
  u = u[0];
  const hpd = hpdOf(a);
  const mins = u === "h" ? v * 60 : u === "m" ? v : u === "w" ? v * hpd * 5 : v * hpd;
  return Math.round(mins);
}
// dates typed by hand: 2026-11-02, 2026-11-02 08:00, 11/02/2026, 02-Nov-26 08:00
function parseDateInput(text, endOfDay) {
  const t = String(text || "").trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  let y, mo, d, hh = null, mi = null;
  if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; if (m[4] !== undefined) { hh = +m[4]; mi = +m[5]; } }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(t))) { [mo, d, y] = [+m[1], +m[2], +m[3]]; if (y < 100) y += 2000; if (m[4] !== undefined) { hh = +m[4]; mi = +m[5]; } }
  else if ((m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(t))) {
    d = +m[1]; mo = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) + 1; y = +m[3]; if (y < 100) y += 2000;
    if (m[4] !== undefined) { hh = +m[4]; mi = +m[5]; }
  } else throw new C.SchedError("bad_date", `"${t.slice(0, 24)}" is not a date. Use 2026-11-02 08:00 or 02-Nov-26.`);
  if (hh === null) { hh = endOfDay ? 24 : 0; mi = 0; }
  const s = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  return C.fmt_dt(C.parse_dt(s, "date"));
}
const pctText = (tenths) => trimNum(C.fmt_fixed(tenths, 10, 1)) + "%";
function safeName(s) { return String(s || "schedule").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "schedule"; }
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
// Save with the File System Access picker where the browser has one; otherwise a normal download.
async function saveFile(name, data, type, ext, desc) {
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc || "File", accept: { [type]: [ext] } }] });
      const w = await h.createWritable();
      await w.write(data instanceof Blob ? data : new Blob([data], { type }));
      await w.close();
      toast("Saved " + h.name + ".");
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  download(name, data, type);
  toast("Saved " + name + ".");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied."); }
  catch (e) {
    const ta = el("textarea", { cls: "pre", readonly: true, "aria-label": "Text to copy", rows: 12 });
    ta.value = text;
    openDialog({ title: "Copy this text", body: [el("p", { cls: "muted", text: "Copying is blocked here. Select the text and copy it by hand." }), ta] });
    ta.select();
  }
}
function errText(e) { return e && e.message ? e.message : String(e); }
