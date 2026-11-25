/**
 * `webp-to-pdf` and the two things a WebP holds that the reader did not read.
 *
 * Measured on the dev build (docs/research/webp-to-pdf-round.mjs, PyMuPDF and
 * Pillow on the produced pages):
 *
 *   - a lossy and a lossless WebP decode exactly (0 mismatched pixels against
 *     Pillow's decode of the same files, page = pixels), and an alpha WebP keeps
 *     its transparency as an `/SMask` under white paper — those were already
 *     right and are pinned as controls;
 *   - a WebP cut at 40 % of its bytes embedded as a **complete 400 x 240 page of
 *     white**: `createImageBitmap` answered a full-size bitmap of nothing;
 *   - an animated WebP gave one page — its first frame — and the card said
 *     `1 WEBP image(s) -> 1 page(s)` with no mention of the other three frames,
 *     nor did any note.
 *
 * The reader now walks the RIFF length and chunk sizes before the decoder is
 * asked (refusing by name, the way the BMP round does) and the run names any
 * animated file it meets. jsdom decodes no WebP, so the canvas shim in this file
 * answers the way Chrome did: a *blank* bitmap of the header's size for a file it
 * cannot really read, the file's own table pixels where the fixture needs them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFObject } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { pdfFromImages } from '@/lib/pdf/core/pack';
import { pageContentOps } from '@/lib/pdf/core/content';
import { decodeImage } from '@/lib/pdf/core/images';
import { contextFor } from './convert-to-harness';

/* ------------------------------------------------------------------ *
 * Fixtures                                                              *
 * ------------------------------------------------------------------ */

/** A real 400 x 240 lossy WebP (VP8), written by Pillow. */
const LOSSY = new Uint8Array(Buffer.from(
    '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',
  'base64',
));

/** A real 40 x 40 lossless WebP (VP8L): alpha 0 outside a red disc, 255 inside. */
const ALPHA = new Uint8Array(Buffer.from(
    'UklGRlYAAABXRUJQVlA4TEoAAAAvJ8AJEA8wHsP9lP/5D1owim2rzaUkWSIBKUgL0pCCBJbpb5VuIKL/E8AvDyDLQdEAVQGa'
  + 'IkxKJ5vG9yalk6YIVQGKBshywMHXAQ==',
  'base64',
));

/** The RGBA pixels `ALPHA` decodes to (it is lossless, so this is the source). */
const ALPHA_RGBA = new Uint8Array(Buffer.from(
    'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8A3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP8AAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8A3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/ANweKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP8AAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/ANweKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP8AAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/AAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8A3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/ANweKP/cHij/3B4o/9weKP/cHij/'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + '3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/3B4o/wAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wDcHij/3B4o/9weKP/cHij/3B4o/9weKP/cHij/'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8A'
  + 'AAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AA==',
  'base64',
));

/* ------------------------------------------------------------------ *
 * Container builders — only what the reader judges                    *
 * ------------------------------------------------------------------ */

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function le32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function riff(...chunks: Uint8Array[]): Uint8Array {
  const body = concat(...chunks);
  return concat(Buffer.from('RIFF', 'latin1'), le32(4 + body.length), Buffer.from('WEBP', 'latin1'), body);
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  // Odd payloads carry a pad byte that is *not* counted in the size.
  return concat(Buffer.from(type, 'latin1'), le32(payload.length), payload, (payload.length & 1) ? new Uint8Array(1) : new Uint8Array(0));
}

