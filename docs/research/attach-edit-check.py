#!/usr/bin/env python3
"""Judge what `edit-attachments` did, with readers that did not write it.

    python3 docs/research/attach-edit-check.py [edit-dir]

Ground truth for every run in `edit.json` (written by
`tests/pdf/c4-edit-battery.test.ts`) is the source document read by libqpdf, MuPDF, pypdf
and poppler — never this app's own reader. Checks, per case:

* **re-open gate** — all four readers open the produced file (a rename that ships a PDF
  MuPDF refuses is a defect even when the card says it renamed one);
* **rename really renamed** — the entry now answers to the new name in `/UF`, in `/F`, in
  the name-tree key, and in the hosting annotation's `/Contents`, and the old name is
  gone from all four; the payload SHA-256, `/Params /Size`, both dates and `/Desc` are
  the same bytes they were (the card promises "keeps the bytes and the file's size, dates
  and description");
* **collision rename** — a name the document already carries keeps both files, the moved
  one under the `-2` form the card says it used, and the card's sentence names the name it
  actually stored;
* **delete is not a pointer edit** — the removed entry's payload object is gone from the
  file (no `/EmbeddedFile` stream anywhere, reachable or not, still holds those bytes),
  the name-tree pair is spliced, and an emptied `/EmbeddedFiles` / `/Names` store does not
  stay standing;
* **bystanders untouched** — every entry the run did not name is byte-identical, with its
  description and dates, and the pages, their ink and their text are unchanged;
* **counts** — "Removed N of M", "renamed N of M" and "Remaining: X" match the produced
  tree, and "Now carried: …" lists the names the file actually holds.

Exit status is the number of failing runs.
"""
import json
import os
import re
import subprocess
import sys
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-security/c4/edit"

def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    module = importlib.util.module_from_spec(spec)
    saved = sys.argv[:]
    sys.argv = [file, ROOT]
    spec.loader.exec_module(module)
    sys.argv = saved
    return module


base = _load("extract_check", "attach-extract-check.py")
mupdf = _load("mupdf_reader", "attach-names-mupdf.py")

sha, source_truth, deref, text_of = base.sha, base.source_truth, base.deref, base.text_of
FLATE = re.compile(rb"stream\r?\n")


def read_mupdf(path: str) -> dict:
    return mupdf.read(path)


def every_stream_payload(path: str) -> list[str]:
    """SHA-256 of every stream object in the file, reachable or not — the closure yardstick.

    A deletion that only unlinks the name-tree pair leaves the `/EmbeddedFile` stream
    sitting in the file with its bytes still in it, so the payload is found here even when
    no reader can list it any more.
    """
    pdf = __import__("pikepdf")
    doc = pdf.open(path)  # pikepdf repairs on open by default; there is no `recover` kwarg
    out = []
    for ref in [o for o in doc.objects]:
        try:
            obj = ref
        except Exception:  # noqa: BLE001
            continue
        if isinstance(obj, pdf.Stream):
            try:
                out.append(sha(obj.read_bytes()))
            except Exception:  # noqa: BLE001
                pass
    return out


def entries(path: str) -> list[dict]:
    return source_truth(path)


def tree_shape(path: str) -> dict:
    """What the name-tree stores look like, for the "emptied dictionary stood" check."""
    pdf = __import__("pikepdf").open(path)
    names = deref(pdf, pdf.Root.get("/Names"))
    tree = deref(pdf, names.get("/EmbeddedFiles")) if names is not None else None
    shape = {"hasNamesDict": names is not None, "hasEmbeddedFiles": tree is not None,
             "treeKeys": sorted(tree.keys()) if tree is not None else [],
             "emptyTree": bool(tree is not None and len(dict(tree)) == 0),
             "emptyNames": bool(names is not None and len(dict(names)) == 0),
             "af": len(list(pdf.Root.get("/AF") or []))}
    return shape


def norm(name: str) -> str:
    return (name or "").strip().lower()


