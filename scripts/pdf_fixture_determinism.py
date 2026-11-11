#!/usr/bin/env python3
"""Byte-reproducibility for the committed fixture generators.

Two generators use this: `attachments-foreign-fixtures.py` (embedded files) and
`foreign-structure-fixtures.py` (outlines, page labels, layers, annotations, form
fields, metadata). Both write through MuPDF, pikepdf/libqpdf and pypdf, and all
three stamp the clock or draw a random file identifier, so a fixture regenerated a
minute later differs for a reason that has nothing to do with the reader under test.

`freeze()` replaces what varies and nothing else:

* every `/CreationDate` and `/ModDate`, in `/Info`, in any dictionary's `/Params`
  (where MuPDF puts an embedded file's times) and on a bare stream dictionary;
* the trailer `/ID`, in **both** halves. ISO 32000-1 §14.4 defines it as two 16-byte
  strings: a permanent first element and a second that changes on every update.
  `static_id` alone pins only the second — the first is carried over from the
  producer, and MuPDF gives each base document a fresh random one; naming the first
  alone is no better. Both levers, or the bytes move.

`pikepdf.Stream` is **not** a `pikepdf.Dictionary` subclass in pikepdf 10.9.1, so
every walk here names both; a `Dictionary`-only test silently matched nothing, which
is how a freeze can report success while the stamps stay live.

`check_reproducible()` rebuilds through the documented CLI in a **separate process**
twice, with a pause longer than the producers' one-second stamp resolution, so two
fast runs cannot land in the same second and look reproducible by luck.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

# The one timestamp every fixture carries, so the bytes never depend on the clock.
FROZEN_STAMP = "D:20240101120000Z"
# MuPDF, pikepdf and pypdf all stamp to the second; a pause shorter than that makes
# the determinism check pass on timing rather than on the freeze working.
PAUSE_SECONDS = 2


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def freeze(path: str) -> None:
    """Pin the timestamps and both halves of the file ID in one file, in place."""
    import pikepdf

    pdf = pikepdf.open(path, allow_overwriting_input=True)
    stamp = pikepdf.String(FROZEN_STAMP)
    identity = bytes.fromhex(sha(os.path.basename(path).encode()))[:16]
    pdf.trailer["/ID"] = pikepdf.Array([pikepdf.String(identity), pikepdf.String(identity)])

    def pin(container) -> None:
        for key in ("/CreationDate", "/ModDate"):
            if key in container:
                container[key] = stamp

    if "/Info" in pdf.trailer:
        pin(pdf.trailer["/Info"])
    for obj in pdf.objects:
        if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            continue
        params = obj.get("/Params") if hasattr(obj, "get") else None
        if isinstance(params, pikepdf.Dictionary):
            pin(params)
        pin(obj)
    pdf.save(path, static_id=True)
    pdf.close()


def pdf_names(target: str) -> list[str]:
    return sorted(name for name in os.listdir(target) if name.endswith(".pdf"))


def freeze_all(target: str, shapes: dict, payloads: dict, default_shape: str, default_producer: str) -> dict:
    """Freeze every fixture in `target` and return the manifest it hashes to."""
    for name in pdf_names(target):
        freeze(os.path.join(target, name))
    return {
        name: {
            "sha256": sha(file_bytes(os.path.join(target, name))),
            "shape": shapes.get(name, {}).get("shape", default_shape),
            "producer": shapes.get(name, {}).get("producer", default_producer),
            "payloads": payloads.get(name, {}),
        }
        for name in pdf_names(target)
    }


def write_manifest(target: str, manifest: dict) -> str:
    path = os.path.join(target, "MANIFEST.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
    return path


def check_reproducible(build_argv, target_dirname: str = "attachments", rounds: int = 2) -> int:
    """Run `build_argv` (with the scratch directory appended) twice; compare bytes.

    A subprocess per round, because that is the path a person re-running the
    generator actually takes; an in-process rebuild would share whatever state the
    first left behind and could pass while the real thing drifts.
    """
    seen: list[dict] = []
    for attempt in range(rounds):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        scratch = tempfile.mkdtemp(prefix="fixture-check-")
        target = os.path.join(scratch, target_dirname)
        os.makedirs(target, exist_ok=True)
        subprocess.run([*build_argv, target], check=True, capture_output=True, timeout=900)
        seen.append({name: sha(file_bytes(os.path.join(target, name))) for name in pdf_names(target)})
        shutil.rmtree(scratch, ignore_errors=True)
    for name in seen[0]:
        stable = all(run.get(name) == seen[0][name] for run in seen)
        print(f"  {name:28s} {seen[0][name][:16]}  {'STABLE' if stable else 'VARIES'}")
    differs = [name for name in seen[0] if any(run.get(name) != seen[0][name] for run in seen)]
    unmatched = set().union(*(set(run) for run in seen)) ^ set(seen[0])
    if differs or unmatched:
        print(f"NOT byte-reproducible: {len(differs)} file(s) differ, {len(unmatched)} name(s) unmatched")
        return 1
    print(f"{len(seen[0])} fixtures, byte-identical across {rounds} runs")
    return 0


def scratch_target(prefix: str) -> str:
    """A fresh output directory for a `--check`-style rebuild."""
    path = os.path.join(tempfile.mkdtemp(prefix=prefix), "out")
    os.makedirs(path, exist_ok=True)
    return path


def argv_without_check() -> list[str]:
    return [argument for argument in sys.argv if argument != "--check"]
