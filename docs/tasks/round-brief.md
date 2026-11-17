# Round brief — one PDF tool, measured, fixed, pinned, committed

You are the single owner of **one** tool this round. A dev server is already
running at `http://localhost:5271` (do not start another one). Fixtures are in
`/tmp/triage/in/`. Nothing else is being edited while you work.

Read these before you touch anything, in this order, and only to the depth you
need (do not read all of `docs/TOOL-CAMPAIGN.md` — the top rules block is enough):

1. `docs/TOOL-CAMPAIGN.md` lines 1–30 (the rule, the order of operations).
2. The tool's own definition: `grep -rn "'<tool-id>'" src/lib/pdf/tools/` and the
   engine function its `run` calls.
3. Its existing tests: `grep -rln "<tool-id>" tests/`.
4. `docs/tasks/round-brief.md` §Failing well, below.

## The rule

A tool is verified only by **what the user sees** and **what the file contains**.
Both halves, or neither.

* **Screen half** — a real Chromium tab on the dev server, with the tool holding
  real content, judged by a screenshot **you look at with your own eyes** (you
  have vision: `read` the PNG). Report what the screenshot shows.
* **File half** — open the download with PyMuPDF and measure what the file itself
  draws (`page.get_pixmap()`, non-white pixel count, text, page boxes, rotations,
  `/Annots`, `/Subtype /Image`), against the untouched source measured the same
  way with the same fixture.

A green unit run is neither half. Counts of objects are not ink.

## Driving a run

Rail tools (a form on the right, a run button):

```bash
BASE=http://localhost:5271 TOOL=<id> PDF=/tmp/triage/in/<fixture>.pdf \
  LABEL='^<exact button text>$' PORT=<98xx> OUT=/tmp/r/<id>.pdf \
  node docs/research/rail-tool-bytes.mjs
```

With field flips, a screenshot, or a bespoke pane:

```bash
BASE=http://localhost:5271 TOOL=<id> PDF=<fixture> LABEL='<button>' \
  FIELDS='fieldKey=value pages=2' SHOT=/tmp/r/<id>-<case>.png OUT=/tmp/r/<id>-<case>.pdf \
  PORT=<98xx> node docs/research/colour-rail.mjs
```

* `<fixture>` and the button text come from
  `node docs/research/triage-spec.mjs --dir /tmp/triage` → `/tmp/triage/spec.json`.
  Pick the run whose `tool` is yours; take `files[0]` and `label`.
* `colour-rail.mjs` writes each field the way a user's event reaches React and
  **reads it back out of the DOM before clicking** — if the read-back does not
  match, the run is wrong, not the tool.
* Bespoke panes (no rail button) have their own driver in `docs/research/`
  (`organize-campaign.mjs`, `compare-rail.mjs`, `text-campaign-repro.mjs`,
  `ocr-round-trip.mjs`, …). Write one if yours needs it, following the same
  shape: upload → gesture → capture blob → capture screenshot.
* Ports: 9810–9811 may still hold a stale Chrome; take a **unique** port from 9820–9899 and
  clear it first: `pkill -9 -f 'debugging-port=98' ; sleep 0.5`. The dev server is at :5271 and dies
  if you kill it — restart with `(nohup npx vite --port 5271 --strictPort >/tmp/vite-5271.log 2>&1 &)`. A probe is bounded — if a
  script has not returned in 120 s, it is hung, not busy: kill it and say so.
* **A tool that refuses a fixture the corpus considers valid is a finding**, not a
  harness problem — record the sentence and measure whether the refusal is right.

## Measuring a produced file

```bash
python3 docs/research/rail-measure.py --triage <runs.jsonl> --fixtures /tmp/triage
python3 - <<'PY'
import pymupdf
for f in ("/tmp/triage/in/<fixture>.pdf", "/tmp/r/<id>.pdf"):
    d = pymupdf.open(f)
    print(f, d.page_count, [(round(p.rect.width,1), round(p.rect.height,1), p.rotation,
          len(p.get_text()), sum(1 for _ in p.get_images()), len(p.annots() or [])) for p in d])
PY
```

