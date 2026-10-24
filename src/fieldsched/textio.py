"""Text decoding and encoding for schedule files, plus a small, strict XML reader.

Decoding: a UTF-8 or UTF-16 byte order mark wins; otherwise the bytes are read as UTF-8 when they
are valid UTF-8, and as Windows-1252 (the code page desktop schedulers write by default) when not.
Windows-1252 follows the WHATWG table, so every byte maps to a character.

The XML reader handles elements, attributes, text, CDATA, comments and processing instructions.
It refuses any DOCTYPE or ENTITY declaration, so a file cannot define entities that expand (the
"billion laughs" attack) or pull in outside files. Only the five XML entities and numeric character
references are decoded. Depth and element counts are capped.
"""

from __future__ import annotations

import re

from .errors import SchedError

MAX_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 64
MAX_NODES = 3_000_000

CP1252_HIGH = [0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152,
               0x8D, 0x17D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122,
               0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178]
CP1252_REV = {cp: 0x80 + i for i, cp in enumerate(CP1252_HIGH)}


def decode_cp1252(data):
    return "".join(chr(b) if b < 0x80 or b >= 0xA0 else chr(CP1252_HIGH[b - 0x80]) for b in data)


def encode_cp1252(text):
    out = bytearray()
    for ch in text:
        c = ord(ch)
        if c < 0x80 or 0xA0 <= c <= 0xFF:
            out.append(c)
        elif c in CP1252_REV:
            out.append(CP1252_REV[c])
        else:
            out.append(0x3F)
    return bytes(out)


def _utf16(data, little):
    n = len(data) // 2
    units = [(data[2 * i] | (data[2 * i + 1] << 8)) if little else ((data[2 * i] << 8) | data[2 * i + 1]) for i in range(n)]
    out = []
    i = 0
    while i < n:
        u = units[i]
        if 0xD800 <= u < 0xDC00 and i + 1 < n and 0xDC00 <= units[i + 1] < 0xE000:
            out.append(chr(0x10000 + ((u - 0xD800) << 10) + (units[i + 1] - 0xDC00)))
            i += 2
            continue
        out.append("\ufffd" if 0xD800 <= u < 0xE000 else chr(u))
        i += 1
    if len(data) % 2:
        out.append("\ufffd")
    return "".join(out)


def decode_bytes(data, what="file"):
    """bytes -> (text, encoding name)."""
    if len(data) > MAX_BYTES:
        raise SchedError("too_big", f"The {what} is larger than 64 MB, the limit for this tool.")
    if data[:3] == b"\xef\xbb\xbf":
        try:
            return data[3:].decode("utf-8"), "utf-8"
        except UnicodeDecodeError:
            return decode_cp1252(data[3:]), "windows-1252"
    if data[:2] == b"\xff\xfe":
        return _utf16(data[2:], True), "utf-16le"
    if data[:2] == b"\xfe\xff":
        return _utf16(data[2:], False), "utf-16be"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return decode_cp1252(data), "windows-1252"


_NAME = re.compile(r"[A-Za-z_:][-A-Za-z0-9._:]*")
_ATTR = re.compile(r"\s+([A-Za-z_:][-A-Za-z0-9._:]*)\s*=\s*(?:\"([^\"<]*)\"|'([^'<]*)')")
_TAIL = re.compile(r"\s*(/?)>")
_REF = re.compile(r"&([^;&\s]{0,12});?")
_NAMED = {"lt": "<", "gt": ">", "amp": "&", "quot": '"', "apos": "'"}


def unescape(s):
    if "&" not in s:
        return s

    def rep(m):
        full = m.group(0)
        name = m.group(1)
        if not full.endswith(";"):
            raise SchedError("xml_bad", "The XML file has a bare '&' that is not a character reference.")
        if name in _NAMED:
            return _NAMED[name]
        if re.fullmatch(r"#[0-9]{1,7}", name) or re.fullmatch(r"#x[0-9A-Fa-f]{1,6}", name):
            cp = int(name[2:], 16) if name[1] == "x" else int(name[1:])
            if cp == 0 or cp > 0x10FFFF or 0xD800 <= cp < 0xE000:
                raise SchedError("xml_bad", "The XML file has a character reference outside Unicode.")
            return chr(cp)
        raise SchedError("xml_entity", f'The XML file uses the entity "&{name[:12]};", which is not one of the five XML entities. It is refused.')

    return _REF.sub(rep, s)