/** A still WebP whose VP8 frame header states `width` x `height`. */
function still(width: number, height: number): Uint8Array {
  const body = new Uint8Array(10);
  body[3] = 0x9d;
  body[4] = 0x01;
  body[5] = 0x2a;
  const view = new DataView(body.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return riff(chunk('VP8 ', body));
}

/** An animated WebP: a `VP8X` canvas, an `ANIM` header and one `ANMF` per frame. */
function animated(frames: number, width = 24, height = 16): Uint8Array {
  const canvas = new Uint8Array(10);
  canvas[0] = 0x02; // the Animation flag
  const view = new DataView(canvas.buffer);
  view.setUint8(4, width - 1);
  view.setUint8(5, 0);
  view.setUint8(6, 0);
  view.setUint8(7, height - 1);
  const anim = new Uint8Array(6); // background colour, loop forever
  const anmf = () => {
    const head = new Uint8Array(16);
    new DataView(head.buffer).setUint8(6, width - 1);
    new DataView(head.buffer).setUint8(9, height - 1);
    return chunk('ANMF', concat(head, chunk('VP8 ', new Uint8Array(10).fill(1))));
  };
  return riff(chunk('VP8X', canvas), chunk('ANIM', anim), ...Array.from({ length: frames }, anmf));
}

/** The same file with only `keep` of its bytes left. */
const cut = (bytes: Uint8Array, keep: number) => bytes.slice(0, keep);

/** The same file with its RIFF length rewritten to `size` (a chunk then overruns). */
function retag(bytes: Uint8Array, declared: number): Uint8Array {
  // The field counts from byte 8, so a declared *total* is eight less.
  const out = new Uint8Array(bytes);
  new DataView(out.buffer).setUint32(4, declared - 8, true);
  return out;
}

/* ------------------------------------------------------------------ *
 * A canvas and a decoder that keeps pixels                             *
 * ------------------------------------------------------------------ */

interface Pixels { width: number; height: number; data: Uint8Array }

/** Fixtures the shim decodes for real (a WebP it cannot read is blank white). */
const TABLE = new Map<string, Pixels>();
function key(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
TABLE.set(key(ALPHA), { width: 40, height: 40, data: ALPHA_RGBA });

const stores = new WeakMap<HTMLCanvasElement, Pixels>();

function storeOf(canvas: HTMLCanvasElement): Pixels {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const kept = stores.get(canvas);
  if (!kept || kept.width !== width || kept.height !== height) {
    const fresh = { width, height, data: new Uint8Array(width * height * 4) };
    stores.set(canvas, fresh);
    return fresh;
  }
  return kept;
}

function putPixels(target: Pixels, source: Pixels, w: number, h: number): void {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      // Index in the *source* grid, scaled to the drawn size — dividing by the
      // target's dimensions here runs the last rows past the source buffer.
      const from = ((row * source.height) / h | 0) * source.width + ((col * source.width) / w | 0);
      const to = (row * target.width + col) * 4;
      const alpha = source.data[from * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) {
        target.data[to + c] = Math.round(source.data[from * 4 + c] * alpha + target.data[to + c] * (1 - alpha));
      }
      target.data[to + 3] = Math.round((alpha + (target.data[to + 3] / 255) * (1 - alpha)) * 255);
    }
  }
}

/** A PNG, as the pack step re-encodes the canvas before embedding it. */
function decodePng(bytes: Uint8Array): Pixels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  // Type 2 is RGB: what Chrome writes for a canvas with no transparent pixel.
  const channels = view.getUint8(25) === 2 ? 3 : 4;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(concat(...idat)));
  const stride = 1 + width * channels;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * stride + 1 + x * channels;
      const to = (y * width + x) * 4;
      data.set(raw.subarray(from, from + channels), to);
      if (channels === 3) data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

/** What Chrome did with the bytes: a bitmap of the header's size, or the table's pixels. */
function decodeAny(bytes: Uint8Array): Pixels {
  const known = TABLE.get(key(bytes));
  if (known) return known;
  if (bytes[0] === 0x89) return decodePng(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = String.fromCharCode(...bytes.subarray(12, 16));
  const blank = (width: number, height: number): Pixels => ({
    // What Chrome answered for a file it could not really decode: the header's
    // size, fully opaque white (measured: the truncated page rendered all 255).
    width,
    height,
    data: new Uint8Array(width * height * 4).fill(255),
  });
  if (fourcc === 'VP8X') {
    return blank((bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1, (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1);
  }
  return blank(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
}

function pngOf(pixels: Pixels, rgba: boolean): Uint8Array {
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
  const channels = rgba ? 4 : 3;
  const stride = 1 + pixels.width * channels;
  const raw = new Uint8Array(pixels.height * stride);
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const from = (y * pixels.width + x) * 4;
      raw.set(pixels.data.subarray(from, from + channels), y * stride + 1 + x * channels);
    }
  }
  const table: Uint8Array[] = [];
  const entry = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < 8 + data.length; i++) {
      crc ^= out[i];
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, pixels.width);
  head.setUint32(4, pixels.height);
  ihdr[8] = 8;
  ihdr[9] = rgba ? 6 : 2;
  table.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), entry('IHDR', ihdr), entry('IDAT', new Uint8Array(deflateSync(raw))), entry('IEND', new Uint8Array(0)));
  return concat(...table);
}

const real = {
  getContext: HTMLCanvasElement.prototype.getContext,
  toBlob: HTMLCanvasElement.prototype.toBlob,
};

