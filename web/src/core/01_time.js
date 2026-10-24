// ---------------------------------------------------------------- errors, dates, work calendars
// Mirrors src/fieldsched/errors.py and timecal.py exactly: integer minutes since 1970-01-01 00:00 on
// a wall clock, integer working minutes for durations, calendars with a Sunday-first work week.
class SchedError extends Error {
  constructor(code, message) { super(message); this.code = code; this.message = message; }
}
const DAY = 1440;
const MAX_SCAN_DAYS = 366 * 60;
const fdiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => ((a % b) + b) % b;
const pad = (n, w) => String(n).padStart(w, "0");

function days_from_civil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = fdiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400;
  const doy = fdiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}
function civil_from_days(z) {
  z += 719468;
  const era = fdiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097;
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100));
  const mp = fdiv(5 * doy + 2, 153);
  const d = doy - fdiv(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}
const weekday = (day) => mod(day + 4, 7);
const DT_RE = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*$/;
function valid_ymd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200)) return false;
  const c = civil_from_days(days_from_civil(y, m, d));
  return c[0] === y && c[1] === m && c[2] === d;
}
// parsed and formatted dates repeat constantly in a schedule, so both directions are cached
const _PD = new Map(), _FD = new Map();
function parse_dt(s, field) {
  if (typeof s === "string") { const hit = _PD.get(s); if (hit !== undefined) return hit; }
  const v = _parse_dt(s, field);
  if (_PD.size > 200000) _PD.clear();
  _PD.set(s, v);
  return v;
}
function _parse_dt(s, field) {
  field = field || "date";
  if (typeof s !== "string") throw new SchedError("bad_date", `${field}: expected a date, got ${s === null ? "NoneType" : typeof s === "number" ? (Number.isInteger(s) ? "int" : "float") : typeof s === "boolean" ? "bool" : Array.isArray(s) ? "list" : "dict"}.`);
  const m = DT_RE.exec(s);
  if (!m) throw new SchedError("bad_date", `${field}: "${s.slice(0, 30)}" is not a date (use YYYY-MM-DD HH:MM).`);
  const y = +m[1], mo = +m[2], d = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0);
  if (!valid_ymd(y, mo, d) || hh > 24 || mi > 59 || (hh === 24 && mi !== 0)) throw new SchedError("bad_date", `${field}: "${s.slice(0, 30)}" is not a real date.`);
  return days_from_civil(y, mo, d) * DAY + hh * 60 + mi;
}
function fmt_dt(t) {
  if (t === null || t === undefined) return null;
  const hit = _FD.get(t);
  if (hit !== undefined) return hit;
  const v = _fmt_dt(t);
  if (_FD.size > 200000) _FD.clear();
  _FD.set(t, v);
  return v;
}
function _fmt_dt(t) {
  const day = fdiv(t, DAY), md = t - day * DAY;
  const [y, m, d] = civil_from_days(day);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(fdiv(md, 60), 2)}:${pad(md % 60, 2)}`;
}
function fmt_day(day) { const [y, m, d] = civil_from_days(day); return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`; }
function parse_day(s, field) {
  const t = parse_dt(s, field || "date");
  if (mod(t, DAY)) throw new SchedError("bad_date", `${field || "date"}: a date without a time is expected.`);
  return fdiv(t, DAY);
}
const fmt_hm = (v) => `${pad(fdiv(v, 60), 2)}:${pad(v % 60, 2)}`;
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
function norm_intervals(ivs, field) {
  field = field || "intervals";
  if (!Array.isArray(ivs)) throw new SchedError("bad_calendar", `${field}: expected a list of [start, finish] pairs.`);
  if (ivs.length > 48) throw new SchedError("bad_calendar", `${field}: more than 48 work periods in a day.`);
  const out = [];
  for (const iv of ivs) {
    if (!Array.isArray(iv) || iv.length !== 2 || !iv.every(isInt) || !(0 <= iv[0] && iv[0] < iv[1] && iv[1] <= DAY))
      throw new SchedError("bad_calendar", `${field}: each work period is [start, finish] in minutes, 0 to 1440, start before finish.`);
    out.push([iv[0], iv[1]]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, f] of out) {
    if (merged.length && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], f);
    else merged.push([s, f]);
  }
  return merged;
}

