// ---------------------------------------------------------------- text decoding and a strict XML reader
// Mirrors src/fieldsched/textio.py. Bytes are a Uint8Array (or an array of byte values).
const MAX_BYTES = 64 * 1024 * 1024;
const XML_MAX_DEPTH = 64;
const XML_MAX_NODES = 3000000;
const CP1252_HIGH = [0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152,
  0x8D, 0x17D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122,
  0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178];
const CP1252_REV = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

function _chunkedString(codes) {
  let s = "";
  for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode.apply(null, codes.slice(i, i + 8192));
  return s;
}
function decode_cp1252(data) {
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) { const b = data[i]; out[i] = b < 0x80 || b >= 0xA0 ? b : CP1252_HIGH[b - 0x80]; }
  return _chunkedString(out);
}
function encode_cp1252(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) out.push(c);
    else if (CP1252_REV.has(c)) out.push(CP1252_REV.get(c));
    else out.push(0x3F);
  }
  return Uint8Array.from(out);
}
// strict UTF-8, refusing what Python's decoder refuses (overlong forms, surrogates, past U+10FFFF)
function decode_utf8_strict(data, start) {
  const units = [];
  let i = start || 0;
  const n = data.length;
  while (i < n) {
    const b = data[i];
    if (b < 0x80) { units.push(b); i++; continue; }
    let need, cp, lo = 0x80, hi = 0xBF;
    if (b >= 0xC2 && b <= 0xDF) { need = 1; cp = b & 0x1F; }
    else if (b >= 0xE0 && b <= 0xEF) { need = 2; cp = b & 0x0F; if (b === 0xE0) lo = 0xA0; if (b === 0xED) hi = 0x9F; }
    else if (b >= 0xF0 && b <= 0xF4) { need = 3; cp = b & 0x07; if (b === 0xF0) lo = 0x90; if (b === 0xF4) hi = 0x8F; }
    else return null;
    for (let k = 1; k <= need; k++) {
      const c = data[i + k];
      if (c === undefined) return null;
      if (k === 1 ? c < lo || c > hi : c < 0x80 || c > 0xBF) return null;
      cp = (cp << 6) | (c & 0x3F);
    }
    if (cp >= 0x10000) { cp -= 0x10000; units.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); } else units.push(cp);
    i += need + 1;
  }
  return _chunkedString(units);
}
function _utf16(data, start, little) {
  const n = (data.length - start) >> 1;
  const units = [];
  for (let i = 0; i < n; i++) { const a = data[start + 2 * i], b = data[start + 2 * i + 1]; units.push(little ? a | (b << 8) : (a << 8) | b); }
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = units[i];
    if (u >= 0xD800 && u < 0xDC00 && i + 1 < n && units[i + 1] >= 0xDC00 && units[i + 1] < 0xE000) { out.push(u, units[i + 1]); i++; continue; }
    out.push(u >= 0xD800 && u < 0xE000 ? 0xFFFD : u);
  }
  if ((data.length - start) % 2) out.push(0xFFFD);
  return _chunkedString(out);
}
function decode_bytes(data, what) {
  what = what || "file";
  if (data.length > MAX_BYTES) throw new SchedError("too_big", `The ${what} is larger than 64 MB, the limit for this tool.`);
  if (data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
    const t = decode_utf8_strict(data, 3);
    return t !== null ? [t, "utf-8"] : [decode_cp1252(data.slice(3)), "windows-1252"];
  }
  if (data[0] === 0xFF && data[1] === 0xFE) return [_utf16(data, 2, true), "utf-16le"];
  if (data[0] === 0xFE && data[1] === 0xFF) return [_utf16(data, 2, false), "utf-16be"];
  const t = decode_utf8_strict(data, 0);
  return t !== null ? [t, "utf-8"] : [decode_cp1252(data), "windows-1252"];
}