function install(): void {
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    const canvas = this;
    return {
      fillStyle: '#000000',
      globalAlpha: 1,
      save: () => undefined,
      restore: () => undefined,
      clearRect: () => undefined,
      fillRect(this: { fillStyle: string }, x: number, y: number, w: number, h: number) {
        const store = storeOf(canvas);
        const hex = String(this.fillStyle).replace('#', '');
        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
        const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            store.data.set([...rgb, 255], ((y + row) * store.width + (x + col)) * 4);
          }
        }
      },
      drawImage: (source: Pixels, x: number, y: number, w = source.width, h = source.height) => {
        putPixels(storeOf(canvas), source, Math.round(w), Math.round(h));
      },
      getImageData: (x: number, y: number, w: number, h: number) => {
        const store = storeOf(canvas);
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const at = ((y + row) * store.width + x) * 4;
          out.set(store.data.subarray(at, at + w * 4), row * w * 4);
        }
        return { data: out, width: w, height: h };
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function toBlob(this: HTMLCanvasElement, cb: (blob: Blob | null) => void) {
    const store = storeOf(this);
    // A real canvas holds premultiplied pixels and un-premultiplies on the way out.
    const encoded = new Uint8Array(store.data);
    for (let i = 0; i < encoded.length; i += 4) {
      const alpha = encoded[i + 3];
      for (let c = 0; c < 3; c++) encoded[i + c] = alpha === 0 ? 0 : Math.min(255, Math.round((encoded[i + c] * 255) / alpha));
    }
    // Chrome drops the alpha channel for a canvas with no transparent pixel, and
    // that is what decides whether the embedded image carries an /SMask at all.
    const opaque = encoded.every((byte, index) => index % 4 !== 3 || byte === 255);
    cb(new Blob([pngOf({ ...store, data: encoded }, !opaque)], { type: 'image/png' }));
  };

  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async (blob: Blob) => ({
    ...decodeAny(new Uint8Array(await blob.arrayBuffer())),
    close: () => undefined,
  });
}

function restore(): void {
  HTMLCanvasElement.prototype.getContext = real.getContext;
  HTMLCanvasElement.prototype.toBlob = real.toBlob;
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
}

beforeEach(install);
afterEach(restore);

/* ------------------------------------------------------------------ *
 * Reading the produced file                                            *
 * ------------------------------------------------------------------ */

interface Outcome { outputs: { blob: Blob }[]; warnings: string[]; message?: string }

function fileFrom(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/webp' });
}

async function once(bytes: Uint8Array, name: string): Promise<Outcome> {
  return (await runPdfTool({
    toolId: 'webp-to-pdf', files: [fileFrom(bytes, name)], values: { pageSize: 'fit', margin: 0 },
    onProgress: () => undefined, onLog: () => undefined,
  })) as unknown as Outcome;
}

async function batch(files: File[]): Promise<Outcome> {
  return (await runPdfTool({
    toolId: 'webp-to-pdf', files, values: { pageSize: 'fit', margin: 0 },
    onProgress: () => undefined, onLog: () => undefined,
  })) as unknown as Outcome;
}

async function firstPdf(outcome: Outcome): Promise<Uint8Array> {
  const [output] = outcome.outputs;
  expect(output, 'the run produced no PDF').toBeTruthy();
  return new Uint8Array(await output.blob.arrayBuffer());
}

function resolve(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

interface Drawn { width: number; height: number; rgb: Uint8Array; alpha: Uint8Array | null }

/** The image the first page draws, with its mask resolved the way a viewer does. */
async function drawnOnPage(bytes: Uint8Array): Promise<Drawn> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[0]!;
  const resources = resolve(doc, page.node.get(PDFName.of('Resources')));
  const xobjects = resolve(doc, (resources as PDFDict).get(PDFName.of('XObject')));
  const names = pageContentOps(page)
    .filter((op) => op.name === 'Do')
    .map((op) => String(op.operands[0] && 'value' in op.operands[0] ? op.operands[0].value : ''));
  expect(names.length, 'the page drew no image').toBe(1);
  const stream = resolve(doc, (xobjects as PDFDict).get(PDFName.of(String(names[0]))));
  expect(stream, 'the drawn image is missing').toBeInstanceOf(PDFRawStream);
  const image = stream as PDFRawStream;
  const width = (resolve(doc, image.dict.get(PDFName.of('Width'))) as PDFNumber).asNumber();
  const height = (resolve(doc, image.dict.get(PDFName.of('Height'))) as PDFNumber).asNumber();
  const mask = resolve(doc, image.dict.get(PDFName.of('SMask')));
  return {
    width,
    height,
    rgb: new Uint8Array(inflateSync(image.getContents())),
    alpha: mask instanceof PDFRawStream ? new Uint8Array(inflateSync(mask.getContents())) : null,
  };
}