Use the tool-specific checkers already committed where they exist
(`colour-ink.py`, `rasterize-ink.py`, `pdf-to-image-ink.py`, `organize-campaign-bytes.py`,
`ocr-check.py`, `compare-measure.py`, `text-tail-measure.py`). Prefer an existing
checker to a new one.

## The work

1. **Research first, then decide.** What does the card promise? What does the
   engine actually do? Where can they disagree? Web-search the format or library
   point when you are unsure (pdf-lib, pdf.js, spec) — do not guess.
2. **Measure the current build before changing it.** Record the before numbers.
3. **Fix the real cause**, not the sentence. A copy change is only right when the
   behaviour is right and the words are wrong.
4. **Add a regression test that goes red without the fix.** Run it with the fix
   reverted (`git stash`, or flip the one line) and paste the red count. Test the
   produced bytes, not a mock's call count, wherever the tool writes bytes.
5. **Re-measure after the fix** with the same probe, same fixture, same dpi.
   Before/after must differ in the way you claim.
6. **Controls.** Every "does X" claim needs a case that must NOT satisfy it (an
   empty page, an untouched page, a second run of the same input). If a control
   passes, your instrument is broken.
7. **Copy pass.** Every control must reach the bytes (flip each one, compare the
   produced files). Read the card's description/promise/notes against what you
   measured and correct anything false.
8. **Dark mode** if the surface is UI: one screenshot, tokens only, no hex literal.
9. **Ledger row.** Add/replace your tool's row in `docs/TOOL-CAMPAIGN.md`
   (status `verified-good` when both halves pass, `defect-found` when they do not)
   with the numbers in both states and the paths of the evidence scripts.
   Record measured "left open" items honestly rather than fixing everything.

## Failing well

* **Verify your instrument first.** A check that passes on a page of paper is
  broken. Run it against a blank sheet and against the real one before you trust
  it.
* **No guessed thresholds.** Where a number must be compared, compare against the
  same measurement of the source (equality or a stated, derived tolerance).
* **A render read is not inked until `render.finished` resolves**, and a test
  double that paints synchronously cannot see that race. Model the ordering:
  paper at settle, ink in a later task.
* **Shared modules may be edited** when the true cause is there (`core/render.ts`,
  `core/content.ts`, `shared/**`). Keep the edit to the cause, pin it with a test,
  and name it in the commit body. Do not refactor them.
* **Fundamental product decisions** (a new method, a layout rebuild, a control
  that must disappear) — implement the narrowest defensible version and say in the
  report what you chose and what would need approval.
* If the tool is already correct, that is a result: record the measurement, add
  the missing pin if the behaviour was unpinned, and change no behaviour.

## Reading the noise

These are expected in the `docs/research/**` probes and are not blockers:
`unchecked-throwing-call-js` (a probe may throw), `no-console-except-error-js`
(a probe reports on stdout), `require-safety-comment-for-as-unknown-as` only where
the invariant is obvious from adjacent code. Anything lens reports inside `src/`
or `tests/` is real and must be fixed.

## Disk

`/tmp` is a 16 GB tmpfs and fills up: chrome profiles are ~100 MB each. Delete
your `PORT`'s profile dir and any scratch fixtures larger than a few MB when the
round is over, and never write outside `/tmp/<round>`. `df -h /tmp` before you
commit; at 100 % vitest fails with `ENOSPC` and it reads like a code failure.

## Commit

One commit, exactly your files, conventional-commit subject in the repo's voice
(lowercase, no trailing period, the defect in the subject — see `git log -20`):

```
fix(<tool>): <what was wrong, in one line>

<what the measurement said, before → after, and the reader that judged it>
<the test that goes red without the fix, and its red count>
<shared seams, if any, and why>
```

Never `git add -A`. Never push. Never touch another tool's files.

## Report back (short)

* verdict: `verified-good` / `fixed` / `defect-found-only` / `already-correct`
* the before → after numbers, both halves
* what is left open and why
* files touched, commit sha, red-without-fix count
