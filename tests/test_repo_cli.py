"""The command line, the model's validation, and repository rules."""

import codecs
import re
from pathlib import Path

import pytest

from fieldsched import PRODUCT_NAME
from fieldsched.cli import main
from fieldsched.errors import SchedError
from fieldsched.model import validate_project

ROOT = Path(__file__).resolve().parent.parent


def test_cli(tmp_path, capsys):
    out = tmp_path / "drill.json"
    assert main(["example", "drill", "--out", str(out)]) == 0
    assert main(["schedule", str(out)]) == 0
    assert "A1620" in capsys.readouterr().out
    assert main(["check", str(out)]) == 0
    assert "open_finish" in capsys.readouterr().out
    for fmt in ("xer", "mspdi", "csv", "pdf", "json"):
        assert main(["convert", str(out), "--to", fmt, "--out", str(tmp_path / f"x.{fmt}")]) == 0
    assert main(["fidelity", str(tmp_path / "x.xer")]) == 0
    assert "142 of 142" in capsys.readouterr().out
    assert main(["schedule", str(tmp_path / "missing.xer")]) == 2
    bad = tmp_path / "bad.xml"
    bad.write_text('<!DOCTYPE x [<!ENTITY a "b">]><Project/>')
    assert main(["schedule", str(bad)]) == 2
    assert "DOCTYPE" in capsys.readouterr().err


def test_cli_binary_to_stdout(tmp_path, capsysbinary):
    out = tmp_path / "drill.json"
    assert main(["example", "drill", "--out", str(out)]) == 0
    assert main(["convert", str(out), "--to", "pdf", "--out", str(tmp_path / "f.pdf")]) == 0
    capsysbinary.readouterr()
    assert main(["convert", str(out), "--to", "pdf"]) == 0
    assert capsysbinary.readouterr().out == (tmp_path / "f.pdf").read_bytes()


@pytest.mark.parametrize("mutate,code", [
    (lambda p: p.update(extra=1), "bad_field"),
    (lambda p: p.update(start="2026-02-30"), "bad_date"),
    (lambda p: p["activities"].append({"id": "a1"}), "duplicate_id"),
    (lambda p: p["activities"].append({"id": "a2", "wbs": "nope"}), "bad_ref"),
    (lambda p: p["activities"].append({"id": "a2", "od": -1}), "bad_field"),
    (lambda p: p["activities"].append({"id": "a2", "od": 1.5}), "bad_field"),
    (lambda p: p["activities"].append({"id": "a2", "af": "2026-01-05"}), "bad_progress"),
    (lambda p: p["activities"].append({"id": "a2", "cstr": "SNET"}), "bad_field"),
    (lambda p: p["activities"].append({"id": "bad id!"}), "bad_field"),
    (lambda p: p["rels"].append({"id": "r9", "pred": "a1", "succ": "zz"}), "bad_ref"),
    (lambda p: p["rels"].append({"id": "r9", "pred": "a1", "succ": "a1"}), "loop"),
    (lambda p: p.update(calendars=[{"id": "c", "name": "x", "week": [[]] * 7}]), "no_work"),
    (lambda p: p.update(calendars=[{"id": "c", "name": "x", "week": [[[600, 500]]] * 7}]), "bad_calendar"),
    (lambda p: p.update(wbs=[{"id": "w1", "parent": "w2"}, {"id": "w2", "parent": "w1"}]), "bad_ref"),
    (lambda p: p.update(settings={"oos": "maybe"}), "bad_field"),
    (lambda p: p.update(format="other"), "bad_format"),
])
def test_validation(mutate, code):
    p = {"start": "2026-01-05T08:00", "activities": [{"id": "a1", "od": 480}], "rels": []}
    mutate(p)
    with pytest.raises(SchedError) as e:
        validate_project(p)
    assert e.value.code == code


def test_text_is_cleaned():
    p = validate_project({"start": "2026-01-05", "activities": [{"id": "a", "name": " A\u0000B\nC ", "notes": "x\r\ny"}]})
    assert p["activities"][0]["name"] == "AB C" and p["activities"][0]["notes"] == "x\ny"
    assert p["start"] == "2026-01-05T00:00"


def repo_files():
    skip = {".git", "__pycache__", ".pytest_cache", "node_modules"}
    for p in ROOT.rglob("*"):
        if p.is_file() and not any(part in skip or part.endswith(".egg-info") for part in p.parts):
            yield p


# Words that must never appear in the repository, stored rot13 so this file passes its own check.
BANNED = [codecs.decode(w, "rot13") for w in ("pynhqr", "nagujebcvp", "pungtcg", "bcranv", "pbcvybg", "fnaqobk", "ntrag", "oevrs", "fcrp")]
NOTES = [codecs.decode(w, "rot13") + ".md" for w in ("PYNHQR", "NTRAGF")]


def test_repository_rules():
    banned = re.compile(r"\b(" + "|".join(BANNED) + r")s?\b|\bAI[- ](generated|assist\w*)\b|\u2014", re.I)
    for p in repo_files():
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = p.read_bytes().decode("latin-1")
        hit = banned.search(text)
        assert hit is None, f"{p}: banned text {hit.group(0)!r}" if hit else ""
        assert ("/ho" + "me/") not in text, str(p)
    for name in NOTES:
        assert not list(ROOT.rglob(name))


def test_commit_history_rules():
    # no banned words in any commit message; the owner's commits carry plain messages with no
    # trailers (merge commits made by the hosting service are left out)
    import shutil
    import subprocess
    if not shutil.which("git") or not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    log = subprocess.run(["git", "-C", str(ROOT), "log", "--no-merges", "--format=%an <%ae>%x1f%cn <%ce>%x1f%B%x1e"],
                         capture_output=True, text=True, check=True).stdout
    banned = re.compile(r"\b(" + "|".join(BANNED) + r")s?\b|\bAI[- ](generated|assist\w*)\b|\u2014", re.I)
    for entry in filter(str.strip, log.split("\x1e")):
        author, committer, body = entry.strip("\n").split("\x1f")
        assert not banned.search(body), body
        if author.endswith("<will@users.noreply.github.com>"):
            assert author == committer == "Will Whitmire <will@users.noreply.github.com>", committer
            # trailers live in the last paragraph after the subject, as git reads them
            paras = [x for x in body.strip().split("\n\n") if x.strip()]
            assert len(paras) < 2 or not re.search(r"^[A-Za-z-]+: \S", paras[-1], re.M), body


def test_product_name_lives_in_one_place():
    # Renaming the product means changing brand.py and 00_brand.js only; vectors.json is generated.
    allowed = {"brand.py", "00_brand.js", "test_repo_cli.py", "vectors.json"}
    for p in repo_files():
        rel = p.relative_to(ROOT).as_posix()
        if not (rel.startswith("src/") or rel.startswith("web/src/") or rel.startswith("tests/")):
            continue
        if p.suffix in (".py", ".js", ".mjs", ".json", ".html", ".css", ".webmanifest") and p.name not in allowed:
            assert PRODUCT_NAME not in p.read_text(encoding="utf-8", errors="ignore"), str(p)