function at(drawn: Drawn, x: number, y: number) {
  const i = y * drawn.width + x;
  return { rgb: [drawn.rgb[i * 3], drawn.rgb[i * 3 + 1], drawn.rgb[i * 3 + 2]], alpha: drawn.alpha ? drawn.alpha[i] : 255 };
}

async function pageSizes(bytes: Uint8Array): Promise<number[][]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const box = page.getMediaBox();
    return [Math.round(box.width), Math.round(box.height)];
  });
}

/* ------------------------------------------------------------------ *
 * 1. A file cut short                                                  *
 * ------------------------------------------------------------------ */

describe('a WebP cut short is refused by name instead of shipped as paper', () => {
  it('names the file and its own numbers, and converts the rest of the batch', async () => {
    const short = cut(LOSSY, Math.floor(LOSSY.length * 0.4));
    const outcome = await batch([fileFrom(short, 'cut.webp'), fileFrom(still(64, 48), 'whole.webp')]);
    const shown = outcome.warnings.join(' ');
    expect(shown, 'the truncated file was not named').toMatch(/cut\.webp/);
    expect(shown).toMatch(/could not be decoded/);
    // The sentence quotes the header's claim and the real length — not a guess.
    expect(shown).toContain(`${LOSSY.length}`);
    expect(shown).toContain(`${short.length}`);
    expect(shown).toMatch(/left out/);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes), 'the refused file took a page anyway').toEqual([[64, 48]]);
  });

  it('control: the very same bytes complete are converted at their own size', async () => {
    const outcome = await once(LOSSY, 'whole.webp');
    expect(outcome.warnings.join(' '), 'a complete WebP was refused').not.toMatch(/could not be decoded/);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[400, 240]]);
  });

  it('refuses a chunk that claims more than the header declares', async () => {
    // The RIFF length rewritten to the truncated length: the file-length check
    // alone would pass, so this isolates the chunk walk.
    const doc = still(64, 48);
    const rewritten = retag(doc, 24);
    const outcome = await batch([fileFrom(rewritten, 'half.webp'), fileFrom(still(32, 32), 'whole.webp')]);
    const shown = outcome.warnings.join(' ');
    expect(shown).toMatch(/half\.webp/);
    expect(shown).toMatch(/'VP8 ' chunk at byte 12 says 10 byte\(s\), which runs past the 24 byte\(s\)/);
  });

  it('control: bytes appended past the declared length are still accepted', async () => {
    // The spec says a reader MAY parse such a file, ignoring the trailing data.
    const padded = concat(still(64, 48), new Uint8Array(64));
    const outcome = await once(padded, 'padded.webp');
    expect(outcome.warnings.join(' ')).not.toMatch(/could not be decoded/);
    expect(await pageSizes(await firstPdf(outcome))).toEqual([[64, 48]]);
  });

  it('control: a header that is not RIFF/WEBP is left to the browser', async () => {
    // A MIME resolved from the *name* reaches here too; the reader must not
    // refuse bytes it cannot judge, and the pictures below still convert.
    const outcome = await once(ALPHA, 'alpha.webp');
    expect(outcome.warnings.join(' ')).not.toMatch(/could not be decoded/);
  });
});

/* ------------------------------------------------------------------ *
 * 2. An animation                                                      *
 * ------------------------------------------------------------------ */

