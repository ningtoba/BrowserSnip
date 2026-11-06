# C2 requests — core forms / layers / images

From worker C2 (`src/lib/pdf/core/forms.ts`, `src/lib/pdf/core/layers.ts`,
`src/lib/pdf/core/images.ts`, `tests/pdf/edge-forms-core.test.ts`). Everything
below is in a file C2 does not own, so it is a request rather than a patch. The
three defects C2 was sent to fix are fixed and pinned in
`tests/pdf/edge-forms-core.test.ts` (21 tests; 18 of them fail against the code
before the patch).

## R1 — `src/types/utif.d.ts` declares the fields UTIF never sets (root cause of defect 3)

```ts
export interface UtifIFD {
  w: number;   // does not exist at runtime
  h: number;   // does not exist at runtime
  ...
}
```

`UTIF.decodeImage` publishes `img.width` / `img.height` (copied from the
`t256` / `t257` tags) and `img.data`; it never writes `w` / `h`
(`node_modules/utif/UTIF.js`, `UTIF.decodeImage`). Because the ambient type
*asserted* `w: number`, `core/images.ts` read `ifd.w` and TypeScript was happy —
which is how every imported TIFF silently decoded to a 0 × 0 canvas.

C2 worked around it locally (a `UtifPage` structural read inside `images.ts`) to
stay inside its own files. **Ask:** correct the declaration —

```ts
export interface UtifIFD {
  /** Published by `decodeImage` from `t256` / `t257`; absent until then. */
  width?: number;
  height?: number;
  /** Decompressed samples, after `decodeImage`. */
  data?: Uint8Array;
  /** Raw tag values: `t256[0]` is `ImageWidth`, `t257[0]` `ImageLength`. */
  [tag: `t${number}`]: number[] | undefined;
  isLE?: boolean;
  bpp?: number;
  samples?: number;
  config?: number;
  compression?: number;
}
```

then drop `UtifPage` / the cast in `core/images.ts`. Nobody owns that `.d.ts` in
the Phase C table, so it is also safe for whoever reads this first to take.

## R2 — `tests/pdf/forms.test.ts` does not exist (definition-of-done gap)

The Phase C definition of done for C2 runs
`npx vitest run tests/pdf/edge-forms-core.test.ts tests/pdf/forms.test.ts
tests/pdf/tools-e2e.test.ts`. `tests/pdf/forms.test.ts` is not in the repo and
vitest silently skips a filter that matches nothing, so the command really runs
two files. Nothing else covers `core/forms` today except
`tests/pdf/edge-edit.test.ts` (through the tools). **Ask:** either point the
gate at a file that exists, or accept `edge-forms-core.test.ts` as the core
forms coverage.

## R3 — B3 can delete two workarounds now (b3-request items 1 and 2 are fixed)

`core/forms.ts` reads `/TU` (and falls back to the `/T` tree name) without
naming a class, and `core/layers.ts` decodes `/Name` and stores it as a text
string. So in `tests/pdf/edge-edit.test.ts`:

* line ~916 — `layer.name.replace(/#20/g, ' ')` can become `layer.name`; the
  escaped form no longer exists (it also still passes as written, which is why
  C2 left the file alone).
* the `label` on every `fieldSpecs` entry is no longer required to keep
  `form-filler` from crashing; a spec without one now lists as its own name.

## R4 — `core/layers.ts` should own the "is this layer named X" question

`tools/edit.ts` (`pdf-layers`, ~line 1612) re-implements the case-insensitive
name match that `core/layers.ts` already does in three places
(`setLayerVisibility`, `deleteLayer`, `renameLayer`). C2 collapsed those three
into a private `findLayer`; **ask** (for the owner of `tools/edit.ts`, or with
C2's file): export it, so a rename in the core cannot leave the tool matching on
a spelling the core no longer produces.

## R5 — `ensureArray` writes back a *direct* array when the key was indirect

`arrayAt` now resolves `/OCGs`, `/D` and `ON`/`OFF`/`Order` through a reference,
so reads work on Illustrator/CAD output. `ensureArray` reuses it and therefore
mutates the referenced array in place — correct. The one remaining sharp edge is
`ocProperties(create=true)` on a document whose `/OCProperties` is **not** a
dictionary (an array, say): the bad value is quietly replaced. That is a
judgement call about corrupt input (E3), not a defect C2 was sent for, so it is
recorded here instead of changed.