def _local(name):
    i = name.rfind(":")
    return name[i + 1:] if i >= 0 else name


def parse_xml(text):
    """text -> root element {"tag", "attrs", "kids", "text"} with namespace prefixes dropped."""
    if text.startswith("\ufeff"):
        text = text[1:]
    pos = 0
    n = len(text)
    stack = []
    root = None
    nodes = 0
    while True:
        lt = text.find("<", pos)
        chunk = text[pos:] if lt < 0 else text[pos:lt]
        if chunk:
            if stack:
                stack[-1]["_t"].append(unescape(chunk))
            elif chunk.strip():
                raise SchedError("xml_bad", "The XML file has text outside its root element.")
        if lt < 0:
            break
        if text.startswith("<?", lt):
            end = text.find("?>", lt + 2)
            if end < 0:
                raise SchedError("xml_bad", "The XML file ends inside a processing instruction.")
            pos = end + 2
            continue
        if text.startswith("<!--", lt):
            end = text.find("-->", lt + 4)
            if end < 0:
                raise SchedError("xml_bad", "The XML file ends inside a comment.")
            pos = end + 3
            continue
        if text.startswith("<![CDATA[", lt):
            end = text.find("]]>", lt + 9)
            if end < 0 or not stack:
                raise SchedError("xml_bad", "The XML file has a broken CDATA section.")
            stack[-1]["_t"].append(text[lt + 9:end])
            pos = end + 3
            continue
        if text.startswith("<!", lt):
            raise SchedError("xml_doctype", "The XML file declares a DOCTYPE or entities. Schedule files never need one, so it is refused.")
        if text.startswith("</", lt):
            end = text.find(">", lt)
            if end < 0:
                raise SchedError("xml_bad", "The XML file ends inside a closing tag.")
            name = text[lt + 2:end].strip()
            if not stack or stack[-1]["_raw"] != name:
                raise SchedError("xml_bad", f'The XML file closes "{name[:40]}" where it should not.')
            el = stack.pop()
            el["text"] = "".join(el.pop("_t"))
            del el["_raw"]
            pos = end + 1
            continue
        m = _NAME.match(text, lt + 1)
        if not m:
            raise SchedError("xml_bad", "The XML file has a malformed tag.")
        raw = m.group(0)
        p2 = m.end()
        attrs = {}
        while True:
            am = _ATTR.match(text, p2)
            if not am:
                break
            v = am.group(2) if am.group(2) is not None else am.group(3)
            attrs[_local(am.group(1)) if not am.group(1).startswith("xmlns") else am.group(1)] = unescape(v)
            p2 = am.end()
        tm = _TAIL.match(text, p2)
        if not tm:
            raise SchedError("xml_bad", f'The XML file has a malformed tag "{raw[:40]}".')
        nodes += 1
        if nodes > MAX_NODES:
            raise SchedError("too_many", "The XML file has more than 3 million elements.")
        el = {"tag": _local(raw), "attrs": attrs, "kids": [], "text": "", "_raw": raw, "_t": []}
        if stack:
            stack[-1]["kids"].append(el)
        elif root is None:
            root = el
        else:
            raise SchedError("xml_bad", "The XML file has more than one root element.")
        if tm.group(1) == "/":
            del el["_raw"], el["_t"]
        else:
            stack.append(el)
            if len(stack) > MAX_DEPTH:
                raise SchedError("xml_deep", "The XML file nests deeper than 64 levels.")
        pos = tm.end()
        if pos > n:
            break
    if stack:
        raise SchedError("xml_bad", f'The XML file ends before "{stack[-1]["_raw"][:40]}" is closed.')
    if root is None:
        raise SchedError("xml_bad", "The file has no XML content.")
    return root


def kid(el, tag):
    for k in el["kids"]:
        if k["tag"] == tag:
            return k
    return None


def kids(el, tag):
    return [k for k in el["kids"] if k["tag"] == tag] if el else []


def val(el, tag, default=None):
    k = kid(el, tag) if el else None
    if k is None:
        return default
    return k["text"].strip()


_ESC = re.compile(r"[&<>\"]")
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def xml_escape(s):
    s = _BAD_XML.sub("", str(s))
    return _ESC.sub(lambda m: {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[m.group(0)], s)
