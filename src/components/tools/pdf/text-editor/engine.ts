/**
 * Optional PyMuPDF repair path for blocks the MIT engine cannot clean.
 *
 * `core/content.removeTextInRects` rewrites the page's *own* content stream. Text
 * that arrives inside a form XObject, or drawn with a Type3 font, is outside its
 * reach, and drawing the edited block on top of it would leave doubled, still
 * selectable text. Those blocks are therefore skipped by the built-in writer and
 * reported to the user.
 *
 * When the user has the AGPL PyMuPDF module reachable (CDN, fetched once, files
 * never leave the device) this module runs the same deletion-and-rewrite on the
 * already-exported bytes: `addRedaction` + `applyRedactions` reaches into forms,
 * and `insertText` puts the edited line back. Line geometry comes from the same
 * `model.layoutBlock` pass the MIT writer used, in viewer coordinates, which is
 * also the space PyMuPDF's page objects use.
 *
 * What it does not do: PyMuPDF writes base-14 Helvetica here, so a repaired
 * block's metrics are approximate rather than the embedded face the preview used.
 * That is stated to the user rather than hidden.
 */
import { engineReady, openWithPyMuPDF } from '@/lib/pdf/core/engine-ops';
import type { TopLeftBox } from '@/lib/pdf/core/tables';
import { hexToRgb, type TextObject } from './model';

/** One already-laid-out line, in viewer space, for PyMuPDF to insert. */
export interface EngineLine {
  /** 1-based page. */
  page: number;
  x: number;
  /** Baseline, top-left origin, y down — PyMuPDF's space. */
  y: number;
  size: number;
  text: string;
  color: string;
}

export interface EngineRepairOutcome {
  bytes: Uint8Array;
  repaired: string[];
  note: string;
}

/** True when the fallback is available without the user opening settings. */
export function engineRepairAvailable(): boolean {
  return engineReady('pymupdf');
}

/**
 * Delete `boxes` and write `lines` with PyMuPDF.
 *
 * Returns `null` when the engine is not reachable, so the caller can keep the
 * built-in result and tell the user which blocks were left alone. A failure
 * inside the engine never destroys the built-in output: the original bytes are
 * returned untouched and the error text is reported.
 */
export async function repairWithPyMuPDF(
  bytes: Uint8Array,
  deletions: { object: TextObject }[],
  lines: EngineLine[],
  password?: string,
): Promise<EngineRepairOutcome | null> {
  if (!engineRepairAvailable()) return null;
  if (deletions.length === 0 && lines.length === 0) return null;

  const opened = await openWithPyMuPDF(bytes, password);
  const repaired: string[] = [];
  try {
    const byPage = new Map<number, { object: TextObject }[]>();
    for (const entry of deletions) {
      const list = byPage.get(entry.object.page) ?? [];
      list.push(entry);
      byPage.set(entry.object.page, list);
    }
    for (const [page1, entries] of byPage) {
      const page = opened.doc.getPage(page1 - 1);
      if (!page) continue;
      for (const entry of entries) {
        for (const box of entry.object.deletion) {
          const rect = rectOf(box);
          page.addRedaction(rect);
        }
        repaired.push(entry.object.id);
      }
      page.applyRedactions();
    }

    for (const line of lines) {
      const page = opened.doc.getPage(line.page - 1);
      if (!page || line.text.length === 0) continue;
      const [r, g, b] = hexToRgb(line.color);
      page.insertText({ x: line.x, y: line.y }, line.text, {
        fontsize: line.size,
        fontname: 'helv',
        color: { r: r / 255, g: g / 255, b: b / 255 },
      });
    }

    return {
      bytes: opened.doc.save({ deflate: true }),
      repaired,
      note:
        'PyMuPDF cleaned those blocks. Its text is set in Helvetica rather than the page’s own face, so check the result in a viewer.',
    };
  } finally {
    try {
      opened.doc.close();
    } catch {
      /* the module already released the document */
    }
  }
}

function rectOf(box: TopLeftBox) {
  return { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height };
}