class Calendar {
  constructor(id, name, week, exc, hpd) {
    this.id = id; this.name = name; this.week = week; this.exc = exc; this.hpd = hpd;
    let tot = 0;
    for (const d of week) for (const [s, f] of d) tot += f - s;
    if (tot === 0) throw new SchedError("no_work", `Calendar "${name}" has no working time in its work week.`);
    const dw = week.map((d) => d.reduce((t, [s, f]) => t + f - s, 0));
    this._wk = tot;
    this._pre = [0];
    for (let i = 0; i < 7; i++) this._pre.push(this._pre[i] + dw[(4 + i) % 7]);
    this._exd = Array.from(exc.keys()).sort((a, b) => a - b);
    this._exp = [0];
    for (const d of this._exd) this._exp.push(this._exp[this._exp.length - 1] + exc.get(d).reduce((t, [s, f]) => t + f - s, 0) - dw[mod(d + 4, 7)]);
  }
  cum(t) {
    const d = fdiv(t, DAY), m = t - d * DAY;
    const q = fdiv(d, 7), r = d - q * 7;
    let lo = 0, hi = this._exd.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this._exd[mid] < d) lo = mid + 1; else hi = mid; }
    let w = q * this._wk + this._pre[r] + this._exp[lo];
    if (m) for (const [s, f] of this.ivs(d)) if (s < m) w += Math.min(f, m) - s;
    return w;
  }
  ivs(day) { const e = this.exc.get(day); return e !== undefined ? e : this.week[mod(day + 4, 7)]; }
  day_work(day) { let t = 0; for (const [s, f] of this.ivs(day)) t += f - s; return t; }
  snap_fwd(t) {
    let d = fdiv(t, DAY), md = t - d * DAY;
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      for (const [s, f] of this.ivs(d)) if (f > md) return d * DAY + Math.max(s, md);
      d++; md = 0;
    }
    throw new SchedError("no_work", `Calendar "${this.name}" has no working time after ${fmt_dt(t)}.`);
  }
  snap_back(t) {
    let d = fdiv(t, DAY), md = t - d * DAY;
    if (md === 0) { d--; md = DAY; }
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      const v = this.ivs(d);
      for (let k = v.length - 1; k >= 0; k--) if (v[k][0] < md) return d * DAY + Math.min(v[k][1], md);
      d--; md = DAY;
    }
    throw new SchedError("no_work", `Calendar "${this.name}" has no working time before ${fmt_dt(t)}.`);
  }
  add_work(t, m) {
    if (m <= 0) return m < 0 ? this.sub_work(t, -m) : t;
    let d = fdiv(t, DAY), md = t - d * DAY;
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      for (const [s, f] of this.ivs(d)) {
        if (f <= md) continue;
        const start = Math.max(s, md), avail = f - start;
        if (m <= avail) return d * DAY + start + m;
        m -= avail;
      }
      d++; md = 0;
    }
    throw new SchedError("no_work", `Calendar "${this.name}": a duration runs past 60 years.`);
  }
  sub_work(t, m) {
    if (m <= 0) return m < 0 ? this.add_work(t, -m) : t;
    let d = fdiv(t, DAY), md = t - d * DAY;
    if (md === 0) { d--; md = DAY; }
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      const v = this.ivs(d);
      for (let k = v.length - 1; k >= 0; k--) {
        const [s, f] = v[k];
        if (s >= md) continue;
        const end = Math.min(f, md), avail = end - s;
        if (m <= avail) return d * DAY + end - m;
        m -= avail;
      }
      d--; md = DAY;
    }
    throw new SchedError("no_work", `Calendar "${this.name}": a duration runs past 60 years.`);
  }
  work_between(a, b) {
    if (Math.abs(b - a) > MAX_SCAN_DAYS * DAY) throw new SchedError("no_work", "A span of more than 60 years cannot be measured.");
    return this.cum(b) - this.cum(a);
  }
}
const full_day_calendar = () => new Calendar("__24h", "24 hour", [0, 1, 2, 3, 4, 5, 6].map(() => [[0, DAY]]), new Map(), DAY);
function compile_calendar(c) {
  const week = [0, 1, 2, 3, 4, 5, 6].map((i) => norm_intervals(c.week[i], `calendar "${c.name}" day ${i}`));
  const exc = new Map();
  for (const k of Object.keys(c.exceptions || {})) exc.set(parse_day(k, `calendar "${c.name}" exception`), norm_intervals(c.exceptions[k], `calendar "${c.name}" exception ${k}`));
  return new Calendar(c.id, c.name, week, exc, c.hpd);
}
const standard_week = (start = 480, finish = 960, days = [1, 2, 3, 4, 5]) => [0, 1, 2, 3, 4, 5, 6].map((i) => (days.includes(i) ? [[start, finish]] : []));
function round_div(n, d) {
  if (d < 0) { n = -n; d = -d; }
  const q = fdiv(2 * Math.abs(n) + d, 2 * d);
  return n >= 0 ? q : -q;
}
function fmt_fixed(n, d, places = 2) {
  const scale = 10 ** places;
  let v = round_div(n * scale, d);
  const sign = v < 0 ? "-" : "";
  v = Math.abs(v);
  if (places === 0) return `${sign}${v}`;
  return `${sign}${fdiv(v, scale)}.${pad(v % scale, places)}`;
}
// Python-style helpers used across the core
const rstripChars = (s, chars) => { let i = s.length; while (i > 0 && chars.includes(s[i - 1])) i--; return s.slice(0, i); };
const pyStrip = (s) => (s || "").replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, "");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function cmpTuple(a, b) { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; }
