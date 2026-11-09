#!/usr/bin/env python3
"""
Revert each half of the font-subset fix and report which tests go red.

  python3 docs/research/font-subset-revert.py

`tests/pdf/fonts.test.ts` asserts the byte-level contract of an embedded face,
which is the class of assertion that would have caught the original defect: a
subset whose glyphs no reader can reach still opens, still extracts and still
copies. Each case below edits `src/lib/pdf/core/fonts.ts` in place, runs that
file, and restores it — so a green run here means the tests are pinned to the
bytes and not to the intent.
"""
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TARGET = ROOT / "src" / "lib" / "pdf" / "core" / "fonts.ts"

# (name, the line as it stands, the line as it was before the fix)
CASES = [
    (
        "align the face before subsetting",
        "const faceBytes = alignTrueTypeGlyphs(bytes);",
        "const faceBytes = bytes;",
    ),
    (
        "hand the face to the module's own writer",
        "return embedUnicodeFace(doc, bytes);",
        "return doc.embedFont(bytes, { subset: true });",
    ),
    (
        "read a face's flavour from its tables",
        "this.cff = faceIsCff(font);",
        "this.cff = Boolean((font as unknown as { cff?: unknown }).cff);",
    ),
    (
        "repair the CFF header",
        "const subsetBytes = this.cff ? repairCffHeader(encoded) : encoded;",
        "const subsetBytes = encoded;",
    ),
]


def run_tests() -> tuple[int, int]:
    """(failed, passed) from one vitest run of the file that guards these bytes."""
    proc = subprocess.run(
        ["npx", "vitest", "run", "tests/pdf/fonts.test.ts"],
        cwd=ROOT, capture_output=True, text=True, timeout=1800,
    )
    out = proc.stdout + proc.stderr
    summary = re.search(r"Tests\s+(.*)", out)
    line = summary.group(1) if summary else ""
    failed = int(match.group(1)) if (match := re.search(r"(\d+) failed", line)) else 0
    passed = int(match.group(1)) if (match := re.search(r"(\d+) passed", line)) else 0
    if not line:
        print(out[-2000:])
    return failed, passed


def main() -> int:
    original = TARGET.read_text()
    failed_baseline, passed_baseline = run_tests()
    print(f"as committed: {passed_baseline} passed, {failed_baseline} failed")
    if failed_baseline:
        print("   the file is not green before anything is reverted; fix that first")
        return 1
    for label, fixed, before in CASES:
        if fixed not in original:
            print(f"!! {label}: the line the revert expects is not in fonts.ts any more")
            return 1
        TARGET.write_text(original.replace(fixed, before, 1))
        try:
            failed, passed = run_tests()
        finally:
            TARGET.write_text(original)
        verdict = "RED as it should be" if failed else "GREEN — the test does not pin this"
        print(f"revert {label:38} -> {failed} failed, {passed} passed: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