const _XNAME = /[A-Za-z_:][-A-Za-z0-9._:]*/y;
const _XATTR = /\s+([A-Za-z_:][-A-Za-z0-9._:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const _XTAIL = /\s*(\/?)>/y;
const _XREF = /&([^;&\s]{0,12});?/g;
const _XNAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function unescape_xml(s) {
  if (!s.includes("&")) return s;
  return s.replace(_XREF, (full, name) => {
    if (!full.endsWith(";")) throw new SchedError("xml_bad", "The XML file has a bare '&' that is not a character reference.");
    if (has(_XNAMED, name)) return _XNAMED[name];
    if (/^#[0-9]{1,7}$/.test(name) || /^#x[0-9A-Fa-f]{1,6}$/.test(name)) {
      const cp = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp < 0xE000)) throw new SchedError("xml_bad", "The XML file has a character reference outside Unicode.");
      return String.fromCodePoint(cp);
    }
    throw new SchedError("xml_entity", `The XML file uses the entity "&${pySlice(name, 0, 12)};", which is not one of the five XML entities. It is refused.`);
  });
}
const _local = (name) => { const i = name.lastIndexOf(":"); return i >= 0 ? name.slice(i + 1) : name; };
function parse_xml(text) {
  if (text.startsWith("\ufeff")) text = text.slice(1);
  let pos = 0;
  const n = text.length, stack = [];
  let root = null, nodes = 0;
  for (;;) {
    const lt = text.indexOf("<", pos);
    const chunk = lt < 0 ? text.slice(pos) : text.slice(pos, lt);
    if (chunk) {
      if (stack.length) stack[stack.length - 1]._t.push(unescape_xml(chunk));
      else if (pyStrip(chunk)) throw new SchedError("xml_bad", "The XML file has text outside its root element.");
    }
    if (lt < 0) break;
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end < 0) throw new SchedError("xml_bad", "The XML file ends inside a processing instruction.");
      pos = end + 2; continue;
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end < 0) throw new SchedError("xml_bad", "The XML file ends inside a comment.");
      pos = end + 3; continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end < 0 || !stack.length) throw new SchedError("xml_bad", "The XML file has a broken CDATA section.");
      stack[stack.length - 1]._t.push(text.slice(lt + 9, end));
      pos = end + 3; continue;
    }
    if (text.startsWith("<!", lt)) throw new SchedError("xml_doctype", "The XML file declares a DOCTYPE or entities. Schedule files never need one, so it is refused.");
    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt);
      if (end < 0) throw new SchedError("xml_bad", "The XML file ends inside a closing tag.");
      const name = pyStrip(text.slice(lt + 2, end));
      if (!stack.length || stack[stack.length - 1]._raw !== name) throw new SchedError("xml_bad", `The XML file closes "${pySlice(name, 0, 40)}" where it should not.`);
      const el = stack.pop();
      el.text = el._t.join("");
      delete el._t; delete el._raw;
      pos = end + 1; continue;
    }
    _XNAME.lastIndex = lt + 1;
    const m = _XNAME.exec(text);
    if (!m) throw new SchedError("xml_bad", "The XML file has a malformed tag.");
    const raw = m[0];
    let p2 = _XNAME.lastIndex;
    const attrs = {};
    for (;;) {
      _XATTR.lastIndex = p2;
      const am = _XATTR.exec(text);
      if (!am) break;
      const v = am[2] !== undefined ? am[2] : am[3];
      attrs[am[1].startsWith("xmlns") ? am[1] : _local(am[1])] = unescape_xml(v);
      p2 = _XATTR.lastIndex;
    }
    _XTAIL.lastIndex = p2;
    const tm = _XTAIL.exec(text);
    if (!tm) throw new SchedError("xml_bad", `The XML file has a malformed tag "${pySlice(raw, 0, 40)}".`);
    nodes++;
    if (nodes > XML_MAX_NODES) throw new SchedError("too_many", "The XML file has more than 3 million elements.");
    const el = { tag: _local(raw), attrs, kids: [], text: "", _raw: raw, _t: [] };
    if (stack.length) stack[stack.length - 1].kids.push(el);
    else if (root === null) root = el;
    else throw new SchedError("xml_bad", "The XML file has more than one root element.");
    if (tm[1] === "/") { delete el._raw; delete el._t; }
    else {
      stack.push(el);
      if (stack.length > XML_MAX_DEPTH) throw new SchedError("xml_deep", "The XML file nests deeper than 64 levels.");
    }
    pos = _XTAIL.lastIndex;
    if (pos > n) break;
  }
  if (stack.length) throw new SchedError("xml_bad", `The XML file ends before "${pySlice(stack[stack.length - 1]._raw, 0, 40)}" is closed.`);
  if (root === null) throw new SchedError("xml_bad", "The file has no XML content.");
  return root;
}
const xkid = (el, tag) => (el ? el.kids.find((k) => k.tag === tag) || null : null);
const xkids = (el, tag) => (el ? el.kids.filter((k) => k.tag === tag) : []);
function xval(el, tag, dflt) {
  const k = el ? xkid(el, tag) : null;
  if (k === null) return dflt === undefined ? null : dflt;
  return pyStrip(k.text);
}
const _BAD_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g;
const xml_escape = (s) => String(s).replace(_BAD_XML, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
