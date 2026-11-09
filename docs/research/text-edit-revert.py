#!/usr/bin/env python3
"""How many tests go red when each `edit-pdf-text` fix is reverted, one at a time.

  python3 docs/research/text-edit-revert.py

Each case patches one line back to the behaviour the code had before this row,
runs the two test files that cover the seam, counts the failures, and restores
the file. A fix nobody can turn red is a fix nobody measured, so the numbers go
in the ledger row; a case that prints 0 red is the tell that the test is not
pinning what it claims to.
"""
import re
import shutil
import subprocess
import sys

CONTENT = "src/lib/pdf/core/content.ts"
FACES = "src/components/tools/pdf/text-editor/faces.ts"
FILES = "tests/pdf/text-edit-fidelity.test.ts tests/pdf/ux-text.test.ts"

CASES = [
    (
        "TJ numbers ignored again (pen moves by glyph widths only)",
        CONTENT,
        [("pen -= (item.value / 1000) * Math.abs(size) * horizontalScale;", "pen -= 0;")],
    ),
    (
        "deletion box judged by em box again (no baseline ownership)",
        CONTENT,
        [("""  const inY =
    glyph.baseline.y >= rect.y - eps &&
    glyph.baseline.y <= rect.y + rect.height + eps;""",
          "  const inY = glyph.rect.y < rect.y + rect.height && rect.y < glyph.rect.y + glyph.rect.height;")],
    ),
    (
        "partially covered operator dropped whole again",
        CONTENT,
        [("  if (kept.length === 0) return { ops: lead.length ? lead : null };",
          "  if (kept.length > 0 && kept.length < glyphs.length) return { ops: null };\n  if (kept.length === 0) return { ops: lead.length ? lead : null };")],
    ),
    (
        "Form XObjects not read again",
        CONTENT,
        [("walkText(page, pageContentOps(page), { forms: true })", "walkText(page, pageContentOps(page))")],
    ),
    (
        "standard-14 widths keyed by array position again",
        CONTENT,
        [("      const unicode = nameToUnicode(metric.N);\n      if (unicode === undefined) continue;",
          "      const unicode = 0;\n      if (unicode === undefined) continue;")],
    ),
    (
        "runs joined across a pen move again (textInRects groups by operator)",
        CONTENT,
        [("    if (glyph.moved) runCounter += 1;", "")],
    ),
    (
        "source font never reused (always the editor's face)",
        FACES,
        [("  const wantedBold = Boolean(style.bold);", "  if (sources.length) return embeddedFace(doc, style, text);\n  const wantedBold = Boolean(style.bold);")],
    ),
    (
        "zero-width codes accepted (subsubset gate off)",
        CONTENT,
        [("        if (code === undefined || info.widthOf(code) <= 0) {", "        if (code === undefined) {")],
    ),
]


def apply_patch(path, edits):
    """Rewrite `path`, after backing it up so the undo is byte-exact."""
    shutil.copyfile(path, path + ".revert-bak")
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    for old, new in edits:
        assert src.count(old) >= 1, f"{path}: anchor not found: {old[:60]!r}"
        src = src.replace(old, new)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)


def restore(path):
    shutil.move(path + ".revert-bak", path)


def run_tests():
    proc = subprocess.run(
        ["npx", "vitest", "run", *FILES.split()],
        capture_output=True, text=True, timeout=1800,
    )
    out = proc.stdout + proc.stderr
    failed = 0
    m2 = re.search(r"Tests[^\n]*?(\d+) failed", out)
    if m2:
        failed = int(m2.group(1))
    passed = 0
    m3 = re.search(r"Tests[^\n]*?(\d+) passed", out)
    if m3:
        passed = int(m3.group(1))
    if not m2:
        print(out[-2000:])
    return failed, passed


def main():
    print(f"{'case':58} {'red':>4} {'green':>6}")
    for label, path, edits in CASES:
        try:
            apply_patch(path, edits)
            failed, passed = run_tests()
        finally:
            restore(path)
        print(f"{label:58} {failed:4} {passed:6}", flush=True)
    baseline_failed, baseline_passed = run_tests()
    print(f"{'nothing reverted':58} {baseline_failed:4} {baseline_passed:6}")


if __name__ == "__main__":
    sys.exit(main())