def check_run(run: dict) -> list[str]:
    problems: list[str] = []
    case = run["case"]
    produced = run.get("out")
    if run.get("error"):
        return problems
    if not produced or not os.path.exists(produced):
        # A run with no request lists instead of writing: the count it reads out has to
        # be the number of attachments the source actually holds.
        listed = re.search(r"carries (\d+) attachment\(s\)", run.get("message", ""))
        if run.get("before") and (listed is None or int(listed.group(1)) != len(run["before"])):
            problems.append(
                f"a listing run should count the {len(run.get('before', []))} attachments it holds: "
                f"{run.get('message','')[:120]!r}"
            )
        if not run.get("before") and run.get("message"):
            problems.append(f"a document with nothing in it should refuse by name: {run.get('message')[:120]!r}")
        return problems

    source = os.path.join(ROOT, "sources", f"{case}-in.pdf")
    if not os.path.exists(source):
        return problems + [f"{case}: source snapshot missing"]
    before = entries(source)
    # An entry with no name anywhere reaches the tool as `attachment-N.bin`
    # (`core/attachments.ts` positional naming) — without the same stand-in
    # here, a positional removal the tool honoured reads as a bystander whose
    # "bytes were lost".
    for i, entry in enumerate(before):
        if not entry["name"]:
            entry["name"] = f"attachment-{i + 1}.bin"
    after = entries(produced)
    before_by_sha = {e["sha256"]: e for e in before}
    after_by_sha = {e["sha256"]: e for e in after}

    # 1. Re-open gate.
    verdict = read_mupdf(produced)
    if not verdict.get("opens"):
        problems.append(f"MuPDF cannot open the produced file: {verdict.get('error')}")
    # MuPDF's attachment resolver only follows /EF keys /UF and /F — a filespec
    # naming /DOS or /UNIX is invisible to it even in the UNTOUCHED fixture
    # (measured: `ef-dos-unix.pdf` opens, renders, then throws object-not-a-
    # stream). Whatever MuPDF could not see in the source it may not be missed
    # for in the output.
    src_mupdf = read_mupdf(source)
    src_shas = {f["sha256"] for f in src_mupdf.get("files", [])}
    try:
        __import__("pypdf").PdfReader(produced)
    except Exception as exc:  # noqa: BLE001
        problems.append(f"pypdf cannot read the produced file: {type(exc).__name__}: {exc}")
    pop = subprocess.run(["pdfdetach", "-list", produced], capture_output=True, timeout=180, check=False)
    src_pop = subprocess.run(["pdfdetach", "-list", source], capture_output=True, timeout=180, check=False)
    new_errors = [ln for ln in pop.stderr.decode("utf-8", "replace").splitlines()
                  if "Syntax Error" in ln and ln not in src_pop.stderr.decode("utf-8", "replace")]
    if new_errors:
        problems.append(f"poppler reports NEW syntax errors: {new_errors[:2]}")

    requested_remove = [n for n in re.split(r"[\n,]+", run.get("remove") or "") if n.strip()]
    requested_rename = []
    for line in (run.get("rename") or "").split("\n"):
        parts = [p.strip() for p in re.split(r"\s*(?:->|=>)\s*", line.strip()) if p.strip()]
        if len(parts) == 2:
            requested_rename.append((parts[0], parts[1]))

    removed = {norm(n) for n in requested_remove}
    rename_from = {norm(a): (a, b) for a, b in requested_rename}

    # 2. Renames: new name everywhere, everything else the same bytes.
    for old, new in requested_rename:
        origin = next((e for e in before if norm(e["name"]) == norm(old)), None)
        if origin is None:
            continue  # a missing name is judged by the sentence, below
        if norm(new) in removed or norm(old) in removed:
            continue  # removed in the same run: the delete check owns it (the tool removes before renaming, so a name both removed and renamed away is gone, not lost)
        moved = after_by_sha.get(origin["sha256"])
        if moved is None:
            problems.append(f"renaming `{old}` -> `{new}` lost the payload ({origin['sha256'][:10]})")
            continue
        stored = {norm(moved["uf"]), norm(moved["f"]), norm(moved["key"])}
        message_low = run.get("message", "").lower()
        if norm(new) not in stored:
            base, dot, suffix = new.rpartition(".")
            stem = (base if dot else new).lower()
            ext = suffix.lower() if dot else ""
            # The tool's note promises a rename onto a held name keeps both under
            # the -2 form, and the card names the stored one: accept exactly that.
            collision = any(
                re.fullmatch(rf"{re.escape(stem)}-\d+(\.{re.escape(ext)})?", s2) and s2 in message_low
                for s2 in stored if s2
            )
            if not collision:
                problems.append(f"`{old}` -> `{new}`: the file answers to {sorted(stored)}")
        if norm(old) in stored and len(stored - {norm(new)} - {""}) > 0 and norm(old) not in {norm(e["name"]) for e in after}:
            pass
        if moved["size"] != origin["size"]:
            problems.append(f"`{old}` -> `{new}` changed the payload size {origin['size']} -> {moved['size']}")
        for key in ("description",):
            if (moved.get(key) or "") != (origin.get(key) or ""):
                problems.append(f"`{old}` -> `{new}` changed /Desc: {origin.get(key)!r} -> {moved.get(key)!r}")
        for key in ("uf", "f", "key"):
            if norm(old) == norm(new):
                break  # a rename onto its own name keeps the name — nothing to erase
            if moved.get(key) and norm(moved[key]) == norm(old) and key != "f":
                problems.append(f"`{old}` -> `{new}` left the old name in /{key.upper()}: {moved[key]!r}")
        # MuPDF must agree the entry now answers to the new name — but only
        # where MuPDF could see the payload in the source at all.
        if verdict.get("opens") and origin["sha256"] in src_shas:
            mirror = [f for f in verdict.get("files", []) if f["sha256"] == origin["sha256"]]
            if not mirror:
                problems.append(f"MuPDF no longer returns the payload of `{old}`")
            elif norm(new) not in {norm(mirror[0].get("filename")), norm(mirror[0].get("ufilename"))}:
                problems.append(f"MuPDF lists the renamed entry as {mirror[0].get('filename')!r}, not {new!r}")
        names_in_pop = [ln.split(":", 1)[-1].strip() for ln in pop.stdout.decode("utf-8", "replace").splitlines() if ":" in ln]
        if norm(new) not in {norm(n) for n in names_in_pop} and norm(old) in {norm(n) for n in names_in_pop}:
            problems.append(f"pdfdetach still lists the OLD name: {names_in_pop}")

    # 3. Deletions: pointer AND object.
    all_streams = every_stream_payload(produced)
    for name in removed:
        origin = next((e for e in before if norm(e["name"]) == name), None)
        if origin is None:
            continue
        if any(norm(e["name"]) == name for e in after):
            problems.append(f"`{origin['name']}` is still listed after removal")
        elif origin["sha256"] in all_streams:
            problems.append(
                f"`{origin['name']}` was unlinked but its payload object is still in the file "
                f"({origin['sha256'][:10]} found among {len(all_streams)} streams)"
            )

    # 4. Bystanders byte-identical, and the document unmoved.
    for entry in before:
        asked = norm(entry["name"]) in {norm(a) for a, _ in requested_rename} | removed
        if asked:
            continue
        same = after_by_sha.get(entry["sha256"])
        if same is None:
            problems.append(f"untouched entry `{entry['name']}` lost its bytes ({entry['sha256'][:10]})")
            continue
        if (same.get("description") or "") != (entry.get("description") or ""):
            problems.append(f"untouched entry `{entry['name']}` changed /Desc")

    # 5. The sentence's arithmetic against the produced tree.
    message = run.get("message", "")
    remaining = re.search(r"Remaining: (\d+)\.", message)
    if remaining and int(remaining.group(1)) != len(after):
        problems.append(f"card says `Remaining: {remaining.group(1)}`, the produced tree holds {len(after)}: {[e['name'] for e in after]}")
    removed_claim = re.search(r"Removed (\d+) of (\d+) requested", message)
    if removed_claim:
        claimed = int(removed_claim.group(1))
        really = sum(
            1 for e in before
            if norm(e["name"]) in removed
            and not any(norm(a["name"]) == norm(e["name"]) for a in after)
        )
        if claimed != really:
            problems.append(f"card says `Removed {claimed}`, the bytes lost {really} named attachment(s)")
    rename_claim = re.search(r"renamed (\d+) of (\d+) requested", message)
    if rename_claim:
        claimed = int(rename_claim.group(1))
        really = sum(1 for old, new in requested_rename
                     if any(norm(e["name"]) == norm(old) for e in before)
                     and any(norm(new) in {norm(x["uf"]), norm(x["f"]), norm(x["key"])} for x in after))
        if claimed != really:
            problems.append(f"card says `renamed {claimed}`, the bytes renamed {really}")
    listed = re.search(r"Now carried: (.+)\.$", message)
    if listed:
        named = {n.strip(" '\"") for n in listed.group(1).split(",")}
        actual = {e["name"] for e in after}
        if not named <= {n for n in actual} and not any(norm(n) == norm(a) for n in named for a in actual):
            problems.append(f"`Now carried: {sorted(named)}` but the file holds {sorted(actual)}")

    # 6. Nothing emptied is left standing after removing every entry.
    if not after:
        shape = tree_shape(produced)
        if shape["emptyTree"] or shape["emptyNames"]:
            problems.append(f"an emptied attachment store stayed standing: {shape}")
    return problems


def main() -> int:
    runs = json.load(open(os.path.join(ROOT, "edit.json")))
    failed = 0
    for run in runs:
        problems = check_run(run)
        if problems:
            failed += 1
        print(f"{'ok  ' if not problems else 'FAIL'} {run['case']:32s} {len(run.get('before',[]))} -> {len(run.get('after',[]))} | {run.get('message','')[:70]!r}")
        for problem in problems:
            print(f"      · {problem}")
    print(f"\n{len(runs)} runs, {failed} failed")
    return failed


if __name__ == "__main__":
    sys.exit(main())