describe('an animated WebP gives one page and says which file it was', () => {
  it('names the file and the frame count on the card', async () => {
    const outcome = await once(animated(4), 'walk.webp');
    const shown = outcome.warnings.join(' ');
    expect(shown, 'the animation was dropped silently').toMatch(/walk\.webp/);
    expect(shown).toMatch(/animated WebP with 4 frames/);
    expect(shown).toMatch(/only the first one/);
    const bytes = await firstPdf(outcome);
    expect(await pageSizes(bytes), 'one file is not one page').toEqual([[24, 16]]);
    expect((await drawnOnPage(bytes)).width, 'the frame was resized').toBe(24);
  });

  it('hands the runner the animation note once, not twice', async () => {
    // The loop pushes the note inline *and* calls `collectNotice`, which is that
    // inline block's own extraction (its comment says so) — the raw tool result
    // carried the sentence twice, and only the runner's `new Set` hid it from
    // the card. Asked at the tool, where the duplication lives.
    const result = await getPdfTool('webp-to-pdf')?.run?.(
      contextFor({ pageSize: 'fit', margin: 0 }, [fileFrom(animated(3), 'walk.webp')]),
    );
    expect(result, 'webp-to-pdf did not run').toBeTruthy();
    const notes = (result?.warnings ?? []).filter((line) => /animated WebP with 3 frames/.test(line));
    expect(notes.length, 'the animation note is pushed by the loop and again by collectNotice').toBe(1);
  });

  it('control: a still WebP gets no animation warning', async () => {
    const outcome = await once(still(64, 48), 'still.webp');
    expect(outcome.warnings.join(' ')).not.toMatch(/animated WebP/);
  });

  it('control: a single-frame animation is one frame and is not warned about', async () => {
    const outcome = await once(animated(1), 'one.webp');
    expect(outcome.warnings.join(' ')).not.toMatch(/animated WebP/);
  });

  it('says it on the card before the run, and does not claim PDF plays it', () => {
    const notes = getPdfTool('webp-to-pdf')?.notes?.join(' ') ?? '';
    expect(notes).toMatch(/animated WebP/);
    expect(notes).toMatch(/first frame/);
    expect(notes).toMatch(/cannot play|will not play|no animation/);
    // The sibling that cannot animate must not borrow the claim.
    expect(getPdfTool('jpg-to-pdf')?.notes?.join(' ') ?? '').not.toMatch(/animated/i);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Transparency, and the pixel path it travels on                    *
 * ------------------------------------------------------------------ */

describe('a transparent WebP keeps its mask over the page’s own paper', () => {
  it('carries the alpha as an /SMask and paints white paper under it', async () => {
    const bytes = await firstPdf(await once(ALPHA, 'cut-out.webp'));
    const drawn = await drawnOnPage(bytes);
    expect(drawn.alpha, 'the transparent WebP lost its /SMask').not.toBeNull();
    expect(drawn.alpha!.length).toBe(40 * 40);
    expect(at(drawn, 0, 0).alpha, 'a corner is not see-through').toBe(0);
    expect(at(drawn, 20, 20).alpha, 'the disc is not opaque').toBe(255);
    // The disc keeps its colour; the see-through part is premultiplied to black
    // and hidden by the mask, which is what the paper shows through.
    expect(at(drawn, 20, 20).rgb).toEqual([220, 30, 40]);
    expect(at(drawn, 0, 0).rgb).toEqual([0, 0, 0]);

    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ops = pageContentOps(doc.getPages()[0]!);
    const before = ops.slice(0, ops.findIndex((op) => op.name === 'Do'));
    expect(before.filter((op) => op.name === 'f').length, 'no paper under the image').toBe(1);
    expect(before.filter((op) => op.name === 'rg')[0]?.operands.map((op) => ('value' in op ? op.value : ''))).toEqual([1, 1, 1]);
  });

  it('control: a still VP8 WebP has no mask to carry', async () => {
    const drawn = await drawnOnPage(await firstPdf(await once(still(64, 48), 'flat.webp')));
    expect(drawn.alpha).toBeNull();
  });

  it('notes the transparency, the way the PNG tool does', () => {
    const notes = getPdfTool('webp-to-pdf')?.notes?.join(' ') ?? '';
    expect(notes).toMatch(/soft mask/);
    expect(notes).toMatch(/white paper/);
  });

  it('says it about a WebP, not about somebody else’s format', () => {
    // Measured on the rail (:5296): the WEBP card's standing note opened
    // "A transparent PNG keeps its transparency…" — the PNG sentence borrowed
    // wholesale, in front of a user holding a .webp.
    const webp = getPdfTool('webp-to-pdf')?.notes?.join(' ') ?? '';
    expect(webp).toMatch(/A transparent WebP/);
    expect(webp, 'the WEBP card speaks of PNG').not.toMatch(/A transparent PNG/);
    // The PNG tool keeps its own sentence.
    expect(getPdfTool('png-to-pdf')?.notes?.join(' ') ?? '').toMatch(/A transparent PNG/);
  });

  it('reads the file through the same reader when called directly', async () => {
    // The tool is not the only caller of `decodeImage`; a cut file must refuse
    // there too, so `image-to-pdf` and the OCR paths see it.
    const written = await pdfFromImages([{ data: still(10, 10) }], { pageSize: 'fit' });
    expect(await pageSizes(await written.bytes())).toEqual([[10, 10]]);
    await expect(decodeImage(cut(LOSSY, 200), { name: 'cut.webp' })).rejects.toThrow(/stops after 200/);
  });
});
