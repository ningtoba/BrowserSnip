/**
 * `edit-pdf-text` / PyMuPDF repair: redactions must not paint slabs.
 *
 * The shipped `@bentopdf/pymupdf-wasm` wrapper hard-codes the default fill of
 * `addRedaction` to black — `fill = "(0, 0, 0)"` in `dist/index.js` — so a call
 * that omits the colour leaves a black rectangle exactly where the repaired
 * block's words were. That is one physical source of the *"editing a text
 * literally draws boxes on top of current text"* report, independent of the
 * font-subset row: on a light page the repair reads as a slab over the spot.
 *
 * The repair path must therefore redact in the colour sampled from behind the
 * block — the same answer the built-in cover patch gives — and this pins the
 * call the seam makes. The byte half (a real repaired export whose cleared spot
 * measures paper, not black) is driven live in the campaign rig, per the ticket
 * file's evidence rules.
 */
import { describe, expect, it, vi } from 'vitest';

interface RedactionCall {
  rect: { x0: number; y0: number; x1: number; y1: number };
  text: string;
  fill: { r: number; g: number; b: number } | undefined;
}

const calls = vi.hoisted(() => [] as unknown[]);

vi.mock('@/lib/pdf/core/engine-ops', () => ({
  engineReady: () => true,
  enginePurpose: () => 'PyMuPDF — high-fidelity text extraction.',
  EngineUnavailable: class EngineUnavailable extends Error {},
  openWithPyMuPDF: async () => ({
    doc: {
      getPage: () => ({
        addRedaction: (rect: RedactionCall['rect'], text: string, fill?: RedactionCall['fill']) => {
          calls.push({ rect, text, fill });
        },
        applyRedactions: () => {},
        insertText: () => {},
      }),
      save: () => new Uint8Array([1, 2, 3]),
      close: () => {},
    },
  }),
}));

import { repairWithPyMuPDF } from '@/components/tools/pdf/text-editor/engine';
import { DEFAULT_STYLE, type TextObject } from '@/components/tools/pdf/text-editor/model';

function blocked(id: string, paperColor: string, boxes: number): TextObject {
  return {
    id,
    page: 1,
    kind: 'text',
    box: { x: 50, y: 100, width: 300, height: 60 },
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'needs-engine',
    paragraphs: [],
    style: { ...DEFAULT_STYLE, size: 12, color: '#000000' },
    deletion: Array.from({ length: boxes }, (_, i) => ({ x: 50, y: 100 + i * 16, width: 300, height: 14 })),
    paperColor,
    sourceId: `p1-${id}`,
    fromInvisibleLayer: false,
  };
}

describe('the repair path redacts in paper, not black', () => {
  it('passes the block’s sampled colour to every redaction box', async () => {
    calls.length = 0;
    const object = blocked('b1', '#f2efe6', 3);
    const repair = await repairWithPyMuPDF(new Uint8Array([0]), [{ object }], []);
    expect(repair?.repaired).toEqual(['b1']);
    expect(calls).toHaveLength(3);
    for (const entry of calls as RedactionCall[]) {
      // #f2efe6 = (242, 239, 230)/255 — the colour sampled from behind the words.
      expect(entry.fill).toBeDefined();
      expect(entry.fill!.r).toBeCloseTo(242 / 255, 3);
      expect(entry.fill!.g).toBeCloseTo(239 / 255, 3);
      expect(entry.fill!.b).toBeCloseTo(230 / 255, 3);
      // Never the wrapper's black default: r+g+b all zero is the slab.
      expect(entry.fill!.r + entry.fill!.g + entry.fill!.b).toBeGreaterThan(0);
    }
  });

  it('falls back to white when a block sampled no paper colour', async () => {
    calls.length = 0;
    const object = blocked('b2', '', 1);
    await repairWithPyMuPDF(new Uint8Array([0]), [{ object }], []);
    const [entry] = calls as RedactionCall[];
    expect(entry.fill).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('keeps a genuinely dark page dark — the colour follows the sample (control)', async () => {
    calls.length = 0;
    // A black-papered page must still be redacted *in its own colour*: the fix
    // is honesty about the sample, not a forced white patch.
    const object = blocked('b3', '#000000', 1);
    await repairWithPyMuPDF(new Uint8Array([0]), [{ object }], []);
    const [entry] = calls as RedactionCall[];
    expect(entry.fill).toEqual({ r: 0, g: 0, b: 0 });
  });
});
